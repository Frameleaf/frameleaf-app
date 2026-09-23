import {
  DuplicateDecisionKind,
  DuplicateGroupKind,
  MediaOperationStatus,
  type DuplicateDecisionBatchDto,
  type DuplicateReviewGroupDto,
  type MediaOperationDetailDto,
  type MediaOperationDuplicateGroupDto,
} from '@immich/sdk';
import type { Translations } from 'svelte-i18n';
import { durableItemStates } from '$lib/frameleaf/bulk-operations';

/**
 * The fast duplicate review (FL-61), ported from the design template's `duplicate-review.mjs` and
 * `DuplicateReview.jsx` with the prototype's local store replaced by the server.
 *
 * The server owns every rule that matters: which groups exist and whether this session may decide
 * them, the keeper suggestion and its evidence, and the decision itself, which runs as a durable
 * bulk job (`resolve-duplicates`) and is undone by another (`undo-duplicates`). What lives here is
 * the page's arithmetic: which groups a filter shows, what a decision sends, where the queue goes
 * next, and how a running job reads on a group's tile.
 */

/** Height of one row of the virtualised queue, in pixels. The prototype's 68. */
export const DUPLICATE_QUEUE_ROW_HEIGHT = 68;
/** Frames shown per page of a contact sheet. */
export const DUPLICATE_FRAME_PAGE_SIZE = 48;
/** What one decision job accepts; larger selections are split into several jobs, in order. */
export const DUPLICATE_DECISION_MAX_GROUPS = 5000;
export const DUPLICATE_DECISION_MAX_ITEMS = 50_000;
/** How many undoable decisions the page keeps within reach. */
export const DUPLICATE_UNDO_LIMIT = 20;

/** What the person chose. `suggested` and `keeper` are both a `keepers` decision on the server. */
export type ReviewDecision = 'suggested' | 'keeper' | 'keepers' | 'keep-all' | 'stack';

/** `open` is "Needs attention"; `all` also shows groups decided in this session and blocked ones. */
export type ReviewFilter = 'open' | 'all';

/** A group's tile while a job works on it, and after. Absent means nothing is happening to it. */
export type GroupProgress = { state: 'pending' } | { state: 'failed'; reasonKey: Translations } | { state: 'done' };

export type ReviewGroup = DuplicateReviewGroupDto;
type Asset = ReviewGroup['assets'][number];

export const isBurst = (group: Pick<ReviewGroup, 'kind'> | undefined): boolean =>
  group?.kind === DuplicateGroupKind.Burst;

/** A burst, or more than two copies, is reviewed as a contact sheet with several keepers. */
export const usesContactSheet = (group: Pick<ReviewGroup, 'kind' | 'assets'> | undefined): boolean =>
  !!group && (isBurst(group) || group.assets.length > 2);

export const groupTitle = (group: Pick<ReviewGroup, 'assets' | 'duplicateId'>): string =>
  group.assets[0]?.originalFileName?.replace(/\.[^.]+$/, '') || group.duplicateId;

/** The one suggested keeper, or null: never for a burst, and never a guess between two. */
export const suggestedKeeper = (group: Pick<ReviewGroup, 'kind' | 'suggestedKeepAssetIds' | 'assets'>) => {
  if (isBurst(group) || group.suggestedKeepAssetIds.length !== 1) {
    return null;
  }
  const [id] = group.suggestedKeepAssetIds;
  return group.assets.some((asset) => asset.id === id) ? id : null;
};

/** Whether the person can decide the group now: theirs to decide, and nothing already working on it. */
export const isActionable = (group: Pick<ReviewGroup, 'editable'>, progress?: GroupProgress): boolean =>
  group.editable && progress?.state !== 'pending' && progress?.state !== 'done';

export const canSuggest = (group: ReviewGroup, progress?: GroupProgress): boolean =>
  isActionable(group, progress) && suggestedKeeper(group) !== null;

/**
 * The groups a filter shows, in the queue's order: groups the person can decide first, in the
 * server's order. A query matches names and kinds; it never narrows a group to some of its photos —
 * a group is always reviewed whole.
 */
export const filterReviewGroups = (
  groups: readonly ReviewGroup[],
  {
    query = '',
    filter = 'open',
    progress,
  }: { query?: string; filter?: ReviewFilter; progress: ReadonlyMap<string, GroupProgress> },
): ReviewGroup[] => {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const shown = groups.filter((group) => {
    if (filter === 'open' && progress.get(group.duplicateId)?.state === 'done') {
      return false;
    }
    if (terms.length === 0) {
      return true;
    }
    const searchable = [group.duplicateId, group.kind, ...group.assets.map((asset) => asset.originalFileName)]
      .join(' ')
      .toLocaleLowerCase();
    return terms.every((term) => searchable.includes(term));
  });
  return [...shown.filter((group) => group.editable), ...shown.filter((group) => !group.editable)];
};

export class DuplicateDecisionError extends Error {
  constructor(readonly key: Translations) {
    super(key);
  }
}

/**
 * What one decision sends for each target group: the complete group as reviewed and the photos to
 * keep. Throws a `DuplicateDecisionError` with a translation key rather than guessing: a burst is never
 * decided by suggestion, a group with no single suggestion needs a choice, and a keeper must come
 * from its own group.
 */
export const buildDecisionGroups = (
  targets: readonly ReviewGroup[],
  decision: ReviewDecision,
  { keeperId, keeperIds = [] }: { keeperId?: string; keeperIds?: readonly string[] } = {},
): MediaOperationDuplicateGroupDto[] => {
  if (targets.length === 0) {
    throw new DuplicateDecisionError('frameleaf_duplicates_error_no_groups');
  }
  if ((decision === 'keeper' || decision === 'keepers') && targets.length !== 1) {
    throw new DuplicateDecisionError('frameleaf_duplicates_error_one_group');
  }

  return targets.map((group) => {
    if (!group.editable) {
      throw new DuplicateDecisionError('frameleaf_duplicates_error_not_editable');
    }
    const memberIds = group.assets.map((asset) => asset.id);
    const inGroup = (id: string) => memberIds.includes(id);

    switch (decision) {
      case 'suggested': {
        if (isBurst(group)) {
          throw new DuplicateDecisionError('frameleaf_duplicates_error_burst_suggestion');
        }
        const suggested = suggestedKeeper(group);
        if (!suggested) {
          throw new DuplicateDecisionError('frameleaf_duplicates_error_needs_choice');
        }
        return {
          duplicateId: group.duplicateId,
          decision: DuplicateDecisionKind.Keepers,
          memberIds,
          keepAssetIds: [suggested],
        };
      }
      case 'keeper': {
        if (!keeperId || !inGroup(keeperId)) {
          throw new DuplicateDecisionError('frameleaf_duplicates_error_keeper_outside');
        }
        return {
          duplicateId: group.duplicateId,
          decision: DuplicateDecisionKind.Keepers,
          memberIds,
          keepAssetIds: [keeperId],
        };
      }
      case 'keepers': {
        const keep = [...new Set(keeperIds)];
        if (keep.length === 0 || keep.some((id) => !inGroup(id))) {
          throw new DuplicateDecisionError('frameleaf_duplicates_error_keeper_outside');
        }
        return {
          duplicateId: group.duplicateId,
          decision: DuplicateDecisionKind.Keepers,
          memberIds,
          keepAssetIds: keep,
        };
      }
      case 'keep-all': {
        return {
          duplicateId: group.duplicateId,
          decision: DuplicateDecisionKind.KeepAll,
          memberIds,
          keepAssetIds: [],
        };
      }
      case 'stack': {
        // the stack's cover: the first chosen keeper, else the suggestion, else the server's first photo
        const cover = keeperIds.find((id) => inGroup(id)) ?? suggestedKeeper(group);
        return {
          duplicateId: group.duplicateId,
          decision: DuplicateDecisionKind.Stack,
          memberIds,
          keepAssetIds: cover ? [cover] : [],
        };
      }
    }
  });
};

/** The job's frozen asset set: every member, group by group. The server insists on exactly this. */
export const decisionAssetIds = (groups: readonly Pick<MediaOperationDuplicateGroupDto, 'memberIds'>[]): string[] =>
  groups.flatMap((group) => group.memberIds);

/** Split decisions into jobs the server accepts, in order, never splitting a group. */
export const decisionParts = <T extends Pick<MediaOperationDuplicateGroupDto, 'memberIds'>>(
  groups: readonly T[],
  { maxGroups = DUPLICATE_DECISION_MAX_GROUPS, maxItems = DUPLICATE_DECISION_MAX_ITEMS } = {},
): T[][] => {
  const parts: T[][] = [];
  let part: T[] = [];
  let items = 0;
  for (const group of groups) {
    if (part.length > 0 && (part.length >= maxGroups || items + group.memberIds.length > maxItems)) {
      parts.push(part);
      part = [];
      items = 0;
    }
    part.push(group);
    items += group.memberIds.length;
  }
  if (part.length > 0) {
    parts.push(part);
  }
  return parts;
};

/** What an undo sends for a decision job: every decision of it that is applied and not undone. */
export const undoGroupsFor = (batch: DuplicateDecisionBatchDto): MediaOperationDuplicateGroupDto[] =>
  batch.groups
    .filter((group) => group.applied && !group.undone && !group.undoing)
    .map((group) => ({
      duplicateId: group.duplicateId,
      decision: group.decision,
      memberIds: group.memberIds,
      keepAssetIds: group.keepAssetIds,
      decisionId: group.decisionId,
    }));

/** The undoable decision jobs, newest first, within reach. */
export const undoableBatches = (recent: readonly DuplicateDecisionBatchDto[]): DuplicateDecisionBatchDto[] =>
  recent.filter((batch) => batch.undoable && undoGroupsFor(batch).length > 0).slice(0, DUPLICATE_UNDO_LIMIT);

const FINISHED: ReadonlySet<MediaOperationStatus> = new Set([
  MediaOperationStatus.Completed,
  MediaOperationStatus.Cancelled,
  MediaOperationStatus.Failed,
]);

export const isFinishedOperation = (detail: Pick<MediaOperationDetailDto, 'status'>): boolean =>
  FINISHED.has(detail.status);

/**
 * Where each group of a decision job stands, read from the job itself (`durableItemStates`, the same
 * reading the library's tiles use). A group answers as one: every member of it gets the same
 * outcome, so any failed member is the group's failure and any pending member keeps its loader. A
 * group the job never reached because it was cancelled simply has nothing to show.
 */
export const groupProgressFrom = (
  groups: readonly Pick<MediaOperationDuplicateGroupDto, 'duplicateId' | 'memberIds'>[],
  detail: Pick<MediaOperationDetailDto, 'status' | 'processedUnits' | 'bulkItems' | 'bulkRetryPending' | 'bulk'>,
): Map<string, GroupProgress | null> => {
  const states = durableItemStates(decisionAssetIds(groups), detail);
  const progress = new Map<string, GroupProgress | null>();
  for (const group of groups) {
    const members = group.memberIds.map((id) => states.get(id) ?? { state: 'unchanged' as const });
    const failed = members.find((member) => member.state === 'failed');
    if (failed && failed.state === 'failed') {
      progress.set(group.duplicateId, { state: 'failed', reasonKey: failed.reasonKey });
    } else if (members.some((member) => member.state === 'pending')) {
      progress.set(group.duplicateId, { state: 'pending' });
    } else if (members.every((member) => member.state === 'done')) {
      progress.set(group.duplicateId, { state: 'done' });
    } else {
      progress.set(group.duplicateId, null);
    }
  }
  return progress;
};

/**
 * The next group in a stable order, skipping `excludeIds`. With `wrap` the queue is circular; without
 * it the ends stop. An unknown current id starts from the first (or last) eligible group.
 */
export const nextGroupId = (
  ids: readonly string[],
  currentId: string | undefined,
  {
    direction = 1,
    excludeIds = [],
    wrap = false,
  }: { direction?: 1 | -1; excludeIds?: readonly string[]; wrap?: boolean } = {},
): string | null => {
  const excluded = new Set(excludeIds);
  const current = currentId ? ids.indexOf(currentId) : -1;
  if (current === -1) {
    return (direction === 1 ? ids : [...ids].reverse()).find((id) => !excluded.has(id)) ?? null;
  }
  for (let distance = 1; distance <= ids.length; distance++) {
    const index = current + distance * direction;
    if (!wrap && (index < 0 || index >= ids.length)) {
      return null;
    }
    const id = ids[((index % ids.length) + ids.length) % ids.length];
    if (id !== currentId && !excluded.has(id)) {
      return id;
    }
  }
  return null;
};

/**
 * Toggle a keeper on a contact sheet. With `shift` and a previous choice, the whole range between the
 * two is added or removed together, as the prototype's shift-click does.
 */
export const toggleKeepers = (
  ids: readonly string[],
  keeperIds: readonly string[],
  index: number,
  { lastIndex = null, shift = false }: { lastIndex?: number | null; shift?: boolean } = {},
): string[] => {
  const id = ids[index];
  if (id === undefined) {
    return [...keeperIds];
  }
  const adding = !keeperIds.includes(id);
  const from = shift && lastIndex !== null ? Math.min(index, lastIndex) : index;
  const to = shift && lastIndex !== null ? Math.max(index, lastIndex) : index;
  const range = ids.slice(from, to + 1);
  return adding ? [...new Set([...keeperIds, ...range])] : keeperIds.filter((keeper) => !range.includes(keeper));
};

/** The review's keyboard map, as the prototype's shortcut panel lists it. */
export type ReviewShortcut =
  | { id: 'undo' | 'help' | 'next' | 'previous' | 'suggested' | 'keep-all' | 'stack' | 'keepers' }
  | { id: 'digit'; digit: number };

type KeyLike = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'repeat'>;

export const matchReviewShortcut = (event: KeyLike): ReviewShortcut | null => {
  if (event.repeat || event.altKey) {
    return null;
  }
  const key = event.key.toLowerCase();
  if (event.metaKey || event.ctrlKey) {
    return key === 'z' && !event.shiftKey ? { id: 'undo' } : null;
  }
  switch (key) {
    case '?': {
      return { id: 'help' };
    }
    case 'arrowright': {
      return { id: 'next' };
    }
    case 'arrowleft': {
      return { id: 'previous' };
    }
    case 'k': {
      return { id: 'suggested' };
    }
    case 'a': {
      return { id: 'keep-all' };
    }
    case 's': {
      return { id: 'stack' };
    }
    case 'e': {
      return { id: 'keepers' };
    }
  }
  return /^[1-9]$/.test(key) ? { id: 'digit', digit: Number(key) } : null;
};

const captureTime = (asset: Asset): number | null => {
  const value = asset.exifInfo?.dateTimeOriginal ?? asset.localDateTime;
  const time = value ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? time : null;
};

/** Seconds after the burst's first frame, for a burst's frame details. Null outside a burst. */
export const frameOffsetSeconds = (group: Pick<ReviewGroup, 'kind' | 'assets'>, asset: Asset): number | null => {
  if (!isBurst(group)) {
    return null;
  }
  const times = group.assets.map((member) => captureTime(member)).filter((time): time is number => time !== null);
  const time = captureTime(asset);
  return time === null || times.length === 0 ? null : (time - Math.min(...times)) / 1000;
};

/** A photo's pixel dimensions, or null when unknown. */
export const dimensionsOf = (asset: Asset): { width: number; height: number } | null => {
  const width = asset.exifInfo?.exifImageWidth ?? asset.width ?? null;
  const height = asset.exifInfo?.exifImageHeight ?? asset.height ?? null;
  return width && height ? { width, height } : null;
};

/** The label of one quality reason the server gives for a suggested keeper. */
export const qualityReasonKey = (reason: string): Translations =>
  `frameleaf_duplicates_quality_${reason.replaceAll('-', '_')}` as Translations;
