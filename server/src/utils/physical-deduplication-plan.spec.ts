import { AssetStatus, PhysicalDeduplicationDecision, PhysicalDeduplicationSkipReason } from 'src/enum.js';
import {
  type PhysicalDeduplicationEvidenceRow,
  type PhysicalDeduplicationItemOutcome,
  type PhysicalDeduplicationStoredPlan,
  copyEvidenceProblem,
  currentReferences,
  emptyPhysicalDeduplicationResult,
  mergePhysicalDeduplicationItem,
  normalizeExcluded,
  parsePhysicalDeduplicationResult,
  parsePhysicalDeduplicationSnapshot,
  physicalDeduplicationByteAccounting,
  physicalDeduplicationConfirmation,
  physicalDeduplicationFingerprint,
  physicalDeduplicationPlanId,
  physicalDeduplicationPlanItems,
  physicalDeduplicationProgress,
  physicalDeduplicationReviewToken,
  planPhysicalDeduplicationRetry,
  retainedEvidenceProblem,
} from 'src/utils/physical-deduplication-plan.js';

const hex = 'aa'.repeat(20);

const retained = (assetId: string, referencesBefore = 1) => ({
  assetId,
  ownerId: 'taylor',
  originalPath: `/upload/taylor/${assetId}.jpg`,
  checksum: hex,
  sizeInBytes: 10,
  referencesBefore,
});

const copy = (assetId: string, retainedAssetId: string | null, overrides: Record<string, unknown> = {}) => ({
  assetId,
  ownerId: 'jamie',
  originalPath: `/upload/jamie/${assetId}.jpg`,
  checksum: hex,
  sizeInBytes: 10,
  retainedAssetId,
  decision: retainedAssetId ? PhysicalDeduplicationDecision.Share : PhysicalDeduplicationDecision.Skip,
  reason: retainedAssetId ? null : PhysicalDeduplicationSkipReason.NoRetainedMatch,
  ...overrides,
});

const plan = (overrides: Partial<PhysicalDeduplicationStoredPlan> = {}): PhysicalDeduplicationStoredPlan => ({
  mode: 'dry-run',
  ranAt: '2026-09-23T10:00:00.000Z',
  masterUserId: 'taylor',
  scopeUserId: null,
  eligibleAssets: 3,
  reclaimableBytes: 30,
  copiesTruncated: false,
  retained: [retained('lake'), retained('garden')],
  copies: [
    copy('lake-j', 'lake'),
    copy('lake-e', 'lake', { ownerId: 'emma' }),
    copy('garden-j', 'garden'),
    copy('trip-j', null),
    copy('shared-j', 'lake', {
      decision: PhysicalDeduplicationDecision.Skip,
      reason: PhysicalDeduplicationSkipReason.AlreadyShared,
    }),
  ],
  ...overrides,
});

const row = (
  id: string,
  overrides: Partial<PhysicalDeduplicationEvidenceRow> = {},
): PhysicalDeduplicationEvidenceRow => ({
  id,
  ownerId: 'jamie',
  originalPath: `/upload/jamie/${id}.jpg`,
  checksum: Buffer.from(hex, 'hex'),
  sizeInBytes: '10',
  deletedAt: null,
  status: AssetStatus.Active,
  isExternal: false,
  isOffline: false,
  libraryId: null,
  physicalOriginalFileId: null,
  ...overrides,
});

describe('physical deduplication plans (FL-73)', () => {
  describe('fingerprint', () => {
    it('is stable for the same evidence, whatever order the rows were stored in', () => {
      const reordered = plan({ copies: plan().copies!.toReversed(), retained: plan().retained!.toReversed() });
      expect(physicalDeduplicationFingerprint(reordered)).toBe(physicalDeduplicationFingerprint(plan()));
    });

    it.each([
      ['a new preview', { ranAt: '2026-09-23T11:00:00.000Z' }],
      ['another retained account', { masterUserId: 'jamie' }],
      ['another scope', { scopeUserId: 'emma' }],
      ['a copy checksum', { copies: [copy('lake-j', 'lake', { checksum: 'bb'.repeat(20) })] }],
      ['a copy path', { copies: [copy('lake-j', 'lake', { originalPath: '/elsewhere.jpg' })] }],
      ['a decision', { copies: [copy('lake-j', 'lake', { decision: PhysicalDeduplicationDecision.Skip })] }],
      ['a reference count', { retained: [retained('lake', 2), retained('garden')] }],
    ])('changes with %s', (_, overrides) => {
      expect(physicalDeduplicationFingerprint(plan(overrides as never))).not.toBe(
        physicalDeduplicationFingerprint(plan()),
      );
    });

    it('stays the same once the plan is applied, so its job can still be found by it', () => {
      expect(physicalDeduplicationFingerprint(plan({ mode: 'apply' }))).toBe(physicalDeduplicationFingerprint(plan()));
    });

    it('names the plan and the phrase that confirms it', () => {
      const fingerprint = physicalDeduplicationFingerprint(plan());
      const planId = physicalDeduplicationPlanId(fingerprint);
      expect(planId).toMatch(/^PD-[\dA-F]{8}$/);
      expect(planId).toBe(`PD-${fingerprint.slice(0, 8).toUpperCase()}`);
      expect(physicalDeduplicationConfirmation(planId)).toBe(`APPLY ${planId}`);
    });
  });

  describe('review token', () => {
    it('binds the decisions, in any order, to one plan', () => {
      const fingerprint = physicalDeduplicationFingerprint(plan());
      expect(physicalDeduplicationReviewToken('secret', fingerprint, ['garden', 'lake'])).toBe(
        physicalDeduplicationReviewToken('secret', fingerprint, ['lake', 'garden', 'lake']),
      );
      expect(physicalDeduplicationReviewToken('secret', fingerprint, ['lake'])).not.toBe(
        physicalDeduplicationReviewToken('secret', fingerprint, []),
      );
      expect(physicalDeduplicationReviewToken('secret', fingerprint, [])).not.toBe(
        physicalDeduplicationReviewToken('secret', 'ff'.repeat(32), []),
      );
    });

    it('cannot be made without the server secret', () => {
      const fingerprint = physicalDeduplicationFingerprint(plan());
      expect(physicalDeduplicationReviewToken('secret', fingerprint, [])).not.toBe(
        physicalDeduplicationReviewToken('another', fingerprint, []),
      );
    });

    it('normalizes the left-out groups', () => {
      expect(normalizeExcluded(['b', 'a', 'b'])).toEqual(['a', 'b']);
      expect(normalizeExcluded(undefined)).toEqual([]);
    });
  });

  describe('plan items', () => {
    it('are the copies the preview shares, with their evidence, and nothing it skipped', () => {
      const { items, retained: used } = physicalDeduplicationPlanItems(plan(), []);

      expect(items.map((item) => item.assetId)).toEqual(['lake-j', 'lake-e', 'garden-j']);
      expect(items[0]).toEqual({
        assetId: 'lake-j',
        ownerId: 'jamie',
        originalPath: '/upload/jamie/lake-j.jpg',
        checksum: hex,
        sizeInBytes: 10,
        retainedAssetId: 'lake',
        retainedPath: '/upload/taylor/lake.jpg',
        retainedChecksum: hex,
      });
      expect(used.map((item) => item.assetId)).toEqual(['lake', 'garden']);
    });

    it('leave out every copy of a group the administrator kept separate', () => {
      const { items, retained: used } = physicalDeduplicationPlanItems(plan(), ['lake']);

      expect(items.map((item) => item.assetId)).toEqual(['garden-j']);
      expect(used.map((item) => item.assetId)).toEqual(['garden']);
    });

    it('never include a copy whose retained original is not in the plan', () => {
      const { items } = physicalDeduplicationPlanItems(plan({ retained: [retained('garden')] }), []);
      expect(items.map((item) => item.assetId)).toEqual(['garden-j']);
    });
  });

  describe('byte accounting', () => {
    it('counts logical bytes per referencing asset and shared-original bytes once per file', () => {
      expect(
        physicalDeduplicationByteAccounting([
          // One original, its owner's asset and copies from two other owners: 3 × 10 logical, 10 on disk.
          { sizeInBytes: 10, referencesAfter: 3 },
          { sizeInBytes: 7, referencesAfter: 2 },
          // Nothing else would reference this one (its copies were skipped): not shared.
          { sizeInBytes: 1000, referencesAfter: 1 },
        ]),
      ).toEqual({ logicalBytes: 44, sharedOriginalBytes: 17 });
    });

    it('is zero for a plan that shares nothing', () => {
      expect(physicalDeduplicationByteAccounting([])).toEqual({ logicalBytes: 0, sharedOriginalBytes: 0 });
    });
  });

  describe('evidence', () => {
    const item = physicalDeduplicationPlanItems(plan(), []).items[0];
    const original = { ...retained('lake') };
    const retainedRow = row('lake', { ownerId: 'taylor', originalPath: '/upload/taylor/lake.jpg' });

    it('accepts a retained original that is still what was reviewed', () => {
      expect(retainedEvidenceProblem(original, retainedRow, 'taylor')).toBeNull();
    });

    it.each([
      ['missing', undefined],
      ['trashed', { ...retainedRow, deletedAt: new Date() }],
      ['in another account', { ...retainedRow, ownerId: 'jamie' }],
      ['moved', { ...retainedRow, originalPath: '/moved.jpg' }],
      ['re-encoded', { ...retainedRow, checksum: Buffer.from('bb'.repeat(20), 'hex') }],
      ['resized', { ...retainedRow, sizeInBytes: 11 }],
      ['in an external library', { ...retainedRow, isExternal: true }],
      ['offline', { ...retainedRow, isOffline: true }],
    ])('refuses a retained original that is %s', (_, value) => {
      expect(retainedEvidenceProblem(original, value as PhysicalDeduplicationEvidenceRow, 'taylor')).toBe(
        'retained-changed',
      );
    });

    it('accepts a copy that is still what was reviewed', () => {
      expect(copyEvidenceProblem(item, row('lake-j'), retainedRow)).toEqual({ reason: null, alreadyShared: false });
    });

    it.each([
      ['missing', undefined],
      ['trashed', row('lake-j', { deletedAt: new Date(), status: AssetStatus.Trashed })],
      ['in another account', row('lake-j', { ownerId: 'emma' })],
      ['moved', row('lake-j', { originalPath: '/moved.jpg' })],
      ['different bytes', row('lake-j', { checksum: Buffer.from('bb'.repeat(20), 'hex') })],
    ])('refuses a copy that is %s', (_, value) => {
      expect(copyEvidenceProblem(item, value, retainedRow).reason).toBe('copy-changed');
    });

    it('recognises a copy an earlier attempt already linked', () => {
      const linkedRetained = { ...retainedRow, physicalOriginalFileId: 'pf-1' };
      const linked = row('lake-j', { physicalOriginalFileId: 'pf-1', originalPath: '/upload/taylor/lake.jpg' });
      expect(copyEvidenceProblem(item, linked, linkedRetained)).toEqual({ reason: null, alreadyShared: true });
    });

    it('counts references the way the preview does', () => {
      expect(currentReferences(retainedRow, new Map())).toBe(1);
      const linked = { ...retainedRow, physicalOriginalFileId: 'pf-1' };
      expect(currentReferences(linked, new Map([['pf-1', 3]]))).toBe(3);
      expect(currentReferences(linked, new Map())).toBe(1);
    });
  });

  describe('snapshot', () => {
    const snapshot = {
      version: 1,
      planId: 'PD-ABCDEF12',
      fingerprint: 'ab'.repeat(32),
      reviewToken: 'cd'.repeat(32),
      ranAt: '2026-09-23T10:00:00.000Z',
      masterUserId: 'taylor',
      scopeUserId: null,
      excludedRetainedAssetIds: ['garden'],
      items: physicalDeduplicationPlanItems(plan(), ['garden']).items,
      retained: physicalDeduplicationPlanItems(plan(), ['garden']).retained,
      estimatedBytes: 20,
    };

    it('reads back what apply froze', () => {
      expect(parsePhysicalDeduplicationSnapshot(snapshot)).toEqual(snapshot);
    });

    it.each([
      ['missing', null],
      ['another version', { ...snapshot, version: 2 }],
      ['without copies', { ...snapshot, items: undefined }],
      ['with a malformed copy', { ...snapshot, items: [{ assetId: 'lake-j' }] }],
    ])('fails the job rather than guess when %s', (_, value) => {
      expect(() => parsePhysicalDeduplicationSnapshot(value)).toThrow();
    });
  });

  describe('result', () => {
    const outcome = (id: string, state: PhysicalDeduplicationItemOutcome['state'], reclaimedBytes = 0) => ({
      id,
      state,
      reasonKey: state === 'skipped' ? ('copy-changed' as const) : null,
      message: null,
      reclaimedBytes,
      at: '2026-09-23T10:00:00.000Z',
    });

    it('keeps one outcome per copy and totals what was actually removed', () => {
      let result = emptyPhysicalDeduplicationResult();
      result = mergePhysicalDeduplicationItem(result, outcome('a', 'applied', 10));
      result = mergePhysicalDeduplicationItem(result, outcome('b', 'failed'));
      result = mergePhysicalDeduplicationItem(result, outcome('c', 'skipped'));
      result = mergePhysicalDeduplicationItem(result, outcome('b', 'already-applied', 5));

      expect(result.items.map((item) => [item.id, item.state])).toEqual([
        ['a', 'applied'],
        ['c', 'skipped'],
        ['b', 'already-applied'],
      ]);
      expect(result.summary).toEqual({ applied: 1, alreadyApplied: 1, skipped: 1, failed: 0, reclaimedBytes: 15 });
    });

    it('retries failed copies once, never skipped ones, and never plans a second retry', () => {
      let result = emptyPhysicalDeduplicationResult();
      result = mergePhysicalDeduplicationItem(result, outcome('a', 'failed'));
      result = mergePhysicalDeduplicationItem(result, outcome('b', 'skipped'));

      const planned = planPhysicalDeduplicationRetry(result);
      expect(planned?.retry).toEqual({ ids: ['a'], processed: 0 });
      expect(planPhysicalDeduplicationRetry(planned!)).toBeNull();
      const clean = mergePhysicalDeduplicationItem(emptyPhysicalDeduplicationResult(), outcome('c', 'applied'));
      expect(planPhysicalDeduplicationRetry(clean)).toBeNull();
    });

    it('reads a stored result leniently and recounts its summary', () => {
      const parsed = parsePhysicalDeduplicationResult({
        items: [outcome('a', 'applied', 10), { id: 'b', state: 'nonsense' }, 'junk'],
        retry: { ids: ['b', 3], processed: 1 },
        summary: { applied: 99 },
      });

      expect(parsed.items.map((item) => [item.id, item.state])).toEqual([
        ['a', 'applied'],
        ['b', 'failed'],
      ]);
      expect(parsed.retry).toEqual({ ids: ['b'], processed: 1 });
      expect(parsed.summary).toEqual({ applied: 1, alreadyApplied: 0, skipped: 0, failed: 1, reclaimedBytes: 10 });
      expect(parsePhysicalDeduplicationResult(null)).toEqual(emptyPhysicalDeduplicationResult());
    });

    it('reports progress from the copies done', () => {
      expect(physicalDeduplicationProgress(0, 4)).toBe(0);
      expect(physicalDeduplicationProgress(1, 3)).toBe(33.33);
      expect(physicalDeduplicationProgress(4, 4)).toBe(100);
      expect(physicalDeduplicationProgress(0, 0)).toBe(100);
    });
  });
});
