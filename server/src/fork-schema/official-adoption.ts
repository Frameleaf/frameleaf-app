import { Kysely, sql } from 'kysely';
import {
  CERTIFIED_TAG_MIGRATIONS,
  GENERIC_LEGACY_FORK_MIGRATIONS,
  LEGACY_FORK_MIGRATIONS,
  POST_CERTIFIED_UPSTREAM_MIGRATIONS,
} from 'src/fork-schema/migration-manifest.js';
import { up as indexMlAccountingJobs } from 'src/fork-schema/migrations/0000000000170-MlWorkloadAccountingJobIndex.js';
import { up as addRenderSessionOutputEvidence } from 'src/fork-schema/migrations/0000000000172-RenderSessionOutputEvidence.js';
import { up as indexMlAccountingCloudJobs } from 'src/fork-schema/migrations/0000000000201-MlWorkloadAccountingCloudJobIndex.js';
import supportedVersions from 'src/fork-schema/supported-versions.json' with { type: 'json' };
import { LEGACY_WORKFLOW_MIGRATION, WorkflowCompatibility } from 'src/fork-schema/workflow-compatibility.js';

/**
 * FL-44: adopting a library the official server created.
 *
 * The first Frameleaf boot on an official v3.1.0 database (`official-origin`) runs only the certified
 * official provider and the isolated `immich_fork` migrations, so the public schema stays byte-exact
 * with the certified tag and the official server can still take the library back without a cutover.
 * That library is not yet a Frameleaf library: the post-certified upstream migrations (e.g.
 * `1787148183729-ClusterGroups`) and every Frameleaf public migration (`2100…`) are missing, and
 * `immich_fork.state` is `inactive` / schema version `1`.
 *
 * `immich-admin fork-schema adopt` closes that gap in one transaction: it applies the missing
 * post-certified migrations through their registered applies and the Frameleaf public migrations in
 * name order (never the Frameleaf copy of the workflow rewrite, whose official original already ran),
 * repeats the parts of `immich_fork` migrations that only act when a Frameleaf public table exists,
 * and moves the state to `legacy`, the phase a fresh Frameleaf install starts in. From there the
 * normal compatibility backfill (`fork-schema start`) and the certified handoff apply unchanged.
 */
export const OFFICIAL_ADOPTION_AUDIT = 'official-origin-adoption';

export type OfficialAdoptionResult = {
  /** False when the library had already been adopted and nothing changed. */
  adopted: boolean;
  /** Migration names adoption recorded in the official ledger, in the order it applied them. */
  applied: string[];
};

const RESIDUE_ORDER: readonly string[] = supportedVersions.postCertifiedUpstreamMigrations;

/**
 * The adoptable ledger is the exact certified tag, optionally followed by an ordered prefix of the
 * post-certified upstream migrations (an official server newer than the certified tag), and nothing
 * else.
 */
export const assertAdoptableOfficialLedger = (ledger: readonly string[]): void => {
  const legacy = ledger.filter((name) => LEGACY_FORK_MIGRATIONS.has(name));
  if (legacy.length > 0) {
    throw new Error(`Library already holds Frameleaf migrations: ${legacy.join(', ')}`);
  }
  const allowed = [...CERTIFIED_TAG_MIGRATIONS, ...RESIDUE_ORDER];
  const exact =
    ledger.length >= CERTIFIED_TAG_MIGRATIONS.length &&
    ledger.length <= allowed.length &&
    ledger.every((name, index) => name === allowed[index]);
  if (!exact) {
    throw new Error(
      'Adoption requires the exact certified v3.1.0 migration ledger; upgrade the official server to v3.1.0 and start it once first',
    );
  }
};

/**
 * The migrations adoption applies: every bundled migration the ledger lacks, in name order (the
 * order a fresh install applies them relative to each other). Only post-certified upstream and
 * Frameleaf public migrations may be pending, and every Frameleaf public migration must be.
 */
export const planOfficialAdoption = (ledger: readonly string[], bundled: readonly string[]): string[] => {
  assertAdoptableOfficialLedger(ledger);
  if (bundled.includes(LEGACY_WORKFLOW_MIGRATION)) {
    throw new Error(`Adoption must never run ${LEGACY_WORKFLOW_MIGRATION}; its official original already ran`);
  }
  const applied = new Set(ledger);
  const pending = bundled.filter((name) => !applied.has(name)).toSorted();
  const unexpected = pending.filter(
    (name) => !POST_CERTIFIED_UPSTREAM_MIGRATIONS.has(name) && !GENERIC_LEGACY_FORK_MIGRATIONS.has(name),
  );
  if (unexpected.length > 0) {
    throw new Error(`Adoption found unexpected pending migration(s): ${unexpected.join(', ')}`);
  }
  const pendingSet = new Set(pending);
  const missing = [
    ...[...GENERIC_LEGACY_FORK_MIGRATIONS].filter((name) => !pendingSet.has(name)),
    ...RESIDUE_ORDER.filter((name) => !applied.has(name) && !pendingSet.has(name)),
  ];
  if (missing.length > 0) {
    throw new Error(`Adoption is missing bundled migration(s): ${missing.join(', ')}`);
  }
  return pending;
};

/**
 * Workflow and plugin data crosses adoption unchanged. `1786741078327-AddWorkflowLogsTable` appends
 * `workflow.logging`, so the workflow rows' digest legitimately changes and only their count is
 * compared; plugins, methods and steps must be byte-identical.
 */
export const assertWorkflowDataPreserved = (before: WorkflowCompatibility, after: WorkflowCompatibility): void => {
  if (before.mode !== 'official' || after.mode !== 'official' || before.timestamp !== after.timestamp) {
    throw new Error('Adoption changed the workflow migration marker');
  }
  const beforeByTable = new Map(before.rowDigests.map((row) => [row.table, row]));
  const changed = after.rowDigests.filter((row) => {
    const previous = beforeByTable.get(row.table);
    return (
      !previous || previous.count !== row.count || (row.table !== 'public.workflow' && previous.digest !== row.digest)
    );
  });
  if (changed.length > 0 || after.rowDigests.length !== before.rowDigests.length) {
    throw new Error(`Adoption changed workflow data: ${changed.map(({ table }) => table).join(', ')}`);
  }
};

/**
 * Parts of released `immich_fork` migrations that only act once the Frameleaf public schema exists.
 * They ran at the first boot, before adoption created those tables and columns, so they are repeated
 * here, after every adoption migration (ClusterGroups included):
 *
 * - 0000000000170, 0000000000172 and 0000000000201: their `up` functions are idempotent and run as
 *   released.
 * - 0000000000176: it also creates a fork table that already exists, so only its `pet_observation`
 *   statement is repeated.
 * - 0000000000175: its carry-over of earlier face decisions needs `asset_face.personGroupId`, which
 *   ClusterGroups creates. An official library has no `correctedAt`, so the carry-over reduces to the
 *   faces the owner removed (soft-deleted, `deletedAt`), recorded as `remove` decisions exactly as
 *   0000000000175 records them. Faces already recorded are skipped.
 *
 * Returns the number of face decisions carried over.
 */
export async function applyAdoptionForkFollowUps(db: Kysely<any>): Promise<{ faceDecisions: number }> {
  await indexMlAccountingJobs(db);
  await addRenderSessionOutputEvidence(db);
  await sql`
    ALTER TABLE public.pet_observation
      ADD COLUMN IF NOT EXISTS "sourceChecksum" bytea,
      ADD COLUMN IF NOT EXISTS "staleAt" timestamp with time zone
  `.execute(db);
  const faceDecisions = await sql`
    INSERT INTO immich_fork.face_correction
      ("ownerId", "actorId", action, "faceId", "assetId", "assetChecksum", "boxX1", "boxY1", "boxX2", "boxY2",
       "fromPersonId", "toPersonId", "toPersonName", "createdAt")
    SELECT asset."ownerId", asset."ownerId", 'remove', face.id, face."assetId", asset.checksum,
      face."boundingBoxX1"::float8 / face."imageWidth", face."boundingBoxY1"::float8 / face."imageHeight",
      face."boundingBoxX2"::float8 / face."imageWidth", face."boundingBoxY2"::float8 / face."imageHeight",
      face."personGroupId", NULL, NULL, face."deletedAt"
    FROM public.asset_face face
    INNER JOIN public.asset asset ON asset.id = face."assetId"
    WHERE face."deletedAt" IS NOT NULL
      AND face."imageWidth" > 0 AND face."imageHeight" > 0
      AND NOT EXISTS (
        SELECT 1 FROM immich_fork.face_correction recorded
        WHERE recorded."faceId" = face.id AND recorded.action = 'remove'
      )
  `.execute(db);
  await indexMlAccountingCloudJobs(db);
  return { faceDecisions: Number(faceDecisions.numAffectedRows ?? 0) };
}

type StepCounter = { relations: readonly string[]; query: string };

const count = (relations: readonly string[], query: string): StepCounter => ({ relations, query });

const lockedFolderAssets = count(
  ['public.asset'],
  `SELECT count(*)::int AS count FROM public.asset WHERE visibility::text = 'locked'`,
);
const albumsWithoutCover = count(
  ['public.album'],
  `SELECT count(*)::int AS count FROM public.album WHERE "albumThumbnailAssetId" IS NULL`,
);
const peopleWithoutThumbnail = count(
  ['public.person'],
  `SELECT count(*)::int AS count FROM public.person WHERE "thumbnailPath" = ''`,
);

/**
 * References to Locked assets that the cover repairs replace. 2100000000290 and 2100000000300 read
 * Locked as the official Locked folder (`visibility = locked`); 2100000000320 reads it as a lock
 * record (`asset_lock`), so its counters are keyed on the lock records.
 */
const lockedReferences = (locked: { relations: readonly string[]; ids: string }) => ({
  lockedAlbumCovers: count(
    ['public.album', ...locked.relations],
    `SELECT count(*)::int AS count FROM public.album WHERE "albumThumbnailAssetId" IN (${locked.ids})`,
  ),
  lockedFaceThumbnails: count(
    ['public.person', 'public.asset_face', ...locked.relations],
    `SELECT count(*)::int AS count FROM public.person person
     JOIN public.asset_face face ON face.id = person."faceAssetId"
     WHERE face."assetId" IN (${locked.ids})`,
  ),
  lockedSharedSpaceCovers: count(
    ['public.shared_space_person', ...locked.relations],
    `SELECT count(*)::int AS count FROM public.shared_space_person WHERE "coverAssetId" IN (${locked.ids})`,
  ),
  lockedPetCovers: count(
    ['public.pet', ...locked.relations],
    `SELECT count(*)::int AS count FROM public.pet WHERE "featuredAssetId" IN (${locked.ids})`,
  ),
});
const lockedFolderReferences = lockedReferences({
  relations: ['public.asset'],
  ids: `SELECT id FROM public.asset WHERE visibility::text = 'locked'`,
});
const lockRecordReferences = lockedReferences({
  relations: ['public.asset_lock'],
  ids: `SELECT "assetId" FROM public.asset_lock`,
});

/**
 * What each adoption migration that changes or deletes existing official data touched, as row counts
 * taken right before and right after it inside the adoption transaction. The migrations expose no
 * counts of their own, so the affected tables are counted. Recorded in the adoption audit row.
 */
export const ADOPTION_STEP_COUNTERS: Readonly<Record<string, Readonly<Record<string, StepCounter>>>> = {
  '1786385711807-AlbumOwnerDeleteTrigger': {
    albums: count(['public.album'], `SELECT count(*)::int AS count FROM public.album`),
    ownerlessAlbums: count(
      ['public.album', 'public.album_user'],
      `SELECT count(*)::int AS count FROM public.album album
       WHERE NOT EXISTS (
         SELECT 1 FROM public.album_user owner WHERE owner."albumId" = album.id AND owner.role = 'owner'
       )`,
    ),
  },
  '1786972746372-AssetOcrSyncReset': {
    ocrSyncCheckpoints: count(
      ['public.session_sync_checkpoint'],
      `SELECT count(*)::int AS count FROM public.session_sync_checkpoint WHERE type = 'AssetOcrV1'`,
    ),
  },
  '1787148183729-ClusterGroups': {
    people: count(['public.person'], `SELECT count(*)::int AS count FROM public.person`),
    personGroups: count(['public.person_group'], `SELECT count(*)::int AS count FROM public.person_group`),
    clusterGroups: count(['public.cluster_group'], `SELECT count(*)::int AS count FROM public.cluster_group`),
  },
  '1787148183730-DeleteMismatchedMemoryAssets': {
    memoryAssets: count(['public.memory_asset'], `SELECT count(*)::int AS count FROM public.memory_asset`),
    crossOwnerMemoryAssets: count(
      ['public.memory_asset', 'public.memory', 'public.asset'],
      `SELECT count(*)::int AS count FROM public.memory_asset link
       JOIN public.memory memory ON memory.id = link."memoriesId"
       JOIN public.asset asset ON asset.id = link."assetId"
       WHERE memory."ownerId" <> asset."ownerId"`,
    ),
  },
  '2100000000290-ClearLockedAlbumCovers': { ...lockedFolderReferences, albumsWithoutCover },
  '2100000000300-ClearLockedCoverReferences': {
    ...lockedFolderReferences,
    albumsWithoutCover,
    peopleWithoutThumbnail,
  },
  '2100000000320-AddAssetLock': {
    lockedFolderAssets,
    assetLocks: count(['public.asset_lock'], `SELECT count(*)::int AS count FROM public.asset_lock`),
    ...lockRecordReferences,
    albumsWithoutCover,
    peopleWithoutThumbnail,
  },
};

/** Counts for one step; a counter whose tables do not exist yet reads `null`. */
export async function countAdoptionStep(
  db: Kysely<any>,
  name: string,
): Promise<Record<string, number | null> | undefined> {
  const counters = ADOPTION_STEP_COUNTERS[name];
  if (!counters) {
    return undefined;
  }
  const result: Record<string, number | null> = {};
  for (const [key, { relations, query }] of Object.entries(counters)) {
    const present = await sql<{ present: boolean }>`
      SELECT bool_and(to_regclass(relation) IS NOT NULL) AS present FROM unnest(${[...relations]}::text[]) AS relation
    `.execute(db);
    result[key] = present.rows[0]?.present
      ? ((await sql.raw<{ count: number }>(query).execute(db)).rows[0]?.count ?? 0)
      : null;
  }
  return result;
}
