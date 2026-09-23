import {
  PhysicalDeduplicationDecision,
  PhysicalDeduplicationPlanMode,
  PhysicalDeduplicationSkipReason,
  type PhysicalDeduplicationCopyDto,
  type PhysicalDeduplicationPlanDto,
  type PhysicalDeduplicationRetainedDto,
} from '@immich/sdk';

/**
 * Pure helpers for the physical deduplication preview (FL-71), ported from the design
 * template's `physical-dedup-data.mjs`. The template kept a local sample model; here the plan
 * is the server's dry-run result and these functions only shape it for display and decide
 * when a plan may be applied.
 */

export const DEDUP_SCOPE_ALL = 'all';

export type DedupGroup = {
  key: string;
  retained: PhysicalDeduplicationRetainedDto | null;
  copies: PhysicalDeduplicationCopyDto[];
  /** Copies in this group the plan would point at the retained original. */
  shares: number;
  reclaimableBytes: number;
};

/**
 * One group per retained original, with copies that have no exact match in the retained
 * account grouped on their own by checksum. Groups that would share something come first,
 * then unmatched groups, each block ordered by file name.
 */
export const groupPlanCopies = (plan: PhysicalDeduplicationPlanDto): DedupGroup[] => {
  const retainedById = new Map(plan.retained.map((item) => [item.assetId, item]));
  const groups = new Map<string, DedupGroup>();

  for (const copy of plan.copies) {
    const key = copy.retainedAssetId ? `retained:${copy.retainedAssetId}` : `unmatched:${copy.checksum}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        retained: copy.retainedAssetId ? (retainedById.get(copy.retainedAssetId) ?? null) : null,
        copies: [],
        shares: 0,
        reclaimableBytes: 0,
      };
      groups.set(key, group);
    }
    group.copies.push(copy);
    if (copy.decision === PhysicalDeduplicationDecision.Share) {
      group.shares++;
      group.reclaimableBytes += copy.sizeInBytes;
    }
  }

  const nameOf = (group: DedupGroup) => group.retained?.originalFileName ?? group.copies[0].originalFileName;

  return [...groups.values()].sort(
    (a, b) =>
      Number(a.shares === 0) - Number(b.shares === 0) ||
      Number(a.retained === null) - Number(b.retained === null) ||
      nameOf(a).localeCompare(nameOf(b)),
  );
};

export type DedupMetrics = {
  copiesToShare: number;
  retainedOriginals: number;
  reclaimableBytes: number;
  skippedCopies: number;
};

export const planMetrics = (plan: PhysicalDeduplicationPlanDto): DedupMetrics => {
  const sharing = plan.copies.filter((copy) => copy.decision === PhysicalDeduplicationDecision.Share);
  return {
    copiesToShare: plan.eligibleAssets,
    retainedOriginals: new Set(sharing.map((copy) => copy.retainedAssetId)).size,
    reclaimableBytes: plan.reclaimableBytes,
    // The server counters cover external and unmatched copies; copies that already share the
    // retained original are only visible in the copy list.
    skippedCopies:
      plan.skippedExternal +
      plan.skippedMissingMaster +
      plan.copies.filter((copy) => copy.reason === PhysicalDeduplicationSkipReason.AlreadyShared).length,
  };
};

/** A short, stable label for a plan, derived from when it ran, so the confirmation phrase names it. */
export const planLabel = (plan: Pick<PhysicalDeduplicationPlanDto, 'ranAt'>) => {
  const stamp = Date.parse(plan.ranAt);
  const code = Number.isFinite(stamp) ? stamp.toString(36).toUpperCase().slice(-6) : 'UNKNOWN';
  return `PD-${code}`;
};

export const confirmationPhrase = (plan: Pick<PhysicalDeduplicationPlanDto, 'ranAt'>) => `APPLY ${planLabel(plan)}`;

export const matchesConfirmation = (plan: Pick<PhysicalDeduplicationPlanDto, 'ranAt'>, typed: string) =>
  typed.trim() === confirmationPhrase(plan);

export type DedupStaleReason = 'scope' | 'master';

/**
 * Whether the plan on screen still describes what the toolbar selects. `scope` is the scan
 * scope ({@link DEDUP_SCOPE_ALL} or a user id); `masterUserId` is the account that would
 * retain originals for the next preview.
 */
export const planStaleReason = (
  plan: Pick<PhysicalDeduplicationPlanDto, 'scopeUserId' | 'masterUserId'>,
  selection: { scope: string; masterUserId: string | null },
): DedupStaleReason | null => {
  const selectedScope = selection.scope === DEDUP_SCOPE_ALL ? null : selection.scope;
  if ((plan.scopeUserId ?? null) !== selectedScope) {
    return 'scope';
  }
  if (selection.masterUserId && plan.masterUserId !== selection.masterUserId) {
    return 'master';
  }
  return null;
};

export type DedupApplyBlockedReason =
  | 'disabled'
  | 'no-saved-master'
  | 'master-mismatch'
  | 'applied'
  | 'no-shares'
  | 'running';

/**
 * Why a plan cannot be applied right now. Mirrors the server: applying requires the feature
 * to be enabled, a saved retained account, and a preview produced for exactly that account.
 */
export const applyBlockedReason = ({
  plan,
  enabled,
  savedMasterUserId,
  running,
}: {
  plan: Pick<PhysicalDeduplicationPlanDto, 'mode' | 'masterUserId' | 'eligibleAssets'>;
  enabled: boolean;
  savedMasterUserId: string | null;
  running: boolean;
}): DedupApplyBlockedReason | null => {
  if (running) {
    return 'running';
  }
  if (plan.mode === PhysicalDeduplicationPlanMode.Apply) {
    return 'applied';
  }
  if (!enabled) {
    return 'disabled';
  }
  if (!savedMasterUserId) {
    return 'no-saved-master';
  }
  if (plan.masterUserId !== savedMasterUserId) {
    return 'master-mismatch';
  }
  if (plan.eligibleAssets === 0) {
    return 'no-shares';
  }
  return null;
};

export const formatBytes = (value: number, locale?: string) => {
  const format = (amount: number, digits: number) =>
    amount.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  if (value >= 1024 ** 3) {
    return `${format(value / 1024 ** 3, 2)} GiB`;
  }
  if (value >= 1024 ** 2) {
    return `${format(value / 1024 ** 2, 1)} MiB`;
  }
  if (value >= 1024) {
    return `${format(value / 1024, 0)} KiB`;
  }
  return `${format(value, 0)} B`;
};

export const skipReasonKey = (reason: PhysicalDeduplicationSkipReason | null) => {
  switch (reason) {
    case PhysicalDeduplicationSkipReason.ExternalLibrary: {
      return 'frameleaf_dedup_reason_external_library' as const;
    }
    case PhysicalDeduplicationSkipReason.MissingSize: {
      return 'frameleaf_dedup_reason_missing_size' as const;
    }
    case PhysicalDeduplicationSkipReason.NoRetainedMatch: {
      return 'frameleaf_dedup_reason_no_retained_match' as const;
    }
    case PhysicalDeduplicationSkipReason.AlreadyShared: {
      return 'frameleaf_dedup_reason_already_shared' as const;
    }
    case PhysicalDeduplicationSkipReason.RetainedFileMissing: {
      return 'frameleaf_dedup_reason_retained_file_missing' as const;
    }
    default: {
      return 'frameleaf_dedup_reason_no_retained_match' as const;
    }
  }
};

/** The exportable review record: the plan as the server returned it plus the label the admin saw. */
export const reviewExport = (plan: PhysicalDeduplicationPlanDto, exportedAt = new Date().toISOString()) =>
  JSON.stringify({ exportedAt, plan: { ...plan, label: planLabel(plan) } }, null, 2);
