import { type Kysely } from 'kysely';
import type { DB } from 'src/schema/index.js';
import type { HiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import type { LockedVisibilityOptions } from 'src/utils/locked-visibility.js';
import { recentWorkScope } from 'src/queue/recent-work.js';
import { causeRank, singleMessage } from 'src/queue/run-failure-cause.js';
import {
  type FailureScope,
  type RunFailureGroup,
  failureRoots,
  groupRoots,
  needsLook,
  runCountsPhotos,
} from 'src/queue/run-query.js';
import { anyUuid, lockedOwnerScope, withHiddenContentFilter } from 'src/utils/database.js';

/** What the reader may see of photos: the Library care list's rules (`MediaHealthService.privacyFor`). */
export type RunFailurePrivacy = HiddenContentQueryOptions & LockedVisibilityOptions;
export const RUN_FAILURE_SAMPLES = 6;

export type RunFailureSample = { assetId: string; fileName: string; ownerId: string; ownerName: string };
export type RunFailureReview = {
  /** photos left over, stopped ones included */
  photos: number;
  countsPhotos: boolean;
  causes: Array<RunFailureGroup & { message: string | null; samples: RunFailureSample[] }>;
  /** FL-1430 (`foldNightly`): photos left over here that newer work left over again, counted on its card */
  superseded: number;
};

/**
 * FL-1430: whose left-over photos are reviewed: as Recent work's card counts them (`foldNightly`: the same scope as
 * `listRecentWork`), or the run alone, as before. Undefined for an unknown run.
 */
export async function failureScopeOf(db: Kysely<DB>, runId: string, foldNightly = false) {
  if (foldNightly) return (await recentWorkScope(db, runId))?.scope;
  const countsPhotos = await runCountsPhotos(db, runId);
  return countsPhotos === undefined ? undefined : ({ runs: [{ id: runId, countsPhotos }] } satisfies FailureScope);
}

/**
 * FL-1349: a run's left-over photos by cause for the review sheet. The counts are the run's work, every account's
 * photos included; the samples (and the one raw message) only come from photos the reader may see: not in Trash,
 * not someone else's Locked media, nothing the reader's hidden-content settings hide. The message is from a job that
 * isn't `sensitive`, on one of those sample photos. One read of the scope's left-over photos serves all of it.
 */
export async function reviewRunFailures(
  db: Kysely<DB>,
  runId: string,
  privacy: RunFailurePrivacy,
  foldNightly = false,
): Promise<RunFailureReview | undefined> {
  const scope = await failureScopeOf(db, runId, foldNightly);
  if (!scope) return;
  const countsPhotos = scope.runs.some((run) => run.countsPhotos);
  const roots = await failureRoots(db, scope);
  const groups = groupRoots(roots);

  const causes: RunFailureReview['causes'] = [];
  for (const group of groups) {
    // the photos still needing a look; once all are stopped, the stopped ones
    const stopped = group.count === 0;
    const candidates = roots.filter(
      (row) => row.rooted && row.rank === causeRank(group.cause) && (stopped ? row.stopped : needsLook(row)),
    );
    const ids = candidates.flatMap(({ assetId }) => (assetId ? [assetId] : []));
    const samples = ids.length === 0 ? [] : await visibleSamples(db, ids, privacy);
    const messages = new Map(candidates.map(({ assetId, message }) => [assetId, message]));
    // FL-1482: work that is no photo's (a backup, a sync, housekeeping) has no sample to speak for it, and nobody's
    // photo to keep private: its own message is shown. Only when none of the group is a photo's.
    const message = singleMessage(
      samples.map(({ assetId }) => messages.get(assetId)).find((text) => !!text) ??
        (ids.length === 0 ? candidates.find(({ message }) => !!message)?.message : null) ??
        null,
    );
    causes.push({ ...group, message, samples });
  }
  return {
    photos: groups.reduce((sum, group) => sum + group.count + group.stopped, 0),
    countsPhotos,
    causes,
    superseded: groups.reduce((sum, group) => sum + group.superseded, 0),
  };
}

const visibleSamples = (db: Kysely<DB>, ids: string[], privacy: RunFailurePrivacy): Promise<RunFailureSample[]> =>
  db
    .selectFrom('asset')
    .innerJoin('user', 'user.id', 'asset.ownerId')
    .select(['asset.id as assetId', 'asset.originalFileName as fileName', 'asset.ownerId', 'user.name as ownerName'])
    .where('asset.id', '=', anyUuid(ids))
    .where('asset.deletedAt', 'is', null)
    .where((eb) => lockedOwnerScope(eb, privacy.lockedOwnerId))
    .$call((qb) => withHiddenContentFilter(qb, privacy))
    .orderBy('asset.originalFileName')
    .orderBy('asset.id')
    .limit(RUN_FAILURE_SAMPLES)
    .execute();
