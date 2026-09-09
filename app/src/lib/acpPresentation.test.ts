import { describe, expect, it } from 'vitest';
import { acpContentText, agentMessages, agentTools } from './acpPresentation';
import { historyEntry } from '../test/acpFixture';
describe('normalized ACP presentation', () => {
  it('represents rich content as inert text without exposing media payloads or fetching links', () => {
    const text = acpContentText([
      { type: 'text', text: '<script>literal text</script>' },
      { type: 'image', mimeType: 'image/png', data: 'SECRET_BASE64' },
      { type: 'resource_link', name: 'Reference', uri: 'javascript:alert(1)' },
      { type: 'resource', resource: { uri: 'file:///source', text: '<img src="remote">' } },
    ]);
    expect(text).toContain('<script>literal text</script>');
    expect(text).toContain('media is not fetched');
    expect(text).not.toContain('SECRET_BASE64');
    expect(text).toContain('not fetched');
    expect(text).toContain('<img src="remote">');
    expect(acpContentText({ type: 'thought', text: 'hidden' })).not.toContain('hidden');
  });
  it('joins consecutive streamed chunks without exposing reasoning or raw metadata', () => {
    expect(
      agentMessages([historyEntry('s'), historyEntry('s', 2, ' world'), { ...historyEntry('s', 3, 'hidden'), kind: 'activity' }]),
    ).toEqual([{ id: 'message', role: 'agent-message', text: 'Hello world' }]);
  });
  it('merges tool updates by stable tool ID', () => {
    const first = { ...historyEntry('s'), kind: 'tool-call', content: { toolCallId: 'tool', title: 'Read diff', status: 'pending' } };
    expect(agentTools([first, { ...first, sequence: 2, content: { toolCallId: 'tool', status: 'completed' } }])).toEqual([
      { toolCallId: 'tool', title: 'Read diff', status: 'completed' },
    ]);
  });
});
