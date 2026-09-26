import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import {
  CERTIFIED_TAG_MIGRATIONS,
  GENERIC_LEGACY_FORK_MIGRATIONS,
  POST_CERTIFIED_UPSTREAM_MIGRATIONS,
} from 'src/fork-schema/migration-manifest.js';
import { OFFICIAL_ADOPTION_AUDIT } from 'src/fork-schema/official-adoption.js';
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
  const userId = randomUUID();
  const personId = randomUUID();
  const workflowId = randomUUID();

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
    officialLedger = await ledgerNames(db);
  }, 120_000);

  afterAll(async () => db.destroy());

  it('leaves the first boot certified-upstream and reports the pending adoption', async () => {
    expect(officialLedger).toEqual(CERTIFIED_TAG_MIGRATIONS);
    await expect(forkState(db)).resolves.toEqual({ active: false, phase: 'inactive', schemaVersion: '1' });
    await expect(repository.isAwaitingOfficialAdoption()).resolves.toBe(true);
    await expect(repository.detectMigrationMode()).resolves.toBe('isolated');
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
    const audit = await sql`SELECT 1 FROM immich_fork.migration_audit WHERE name = ${OFFICIAL_ADOPTION_AUDIT}`.execute(
      db,
    );
    expect(audit.rows).toHaveLength(0);
  });

  it('applies the post-certified and Frameleaf migrations and starts the library in the legacy phase', async () => {
    const result = await repository.adoptOfficialOrigin();

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

  it('creates the Frameleaf public tables and repeats the table-dependent fork migration steps', async () => {
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
    const evidence = await repository.getForkSchemaCutoverEvidence();

    expect(evidence.installationClass).toBe('current-fork');
    expect(evidence.catalogDiff).toEqual({ clean: true, mismatched: [], missing: [], unexpected: [] });
    expect(evidence.migrationOrderValid).toBe(true);
    expect(evidence.forkLedgerValid).toBe(true);
    expect(evidence.workflowCompatibility.mode).toBe('official');
  });

  it('boots afterwards as a legacy library without running the Frameleaf workflow rewrite', async () => {
    const before = await ledgerNames(db);

    await expect(repository.detectMigrationMode()).resolves.toBe('legacy');
    await repository.runMigrations();
    await repository.runForkMigrations();

    await expect(ledgerNames(db)).resolves.toEqual(before);
  });

  it('changes nothing when run again', async () => {
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
