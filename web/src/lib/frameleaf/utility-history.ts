import { MediaOperationKind, type MediaOperationDto } from '@immich/sdk';
import { fromMediaOperation, type ActivityItem } from '$lib/frameleaf/activity';

/**
 * "Recent utility activity" (FL-69, UT-11; UtilitiesManager.jsx:946-955): the template keeps one
 * history for every tool and shows its latest eight entries under each tool but Duplicate review.
 * Here that history is the viewer's own recent jobs of the kinds the utilities start: bulk changes
 * (relinked Live Photos, locations, trash, repairs), Library Care scans and searches, iCloud Photos
 * syncs and imports. Jobs are never shared, so another account's work never appears; a Locked item
 * is named generically by `fromMediaOperation`, never by its file.
 */
export const UTILITY_HISTORY_KINDS: ReadonlySet<MediaOperationKind> = new Set([
  MediaOperationKind.Bulk,
  MediaOperationKind.MediaHealth,
  MediaOperationKind.IcloudSync,
  MediaOperationKind.TakeoutImport,
  MediaOperationKind.LibraryScan,
]);

/** How many entries the history shows, as the template does. */
export const UTILITY_HISTORY_LIMIT = 8;

/** How many recent jobs the page asks for before keeping the utilities' own. */
export const UTILITY_HISTORY_FETCH = 50;

export const recentUtilityActivity = (operations: readonly MediaOperationDto[]): ActivityItem[] =>
  operations
    .filter((operation) => UTILITY_HISTORY_KINDS.has(operation.kind))
    .map((operation) => fromMediaOperation(operation))
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, UTILITY_HISTORY_LIMIT);
