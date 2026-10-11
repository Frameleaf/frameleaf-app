import { describe, expect, it } from 'vitest';
import { journalOwnsPath } from 'src/utils/studio-import-reference-roles.js';
import { KEY, PREPARED } from 'test/fixtures/studio-import-retention.js';

describe('journal path ownership roles', () => {
  it.each(['registered', 'preparing', 'published', 'aborted'] as const)('counts exact %s roles', (state) => {
    const row = { ...KEY, state, createdAt: new Date(0), expiresAt: new Date(21_600_000), file: PREPARED };
    expect(journalOwnsPath(row, PREPARED.stagedPath)).toBe(state !== 'registered');
    expect(journalOwnsPath(row, PREPARED.targetPath)).toBe(state === 'preparing' || state === 'aborted');
    expect(journalOwnsPath(row, PREPARED.stagedPath + '.foreign')).toBe(false);
    expect(journalOwnsPath({ ...row, file: null }, PREPARED.stagedPath)).toBe(false);
  });
});
