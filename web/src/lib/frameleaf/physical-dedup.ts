import {
  MediaOperationStatus,
  PhysicalDeduplicationDecision,
  PhysicalDeduplicationPlanMode,
  PhysicalDeduplicationSkipReason,
  type PhysicalDeduplicationApplyDto,
  type PhysicalDeduplicationCopyDto,
  type PhysicalDeduplicationPlanDto,
  type PhysicalDeduplicationRetainedDto,
  type PhysicalDeduplicationReviewResponseDto,
  type PhysicalDeduplicationVerificationItemDto,
} from '@immich/sdk';

/**
 * Pure helpers for physical deduplication (FL-71, FL-73), ported from the design template's
 * `physical-dedup-data.mjs`. The template kept a local sample model; here the plan is the server's
 * dry-run result, a review is the server's check of that plan against the library, and applying is
 * a durable server job. These functions only shape what the server returns and mirror its rules so
 * buttons are not offered pointlessly; the server decides.
 */

export const DEDUP_SCOPE_ALL = 'all';

/**
 * The `openSetting` value that opens Storage at the account shared originals are retained in: the
 * prototype's `advanced-dedup-owner` setting (settings-catalog.mjs:1860, CommandCenter.jsx:2599).
 */
export const DEDUP_OWNER_SETTING = 'dedup-owner';

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

/** A group the administrator may decide on: one retained original with copies the plan would share. */
export const isDecidableGroup = (group: DedupGroup) => group.retained !== null && group.shares > 0;

export type DedupMetrics = {
  copiesToShare: number;
  retainedOriginals: number;
  /** Estimate: what applying the plan would free. */
  reclaimableBytes: number;
  skippedCopies: number;
  /** What the assets that reference a shared original add up to, each at its own size (FL-73). */
  logicalBytes: number;
  /** The shared originals those assets use on disk, each file counted once (FL-73). */
  sharedOriginalBytes: number;
  /** Measured: bytes actually removed by applying this plan, or null before it was applied (FL-73). */
  measuredReclaimedBytes: number | null;
};

/**
 * The plan's headline numbers (prototype PhysicalDedupManager.jsx:636-660) and, kept apart from the
 * estimate (FL-73), the logical asset bytes, the physical shared-original bytes and the bytes an
 * apply measurably removed. `apply` is the newest job applying this plan, if any.
 */
export const planMetrics = (
  plan: PhysicalDeduplicationPlanDto,
  apply: Pick<PhysicalDeduplicationApplyDto, 'reclaimedBytes'> | null = null,
): DedupMetrics => {
  const sharing = plan.copies.filter((copy) => copy.decision === PhysicalDeduplicationDecision.Share);
  return {
    copiesToShare: plan.eligibleAssets,
    retainedOriginals: new Set(sharing.map((copy) => copy.retainedAssetId)).size,
    reclaimableBytes: plan.reclaimableBytes,
    logicalBytes: plan.logicalBytes ?? 0,
    sharedOriginalBytes: plan.sharedOriginalBytes ?? 0,
    measuredReclaimedBytes: apply
      ? apply.reclaimedBytes
      : plan.mode === PhysicalDeduplicationPlanMode.Apply
        ? plan.deletedBytes
        : null,
    // The server counters cover external and unmatched copies; copies that already share the
    // retained original are only visible in the copy list.
    skippedCopies:
      plan.skippedExternal +
      plan.skippedMissingMaster +
      plan.copies.filter((copy) => copy.reason === PhysicalDeduplicationSkipReason.AlreadyShared).length,
  };
};

export type DedupConfigError = 'disabled' | 'no-master';

/**
 * Why no plan can be prepared right now (FL-73, UT-23), from the prototype's
 * `dedupConfigurationError` (physical-dedup-data.mjs:76-86): file reuse must be enabled, and an
 * account to retain shared originals in must be saved or, until one is, chosen on the page.
 */
export const dedupConfigurationError = ({
  enabled,
  masterUserId,
  accountIds,
}: {
  enabled: boolean;
  masterUserId: string | null | undefined;
  accountIds: readonly string[];
}): DedupConfigError | null => {
  if (!enabled) {
    return 'disabled';
  }
  if (!masterUserId || !accountIds.includes(masterUserId)) {
    return 'no-master';
  }
  return null;
};

const pad = (value: number) => String(value).padStart(2, '0');

/** A video's length as the prototype writes it: `1:12`, or `1:02:05` past an hour. */
export const formatDuration = (milliseconds: number) => {
  const total = Math.round(milliseconds / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
};

/** The resolution name a video's detail line uses, from its larger side; null below HD. */
export const videoResolutionLabel = (width: number, height: number) => {
  const side = Math.max(width, height);
  if (side >= 7680) {
    return '8K';
  }
  if (side >= 3840) {
    return '4K';
  }
  if (side >= 1920) {
    return '1080p';
  }
  if (side >= 1280) {
    return '720p';
  }
  return null;
};

/**
 * The detail after owner and size on a preview row (FL-73, UT-25; prototype
 * PhysicalDedupManager.jsx:315-318, 359-362): `6000 × 4000` for a photo, `1:12 · 4K` for a video.
 * Empty when the asset has neither recorded.
 */
export const mediaDetail = (item: {
  type: string;
  width?: number | null;
  height?: number | null;
  duration?: number | null;
}) => {
  const hasSize = !!item.width && !!item.height;
  if (item.type === 'VIDEO') {
    const parts = [
      item.duration ? formatDuration(item.duration) : null,
      hasSize ? videoResolutionLabel(item.width!, item.height!) : null,
    ].filter((part): part is string => !!part);
    return parts.join(' · ');
  }
  return hasSize ? `${item.width} × ${item.height}` : '';
};

/** Whether an applied plan can be verified: its job has finished and it changed at least one copy. */
export const canVerifyApply = (apply: Pick<PhysicalDeduplicationApplyDto, 'status' | 'applied' | 'alreadyApplied'>) =>
  !isApplyActive(apply) && apply.applied + apply.alreadyApplied > 0;

export type DedupVerificationItemKey =
  | 'frameleaf_dedup_verify_item_verified'
  | 'frameleaf_dedup_verify_item_restored'
  | 'frameleaf_dedup_verify_item_retained_missing'
  | 'frameleaf_dedup_verify_item_retained_changed'
  | 'frameleaf_dedup_verify_item_not_linked';

/** One verified copy's result, most serious first. */
export const verificationItemKey = (
  item: Pick<PhysicalDeduplicationVerificationItemDto, 'retainedFile' | 'linked' | 'restored'>,
): DedupVerificationItemKey => {
  if (item.restored) {
    return 'frameleaf_dedup_verify_item_restored';
  }
  if (!item.linked) {
    return 'frameleaf_dedup_verify_item_not_linked';
  }
  if (item.retainedFile === 'missing') {
    return 'frameleaf_dedup_verify_item_retained_missing';
  }
  if (item.retainedFile === 'changed') {
    return 'frameleaf_dedup_verify_item_retained_changed';
  }
  return 'frameleaf_dedup_verify_item_verified';
};

export type DedupUndoKey =
  | 'frameleaf_dedup_undo_removed'
  | 'frameleaf_dedup_undo_restorable'
  | 'frameleaf_dedup_undo_changed'
  | 'frameleaf_dedup_undo_restored';

/**
 * What can be undone for one copy, stated plainly (FL-73): a copy whose own file was removed cannot
 * go back, a copy whose own file is still there can.
 */
export const undoKey = (
  item: Pick<PhysicalDeduplicationVerificationItemDto, 'copyFile' | 'restored' | 'restorable'>,
): DedupUndoKey => {
  if (item.restored) {
    return 'frameleaf_dedup_undo_restored';
  }
  if (item.restorable) {
    return 'frameleaf_dedup_undo_restorable';
  }
  return item.copyFile === 'removed' ? 'frameleaf_dedup_undo_removed' : 'frameleaf_dedup_undo_changed';
};

export type DedupSelection = {
  /** Copies the plan applies with these decisions, listed and unlisted. */
  copies: number;
  /** Unlisted copies the plan applies with these decisions: another account's Locked media. */
  hiddenCopies: number;
  /** Bytes of the listed copies the plan applies. Unlisted copies are measured by the review. */
  listedBytes: number;
  /** Groups left as they are. */
  keptGroups: number;
};

/**
 * What the plan applies with the administrator's per-group decisions. `excluded` holds retained
 * asset ids. The server counts the same way when it reviews the plan and returns exact totals.
 */
export const planSelection = (plan: PhysicalDeduplicationPlanDto, excluded: ReadonlySet<string>): DedupSelection => {
  const retainedIds = new Set(plan.retained.map((item) => item.assetId));
  const listed = plan.copies.filter(
    (copy) =>
      copy.decision === PhysicalDeduplicationDecision.Share &&
      !!copy.retainedAssetId &&
      retainedIds.has(copy.retainedAssetId),
  );
  const included = listed.filter((copy) => !excluded.has(copy.retainedAssetId!));
  // Unlisted copies belong to a group too: the ones of a group left out are left out with it.
  const hiddenInExcluded = plan.retained
    .filter((retained) => excluded.has(retained.assetId))
    .reduce((total, retained) => total + retained.hiddenCopies, 0);
  const hiddenCopies = Math.max(0, plan.applicableCopies - listed.length - hiddenInExcluded);

  return {
    copies: included.length + hiddenCopies,
    hiddenCopies,
    listedBytes: included.reduce((total, copy) => total + copy.sizeInBytes, 0),
    keptGroups: [...excluded].filter((id) => retainedIds.has(id)).length,
  };
};

/** The left-out groups in the order the server compares them. */
export const normalizeExcluded = (excluded: Iterable<string>) => [...new Set(excluded)].sort();

/** Whether a review still describes the plan on screen with the decisions on screen. */
export const reviewMatches = (
  review: Pick<PhysicalDeduplicationReviewResponseDto, 'fingerprint' | 'excludedRetainedAssetIds'> | null,
  plan: Pick<PhysicalDeduplicationPlanDto, 'fingerprint'> | null,
  excluded: Iterable<string>,
) =>
  !!review &&
  !!plan &&
  review.fingerprint === plan.fingerprint &&
  normalizeExcluded(review.excludedRetainedAssetIds).join('\n') === normalizeExcluded(excluded).join('\n');

export const confirmationPhrase = (plan: Pick<PhysicalDeduplicationPlanDto, 'planId'>) => `APPLY ${plan.planId}`;

export const matchesConfirmation = (plan: Pick<PhysicalDeduplicationPlanDto, 'planId'>, typed: string) =>
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

const ACTIVE_APPLY_STATUSES: ReadonlySet<MediaOperationStatus> = new Set([
  MediaOperationStatus.Queued,
  MediaOperationStatus.Preparing,
  MediaOperationStatus.Rendering,
  MediaOperationStatus.Validating,
  MediaOperationStatus.Cancelling,
  MediaOperationStatus.Paused,
]);

export const isApplyActive = (apply: Pick<PhysicalDeduplicationApplyDto, 'status'>) =>
  ACTIVE_APPLY_STATUSES.has(apply.status);

/** The newest job applying this plan, if any. The server lists applies newest first. */
export const applyForPlan = (
  applies: readonly PhysicalDeduplicationApplyDto[],
  plan: Pick<PhysicalDeduplicationPlanDto, 'fingerprint'> | null,
) => (plan ? (applies.find((apply) => apply.fingerprint === plan.fingerprint) ?? null) : null);

export type DedupApplyStatusKey =
  | 'frameleaf_dedup_apply_status_queued'
  | 'frameleaf_dedup_apply_status_running'
  | 'frameleaf_dedup_apply_status_pausing'
  | 'frameleaf_dedup_apply_status_paused'
  | 'frameleaf_dedup_apply_status_retrying'
  | 'frameleaf_dedup_apply_status_cancelling'
  | 'frameleaf_dedup_apply_status_completed'
  | 'frameleaf_dedup_apply_status_cancelled'
  | 'frameleaf_dedup_apply_status_failed';

export const applyStatusKey = (
  apply: Pick<PhysicalDeduplicationApplyDto, 'status' | 'retrying' | 'pauseRequested'>,
): DedupApplyStatusKey => {
  switch (apply.status) {
    case MediaOperationStatus.Queued: {
      return apply.retrying ? 'frameleaf_dedup_apply_status_retrying' : 'frameleaf_dedup_apply_status_queued';
    }
    case MediaOperationStatus.Preparing:
    case MediaOperationStatus.Rendering:
    case MediaOperationStatus.Validating: {
      return apply.pauseRequested ? 'frameleaf_dedup_apply_status_pausing' : 'frameleaf_dedup_apply_status_running';
    }
    case MediaOperationStatus.Paused: {
      return 'frameleaf_dedup_apply_status_paused';
    }
    case MediaOperationStatus.Cancelling: {
      return 'frameleaf_dedup_apply_status_cancelling';
    }
    case MediaOperationStatus.Completed: {
      return 'frameleaf_dedup_apply_status_completed';
    }
    case MediaOperationStatus.Cancelled: {
      return 'frameleaf_dedup_apply_status_cancelled';
    }
    default: {
      return 'frameleaf_dedup_apply_status_failed';
    }
  }
};

export type DedupApplyBlockedReason =
  'disabled' | 'no-saved-master' | 'master-mismatch' | 'applied' | 'no-shares' | 'running' | 'applying';

/**
 * Why a plan cannot be applied right now. Mirrors the server: applying requires the feature to be
 * enabled, a saved retained account, a preview produced for exactly that account, at least one copy
 * to share with these decisions, and no other plan being applied.
 */
export const applyBlockedReason = ({
  plan,
  enabled,
  savedMasterUserId,
  running,
  applying,
  applied,
  selectedCopies,
}: {
  plan: Pick<PhysicalDeduplicationPlanDto, 'mode' | 'masterUserId'>;
  enabled: boolean;
  savedMasterUserId: string | null;
  running: boolean;
  applying: boolean;
  applied: boolean;
  selectedCopies: number;
}): DedupApplyBlockedReason | null => {
  if (running) {
    return 'running';
  }
  if (applying) {
    return 'applying';
  }
  if (applied || plan.mode === PhysicalDeduplicationPlanMode.Apply) {
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
  if (selectedCopies === 0) {
    return 'no-shares';
  }
  return null;
};

/**
 * Reasons that also stop a review. A review checks the plan against the library without the saved
 * settings, so a preview prepared against an account chosen on the page can still be reviewed.
 */
export const blocksReview = (reason: DedupApplyBlockedReason | null) =>
  ['running', 'applying', 'applied', 'no-shares'].includes(reason ?? '');

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

/** The checksum a row carries: SHA-1 for older uploads, SHA-256 for newer ones. */
export const checksumAlgorithmKey = (checksum: string) =>
  checksum.length === 64 ? ('frameleaf_dedup_evidence_sha256' as const) : ('frameleaf_dedup_evidence_sha1' as const);

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

/**
 * The exportable review record: the plan as the server returned it, the per-group decisions and,
 * once reviewed, the server's review of them. The review token is left out; it authorizes nothing
 * on its own, but it is not something to pass around either.
 */
export const reviewExport = (
  plan: PhysicalDeduplicationPlanDto,
  excluded: Iterable<string> = [],
  review: PhysicalDeduplicationReviewResponseDto | null = null,
  exportedAt = new Date().toISOString(),
) => {
  const reviewed = review ? Object.fromEntries(Object.entries(review).filter(([key]) => key !== 'reviewToken')) : null;
  return JSON.stringify(
    {
      exportedAt,
      plan,
      decisions: { excludedRetainedAssetIds: normalizeExcluded(excluded) },
      review: reviewed,
    },
    null,
    2,
  );
};
