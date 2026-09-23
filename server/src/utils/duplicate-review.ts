import { AssetResponseDto } from 'src/dtos/asset-response.dto.js';
import { AssetType, DuplicateDecisionKind, DuplicateGroupKind, DuplicateQualityReason } from 'src/enum.js';
import { getExifCount, getFormatRank } from 'src/utils/duplicate.js';

/**
 * The rules of the fast duplicate review (FL-61), kept free of the database and of NestJS so they can
 * be read and tested on their own. Ported from the design template's `duplicate-review.mjs`.
 *
 * Three things live here:
 *
 * 1. **How a group reads.** A group of copies has a keeper suggestion with its evidence; a burst —
 *    several moments captured in quick succession — never does, because related frames are not
 *    disposable copies of one another.
 * 2. **What a decision is.** One complete group, the members the owner saw, and the photos to keep.
 *    Everything a decision trashes follows from those two lists; nothing is inferred later.
 * 3. **How a durable job walks decisions.** A bulk job works through asset ids in batches, and a
 *    decision must never be split across two batches, so batches end on group boundaries.
 */

/** Two captures closer together than this, and never at the same instant, read as one burst. */
export const DUPLICATE_BURST_SECONDS = 20;

/** The most groups one durable decision job accepts. Larger reviews are split by the client. */
export const DUPLICATE_DECISION_MAX_GROUPS = 5000;

/** One group of a duplicate decision job, as the client submits it and the snapshot stores it. */
export type DuplicateGroupDecision = {
  duplicateId: string;
  decision: DuplicateDecisionKind;
  /** Every photo of the group the owner reviewed. Compared with the group when the job reaches it. */
  memberIds: string[];
  /** The photos to keep; for a stack, the first is the stack's cover. Ignored by `keep-all`. */
  keepAssetIds: string[];
  /** For an undo job only: the recorded decision to reverse. */
  decisionId?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const DECISIONS = new Set<string>(Object.values(DuplicateDecisionKind));

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];

/**
 * Read the groups of a decision job back out of a snapshot payload. Malformed entries are dropped
 * rather than guessed at; `duplicateDecisionProblem` refuses a submission that has any.
 */
export const parseDuplicateGroups = (value: unknown): DuplicateGroupDecision[] =>
  Array.isArray(value)
    ? value.filter(isRecord).flatMap((group) => {
        const { duplicateId, decision, decisionId } = group;
        if (typeof duplicateId !== 'string' || typeof decision !== 'string' || !DECISIONS.has(decision)) {
          return [];
        }
        return [
          {
            duplicateId,
            decision: decision as DuplicateDecisionKind,
            memberIds: [...new Set(strings(group.memberIds))],
            keepAssetIds: [...new Set(strings(group.keepAssetIds))],
            ...(typeof decisionId === 'string' && decisionId && { decisionId }),
          },
        ];
      })
    : [];

/** The photos a decision moves to the trash: every member that is not kept, for `keepers` only. */
export const duplicateTrashIds = (group: Pick<DuplicateGroupDecision, 'decision' | 'memberIds' | 'keepAssetIds'>) => {
  if (group.decision !== DuplicateDecisionKind.Keepers) {
    return [];
  }
  const keep = new Set(group.keepAssetIds);
  return group.memberIds.filter((id) => !keep.has(id));
};

/** The stack's cover: the first keeper that is a member, or the first member. */
export const duplicateStackPrimary = (group: Pick<DuplicateGroupDecision, 'memberIds' | 'keepAssetIds'>) =>
  group.keepAssetIds.find((id) => group.memberIds.includes(id)) ?? group.memberIds[0];

/**
 * Why one group's decision cannot run, or null when it can. Checked at submit, so a malformed
 * decision is a 400 to the person who made it, never a trashed photo.
 */
export const duplicateGroupProblem = (group: DuplicateGroupDecision): string | null => {
  if (group.memberIds.length < 2) {
    return 'A duplicate group needs at least two photos';
  }
  if (group.keepAssetIds.some((id) => !group.memberIds.includes(id))) {
    return 'Keepers must be photos of the same group';
  }
  if (group.decision === DuplicateDecisionKind.Keepers && group.keepAssetIds.length === 0) {
    return 'Choose at least one photo to keep';
  }
  return null;
};

/**
 * Why the groups of a decision job cannot run, or null when they can.
 *
 * The job's frozen asset set must be exactly the members of its groups, each group whole and in one
 * place: that is what lets the worker's cursor, which counts assets, move one complete group at a
 * time. An undo job names the recorded decision each group reverses.
 */
export const duplicateDecisionProblem = (
  groups: readonly DuplicateGroupDecision[],
  assetIds: readonly string[],
  { undo }: { undo: boolean },
): string | null => {
  if (groups.length === 0) {
    return 'At least one duplicate group is required for this action';
  }
  if (groups.length > DUPLICATE_DECISION_MAX_GROUPS) {
    return `At most ${DUPLICATE_DECISION_MAX_GROUPS} duplicate groups can be decided at once`;
  }

  const seenGroups = new Set<string>();
  const seenAssets = new Set<string>();
  for (const group of groups) {
    if (seenGroups.has(group.duplicateId)) {
      return 'Each duplicate group can only be decided once in a job';
    }
    seenGroups.add(group.duplicateId);

    const problem = duplicateGroupProblem(group);
    if (problem) {
      return problem;
    }
    if (undo && !group.decisionId) {
      return 'Undo needs the decision it reverses';
    }
    for (const id of group.memberIds) {
      if (seenAssets.has(id)) {
        return 'A photo can only belong to one duplicate group';
      }
      seenAssets.add(id);
    }
  }

  const ordered = duplicateGroupAssetIds(groups);
  if (ordered.length !== assetIds.length || ordered.some((id, index) => id !== assetIds[index])) {
    return 'The photos of the job must be the photos of its groups, group by group';
  }
  return null;
};

/** The job's frozen asset set for these groups: every member, group by group, in order. */
export const duplicateGroupAssetIds = (groups: readonly Pick<DuplicateGroupDecision, 'memberIds'>[]): string[] =>
  groups.flatMap((group) => group.memberIds);

/** Which group each asset of a decision job belongs to. */
export const duplicateGroupIndex = (
  groups: readonly Pick<DuplicateGroupDecision, 'duplicateId' | 'memberIds'>[],
): Map<string, string> => {
  const index = new Map<string, string>();
  for (const group of groups) {
    for (const id of group.memberIds) {
      index.set(id, group.duplicateId);
    }
  }
  return index;
};

/**
 * How many ids from `start` the next batch takes: up to `size`, then on to the end of the group the
 * last one belongs to. A group larger than a batch is taken whole. Ids with no group (never the case
 * for a well-formed job) end the batch where they fall.
 */
export const groupAlignedBatchSize = (
  ids: readonly string[],
  start: number,
  size: number,
  groupOf: ReadonlyMap<string, string>,
): number => {
  if (start >= ids.length) {
    return 0;
  }
  let end = Math.min(ids.length, start + Math.max(1, size));
  const last = groupOf.get(ids[end - 1]);
  while (last !== undefined && end < ids.length && groupOf.get(ids[end]) === last) {
    end += 1;
  }
  return end - start;
};

/* -------------------------------------------------------------------------- */
/* How a group reads                                                            */
/* -------------------------------------------------------------------------- */

type ReviewAsset = Pick<AssetResponseDto, 'id' | 'type' | 'localDateTime' | 'originalFileName' | 'exifInfo'>;

const captureTime = (asset: ReviewAsset): number | null => {
  const value = asset.exifInfo?.dateTimeOriginal ?? asset.localDateTime;
  const time = value ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? time : null;
};

/**
 * Copies of one photo, or frames of a burst.
 *
 * A burst is photos (never videos) captured at distinct instants within `DUPLICATE_BURST_SECONDS` of
 * one another. Copies of one photo share their capture time — an export, a resized share, a RAW and
 * its JPEG — so any two members captured at the same instant make the group read as copies.
 */
export const classifyDuplicateGroup = (assets: readonly ReviewAsset[]): DuplicateGroupKind => {
  if (assets.length < 2 || assets.some((asset) => asset.type !== AssetType.Image)) {
    return DuplicateGroupKind.Duplicates;
  }
  const times = assets.map((asset) => captureTime(asset));
  if (times.includes(null)) {
    return DuplicateGroupKind.Duplicates;
  }
  const values = times as number[];
  if (new Set(values).size !== values.length) {
    return DuplicateGroupKind.Duplicates;
  }
  const span = Math.max(...values) - Math.min(...values);
  return span <= DUPLICATE_BURST_SECONDS * 1000 ? DuplicateGroupKind.Burst : DuplicateGroupKind.Duplicates;
};

const pixels = (asset: ReviewAsset) => (asset.exifInfo?.exifImageWidth ?? 0) * (asset.exifInfo?.exifImageHeight ?? 0);
const bytes = (asset: ReviewAsset) => asset.exifInfo?.fileSizeInByte ?? 0;

/**
 * The evidence behind a suggestion, per photo: what makes one copy the better original and another
 * the lesser copy. Only differences are reported — a group of identical files says nothing — and the
 * reasons are keys the client translates.
 */
export const duplicateQualityReasons = (assets: readonly ReviewAsset[]): Map<string, DuplicateQualityReason[]> => {
  const reasons = new Map<string, DuplicateQualityReason[]>(assets.map((asset) => [asset.id, []]));
  if (assets.length < 2) {
    return reasons;
  }

  const ranks = assets.map((asset) => getFormatRank(asset as AssetResponseDto));
  const topRank = Math.max(...ranks);
  const lowRank = Math.min(...ranks);
  const sizes = assets.map((asset) => bytes(asset));
  const areas = assets.map((asset) => pixels(asset));
  const counts = assets.map((asset) => getExifCount(asset as AssetResponseDto));

  for (const [index, asset] of assets.entries()) {
    const list = reasons.get(asset.id) as DuplicateQualityReason[];
    if (topRank !== lowRank) {
      list.push(
        ranks[index] === topRank ? DuplicateQualityReason.OriginalFormat : DuplicateQualityReason.CompressedCopy,
      );
    }
    if (areas[index] > 0 && Math.min(...areas) !== Math.max(...areas)) {
      list.push(
        areas[index] === Math.max(...areas)
          ? DuplicateQualityReason.HighestResolution
          : DuplicateQualityReason.LowerResolution,
      );
    }
    if (sizes[index] > 0 && sizes[index] === Math.max(...sizes) && Math.min(...sizes) !== Math.max(...sizes)) {
      list.push(DuplicateQualityReason.LargestFile);
    }
    if (counts[index] === Math.max(...counts) && Math.min(...counts) !== Math.max(...counts)) {
      list.push(DuplicateQualityReason.MostMetadata);
    }
  }

  return reasons;
};
