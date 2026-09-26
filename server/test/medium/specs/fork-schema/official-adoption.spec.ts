import { Kysely, sql } from 'kysely';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  CERTIFIED_TAG_MIGRATIONS,
  GENERIC_LEGACY_FORK_MIGRATIONS,
  POST_CERTIFIED_UPSTREAM_MIGRATIONS,
} from 'src/fork-schema/migration-manifest.js';
import { OFFICIAL_ADOPTION_AUDIT, OfficialAdoptionResult } from 'src/fork-schema/official-adoption.js';
import {
  LEGACY_WORKFLOW_MIGRATION,
  OFFICIAL_WORKFLOW_MIGRATION,
  classifyWorkflowCompatibility,
  getWorkflowCompatibilityEvidence,
} from 'src/fork-schema/workflow-compatibility.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { getKyselyConfig } from 'src/utils/database.js';
import { restoreOfficialPublicSchema } from 'test/medium/specs/fork-schema/official-schema-fixture.js';
import { getKyselyDB } from 'test/utils.js';

/**
 * FL-44: a library the official v3.1.0 server created, started once under Frameleaf and then adopted
 * with `immich-admin fork-schema adopt`, becomes the same library a fresh Frameleaf install has.
 */
class FailingAdoptionRepository extends DatabaseRepository {
  protected override afterOfficialAdoptionStep(_transaction: Kysely<DB>, name: string): Promise<void> {
    if (name === '2100000000570-AddWorkflowDefinitions') {
      return Promise.reject(new Error('interrupted adoption'));
    }
    return Promise.resolve();
  }
}

const ledgerNames = async (db: Kysely<DB>) => {
  const { rows } = await sql<{ name: string }>`
    SELECT name FROM public.kysely_migrations ORDER BY timestamp, name
  `.execute(db);
  return rows.map(({ name }) => name);
};

const forkState = async (db: Kysely<DB>) => {
  const { rows } = await sql<{ active: boolean; phase: string; schemaVersion: string }>`
    SELECT active, phase, "schemaVersion" FROM immich_fork.state WHERE id = 1
  `.execute(db);
  return rows[0];
};

const relations = async (db: Kysely<DB>, names: string[]) => {
  const { rows } = await sql<{ name: string; present: boolean }>`
    SELECT name, to_regclass(name) IS NOT NULL AS present FROM unnest(${names}::text[]) AS name ORDER BY name
  `.execute(db);
  return Object.fromEntries(rows.map(({ name, present }) => [name, present]));
};

const connectToSameDatabase = async (db: Kysely<DB>): Promise<Kysely<DB>> => {
  const database = await sql<{ name: string }>`SELECT current_database() AS name`.execute(db);
  const url = process.env.IMMICH_TEST_POSTGRES_URL!.replace('/mich', () => `/${database.rows[0]!.name}`);
  return new Kysely<DB>(getKyselyConfig({ connectionType: 'url', url }));
};

const setMaintenanceMode = async (db: Kysely<DB>, isMaintenanceMode: boolean) => {
  await sql`
    INSERT INTO public.system_metadata (key, value)
    VALUES ('maintenance-mode', ${{ isMaintenanceMode }}::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value
  `.execute(db);
};

const maintenanceMode = async (db: Kysely<DB>) => {
  const { rows } = await sql<{ enabled: boolean | null }>`
    SELECT (value->>'isMaintenanceMode')::boolean AS enabled FROM public.system_metadata WHERE key = 'maintenance-mode'
  `.execute(db);
  return rows[0]?.enabled ?? false;
};

/** An official v3.1.0 asset row (the columns that schema requires). */
const insertOfficialAsset = async (db: Kysely<DB>, id: string, ownerId: string, visibility: string) => {
  await sql`
    INSERT INTO public.asset
      (id, "ownerId", checksum, "checksumAlgorithm", "fileCreatedAt", "fileModifiedAt", "localDateTime",
       "originalFileName", "originalPath", type, visibility)
    VALUES (${id}::uuid, ${ownerId}::uuid, ${randomBytes(20)}, 'sha1', now(), now(), now(),
      ${`${id}.jpg`}, ${`/data/upload/${id}.jpg`}, 'IMAGE', ${visibility}::asset_visibility_enum)
  `.execute(db);
};

/** The values of `column` in `public.<table>` that are among `ids`. */
const existing = async (db: Kysely<DB>, table: string, column: string, ids: string[]) => {
  const { rows } = await sql<{ id: string }>`
    SELECT ${sql.ref(column)}::text AS id FROM ${sql.table(`public.${table}`)}
    WHERE ${sql.ref(column)} = ANY(${ids}::uuid[])
    ORDER BY 1
  `.execute(db);
  return rows.map(({ id }) => id);
};

const columnExists = async (db: Kysely<DB>, table: string, column: string) => {
  const { rows } = await sql<{ present: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}
    ) AS present
  `.execute(db);
  return rows[0]!.present;
};

describe('official-origin adoption into a full Frameleaf library', () => {
  let db: Kysely<DB>;
  let repository: DatabaseRepository;
  let officialLedger: string[];
  let adoption: Promise<OfficialAdoptionResult> | undefined;
  // The cases after the adoption read its result; each one starts from it rather than from the order
  // the cases run in, so a failure is reported where it happens.
  const adopt = () => (adoption ??= repository.adoptOfficialOrigin());
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const personId = randomUUID();
  const workflowId = randomUUID();
  const lockedAssetId = randomUUID();
  const stackMateId = randomUUID();
  const otherOwnersAssetId = randomUUID();
  const stackId = randomUUID();
  const memoryId = randomUUID();
  const ownerlessAlbumId = randomUUID();
  const ownedAlbumId = randomUUID();
  const removedFaceId = randomUUID();
  const lockedFaceId = randomUUID();

  beforeAll(async () => {
    db = await getKyselyDB('official_origin_full_adoption');
    await restoreOfficialPublicSchema(db);
    repository = new DatabaseRepository(db, LoggingRepository.create(), new ConfigRepository());

    // The first Frameleaf boot on the official library.
    await expect(repository.detectMigrationMode()).resolves.toBe('official-origin');
    await repository.runOfficialMigrations();
    await repository.runForkMigrations();

    // Official data adoption must carry: a user, one of their people and a workflow.
    await sql`
      INSERT INTO public."user" (id, email, name) VALUES (${userId}::uuid, 'adopted@example.test', 'Adopted')
    `.execute(db);
    await sql`
      INSERT INTO public.person (id, "ownerId", name) VALUES (${personId}::uuid, ${userId}::uuid, 'Grandma')
    `.execute(db);
    await sql`
      INSERT INTO public.workflow (id, "ownerId", trigger, name)
      VALUES (${workflowId}::uuid, ${userId}::uuid, 'AssetCreate', 'Adopted workflow')
    `.execute(db);
    await sql`
      INSERT INTO public."user" (id, email, name) VALUES (${otherUserId}::uuid, 'other@example.test', 'Other')
    `.execute(db);

    // A stack with one member in the official Locked folder.
    await insertOfficialAsset(db, lockedAssetId, userId, 'locked');
    await insertOfficialAsset(db, stackMateId, userId, 'timeline');
    await sql`
      INSERT INTO public.stack (id, "ownerId", "primaryAssetId")
      VALUES (${stackId}::uuid, ${userId}::uuid, ${stackMateId}::uuid)
    `.execute(db);
    await sql`
      UPDATE public.asset SET "stackId" = ${stackId}::uuid WHERE id IN (${lockedAssetId}::uuid, ${stackMateId}::uuid)
    `.execute(db);

    // A memory that also links another owner's asset.
    await insertOfficialAsset(db, otherOwnersAssetId, otherUserId, 'timeline');
    await sql`
      INSERT INTO public.memory (id, "ownerId", type, data, "memoryAt")
      VALUES (${memoryId}::uuid, ${userId}::uuid, 'on_this_day', '{"year":2020}'::jsonb, now())
    `.execute(db);
    await sql`
      INSERT INTO public.memory_asset ("memoriesId", "assetId")
      VALUES (${memoryId}::uuid, ${stackMateId}::uuid), (${memoryId}::uuid, ${otherOwnersAssetId}::uuid)
    `.execute(db);

    // An album without an owner and one with.
    await sql`
      INSERT INTO public.album (id, "albumName")
      VALUES (${ownerlessAlbumId}::uuid, 'Ownerless'), (${ownedAlbumId}::uuid, 'Owned')
    `.execute(db);
    await sql`
      INSERT INTO public.album_user ("albumId", "userId", role)
      VALUES (${ownedAlbumId}::uuid, ${userId}::uuid, 'owner')
    `.execute(db);
    // Its cover is the Locked photo's stack mate, which only the whole-stack lock of 0320 covers.
    await sql`
      UPDATE public.album SET "albumThumbnailAssetId" = ${stackMateId}::uuid WHERE id = ${ownedAlbumId}::uuid
    `.execute(db);

    // The person's featured face is on the Locked photo.
    await sql`
      INSERT INTO public.asset_face (id, "assetId", "personId", "imageWidth", "imageHeight")
      VALUES (${lockedFaceId}::uuid, ${lockedAssetId}::uuid, ${personId}::uuid, 100, 100)
    `.execute(db);
    await sql`UPDATE public.person SET "faceAssetId" = ${lockedFaceId}::uuid WHERE id = ${personId}::uuid`.execute(db);

    // A face the owner removed from their person.
    await sql`
      INSERT INTO public.asset_face
        (id, "assetId", "personId", "imageWidth", "imageHeight", "boundingBoxX1", "boundingBoxY1",
         "boundingBoxX2", "boundingBoxY2", "deletedAt")
      VALUES (${removedFaceId}::uuid, ${stackMateId}::uuid, ${personId}::uuid, 100, 100, 10, 20, 50, 60, now())
    `.execute(db);

    await setMaintenanceMode(db, true);
    officialLedger = await ledgerNames(db);
  }, 120_000);

  afterAll(async () => {
    await setMaintenanceMode(db, false);
    await db.destroy();
  });

  it('leaves the first boot certified-upstream and reports the pending adoption', async () => {
    expect(officialLedger).toEqual(CERTIFIED_TAG_MIGRATIONS);
    await expect(forkState(db)).resolves.toEqual({ active: false, phase: 'inactive', schemaVersion: '1' });
    await expect(repository.isAwaitingOfficialAdoption()).resolves.toBe(true);
    await expect(repository.detectMigrationMode()).resolves.toBe('isolated');
  });

  it('refuses to adopt outside maintenance mode', async () => {
    await setMaintenanceMode(db, false);
    await expect(maintenanceMode(db)).resolves.toBe(false);
    try {
      await expect(repository.adoptOfficialOrigin()).rejects.toThrow('Adoption requires maintenance mode');
    } finally {
      await setMaintenanceMode(db, true);
    }
    await expect(forkState(db)).resolves.toEqual({ active: false, phase: 'inactive', schemaVersion: '1' });
  });

  it('refuses to adopt while another server is working in the database', async () => {
    // Maintenance mode is on, so the connection check is what refuses.
    await setMaintenanceMode(db, true);
    const otherServer = await connectToSameDatabase(db);
    try {
      await otherServer.transaction().execute(async (transaction) => {
        await sql`UPDATE public.album SET "albumName" = "albumName" WHERE id = ${ownedAlbumId}::uuid`.execute(
          transaction,
        );
        await expect(repository.adoptOfficialOrigin()).rejects.toThrow(
          'stop every server connected to this database first',
        );
      });
    } finally {
      await otherServer.destroy();
    }
    await expect(ledgerNames(db)).resolves.toEqual(officialLedger);
  });

  it('rolls an interrupted adoption back completely, so the official server can still read the library', async () => {
    const failing = new FailingAdoptionRepository(db, LoggingRepository.create(), new ConfigRepository());

    await expect(failing.adoptOfficialOrigin()).rejects.toThrow('interrupted adoption');

    await expect(ledgerNames(db)).resolves.toEqual(officialLedger);
    await expect(forkState(db)).resolves.toEqual({ active: false, phase: 'inactive', schemaVersion: '1' });
    await expect(
      relations(db, ['public.cluster_group', 'public.physical_file', 'public.media_operation']),
    ).resolves.toEqual({
      'public.cluster_group': false,
      'public.media_operation': false,
      'public.physical_file': false,
    });
    await expect(columnExists(db, 'user', 'clusterGroupId')).resolves.toBe(false);
    // The destructive steps before the interruption are rolled back with everything else.
    await expect(existing(db, 'album', 'id', [ownerlessAlbumId])).resolves.toEqual([ownerlessAlbumId]);
    await expect(existing(db, 'memory_asset', 'assetId', [otherOwnersAssetId])).resolves.toEqual([otherOwnersAssetId]);
    const visibility = await sql<{ visibility: string }>`
      SELECT visibility::text AS visibility FROM public.asset WHERE id = ${lockedAssetId}::uuid
    `.execute(db);
    expect(visibility.rows).toEqual([{ visibility: 'locked' }]);
    const audit = await sql`SELECT 1 FROM immich_fork.migration_audit WHERE name = ${OFFICIAL_ADOPTION_AUDIT}`.execute(
      db,
    );
    expect(audit.rows).toHaveLength(0);
  });

  it('applies the post-certified and Frameleaf migrations and starts the library in the legacy phase', async () => {
    await expect(maintenanceMode(db)).resolves.toBe(true);
    const result = await adopt();

    const expected = [...POST_CERTIFIED_UPSTREAM_MIGRATIONS, ...GENERIC_LEGACY_FORK_MIGRATIONS].toSorted();
    expect(result).toEqual({ adopted: true, applied: expected });
    const ledger = await ledgerNames(db);
    expect(ledger).toEqual([...officialLedger, ...expected]);
    expect(ledger).toContain(OFFICIAL_WORKFLOW_MIGRATION);
    expect(ledger).not.toContain(LEGACY_WORKFLOW_MIGRATION);
    await expect(forkState(db)).resolves.toEqual({ active: false, phase: 'legacy', schemaVersion: '1' });
    await expect(repository.isAwaitingOfficialAdoption()).resolves.toBe(false);
  });

  it('carries the official user, person and workflow into the Frameleaf schema', async () => {
    await adopt();
    const user = await sql<{ clusterGroupId: string | null }>`
      SELECT "clusterGroupId"::text AS "clusterGroupId" FROM public."user" WHERE id = ${userId}::uuid
    `.execute(db);
    expect(user.rows[0]?.clusterGroupId).toEqual(expect.any(String));
    const person = await sql<{ personGroupId: string }>`
      SELECT "personGroupId"::text AS "personGroupId" FROM public.person WHERE id = ${personId}::uuid
    `.execute(db);
    expect(person.rows).toEqual([{ personGroupId: personId }]);
    const definition = await sql<{ count: number }>`
      SELECT count(*)::int AS count FROM public.workflow_definition WHERE "workflowId" = ${workflowId}::uuid
    `.execute(db);
    expect(definition.rows).toEqual([{ count: 1 }]);
    expect(classifyWorkflowCompatibility(await getWorkflowCompatibilityEvidence(db)).mode).toBe('official');
  });

  it('applies the documented changes to official data and records what each step touched', async () => {
    await adopt();
    // Locked folder -> lock records, extended to the whole stack; the asset returns to the timeline.
    const locks = await sql<{ assetId: string; reason: string; previousVisibility: string | null }>`
      SELECT "assetId"::text AS "assetId", reason, "previousVisibility"::text AS "previousVisibility"
      FROM public.asset_lock WHERE "assetId" IN (${lockedAssetId}::uuid, ${stackMateId}::uuid)
    `.execute(db);
    expect(locks.rows).toEqual(
      expect.arrayContaining([
        { assetId: lockedAssetId, reason: 'immich-locked-folder', previousVisibility: 'locked' },
        { assetId: stackMateId, reason: 'immich-locked-folder', previousVisibility: null },
      ]),
    );
    expect(locks.rows).toHaveLength(2);
    const visibility = await sql<{ visibility: string }>`
      SELECT visibility::text AS visibility FROM public.asset WHERE id = ${lockedAssetId}::uuid
    `.execute(db);
    expect(visibility.rows).toEqual([{ visibility: 'timeline' }]);

    // The ownerless album and the other owner's memory link are deleted; the rest stays.
    await expect(existing(db, 'album', 'id', [ownerlessAlbumId, ownedAlbumId])).resolves.toEqual([ownedAlbumId]);
    await expect(existing(db, 'memory_asset', 'assetId', [stackMateId, otherOwnersAssetId])).resolves.toEqual([
      stackMateId,
    ]);

    // The removed face is carried over as the owner's `remove` decision (0000000000175).
    const decisions = await sql`
      SELECT "ownerId"::text AS "ownerId", "actorId"::text AS "actorId", action, "assetId"::text AS "assetId",
        "fromPersonId"::text AS "fromPersonId", "toPersonId", "boxX1", "boxY1", "boxX2", "boxY2"
      FROM immich_fork.face_correction WHERE "faceId" = ${removedFaceId}::uuid
    `.execute(db);
    expect(decisions.rows).toEqual([
      {
        ownerId: userId,
        actorId: userId,
        action: 'remove',
        assetId: stackMateId,
        fromPersonId: personId,
        toPersonId: null,
        boxX1: 0.1,
        boxY1: 0.2,
        boxX2: 0.5,
        boxY2: 0.6,
      },
    ]);

    const audit = await sql<{ details: { faceDecisionsCarriedOver: number; steps: Record<string, unknown> } }>`
      SELECT details FROM immich_fork.migration_audit WHERE name = ${OFFICIAL_ADOPTION_AUDIT} AND status = 'applied'
    `.execute(db);
    expect(audit.rows).toHaveLength(1);
    const { faceDecisionsCarriedOver, steps } = audit.rows[0]!.details;
    expect(faceDecisionsCarriedOver).toBe(1);
    expect(steps['1786385711807-AlbumOwnerDeleteTrigger']).toEqual({
      before: { albums: 2, ownerlessAlbums: 1 },
      after: { albums: 1, ownerlessAlbums: 0 },
    });
    expect(steps['1787148183730-DeleteMismatchedMemoryAssets']).toEqual({
      before: { memoryAssets: 2, crossOwnerMemoryAssets: 1 },
      after: { memoryAssets: 1, crossOwnerMemoryAssets: 0 },
    });
    expect(steps['1787148183729-ClusterGroups']).toEqual({
      before: { people: 1, personGroups: null, clusterGroups: null },
      after: { people: 1, personGroups: 1, clusterGroups: 2 },
    });
    // The featured face on the Locked photo is released; the person's only other face was removed.
    expect(steps['2100000000300-ClearLockedCoverReferences']).toMatchObject({
      before: { lockedFaceThumbnails: 1, lockedAlbumCovers: 0, lockedSharedSpaceCovers: 0, lockedPetCovers: 0 },
      after: { lockedFaceThumbnails: 0, lockedAlbumCovers: 0, lockedSharedSpaceCovers: 0, lockedPetCovers: 0 },
    });
    const featured = await sql<{ faceAssetId: string | null }>`
      SELECT "faceAssetId"::text AS "faceAssetId" FROM public.person WHERE id = ${personId}::uuid
    `.execute(db);
    expect(featured.rows).toEqual([{ faceAssetId: null }]);
    const cover = await sql<{ albumThumbnailAssetId: string | null }>`
      SELECT "albumThumbnailAssetId"::text AS "albumThumbnailAssetId" FROM public.album WHERE id = ${ownedAlbumId}::uuid
    `.execute(db);
    expect(cover.rows).toEqual([{ albumThumbnailAssetId: null }]);
    // Before 0320 its counters read what it is about to lock: the Locked folder and its stack mates.
    expect(steps['2100000000320-AddAssetLock']).toMatchObject({
      before: {
        lockedFolderAssets: 1,
        assetLocks: null,
        lockedFaceThumbnails: 0,
        lockedAlbumCovers: 1,
        lockedSharedSpaceCovers: 0,
        lockedPetCovers: 0,
      },
      after: {
        lockedFolderAssets: 0,
        assetLocks: 2,
        lockedFaceThumbnails: 0,
        lockedAlbumCovers: 0,
        lockedSharedSpaceCovers: 0,
        lockedPetCovers: 0,
      },
    });
    expect(steps['1786972746372-AssetOcrSyncReset']).toEqual({
      before: { ocrSyncCheckpoints: 0 },
      after: { ocrSyncCheckpoints: 0 },
    });
  });

  it('creates the Frameleaf public tables and repeats the table-dependent fork migration steps', async () => {
    await adopt();
    const missing = Object.entries(
      await relations(db, [
        'public.media_operation',
        'public.media_operation_checkpoint',
        'public.physical_file',
        'public.preservation_package',
        'public.render_worker',
        'public.render_worker_session',
        'public.studio_project',
        'public.takeout_import',
        'public.workflow_log',
        'public."ml_workload_accounting_jobId_jobName_startedAt_idx"',
        'public."ml_workload_accounting_cloudJobId_idx"',
      ]),
    )
      .filter(([, present]) => !present)
      .map(([name]) => name);
    expect(missing).toEqual([]);
    await expect(columnExists(db, 'render_worker_session', 'codecs')).resolves.toBe(true);
    await expect(columnExists(db, 'render_worker_session', 'colorPrecision')).resolves.toBe(true);
    await expect(columnExists(db, 'pet_observation', 'sourceChecksum')).resolves.toBe(true);
    await expect(columnExists(db, 'pet_observation', 'staleAt')).resolves.toBe(true);
  });

  it('matches the Frameleaf catalog and ledger the certified handoff verifies', async () => {
    await adopt();
    const evidence = await repository.getForkSchemaCutoverEvidence();

    expect(evidence.installationClass).toBe('current-fork');
    expect(evidence.catalogDiff).toEqual({ clean: true, mismatched: [], missing: [], unexpected: [] });
    expect(evidence.migrationOrderValid).toBe(true);
    expect(evidence.forkLedgerValid).toBe(true);
    expect(evidence.workflowCompatibility.mode).toBe('official');
  });

  it('boots afterwards as a legacy library without running the Frameleaf workflow rewrite', async () => {
    await adopt();
    const before = await ledgerNames(db);

    await expect(repository.detectMigrationMode()).resolves.toBe('legacy');
    await repository.runMigrations();
    await repository.runForkMigrations();

    await expect(ledgerNames(db)).resolves.toEqual(before);
  });

  it('changes nothing when run again', async () => {
    await adopt();
    const before = await ledgerNames(db);

    await expect(repository.adoptOfficialOrigin()).resolves.toEqual({
      adopted: false,
      applied: [...POST_CERTIFIED_UPSTREAM_MIGRATIONS, ...GENERIC_LEGACY_FORK_MIGRATIONS].toSorted(),
    });
    await expect(ledgerNames(db)).resolves.toEqual(before);
  });
});

describe('official-origin adoption refusals', () => {
  let db: Kysely<DB>;

  beforeAll(async () => {
    db = await getKyselyDB('official_origin_adoption_refusal');
  });

  afterAll(async () => db.destroy());

  it('refuses a library that is already a Frameleaf library', async () => {
    const repository = new DatabaseRepository(db, LoggingRepository.create(), new ConfigRepository());

    await expect(repository.adoptOfficialOrigin()).rejects.toThrow(
      'Only a library created by the official server, and not handed over since, can be adopted',
    );
  });

  it('refuses a library handed over to the official server', async () => {
    await sql`UPDATE immich_fork.state SET phase = 'inactive', "schemaVersion" = '2', active = false WHERE id = 1`.execute(
      db,
    );
    const repository = new DatabaseRepository(db, LoggingRepository.create(), new ConfigRepository());

    await expect(repository.adoptOfficialOrigin()).rejects.toThrow(
      'Only a library created by the official server, and not handed over since, can be adopted',
    );
  });

  it('refuses a schema version 1 library that already holds Frameleaf tables', async () => {
    await sql`UPDATE immich_fork.state SET phase = 'inactive', "schemaVersion" = '1', active = false WHERE id = 1`.execute(
      db,
    );
    const repository = new DatabaseRepository(db, LoggingRepository.create(), new ConfigRepository());

    await expect(repository.adoptOfficialOrigin()).rejects.toThrow('Library already holds Frameleaf tables');
  });
});
