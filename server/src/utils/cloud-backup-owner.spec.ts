import type { CloudBackupManifest } from 'src/utils/cloud-backup.js';
import { ownerBackupHistoryPage } from 'src/utils/cloud-backup-owner.js';
import { authStub } from 'test/fixtures/auth.stub.js';

const own = authStub.user1.user.id;
const details = { visibility: 'timeline' };
const manifest = (assets: Record<string, unknown>) =>
  ({ version: 2, createdAt: '2026-09-01T00:00:00Z', assets }) as CloudBackupManifest;
const sha = 'a'.repeat(64);
const asset = (owner: string | null = own, extra = {}) => ({
  owner,
  details,
  originalFileName: 'own.jpg',
  files: [{ role: 'original', sha256: sha }],
  ...extra,
});
const deletion = (extra = {}) => ({
  ownerId: own,
  deletedAt: new Date('2026-09-03T00:00:00Z'),
  visibility: 'timeline',
  wasLocked: false,
  checksum: Buffer.from(sha, 'hex'),
  checksumAlgorithm: 'sha256',
  evidenceVersion: 1,
  modernPrivacyEvidenceUnavailable: true,
  ...extra,
});
const captured = (...ids: string[]) => new Map(ids.map((id) => [id, { deletion: deletion() }]));
const page = { limit: 1, offset: 0 };

describe('owner backup history projection', () => {
  it('filters foreign/unknown/private names before query, count and pagination', () => {
    const result = ownerBackupHistoryPage(
      authStub.user1,
      manifest({
        a: asset(),
        b: asset('foreign'),
        c: asset(null),
        d: asset(own, { details: undefined }),
        e: asset(own, { details: { visibility: 'locked' } }),
      }),
      captured('a', 'b', 'c', 'd', 'e'),
      page,
    );
    expect(result.total).toBe(1);
    expect(result.items.map((i) => i.assetId)).toEqual(['a']);
    expect(JSON.stringify(result)).not.toContain('foreign');
    expect(
      ownerBackupHistoryPage(
        authStub.user1,
        manifest({ b: asset('foreign', { originalFileName: 'secret.jpg' }) }),
        new Map(),
        { ...page, query: 'secret' },
      ).total,
    ).toBe(0);
  });
  it('refuses absent capture, checksum/algorithm/owner mismatches and post-backup locks', () => {
    const data = manifest({ a: asset() });
    expect(ownerBackupHistoryPage(authStub.user1, data, new Map(), page).total).toBe(0);
    for (const change of [
      { ownerId: 'foreign' },
      { checksum: Buffer.alloc(32) },
      { checksumAlgorithm: 'sha1' },
      { wasLocked: true },
      { visibility: 'hidden' },
      { evidenceVersion: 0 },
    ]) {
      expect(
        ownerBackupHistoryPage(authStub.user1, data, new Map([['a', { deletion: deletion(change) }]]), page).total,
      ).toBe(0);
    }
    expect(
      ownerBackupHistoryPage(
        { ...authStub.user1, session: { ...authStub.user1.session!, hasElevatedPermission: true } },
        data,
        new Map([['a', { deletion: deletion({ wasLocked: true }) }]]),
        page,
      ).total,
    ).toBe(1);
  });

  it('returns and searches only the filename, never a raw original path', () => {
    const data = manifest({ a: asset(own, { originalFileName: '/private/library/own.jpg' }) });
    expect(ownerBackupHistoryPage(authStub.user1, data, captured('a'), page).items[0].name).toBe('own.jpg');
    expect(ownerBackupHistoryPage(authStub.user1, data, captured('a'), { ...page, query: 'private' }).total).toBe(0);
  });
  it('requires historical details and fails closed for active filters, without inventing evidence', () => {
    expect(
      ownerBackupHistoryPage(authStub.user1, { ...manifest({ a: asset() }), version: 1 }, new Map(), page).total,
    ).toBe(0);
    expect(
      ownerBackupHistoryPage({ ...authStub.user1, hideNsfwAssets: true }, manifest({ a: asset() }), new Map(), page)
        .total,
    ).toBe(0);
  });
  it('refuses existing foreign/revoked library or current privacy rows even if snapshot owner matches', () => {
    const states = new Map([
      ['a', { ownerId: 'foreign', allowed: false }],
      ['b', { ownerId: own, allowed: false }],
    ]);
    expect(
      ownerBackupHistoryPage(authStub.user1, manifest({ a: asset(), b: asset() }), states as never, page).total,
    ).toBe(0);
  });
  it('preserves known trash/physical dates and explicitly unknown old dates with deterministic pages', () => {
    const states = new Map([
      ['b', { ownerId: own, allowed: true, deletedAt: new Date('2026-09-02Z'), status: 'trashed' }],
      ['c', { deletion: deletion() }],
    ]);
    const data = manifest({ c: asset(), b: asset(), a: asset() });
    states.set('a', { ownerId: own, allowed: true, deletedAt: new Date('2026-09-01T00:00:00Z'), status: 'trashed' });
    const first = ownerBackupHistoryPage(authStub.user1, data, states as never, page);
    expect(first.items[0]).toMatchObject({
      assetId: 'a',
      deletionDate: { state: 'unavailable', at: null },
      trashDate: '2026-09-01T00:00:00.000Z',
    });
    expect(first.nextOffset).toBe(1);
    const second = ownerBackupHistoryPage(authStub.user1, data, states as never, { ...page, offset: 1 });
    expect(second.items[0].trashDate).toBe('2026-09-02T00:00:00.000Z');
    const third = ownerBackupHistoryPage(authStub.user1, data, states as never, { ...page, offset: 2 });
    expect(third.items[0].deletionDate).toEqual({ state: 'available', at: '2026-09-03T00:00:00.000Z' });
    expect(third.nextOffset).toBeNull();
  });
});
