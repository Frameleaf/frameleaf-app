import { createHash, createHmac } from 'node:crypto';
import { AssetStatus, PhysicalDeduplicationDecision } from 'src/enum.js';

/**
 * Reviewed physical deduplication plans (FL-73), kept free of the database so they can be read and
 * tested on their own.
 *
 * The dry run (FL-71) stores one plan: every duplicate copy it looked at, with the retained original
 * it matches, the checksum and size evidence and the retained original's reference count. Applying
 * works on exactly that plan and nothing wider:
 *
 * 1. **Fingerprint.** A digest over the stored plan's evidence. It changes with every new preview,
 *    and its first eight characters are the plan's name (`PD-1A2B3C4D`), so the typed confirmation
 *    names the exact plan the administrator looked at.
 * 2. **Review token.** A keyed digest (HMAC with a secret the server keeps) over the fingerprint and
 *    the administrator's per-group decisions (which retained originals to leave out). "Mark plan
 *    reviewed" checks the evidence against the library again and hands this back; applying must
 *    present the same token, so the set applied is the set reviewed, and a token can only come from
 *    a review this server made.
 * 3. **Frozen items.** The copies the reviewed plan shares, each with its evidence, go into the
 *    durable job's snapshot. The worker checks each one again before it touches a file.
 */

/** Stable reasons a copy was left alone. Shown to the administrator; never a file name or an id. */
export type PhysicalDeduplicationItemReason =
  /** The copy is gone, trashed, owned by someone else, or its path, checksum or size changed. */
  | 'copy-changed'
  /** The copy's file is not on disk. Nothing to reclaim, and linking it was not what was reviewed. */
  | 'copy-missing'
  /** The copy's bytes on disk no longer hash to the reviewed checksum; it is not a duplicate now. */
  | 'copy-mismatch'
  /** The retained original is gone, trashed, moved to another account or its evidence changed. */
  | 'retained-changed'
  /** The retained original's file is not on disk. The copy is never removed without it. */
  | 'retained-missing'
  /** The retained original's bytes on disk no longer match the reviewed checksum and size. */
  | 'retained-mismatch'
  /** Something unexpected went wrong; the copy is retried once and otherwise left as it was. */
  | 'error';

export type PhysicalDeduplicationItemState = 'applied' | 'already-applied' | 'skipped' | 'failed';

/** One copy of the reviewed plan, frozen with the evidence it was reviewed with. */
export type PhysicalDeduplicationPlanItem = {
  assetId: string;
  ownerId: string;
  originalPath: string;
  /** Hex checksum of the copy's original, as recorded by the preview. */
  checksum: string;
  sizeInBytes: number;
  retainedAssetId: string;
  retainedPath: string;
  retainedChecksum: string;
};

export type PhysicalDeduplicationPlanRetained = {
  assetId: string;
  originalPath: string;
  checksum: string;
  sizeInBytes: number;
  referencesBefore: number;
};

export type PhysicalDeduplicationApplySnapshot = {
  version: 1;
  planId: string;
  fingerprint: string;
  reviewToken: string;
  ranAt: string;
  masterUserId: string;
  scopeUserId: string | null;
  excludedRetainedAssetIds: string[];
  items: PhysicalDeduplicationPlanItem[];
  retained: PhysicalDeduplicationPlanRetained[];
  /** Bytes of the copies' originals the reviewed plan expected to reclaim. */
  estimatedBytes: number;
};

export type PhysicalDeduplicationItemOutcome = {
  id: string;
  state: PhysicalDeduplicationItemState;
  reasonKey: PhysicalDeduplicationItemReason | null;
  message: string | null;
  /** Bytes actually removed from disk for this copy: its original and any generated files. */
  reclaimedBytes: number;
  at: string;
};

export type PhysicalDeduplicationApplySummary = {
  applied: number;
  alreadyApplied: number;
  skipped: number;
  failed: number;
  reclaimedBytes: number;
};

export type PhysicalDeduplicationApplyResult = {
  version: 1;
  items: PhysicalDeduplicationItemOutcome[];
  /** The copy being worked on when the row was last written, so a resumed claim knows. */
  inFlight: string | null;
  /** The one automatic retry of copies that failed, with its own cursor. */
  retry: { ids: string[]; processed: number } | null;
  summary: PhysicalDeduplicationApplySummary;
};

/** The stored dry-run plan as far as this module needs it. */
export type PhysicalDeduplicationStoredPlan = {
  mode: 'dry-run' | 'apply';
  ranAt: string;
  masterUserId: string;
  scopeUserId?: string | null;
  eligibleAssets: number;
  reclaimableBytes: number;
  copiesTruncated?: boolean;
  retained?: Array<{
    assetId: string;
    ownerId: string;
    originalPath: string;
    checksum: string;
    sizeInBytes: number;
    referencesBefore: number;
  }>;
  copies?: Array<{
    assetId: string;
    ownerId: string;
    originalPath: string;
    checksum: string;
    sizeInBytes: number;
    retainedAssetId: string | null;
    decision: PhysicalDeduplicationDecision;
    reason: string | null;
  }>;
};

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

const byAssetId = <T extends { assetId: string }>(a: T, b: T) => a.assetId.localeCompare(b.assetId);

/**
 * The plan's fingerprint: every piece of evidence the administrator reviews, in a fixed order. Two
 * previews never share one, because the time it ran is part of it. Whether the plan was applied is
 * not evidence: a plan keeps its name and fingerprint once applied, so its job can be found by it.
 */
export const physicalDeduplicationFingerprint = (plan: PhysicalDeduplicationStoredPlan): string => {
  const retained = [...(plan.retained ?? [])]
    .sort(byAssetId)
    .map((item) => [
      item.assetId,
      item.ownerId,
      item.originalPath,
      item.checksum,
      item.sizeInBytes,
      item.referencesBefore,
    ]);
  const copies = [...(plan.copies ?? [])]
    .sort(byAssetId)
    .map((item) => [
      item.assetId,
      item.ownerId,
      item.originalPath,
      item.checksum,
      item.sizeInBytes,
      item.retainedAssetId,
      item.decision,
      item.reason,
    ]);

  return sha256(
    JSON.stringify([
      'frameleaf-physical-deduplication-plan',
      1,
      plan.ranAt,
      plan.masterUserId,
      plan.scopeUserId ?? null,
      plan.eligibleAssets,
      plan.reclaimableBytes,
      plan.copiesTruncated ?? false,
      retained,
      copies,
    ]),
  );
};

/** The name a person reads and types: `PD-` and the fingerprint's first eight characters. */
export const physicalDeduplicationPlanId = (fingerprint: string) => `PD-${fingerprint.slice(0, 8).toUpperCase()}`;

export const physicalDeduplicationConfirmation = (planId: string) => `APPLY ${planId}`;

/** The left-out groups in one canonical order, so the same decisions always give the same token. */
export const normalizeExcluded = (ids: readonly string[] | undefined) => [...new Set(ids)].sort();

/** Binds the plan to the administrator's per-group decisions, keyed with the server's secret. */
export const physicalDeduplicationReviewToken = (
  secret: string,
  fingerprint: string,
  excludedRetainedAssetIds: readonly string[],
) =>
  createHmac('sha256', secret)
    .update(
      JSON.stringify([
        'frameleaf-physical-deduplication-review',
        1,
        fingerprint,
        normalizeExcluded(excludedRetainedAssetIds),
      ]),
    )
    .digest('hex');

/**
 * The copies a reviewed plan applies: every copy the preview decided to share, except those whose
 * retained original the administrator left out. A copy beyond the stored preview's limit was never
 * listed, so it was never reviewed and is not part of any plan; a later preview picks it up.
 */
export const physicalDeduplicationPlanItems = (
  plan: PhysicalDeduplicationStoredPlan,
  excludedRetainedAssetIds: readonly string[],
): { items: PhysicalDeduplicationPlanItem[]; retained: PhysicalDeduplicationPlanRetained[] } => {
  const excluded = new Set(excludedRetainedAssetIds);
  const retainedById = new Map((plan.retained ?? []).map((item) => [item.assetId, item]));
  const items: PhysicalDeduplicationPlanItem[] = [];
  const used = new Map<string, PhysicalDeduplicationPlanRetained>();

  for (const copy of plan.copies ?? []) {
    if (copy.decision !== PhysicalDeduplicationDecision.Share || !copy.retainedAssetId) {
      continue;
    }
    const retained = retainedById.get(copy.retainedAssetId);
    if (!retained || excluded.has(retained.assetId)) {
      continue;
    }
    items.push({
      assetId: copy.assetId,
      ownerId: copy.ownerId,
      originalPath: copy.originalPath,
      checksum: copy.checksum,
      sizeInBytes: copy.sizeInBytes,
      retainedAssetId: retained.assetId,
      retainedPath: retained.originalPath,
      retainedChecksum: retained.checksum,
    });
    used.set(retained.assetId, {
      assetId: retained.assetId,
      originalPath: retained.originalPath,
      checksum: retained.checksum,
      sizeInBytes: retained.sizeInBytes,
      referencesBefore: retained.referencesBefore,
    });
  }

  return { items, retained: used.values().toArray() };
};

/**
 * How a plan's bytes add up (FL-73), over every retained original it records, listed or not:
 *
 * - `logicalBytes`: what the assets that reference a shared original add up to once the plan is
 *   applied, each asset counted at its own size (what the library looks like it holds);
 * - `sharedOriginalBytes`: the retained originals those assets share, each file counted once (what
 *   the disk holds for them).
 *
 * A retained original nothing else would reference is not shared and counts in neither. The
 * estimate of what applying frees (`reclaimableBytes`) and what it measurably freed (`deletedBytes`
 * and each apply's `reclaimedBytes`) are separate figures.
 */
export const physicalDeduplicationByteAccounting = (
  retained: ReadonlyArray<{ sizeInBytes: number; referencesAfter: number }>,
) => {
  let logicalBytes = 0;
  let sharedOriginalBytes = 0;
  for (const item of retained) {
    if (item.referencesAfter <= 1) {
      continue;
    }
    logicalBytes += item.sizeInBytes * item.referencesAfter;
    sharedOriginalBytes += item.sizeInBytes;
  }
  return { logicalBytes, sharedOriginalBytes };
};

/** An asset row as the evidence check reads it. */
export type PhysicalDeduplicationEvidenceRow = {
  id: string;
  ownerId: string;
  originalPath: string;
  checksum: Buffer;
  sizeInBytes: number | string | null;
  deletedAt: Date | string | null;
  status: string;
  isExternal: boolean;
  isOffline: boolean;
  libraryId: string | null;
  physicalOriginalFileId: string | null;
  /** Read for the post-apply verification's rows (FL-73); not evidence. */
  originalFileName?: string;
  type?: string;
};

const isLibraryManaged = (row: PhysicalDeduplicationEvidenceRow) =>
  !row.deletedAt && row.status === AssetStatus.Active && !row.isExternal && !row.isOffline && !row.libraryId;

const sameBytes = (row: PhysicalDeduplicationEvidenceRow, checksum: string, sizeInBytes: number) =>
  row.checksum.toString('hex') === checksum && Number(row.sizeInBytes ?? 0) === sizeInBytes;

/** Whether the retained original still is what the reviewed plan recorded. */
export const retainedEvidenceProblem = (
  retained: PhysicalDeduplicationPlanRetained,
  row: PhysicalDeduplicationEvidenceRow | undefined,
  masterUserId: string,
): PhysicalDeduplicationItemReason | null => {
  if (
    !row ||
    !isLibraryManaged(row) ||
    row.ownerId !== masterUserId ||
    row.originalPath !== retained.originalPath ||
    !sameBytes(row, retained.checksum, retained.sizeInBytes)
  ) {
    return 'retained-changed';
  }
  return null;
};

/**
 * Whether a copy still is what the reviewed plan recorded, and not yet sharing the retained
 * original. `alreadyShared` tells the worker a copy some earlier attempt already linked.
 */
export const copyEvidenceProblem = (
  item: PhysicalDeduplicationPlanItem,
  row: PhysicalDeduplicationEvidenceRow | undefined,
  retainedRow: PhysicalDeduplicationEvidenceRow | undefined,
): { reason: PhysicalDeduplicationItemReason | null; alreadyShared: boolean } => {
  if (
    !row ||
    row.deletedAt ||
    row.status !== AssetStatus.Active ||
    row.isExternal ||
    row.isOffline ||
    row.libraryId ||
    row.ownerId !== item.ownerId ||
    !sameBytes(row, item.checksum, item.sizeInBytes)
  ) {
    return { reason: 'copy-changed', alreadyShared: false };
  }

  const alreadyShared =
    !!row.physicalOriginalFileId &&
    !!retainedRow?.physicalOriginalFileId &&
    row.physicalOriginalFileId === retainedRow.physicalOriginalFileId;
  if (alreadyShared) {
    return { reason: null, alreadyShared: true };
  }

  if (row.originalPath !== item.originalPath) {
    return { reason: 'copy-changed', alreadyShared: false };
  }
  return { reason: null, alreadyShared: false };
};

/**
 * The reference count the preview would record for a retained original now: the assets pointing at
 * its physical file, or one (itself) when it has none yet.
 */
export const currentReferences = (row: PhysicalDeduplicationEvidenceRow, counts: ReadonlyMap<string, number>) =>
  Math.max(row.physicalOriginalFileId ? (counts.get(row.physicalOriginalFileId) ?? 0) : 1, 1);

/* -------------------------------------------------------------------------------------------- */
/* The durable job's snapshot and result                                                         */
/* -------------------------------------------------------------------------------------------- */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const asString = (value: unknown) => (typeof value === 'string' ? value : null);

const asCount = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);

const parseItem = (value: unknown): PhysicalDeduplicationPlanItem | null => {
  if (!isRecord(value)) {
    return null;
  }
  const fields = [
    'assetId',
    'ownerId',
    'originalPath',
    'checksum',
    'retainedAssetId',
    'retainedPath',
    'retainedChecksum',
  ];
  if (fields.some((field) => typeof value[field] !== 'string')) {
    return null;
  }
  return {
    assetId: value.assetId as string,
    ownerId: value.ownerId as string,
    originalPath: value.originalPath as string,
    checksum: value.checksum as string,
    sizeInBytes: asCount(value.sizeInBytes),
    retainedAssetId: value.retainedAssetId as string,
    retainedPath: value.retainedPath as string,
    retainedChecksum: value.retainedChecksum as string,
  };
};

const parseRetained = (value: unknown): PhysicalDeduplicationPlanRetained | null => {
  if (!isRecord(value) || typeof value.assetId !== 'string' || typeof value.originalPath !== 'string') {
    return null;
  }
  if (typeof value.checksum !== 'string') {
    return null;
  }
  return {
    assetId: value.assetId,
    originalPath: value.originalPath,
    checksum: value.checksum,
    sizeInBytes: asCount(value.sizeInBytes),
    referencesBefore: asCount(value.referencesBefore),
  };
};

/** The job's frozen plan. Anything malformed fails the job rather than applying a partial guess. */
export const parsePhysicalDeduplicationSnapshot = (value: unknown): PhysicalDeduplicationApplySnapshot => {
  if (!isRecord(value) || value.version !== 1) {
    throw new Error('Physical deduplication job snapshot is missing');
  }
  const planId = asString(value.planId);
  const fingerprint = asString(value.fingerprint);
  const masterUserId = asString(value.masterUserId);
  if (!planId || !fingerprint || !masterUserId || !Array.isArray(value.items) || !Array.isArray(value.retained)) {
    throw new Error('Physical deduplication job snapshot is incomplete');
  }

  const items = value.items.map((item) => parseItem(item));
  const retained = value.retained.map((item) => parseRetained(item));
  if (items.some((item) => !item) || retained.some((item) => !item)) {
    throw new Error('Physical deduplication job snapshot has a malformed copy');
  }

  return {
    version: 1,
    planId,
    fingerprint,
    reviewToken: asString(value.reviewToken) ?? '',
    ranAt: asString(value.ranAt) ?? '',
    masterUserId,
    scopeUserId: asString(value.scopeUserId),
    excludedRetainedAssetIds: Array.isArray(value.excludedRetainedAssetIds)
      ? value.excludedRetainedAssetIds.filter((id): id is string => typeof id === 'string')
      : [],
    items: items as PhysicalDeduplicationPlanItem[],
    retained: retained as PhysicalDeduplicationPlanRetained[],
    estimatedBytes: asCount(value.estimatedBytes),
  };
};

const ITEM_STATES: ReadonlySet<PhysicalDeduplicationItemState> = new Set([
  'applied',
  'already-applied',
  'skipped',
  'failed',
]);

export const emptyPhysicalDeduplicationResult = (): PhysicalDeduplicationApplyResult => ({
  version: 1,
  items: [],
  inFlight: null,
  retry: null,
  summary: { applied: 0, alreadyApplied: 0, skipped: 0, failed: 0, reclaimedBytes: 0 },
});

export const summarizePhysicalDeduplication = (
  items: readonly PhysicalDeduplicationItemOutcome[],
): PhysicalDeduplicationApplySummary => {
  const summary = { applied: 0, alreadyApplied: 0, skipped: 0, failed: 0, reclaimedBytes: 0 };
  for (const item of items) {
    summary.reclaimedBytes += item.reclaimedBytes;
    switch (item.state) {
      case 'applied': {
        summary.applied++;
        break;
      }
      case 'already-applied': {
        summary.alreadyApplied++;
        break;
      }
      case 'skipped': {
        summary.skipped++;
        break;
      }
      case 'failed': {
        summary.failed++;
        break;
      }
    }
  }
  return summary;
};

/** Read leniently: the result is the job's own record, rewritten after every copy. */
export const parsePhysicalDeduplicationResult = (value: unknown): PhysicalDeduplicationApplyResult => {
  if (!isRecord(value)) {
    return emptyPhysicalDeduplicationResult();
  }
  const items: PhysicalDeduplicationItemOutcome[] = [];
  for (const raw of Array.isArray(value.items) ? value.items : []) {
    if (!isRecord(raw) || typeof raw.id !== 'string') {
      continue;
    }
    const state = ITEM_STATES.has(raw.state as PhysicalDeduplicationItemState)
      ? (raw.state as PhysicalDeduplicationItemState)
      : 'failed';
    items.push({
      id: raw.id,
      state,
      reasonKey: (asString(raw.reasonKey) as PhysicalDeduplicationItemReason | null) ?? null,
      message: asString(raw.message),
      reclaimedBytes: asCount(raw.reclaimedBytes),
      at: asString(raw.at) ?? '',
    });
  }
  const retry =
    isRecord(value.retry) && Array.isArray(value.retry.ids)
      ? {
          ids: value.retry.ids.filter((id): id is string => typeof id === 'string'),
          processed: asCount(value.retry.processed),
        }
      : null;
  return {
    version: 1,
    items,
    inFlight: asString(value.inFlight),
    retry,
    summary: summarizePhysicalDeduplication(items),
  };
};

/** Record one copy's outcome, replacing an earlier one (the automatic retry's answer wins). */
export const mergePhysicalDeduplicationItem = (
  result: PhysicalDeduplicationApplyResult,
  outcome: PhysicalDeduplicationItemOutcome,
): PhysicalDeduplicationApplyResult => {
  const items = [...result.items.filter((item) => item.id !== outcome.id), outcome];
  return { ...result, items, summary: summarizePhysicalDeduplication(items) };
};

/**
 * After the first pass: the copies that failed get one more attempt (owner decision, September 22,
 * 2026). Skipped copies are not retried; their evidence changed, and trying again cannot change it
 * back. Returns null when there is nothing to retry or the retry pass already exists.
 */
export const planPhysicalDeduplicationRetry = (
  result: PhysicalDeduplicationApplyResult,
): PhysicalDeduplicationApplyResult | null => {
  if (result.retry) {
    return null;
  }
  const ids = result.items.filter((item) => item.state === 'failed').map((item) => item.id);
  return ids.length > 0 ? { ...result, retry: { ids, processed: 0 } } : null;
};

export const physicalDeduplicationProgress = (processed: number, total: number) =>
  total > 0 ? Math.min(100, Math.round((processed / total) * 10_000) / 100) : 100;
