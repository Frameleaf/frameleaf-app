import { createHash } from 'node:crypto';
import { ReconciliationBucketSchema, ReconciliationStartSchema } from 'src/dtos/backup-device.dto.js';
import {
  assertInventoryUnchanged,
  bucketInventory,
  hashBucket,
  requireReconciliationScope,
  startProgress,
  validateBucket,
} from 'src/utils/backup-reconciliation.js';
import { emptyHiddenContentFilter } from 'src/utils/hidden-content.js';
import { factory } from 'test/small.factory.js';

const a = '01' + 'a'.repeat(62),
  b = '01' + 'b'.repeat(62),
  c = '02' + 'c'.repeat(62);
describe('device reconciliation trust boundaries', () => {
  it('hashes sorted raw bytes independently and treats inputs as a set', () => {
    const expected = createHash('sha256')
      .update(Buffer.from(a + b, 'hex'))
      .digest('hex');
    expect(hashBucket([b, a, a])).toEqual({ count: 2, digest: expected });
    expect(hashBucket([])).toEqual({
      count: 0,
      digest: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    });
  });
  it('refuses malformed server identities rather than interpreting them as bytes', () => {
    expect(() => hashBucket(['bad'])).toThrow();
  });
  it('identical sets have no differing buckets and counts match', () => {
    const buckets = bucketInventory([a, b, c]);
    expect(startProgress({ buckets }, buckets).differing).toEqual([]);
  });
  it('a server superset differs but validates the smaller device set', () => {
    const progress = startProgress({ buckets: bucketInventory([a]) }, bucketInventory([a, b]));
    expect(progress.differing).toEqual([1]);
    expect(validateBucket({ bucket: 1, hashes: [a] }, progress)).toEqual({ bucket: 1, hashes: [a] });
  });
  it('same digest with a forged count is refused', () => {
    const server = bucketInventory([a]);
    const buckets = structuredClone(server);
    buckets[1].count = 2;
    expect(() => startProgress({ buckets }, server)).toThrow('Digest/count');
  });
  it.each([
    { bucket: 1, hashes: [a, a] },
    { bucket: 1, hashes: [c] },
    { bucket: 1, hashes: [b] },
    { bucket: 1, hashes: [] },
    { bucket: 2, hashes: [a] },
    { bucket: 256, hashes: [a] },
    { bucket: 1, hashes: ['malformed'] },
  ])('refuses invalid followup $hashes', (input) => {
    const progress = startProgress({ buckets: bucketInventory([a]) }, bucketInventory([]));
    expect(() => validateBucket(input, progress)).toThrow();
  });
  it('refuses a changed server snapshot instead of finalizing stale all-present evidence', () => {
    const progress = startProgress({ buckets: bucketInventory([a]) }, bucketInventory([a, b]));
    expect(() => assertInventoryUnchanged(progress, bucketInventory([a]))).toThrow('inventory changed');
    expect(() => assertInventoryUnchanged(progress, bucketInventory([a, b]))).not.toThrow();
  });
  it('requires256 bounded digests and bounded complete bucket lists', () => {
    expect(ReconciliationStartSchema.safeParse({ buckets: bucketInventory([]).slice(1) }).success).toBe(false);
    const buckets = bucketInventory([]);
    buckets[0].count = 2001;
    expect(ReconciliationStartSchema.safeParse({ buckets }).success).toBe(false);
    expect(
      ReconciliationBucketSchema.safeParse({ bucket: 1, hashes: Array.from({ length: 2001 }, () => a) }).success,
    ).toBe(false);
  });
  it('allows only current elevated unfiltered session, never admin bypass', () => {
    const elevated = factory.auth({ session: { hasElevatedPermission: true } });
    expect(() => requireReconciliationScope(elevated)).not.toThrow();
    expect(() => requireReconciliationScope(factory.auth())).toThrow('elevated');
    expect(() => requireReconciliationScope({ ...elevated, hideNsfwAssets: true })).toThrow();
    for (const patch of [{ includeNsfw: true }, { tagIds: ['tag'] }, { personIds: ['person'] }, { petIds: ['pet'] }]) {
      expect(() =>
        requireReconciliationScope({
          ...elevated,
          hiddenContent: { ...emptyHiddenContentFilter(elevated.user.id), ...patch },
        }),
      ).toThrow();
    }
    expect(() =>
      requireReconciliationScope({ ...elevated, hiddenContent: emptyHiddenContentFilter(elevated.user.id) }),
    ).not.toThrow();
  });
});
