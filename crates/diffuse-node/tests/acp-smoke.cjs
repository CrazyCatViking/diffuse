// Run after cargo build -p diffuse-node -p diffuse-acp-fixture.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('native ACP methods, separate event stream, snapshot fence and validation', async () => {
  const root = path.resolve(__dirname, '../../..');
  const suffix = process.platform === 'darwin' ? 'dylib' : 'so';
  const library = process.platform === 'win32' ? 'diffuse_node.dll' : `libdiffuse_node.${suffix}`;
  const fixture = process.platform === 'win32' ? 'diffuse-acp-fixture.exe' : 'diffuse-acp-fixture';
  const native = { exports: {} };
  process.dlopen(native, path.join(root, 'target/debug', library));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'diffuse-acp-native-'));
  execFileSync('git', ['init', '--initial-branch=main', temp], { stdio: 'ignore' });
  const batches = [];
  const core = native.exports.createCore({
    databasePath: ':memory:', onEventBatch() {}, onAcpEventBatch(batch) { batches.push(batch); },
  });
  const until = async (predicate) => {
    const deadline = Date.now() + 10000;
    while (!(await predicate())) {
      assert.ok(Date.now() < deadline, 'native operation timed out');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  try {
    const opened = await core.openWorkspace(temp);
    const context = { workspaceId: opened.summary.workspaceId, workspaceGeneration: opened.summary.workspaceGeneration, requestId: 'native' };
    await core.saveAcpAdapter({ id: 'fake', executable: path.join(root, 'target/debug', fixture), args: ['modes'], multiplex: false });
    const adapters = await core.discoverAcpAdapters();
    assert.equal(adapters[0].available, true);
    assert.equal(adapters[0].platformSupported, true);
    await assert.rejects(core.openAcpSession({ context, adapterId: 'fake', unexpected: true }));
    const { sessionId } = await core.openAcpSession({ context, adapterId: 'fake' });
    await until(async () => (await core.getAcpSnapshot(context)).sessions.some(s => s.id === sessionId && s.state === 'ready'));
    assert.deepEqual(await core.setAcpMode({ context, sessionId, modeId: 'review' }), { modeId: 'review' });
    const turn = await core.queueAcpPrompt({ context, sessionId, text: 'hello' });
    assert.equal(turn.state, 'queued');
    await until(async () => (await core.getAcpSnapshot(context)).turnsBySession[sessionId].some(t => t.id === turn.id && t.state === 'completed'));
    assert.equal((await core.queueAcpPrompt({ context, sessionId, text: 'hello' })).id, turn.id);
    await assert.rejects(core.queueAcpPrompt({ context, sessionId, text: 'different' }));
    assert.ok((await core.getAcpHistory({ context, sessionId })).some(e => e.kind === 'agent-message'));
    assert.ok((await core.getAcpActivity({ context, sessionId })).some(e => e.kind === 'turn-ended'));
    const snapshot = await core.getAcpSnapshot(context);
    assert.equal(snapshot.summary.attention.running, 0);
    assert.ok(snapshot.sequence > 0);
    const replay = await core.readAcpEvents({ afterSequence: snapshot.sequence });
    assert.equal(replay.requiresSnapshot, false);
    assert.ok(replay.events.every(e => e.sequence > snapshot.sequence));
    await until(() => batches.some(b => b.events.some(e => e.kind === 'agent/turnChanged' && e.payload.state === 'completed')));
    const events = batches.flatMap(b => b.events);
    assert.ok(events.every((e, index) => index === 0 || e.sequence > events[index - 1].sequence));
    assert.equal(events.find(e => e.kind === 'agent/sessionChanged').workspaceId, context.workspaceId);
    assert.ok(batches.every(b => typeof b.requiresSnapshot === 'boolean'));
    const flood = await core.queueAcpPrompt({ context: { ...context, requestId: 'flood' }, sessionId, text: 'flood' });
    // Deliberately stop Node from draining TSFN callbacks while Rust keeps running.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1800);
    await until(() => batches.some(b => b.requiresSnapshot));
    await until(async () => (await core.getAcpSnapshot(context)).turnsBySession[sessionId].some(t => t.id === flood.id && t.state === 'completed'));
    const afterGap = await core.queueAcpPrompt({ context: { ...context, requestId: 'after-gap' }, sessionId, text: 'hello' });
    await until(() => batches.some(b => b.events.some(e => e.kind === 'agent/turnChanged' && e.payload.id === afterGap.id && e.payload.state === 'completed')));
    await core.closeAcpSession({ context, sessionId });
    await until(async () => (await core.getAcpSnapshot(context)).sessions.find(s => s.id === sessionId).state === 'closed');
  } finally {
    await core.shutdown();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
