import {
  AssetTypeEnum,
  MediaOperationStatus,
  PhysicalDeduplicationDecision,
  PhysicalDeduplicationPlanMode,
  PhysicalDeduplicationSkipReason,
  type PhysicalDeduplicationApplyDto,
  type PhysicalDeduplicationCopyDto,
  type PhysicalDeduplicationPlanDto,
  type PhysicalDeduplicationRetainedDto,
  type PhysicalDeduplicationReviewResponseDto,
  PhysicalDeduplicationCopyFile,
  PhysicalDeduplicationRetainedFile,
} from '@immich/sdk';
import { describe, expect, it } from 'vitest';
import {
  applyBlockedReason,
  applyForPlan,
  applyStatusKey,
  blocksReview,
  canVerifyApply,
  checksumAlgorithmKey,
  confirmationPhrase,
  DEDUP_SCOPE_ALL,
  dedupConfigurationError,
  formatBytes,
  groupPlanCopies,
  isApplyActive,
  isDecidableGroup,
  matchesConfirmation,
  mediaDetail,
  planMetrics,
  planSelection,
  planStaleReason,
  reviewExport,
  reviewMatches,
  skipReasonKey,
  undoKey,
  verificationItemKey,
} from '$lib/frameleaf/physical-dedup';

const retained = (overrides: Partial<PhysicalDeduplicationRetainedDto> = {}): PhysicalDeduplicationRetainedDto => ({
  assetId: 'master-1',
  ownerId: 'taylor',
  ownerName: 'Taylor',
  canView: true,
  originalFileName: 'Moraine Lake.jpg',
  originalPath: '/upload/library/taylor/master-1.jpg',
  type: AssetTypeEnum.Image,
  sizeInBytes: 14_850_240,
  checksum: 'a'.repeat(40),
  referencesBefore: 1,
  referencesAfter: 3,
  hiddenCopies: 0,
  fileAvailable: true,
  width: 6000,
  height: 4000,
  duration: null,
  ...overrides,
});

const copy = (overrides: Partial<PhysicalDeduplicationCopyDto> = {}): PhysicalDeduplicationCopyDto => ({
  assetId: 'copy-1',
  ownerId: 'jamie',
  ownerName: 'Jamie',
  canView: false,
  originalFileName: 'Moraine Lake.jpg',
  originalPath: '/upload/library/jamie/copy-1.jpg',
  type: AssetTypeEnum.Image,
  sizeInBytes: 14_850_240,
  checksum: 'a'.repeat(40),
  retainedAssetId: 'master-1',
  checksumMatch: true,
  decision: PhysicalDeduplicationDecision.Share,
  reason: null,
  width: 6000,
  height: 4000,
  duration: null,
  ...overrides,
});

const plan = (overrides: Partial<PhysicalDeduplicationPlanDto> = {}): PhysicalDeduplicationPlanDto => ({
  mode: PhysicalDeduplicationPlanMode.DryRun,
  ranAt: '2026-09-22T12:00:00.000Z',
  masterUserId: 'taylor',
  masterUserName: 'Taylor',
  scopeUserId: null,
  scopeUserName: null,
  eligibleAssets: 2,
  linkedAssets: 0,
  skippedExternal: 1,
  skippedMissingMaster: 1,
  reclaimableBytes: 14_850_240 * 2,
  deletedBytes: 0,
  logicalBytes: 14_850_240 * 3,
  sharedOriginalBytes: 14_850_240,
  retained: [retained()],
  copies: [
    copy(),
    copy({ assetId: 'copy-2', ownerId: 'emma', ownerName: 'Emma' }),
    copy({
      assetId: 'trail',
      originalFileName: 'Mountain trail.jpg',
      checksum: 'd'.repeat(40),
      retainedAssetId: null,
      checksumMatch: false,
      decision: PhysicalDeduplicationDecision.Skip,
      reason: PhysicalDeduplicationSkipReason.NoRetainedMatch,
    }),
    copy({
      assetId: 'external',
      originalFileName: 'Archive.jpg',
      checksum: 'e'.repeat(40),
      retainedAssetId: null,
      checksumMatch: false,
      decision: PhysicalDeduplicationDecision.Skip,
      reason: PhysicalDeduplicationSkipReason.ExternalLibrary,
    }),
    copy({
      assetId: 'shared',
      ownerId: 'emma',
      ownerName: 'Emma',
      decision: PhysicalDeduplicationDecision.Skip,
      reason: PhysicalDeduplicationSkipReason.AlreadyShared,
    }),
  ],
  copiesTruncated: false,
  planId: 'PD-ABABABAB',
  fingerprint: 'ab'.repeat(32),
  applicableCopies: 2,
  hiddenCopies: 0,
  ...overrides,
});

const apply = (overrides: Partial<PhysicalDeduplicationApplyDto> = {}): PhysicalDeduplicationApplyDto => ({
  operationId: 'operation-1',
  planId: 'PD-ABABABAB',
  fingerprint: 'ab'.repeat(32),
  status: MediaOperationStatus.Rendering,
  requestedById: 'taylor',
  requestedByName: 'Taylor',
  mine: true,
  retrying: false,
  pauseRequested: false,
  total: 2,
  processed: 1,
  progress: 50,
  applied: 1,
  alreadyApplied: 0,
  skipped: 0,
  failed: 0,
  estimatedBytes: 20,
  reclaimedBytes: 10,
  error: null,
  createdAt: '2026-09-22T12:05:00.000Z',
  finishedAt: null,
  ...overrides,
});

const review = (
  overrides: Partial<PhysicalDeduplicationReviewResponseDto> = {},
): PhysicalDeduplicationReviewResponseDto => ({
  planId: 'PD-ABABABAB',
  fingerprint: 'ab'.repeat(32),
  reviewToken: 'cd'.repeat(32),
  confirmation: 'APPLY PD-ABABABAB',
  excludedRetainedAssetIds: [],
  copies: 2,
  retainedOriginals: 1,
  estimatedBytes: 14_850_240 * 2,
  hiddenCopies: 0,
  reviewedAt: '2026-09-22T12:01:00.000Z',
  ...overrides,
});

describe('Frameleaf physical deduplication helpers', () => {
  describe(groupPlanCopies.name, () => {
    it('groups copies per retained original and unmatched copies by checksum, sharing groups first', () => {
      const groups = groupPlanCopies(plan());

      expect(groups.map((group) => group.key)).toEqual([
        'retained:master-1',
        `unmatched:${'e'.repeat(40)}`,
        `unmatched:${'d'.repeat(40)}`,
      ]);
      expect(groups[0].retained?.assetId).toBe('master-1');
      expect(groups[0].copies.map((item) => item.assetId)).toEqual(['copy-1', 'copy-2', 'shared']);
      expect(groups[0].shares).toBe(2);
      expect(groups[0].reclaimableBytes).toBe(14_850_240 * 2);
      expect(groups[1].retained).toBeNull();
      expect(groups[1].shares).toBe(0);
    });

    it('keeps a matched group whose copies are all skipped after the sharing groups', () => {
      const groups = groupPlanCopies(
        plan({
          copies: [
            copy({
              assetId: 'only-shared',
              decision: PhysicalDeduplicationDecision.Skip,
              reason: PhysicalDeduplicationSkipReason.AlreadyShared,
            }),
            copy({
              assetId: 'other',
              retainedAssetId: 'master-2',
              originalFileName: 'Zebra.jpg',
            }),
          ],
          retained: [retained(), retained({ assetId: 'master-2', originalFileName: 'Zebra.jpg' })],
        }),
      );

      expect(groups.map((group) => group.key)).toEqual(['retained:master-2', 'retained:master-1']);
    });
  });

  describe(planMetrics.name, () => {
    it('derives the four headline numbers and keeps the byte figures apart (FL-73)', () => {
      expect(planMetrics(plan())).toEqual({
        copiesToShare: 2,
        retainedOriginals: 1,
        reclaimableBytes: 14_850_240 * 2,
        skippedCopies: 3,
        logicalBytes: 14_850_240 * 3,
        sharedOriginalBytes: 14_850_240,
        measuredReclaimedBytes: null,
      });
    });

    it('reports measured bytes from the apply, or from the plan once applied', () => {
      expect(planMetrics(plan(), apply({ reclaimedBytes: 42 })).measuredReclaimedBytes).toBe(42);
      expect(
        planMetrics(plan({ mode: PhysicalDeduplicationPlanMode.Apply, deletedBytes: 7 })).measuredReclaimedBytes,
      ).toBe(7);
    });
  });

  describe(dedupConfigurationError.name, () => {
    const accountIds = ['taylor', 'jamie'];

    it('asks to enable file reuse first (UT-23)', () => {
      expect(dedupConfigurationError({ enabled: false, masterUserId: 'taylor', accountIds })).toBe('disabled');
    });

    it('asks for an account to retain shared originals in', () => {
      expect(dedupConfigurationError({ enabled: true, masterUserId: null, accountIds })).toBe('no-master');
      // A saved account that no longer exists (deleted master) is not an account to retain originals in.
      expect(dedupConfigurationError({ enabled: true, masterUserId: 'deleted', accountIds })).toBe('no-master');
    });

    it('is null once file reuse is on and the account exists', () => {
      expect(dedupConfigurationError({ enabled: true, masterUserId: 'jamie', accountIds })).toBeNull();
    });
  });

  describe(mediaDetail.name, () => {
    it('writes a photo as its pixel dimensions (UT-25)', () => {
      expect(mediaDetail({ type: AssetTypeEnum.Image, width: 6000, height: 4000 })).toBe('6000 × 4000');
    });

    it('writes a video as its length and resolution', () => {
      expect(mediaDetail({ type: AssetTypeEnum.Video, width: 3840, height: 2160, duration: 72_000 })).toBe('1:12 · 4K');
      expect(mediaDetail({ type: AssetTypeEnum.Video, width: 1080, height: 1920, duration: 3_725_000 })).toBe(
        '1:02:05 · 1080p',
      );
    });

    it('is empty when nothing is recorded', () => {
      expect(mediaDetail({ type: AssetTypeEnum.Image, width: null, height: null })).toBe('');
      expect(mediaDetail({ type: AssetTypeEnum.Video, duration: null })).toBe('');
    });
  });

  describe('verification (FL-73)', () => {
    const item = {
      retainedFile: PhysicalDeduplicationRetainedFile.Intact,
      linked: true,
      restored: false,
      copyFile: PhysicalDeduplicationCopyFile.Removed,
      restorable: false,
    };

    it('verifies only a finished apply that changed something', () => {
      expect(canVerifyApply(apply({ status: MediaOperationStatus.Completed }))).toBe(true);
      expect(canVerifyApply(apply({ status: MediaOperationStatus.Cancelled, applied: 0, alreadyApplied: 1 }))).toBe(
        true,
      );
      expect(canVerifyApply(apply({ status: MediaOperationStatus.Rendering }))).toBe(false);
      expect(canVerifyApply(apply({ status: MediaOperationStatus.Failed, applied: 0 }))).toBe(false);
    });

    it('names each copy result, most serious first', () => {
      expect(verificationItemKey(item)).toBe('frameleaf_dedup_verify_item_verified');
      expect(verificationItemKey({ ...item, retainedFile: PhysicalDeduplicationRetainedFile.Missing })).toBe(
        'frameleaf_dedup_verify_item_retained_missing',
      );
      expect(verificationItemKey({ ...item, retainedFile: PhysicalDeduplicationRetainedFile.Changed })).toBe(
        'frameleaf_dedup_verify_item_retained_changed',
      );
      expect(verificationItemKey({ ...item, linked: false })).toBe('frameleaf_dedup_verify_item_not_linked');
      expect(verificationItemKey({ ...item, linked: false, restored: true })).toBe(
        'frameleaf_dedup_verify_item_restored',
      );
    });

    it('says plainly what can be undone', () => {
      expect(undoKey(item)).toBe('frameleaf_dedup_undo_removed');
      expect(undoKey({ ...item, copyFile: PhysicalDeduplicationCopyFile.Present, restorable: true })).toBe(
        'frameleaf_dedup_undo_restorable',
      );
      expect(undoKey({ ...item, copyFile: PhysicalDeduplicationCopyFile.Changed })).toBe(
        'frameleaf_dedup_undo_changed',
      );
      expect(undoKey({ ...item, restored: true, copyFile: PhysicalDeduplicationCopyFile.Present })).toBe(
        'frameleaf_dedup_undo_restored',
      );
    });
  });

  describe('per-group decisions (FL-73)', () => {
    it('offers a decision only for groups that would share a retained original', () => {
      const groups = groupPlanCopies(plan());
      expect(groups.map((group) => isDecidableGroup(group))).toEqual([true, false, false]);
    });

    it('counts what the plan applies with the groups left as they are', () => {
      expect(planSelection(plan(), new Set())).toEqual({
        copies: 2,
        hiddenCopies: 0,
        listedBytes: 14_850_240 * 2,
        keptGroups: 0,
      });
      expect(planSelection(plan(), new Set(['master-1']))).toEqual({
        copies: 0,
        hiddenCopies: 0,
        listedBytes: 0,
        keptGroups: 1,
      });
    });

    it('includes the copies it cannot list because they are Locked media of another account', () => {
      expect(planSelection(plan({ applicableCopies: 5 }), new Set())).toEqual({
        copies: 5,
        hiddenCopies: 3,
        listedBytes: 14_850_240 * 2,
        keptGroups: 0,
      });
    });

    it('leaves out the unlisted copies of a group left out, with the group', () => {
      const current = plan({
        applicableCopies: 5,
        retained: [retained({ hiddenCopies: 2 })],
      });
      expect(planSelection(current, new Set(['master-1']))).toEqual({
        copies: 1,
        hiddenCopies: 1,
        listedBytes: 0,
        keptGroups: 1,
      });
    });

    it('ignores a left-out id that is not a group of this plan', () => {
      expect(planSelection(plan(), new Set(['elsewhere'])).keptGroups).toBe(0);
    });

    it('treats a review as current only for this plan with these decisions', () => {
      expect(reviewMatches(review(), plan(), [])).toBe(true);
      expect(reviewMatches(review({ excludedRetainedAssetIds: ['master-1'] }), plan(), ['master-1'])).toBe(true);
      expect(reviewMatches(review(), plan(), ['master-1'])).toBe(false);
      expect(reviewMatches(review(), plan({ fingerprint: 'ff'.repeat(32) }), [])).toBe(false);
      expect(reviewMatches(null, plan(), [])).toBe(false);
    });
  });

  describe('plan name and confirmation', () => {
    it('accepts only the exact phrase, ignoring surrounding whitespace', () => {
      const current = plan();
      expect(confirmationPhrase(current)).toBe('APPLY PD-ABABABAB');
      expect(matchesConfirmation(current, ` ${confirmationPhrase(current)} `)).toBe(true);
      expect(matchesConfirmation(current, confirmationPhrase(current).toLowerCase())).toBe(false);
      expect(matchesConfirmation(current, '')).toBe(false);
    });
  });

  describe(planStaleReason.name, () => {
    it('is null when the toolbar still matches the plan', () => {
      expect(planStaleReason(plan(), { scope: DEDUP_SCOPE_ALL, masterUserId: 'taylor' })).toBeNull();
      expect(planStaleReason(plan({ scopeUserId: 'emma' }), { scope: 'emma', masterUserId: 'taylor' })).toBeNull();
    });

    it('reports a changed scan scope before a changed retained account', () => {
      expect(planStaleReason(plan(), { scope: 'emma', masterUserId: 'jamie' })).toBe('scope');
      expect(planStaleReason(plan({ scopeUserId: 'emma' }), { scope: DEDUP_SCOPE_ALL, masterUserId: 'taylor' })).toBe(
        'scope',
      );
      expect(planStaleReason(plan(), { scope: DEDUP_SCOPE_ALL, masterUserId: 'jamie' })).toBe('master');
    });

    it('does not call a plan stale when no retained account is selected yet', () => {
      expect(planStaleReason(plan(), { scope: DEDUP_SCOPE_ALL, masterUserId: null })).toBeNull();
    });
  });

  describe(applyBlockedReason.name, () => {
    const allowed = {
      plan: plan(),
      enabled: true,
      savedMasterUserId: 'taylor',
      running: false,
      applying: false,
      applied: false,
      selectedCopies: 2,
    };

    it('allows applying a preview prepared for the saved retained account', () => {
      expect(applyBlockedReason(allowed)).toBeNull();
    });

    it('blocks while a job runs, after an apply, when disabled, without a saved account, and on a mismatch', () => {
      expect(applyBlockedReason({ ...allowed, running: true })).toBe('running');
      expect(applyBlockedReason({ ...allowed, plan: plan({ mode: PhysicalDeduplicationPlanMode.Apply }) })).toBe(
        'applied',
      );
      expect(applyBlockedReason({ ...allowed, enabled: false })).toBe('disabled');
      expect(applyBlockedReason({ ...allowed, savedMasterUserId: null })).toBe('no-saved-master');
      expect(applyBlockedReason({ ...allowed, savedMasterUserId: 'jamie' })).toBe('master-mismatch');
      expect(applyBlockedReason({ ...allowed, selectedCopies: 0 })).toBe('no-shares');
    });

    it('blocks while any plan is being applied, and once this plan was applied (FL-73)', () => {
      expect(applyBlockedReason({ ...allowed, applying: true })).toBe('applying');
      expect(applyBlockedReason({ ...allowed, applied: true })).toBe('applied');
    });

    it('still lets a preview for a page-chosen account be reviewed, but not applied', () => {
      const reason = applyBlockedReason({ ...allowed, savedMasterUserId: null });
      expect(reason).toBe('no-saved-master');
      expect(blocksReview(reason)).toBe(false);
      expect(blocksReview('applying')).toBe(true);
      expect(blocksReview('no-shares')).toBe(true);
    });

    it('never lets a page-chosen retained account stand in for the saved one', () => {
      // The preview was prepared against Jamie on the page; nothing is saved.
      expect(
        applyBlockedReason({
          plan: plan({ masterUserId: 'jamie' }),
          enabled: true,
          savedMasterUserId: null,
          running: false,
          applying: false,
          applied: false,
          selectedCopies: 2,
        }),
      ).toBe('no-saved-master');
    });
  });

  describe(formatBytes.name, () => {
    it('formats with binary units', () => {
      expect(formatBytes(14_850_240, 'en-US')).toBe('14.2 MiB');
      expect(formatBytes(428_600_320 * 4, 'en-US')).toBe('1.60 GiB');
      expect(formatBytes(2048, 'en-US')).toBe('2 KiB');
      expect(formatBytes(12, 'en-US')).toBe('12 B');
    });
  });

  describe(skipReasonKey.name, () => {
    it('maps every server reason to a translation key', () => {
      for (const reason of Object.values(PhysicalDeduplicationSkipReason)) {
        expect(skipReasonKey(reason)).toMatch(/^frameleaf_dedup_reason_/);
      }
      expect(skipReasonKey(null)).toBe('frameleaf_dedup_reason_no_retained_match');
    });
  });

  describe('applied plans (FL-73)', () => {
    it('finds the newest job applying the plan on screen', () => {
      const applies = [apply(), apply({ operationId: 'older', status: MediaOperationStatus.Failed })];
      expect(applyForPlan(applies, plan())?.operationId).toBe('operation-1');
      expect(applyForPlan(applies, plan({ fingerprint: 'ff'.repeat(32) }))).toBeNull();
      expect(applyForPlan(applies, null)).toBeNull();
    });

    it('reads every job state the way Activity does', () => {
      expect(isApplyActive(apply())).toBe(true);
      expect(isApplyActive(apply({ status: MediaOperationStatus.Paused }))).toBe(true);
      expect(isApplyActive(apply({ status: MediaOperationStatus.Completed }))).toBe(false);
      expect(applyStatusKey(apply())).toBe('frameleaf_dedup_apply_status_running');
      expect(applyStatusKey(apply({ pauseRequested: true }))).toBe('frameleaf_dedup_apply_status_pausing');
      expect(applyStatusKey(apply({ status: MediaOperationStatus.Queued, retrying: true }))).toBe(
        'frameleaf_dedup_apply_status_retrying',
      );
      for (const status of Object.values(MediaOperationStatus)) {
        expect(applyStatusKey(apply({ status }))).toMatch(/^frameleaf_dedup_apply_status_/);
      }
    });
  });

  describe(checksumAlgorithmKey.name, () => {
    it('names the checksum by its length', () => {
      expect(checksumAlgorithmKey('a'.repeat(40))).toBe('frameleaf_dedup_evidence_sha1');
      expect(checksumAlgorithmKey('a'.repeat(64))).toBe('frameleaf_dedup_evidence_sha256');
    });
  });

  describe(reviewExport.name, () => {
    it('exports the plan, the decisions and the review, never the review token or pixel data', () => {
      const reviewed = review({ excludedRetainedAssetIds: ['master-1'] });
      const exported = JSON.parse(reviewExport(plan(), ['master-1'], reviewed, '2026-09-22T13:00:00.000Z'));
      expect(exported.exportedAt).toBe('2026-09-22T13:00:00.000Z');
      expect(exported.plan.planId).toBe('PD-ABABABAB');
      expect(exported.plan.copies).toHaveLength(5);
      expect(exported.decisions).toEqual({ excludedRetainedAssetIds: ['master-1'] });
      expect(exported.review.planId).toBe('PD-ABABABAB');
      expect(exported.review).not.toHaveProperty('reviewToken');
      expect(JSON.stringify(exported)).not.toContain('thumbnail');
    });
  });
});
