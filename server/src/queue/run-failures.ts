import { type Kysely, sql } from 'kysely';
import type { DB } from 'src/schema/index.js';
import type { HiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import type { LockedVisibilityOptions } from 'src/utils/locked-visibility.js';
import { causeRank, singleMessage } from 'src/queue/run-failure-cause.js';
import {
  type FailureScope,
  type RunFailureGroup,
  nightOf,
  runCountsPhotos,
  runFailureTasks,
  summarizeRunFailures,
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
 * FL-1430: whose left-over photos a Recent work card counts (`foldNightly`): a folded night's runs together, and
 * none a newer run left over again. Without it: the run alone, as before. Undefined for an unknown run.
 */
export async function failureScopeOf(db: Kysely<DB>, runId: string, foldNightly = false) {
  const ids = foldNightly ? await nightOf(db, runId) : [runId];
  if (!ids) return;
  const runs: FailureScope['runs'] = [];
  for (const id of ids) {
    const countsPhotos = await runCountsPhotos(db, id);
    if (countsPhotos !== undefined) runs.push({ id, countsPhotos });
  }
  return runs.length > 0 ? { runs, supersede: foldNightly } : undefined;
}

/**
 * FL-1349: a run's left-over photos by cause for the review sheet. The counts are the run's work, every account's
 * photos included; the samples (and the one raw message) only come from photos the reader may see: not in Trash,
 * not someone else's Locked media, nothing the reader's hidden-content settings hide. The message is from a job that
 * isn't `sensitive`, on one of those sample photos.
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
  const groups = await summarizeRunFailures(db, scope);
  const photoScope = { ...scope, runs: scope.runs.filter((run) => run.countsPhotos) };
  const { rows: roots } =
    photoScope.runs.length > 0
      ? await sql<{
          root: string;
          assetId: string | null;
          rank: number;
          stopped: boolean;
          superseded: boolean;
          message: string | null;
        }>`
        select t.root, t."assetId", t."photoRank" rank, t."photoStopped" stopped, t."photoSuperseded" superseded,
          (array_agg(t.error order by t."jobId") filter (where not t.sensitive and t.error is not null
            and t.rank = t."photoRank"))[1] message
        from (${runFailureTasks(photoScope)}) t
        group by t.root, t."assetId", t."photoRank", t."photoStopped", t."photoSuperseded"`.execute(db)
      : { rows: [] };

  const causes: RunFailureReview['causes'] = [];
  for (const group of groups) {
    // the photos still needing a look; once all are stopped, the stopped ones
    const stopped = group.count === 0;
    const candidates = roots.filter(
      (row) => row.rank === causeRank(group.cause) && row.stopped === stopped && (stopped || !row.superseded),
    );
    const ids = candidates.flatMap(({ assetId }) => (assetId ? [assetId] : []));
    const samples = ids.length === 0 ? [] : await visibleSamples(db, ids, privacy);
    const messages = new Map(candidates.map(({ assetId, message }) => [assetId, message]));
    const message = singleMessage(samples.map(({ assetId }) => messages.get(assetId)).find((text) => !!text) ?? null);
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
