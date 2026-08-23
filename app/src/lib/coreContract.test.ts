import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { coreEventNames, isCoreEvent, type CoreRequest } from './coreContract';

describe('core contract', () => {
  it('requires params only for methods that define required fields', () => {
    const request = vi.fn() as unknown as CoreRequest;

    expectTypeOf(request('getVersion')).toEqualTypeOf<Promise<{ name: string; version: string }>>();
    expectTypeOf(request('syncTreeSitterRegistry')).toMatchTypeOf<Promise<unknown>>();
    request('syncTreeSitterRegistry', { gitUrl: 'https://example.test/registry.git' });
    request('openRepository', { path: '/repo' });

    if (false) {
      // @ts-expect-error openRepository requires params.
      request('openRepository');
      // @ts-expect-error getVersion does not accept params.
      request('getVersion', {});
      // @ts-expect-error openRepository requires a path.
      request('openRepository', {});
    }
  });

  it('keeps a unique runtime event list', () => {
    expect(new Set(coreEventNames).size).toBe(coreEventNames.length);
  });

  it.each([
    { jsonrpc: '2.0', method: 'repository/changed', params: { root: '/repo', paths: ['src/main.ts'] } },
    { jsonrpc: '2.0', method: 'review/changed', params: { root: '/repo', sessionId: 'review-1', change: 'progress' } },
    { jsonrpc: '2.0', method: 'treeSitter/installProgress', params: { language: 'zig', step: 'download' } },
    { jsonrpc: '2.0', method: 'lsp/installProgress', params: { serverId: 'zls', step: 'install' } },
    { jsonrpc: '2.0', method: 'search/started', params: { searchId: 'search-1' } },
    { jsonrpc: '2.0', method: 'search/results', params: { searchId: 'search-1', results: [] } },
    {
      jsonrpc: '2.0',
      method: 'search/progress',
      params: { searchId: 'search-1', scannedFiles: 1, totalFiles: 2, emittedResults: 1 },
    },
    { jsonrpc: '2.0', method: 'search/done', params: { searchId: 'search-1', totalResults: 1, scannedFiles: 2 } },
    { jsonrpc: '2.0', method: 'search/cancelled', params: { searchId: 'search-1', scannedFiles: 1, emittedResults: 0 } },
    { jsonrpc: '2.0', method: 'search/error', params: { searchId: 'search-1', message: 'failed' } },
  ])('validates $method events', (event) => {
    expect(isCoreEvent(event)).toBe(true);
  });

  it.each([
    { jsonrpc: '2.0', method: 'unknown', params: {} },
    { jsonrpc: '2.0', method: 'repository/changed', params: { root: '/repo', paths: [1] } },
    { jsonrpc: '2.0', method: 'search/progress', params: { searchId: 'search-1', scannedFiles: '1' } },
    { jsonrpc: '2.0', method: 'search/results', params: { searchId: 'search-1', results: [{}] } },
  ])('rejects malformed events', (event) => {
    expect(isCoreEvent(event)).toBe(false);
  });
});
