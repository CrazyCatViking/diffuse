import { EventEmitter, once } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoreRpcClient, CoreRpcError, CoreRpcProtocolError } from './coreRpcClient';

describe('CoreRpcClient', () => {
  let client: CoreRpcClient | undefined;

  afterEach(() => client?.dispose());

  it('resolves matching numeric responses', async () => {
    const child = createChild();
    client = new CoreRpcClient(child);
    const response = client.request<{ name: string }>('getVersion');

    child.stdout.write('{"jsonrpc":"2.0","id":1,"result":{"name":"Diffuse"}}\n');

    await expect(response).resolves.toEqual({ name: 'Diffuse' });
  });

  it('emits validated notifications as events', async () => {
    const child = createChild();
    client = new CoreRpcClient(child);
    const event = once(client, 'event');

    child.stdout.write('{"jsonrpc":"2.0","method":"search/started","params":{"searchId":"search-1"}}\n');

    await expect(event).resolves.toEqual([{ jsonrpc: '2.0', method: 'search/started', params: { searchId: 'search-1' } }]);
  });

  it('separates null-id errors from notifications', async () => {
    const child = createChild();
    client = new CoreRpcClient(child);
    const eventListener = vi.fn();
    client.on('event', eventListener);
    const rpcError = once(client, 'rpcError');

    child.stdout.write('{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"InvalidRequest"}}\n');

    const [error] = await rpcError;
    expect(error).toBeInstanceOf(CoreRpcError);
    expect(error).toMatchObject({ code: -32700, message: 'InvalidRequest' });
    expect(eventListener).not.toHaveBeenCalled();
  });

  it('rejects malformed notifications at the protocol boundary', async () => {
    const child = createChild();
    client = new CoreRpcClient(child);
    const protocolError = once(client, 'protocolError');

    child.stdout.write('{"jsonrpc":"2.0","method":"search/progress","params":{"searchId":"search-1"}}\n');

    const [error] = await protocolError;
    expect(error).toBeInstanceOf(CoreRpcProtocolError);
  });

  it('rejects malformed error responses at the protocol boundary', async () => {
    const child = createChild();
    client = new CoreRpcClient(child);
    const response = client.request('getVersion');

    child.stdout.write('{"jsonrpc":"2.0","id":1,"error":{"code":"invalid","message":"failed"}}\n');

    await expect(response).rejects.toBeInstanceOf(CoreRpcProtocolError);
  });
});

function createChild(): ChildProcessWithoutNullStreams & { stdout: PassThrough } {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams & { stdout: PassThrough };
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
    exitCode: null,
    signalCode: null,
    kill() {
      this.killed = true;
      return true;
    },
  });
  return child;
}
