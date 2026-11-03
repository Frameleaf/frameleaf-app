import type { DuplicateDecisionBatchDto, IdenticalFilesRecentChangeDto } from '@frameleaf/sdk';

/** One automatic merge as the history lists it. */
export type MergedRow =
  | {
      kind: 'merge';
      key: string;
      at: string;
      batch: DuplicateDecisionBatchDto;
      duplicateId: string;
      keepId: string;
      photos: number;
      undone: boolean;
      undoable: boolean;
    }
  | { kind: 'link'; key: string; at: string; change: IdenticalFilesRecentChangeDto };

/** At most this many rows. */
export const MERGED_ROWS = 12;

/**
 * The history's rows, newest first: identical photos in one library Frameleaf merged into the oldest (the
 * owner's own decision jobs the run made, `automatic`), and photos that now share another person's
 * identical file (`changes`, an administrator's view).
 */
export const mergedRows = (
  recent: readonly DuplicateDecisionBatchDto[],
  changes: readonly IdenticalFilesRecentChangeDto[],
): MergedRow[] =>
  [
    ...recent
      .filter((batch) => batch.automatic)
      .flatMap((batch) =>
        batch.groups
          .filter((group) => group.applied || group.undone)
          .map((group): MergedRow => ({
            kind: 'merge',
            key: `merge:${group.decisionId}`,
            at: batch.createdAt,
            batch,
            duplicateId: group.duplicateId,
            keepId: group.keepAssetIds[0] ?? group.memberIds[0],
            photos: group.memberIds.length,
            undone: group.undone || group.undoing,
            undoable: group.applied && !group.undone && !group.undoing,
          })),
      ),
    ...changes.map((change): MergedRow => ({ kind: 'link', key: `link:${change.id}`, at: change.createdAt, change })),
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, MERGED_ROWS);
