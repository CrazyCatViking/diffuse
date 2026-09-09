import { describe, expect, it } from 'vitest';
import { planReviewScopes, reviewShardPrompt } from './acpReviewPlan';
import { isAcpRequest, isAcpSession, isReviewFileIds, utf8Bytes } from './acpContract';
import { acpSnapshot } from '../test/acpFixture';
const context = { workspaceId: 'workspace-a', workspaceGeneration: 'generation-a', requestId: 'request' };
describe('enforced ACP scope and bounded prompts', () => {
  it('validates scope identity, uniqueness, and UTF-8 limits', () => {
    const request = { context, adapterId: 'a', reviewSessionId: 'r', reviewFileIds: ['file-a'] };
    expect(isAcpRequest('openAcpSession', request)).toBe(true);
    for (const reviewFileIds of [
      null,
      [],
      ['a', 'a'],
      [''],
      ['\0'],
      ['\u6587'.repeat(1366)],
      Array.from({ length: 1025 }, (_, i) => String(i)),
      Array.from({ length: 40 }, (_, i) => `${i}${'x'.repeat(4090)}`),
    ])
      expect(isAcpRequest('openAcpSession', { ...request, reviewFileIds })).toBe(false);
    expect(isAcpRequest('openAcpSession', { ...request, reviewSessionId: undefined })).toBe(false);
    expect(isAcpSession({ ...acpSnapshot().sessions[0], reviewSessionId: 'r', reviewFileIds: ['a'] })).toBe(true);
    expect(isAcpSession({ ...acpSnapshot().sessions[0], reviewFileIds: ['a'] })).toBe(false);
  });
  it('packs large file sets into bounded scopes without raising parallelism', () => {
    const ids = Array.from({ length: 3000 }, (_, i) => `src/${String(i).padStart(4, '0')}.ts`);
    const plan = planReviewScopes(ids, 2);
    expect(plan.parallel).toBe(2);
    expect(plan.scopes.length).toBe(4);
    expect(plan.scopes.every(isReviewFileIds)).toBe(true);
    expect(plan.scopes.flat().sort()).toEqual(ids.sort());
    const long = planReviewScopes(
      Array.from({ length: 100 }, (_, i) => `${String(i).padStart(4, '0')}${'x'.repeat(4000)}`),
      1,
    );
    expect(long.parallel).toBe(1);
    expect(long.scopes.every(isReviewFileIds)).toBe(true);
    expect(long.scopes.length).toBeGreaterThan(1);
    const escaped = planReviewScopes(
      Array.from({ length: 40 }, (_, i) => `${i}${'\u0001'.repeat(4000)}`),
      1,
    );
    expect(
      escaped.scopes.every((reviewFileIds) =>
        isAcpRequest('openAcpSession', { context, adapterId: 'a', reviewSessionId: 'r', reviewFileIds }),
      ),
    ).toBe(true);
  });
  it('does not put file signatures in prompts and rejects oversized instructions before launch', () => {
    expect(utf8Bytes(reviewShardPrompt('Check correctness'))).toBeLessThan(2048);
    expect(reviewShardPrompt('')).toContain('listChangedFiles');
    expect(() => reviewShardPrompt('x'.repeat(32 * 1024))).toThrow('Shorten repository promptInstructions');
    expect(() => planReviewScopes(['x'.repeat(4097)], 1)).toThrow('No agent was started');
  });
});
