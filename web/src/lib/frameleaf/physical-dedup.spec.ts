import { describe, expect, it } from 'vitest';
import {
  applyBlockedReason,
  confirmationPhrase,
  DEDUP_SCOPE_ALL,
  formatBytes,
  groupPlanCopies,
  matchesConfirmation,
  planLabel,
  planMetrics,
  planStaleReason,
  reviewExport,
  skipReasonKey,
} from '$lib/frameleaf/physical-dedup';
import {
  AssetTypeEnum,
  PhysicalDeduplicationDecision,
  PhysicalDeduplicationPlanMode,
  PhysicalDeduplicationSkipReason,
  type PhysicalDeduplicationCopyDto,
  type PhysicalDeduplicationPlanDto,
  type PhysicalDeduplicationRetainedDto,
} from '@immich/sdk';

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
    it('derives the four headline numbers from the plan', () => {
      expect(planMetrics(plan())).toEqual({
        copiesToShare: 2,
        retainedOriginals: 1,
        reclaimableBytes: 14_850_240 * 2,
        skippedCopies: 3,
      });
    });
  });

  describe('plan label and confirmation', () => {
    it('derives a stable label from the run time', () => {
      expect(planLabel(plan())).toBe(planLabel(plan()));
      expect(planLabel(plan())).toMatch(/^PD-[0-9A-Z]{1,6}$/);
      expect(planLabel(plan({ ranAt: '2026-09-23T12:00:00.000Z' }))).not.toBe(planLabel(plan()));
    });

    it('accepts only the exact phrase, ignoring surrounding whitespace', () => {
      const current = plan();
      expect(confirmationPhrase(current)).toBe(`APPLY ${planLabel(current)}`);
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
    const allowed = { plan: plan(), enabled: true, savedMasterUserId: 'taylor', running: false };

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
      expect(applyBlockedReason({ ...allowed, plan: plan({ eligibleAssets: 0 }) })).toBe('no-shares');
    });

    it('never lets a page-chosen retained account stand in for the saved one', () => {
      // The preview was prepared against Jamie on the page; nothing is saved.
      expect(
        applyBlockedReason({
          plan: plan({ masterUserId: 'jamie' }),
          enabled: true,
          savedMasterUserId: null,
          running: false,
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

  describe(reviewExport.name, () => {
    it('exports the plan with its label and never invents pixel data', () => {
      const exported = JSON.parse(reviewExport(plan(), '2026-09-22T13:00:00.000Z'));
      expect(exported.exportedAt).toBe('2026-09-22T13:00:00.000Z');
      expect(exported.plan.label).toBe(planLabel(plan()));
      expect(exported.plan.copies).toHaveLength(5);
      expect(JSON.stringify(exported)).not.toContain('thumbnail');
    });
  });
});
