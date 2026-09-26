import { Kysely, sql } from 'kysely';
import { CatalogManifest, compareCatalogs, getCatalogEvidence } from 'src/fork-schema/catalog.js';
import { ISOLATED_FRAMELEAF_AUDIT_PHASE } from 'src/fork-schema/isolated-frameleaf-migrations.js';
import forkCatalogManifest from 'src/fork-schema/manifests/fork-v2-catalog.json' with { type: 'json' };
import { LEGACY_FORK_MIGRATIONS, POST_CERTIFIED_UPSTREAM_MIGRATIONS } from 'src/fork-schema/migration-manifest.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { down as removeClassificationRules } from 'src/schema/migrations/2100000000610-AddClassificationRule.js';
import { down as removeFrameleafCloud } from 'src/schema/migrations/2100000000620-FrameleafCloudMlDestination.js';
import { getKyselyConfig } from 'src/utils/database.js';
import { mediumFactory } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

/**
 * FL-180: a library past the certified cutover no longer lists Frameleaf public migrations in the
 * official ledger, so the official provider never applies the ones released after its cutover. These
 * tests cut a library over with the real cutover transaction, then take out what 2100000000610 and
 * 2100000000620 created together with their cutover ledger rows: the state of a library cut over on
 * a version that did not have them yet.
 */

const CLASSIFICATION_RULE = '2100000000610-AddClassificationRule';
const FRAMELEAF_CLOUD = '2100000000620-FrameleafCloudMlDestination';
const NEWER = [CLASSIFICATION_RULE, FRAMELEAF_CLOUD];
const REPORT_DIGEST = 'f'.repeat(64);
const FORK_CATALOG_MANIFEST = forkCatalogManifest as CatalogManifest;
// Every relation 2100000000610 and 2100000000620 create or change.
const NEWER_RELATIONS = [
  'public.classification_match',
  'public.classification_rule',
  'public.ml_destination',
  'public.ml_workload_accounting',
  'public.ml_workload_route',
];
const isNewerObject = ({ identity }: { identity: string }) =>
  NEWER_RELATIONS.some((relation) => identity === relation || identity.startsWith(`${relation}.`));

class TestDatabaseRepository extends DatabaseRepository {
  failAfter?: string;

  protected override afterIsolatedFrameleafMigration(_transaction: Kysely<DB>, name: string): Promise<void> {
    if (name === this.failAfter) {
      throw new Error(`synthetic failure after ${name}`);
    }
    return Promise.resolve();
  }
}

const connectToSameDatabase = async (db: Kysely<DB>): Promise<Kysely<DB>> => {
  const database = await sql<{ name: string }>`SELECT current_database() AS name`.execute(db);
  const url = process.env.IMMICH_TEST_POSTGRES_URL!.replace('/mich', () => `/${database.rows[0]!.name}`);
  return new Kysely<DB>(getKyselyConfig({ connectionType: 'url', url }));
};

describe('Frameleaf public migrations after the certified cutover', () => {
  let db: Kysely<DB>;
  let repository: TestDatabaseRepository;

  const newerCatalog = async () => {
    const evidence = await getCatalogEvidence(db);
    return {
      columns: evidence.columns.filter((entry) => isNewerObject(entry)),
      constraints: evidence.constraints.filter((entry) => isNewerObject(entry)),
      indexes: evidence.indexes.filter((entry) => isNewerObject(entry)),
      tables: evidence.tables.filter((entry) => isNewerObject(entry)),
      triggers: evidence.triggers.filter((entry) => isNewerObject(entry)),
    };
  };

  // What the catalog comparison of a handoff reports for the relations those migrations own.
  const newerManifestDiff = async () => {
    const diff = compareCatalogs(FORK_CATALOG_MANIFEST, await getCatalogEvidence(db));
    return {
      mismatched: diff.mismatched.filter((entry) => isNewerObject(entry)),
      missing: diff.missing.filter((entry) => isNewerObject(entry)),
      unexpected: diff.unexpected.filter((entry) => isNewerObject(entry)),
    };
  };

  const officialLedger = async () => {
    const ledger = await sql<{ name: string; timestamp: string }>`
      SELECT name, timestamp::text AS timestamp FROM public.kysely_migrations ORDER BY timestamp, name
    `.execute(db);
    return ledger.rows;
  };

  const frameleafAudit = async () => {
    const audit = await sql<{ details: Record<string, unknown>; name: string; phase: string }>`
      SELECT name, phase, details FROM immich_fork.migration_audit
      WHERE name = ANY(${NEWER}) AND status = 'applied'
      ORDER BY id
    `.execute(db);
    return audit.rows;
  };

  const relationExists = async (relation: string) => {
    const result = await sql<{ present: boolean }>`
      SELECT to_regclass(${relation}) IS NOT NULL AS present
    `.execute(db);
    return result.rows[0]!.present;
  };

  /** Removes what 610 and 620 created and their cutover ledger rows: a cutover on an older version. */
  const cutOverBeforeNewerMigrations = async () => {
    await removeFrameleafCloud(db);
    await removeClassificationRules(db);
    await sql`DELETE FROM immich_fork.migration_audit WHERE name = ANY(${NEWER})`.execute(db);
  };

  const setPhase = async (phase: string, schemaVersion: string) => {
    await sql`
      UPDATE immich_fork.state
      SET phase = ${phase}, active = ${phase === 'active'}, "schemaVersion" = ${schemaVersion}
      WHERE id = 1
    `.execute(db);
  };

  /** The real cutover transaction; its evidence checks are not what these tests are about. */
  const cutOver = async () => {
    await repository.commitForkSchemaCutover(REPORT_DIGEST, () => Promise.resolve());
  };

  beforeEach(async () => {
    db = await getKyselyDB();
    repository = new TestDatabaseRepository(db, LoggingRepository.create(), new ConfigRepository());
    await repository.runForkMigrations();
    await sql`TRUNCATE immich_fork.migration_audit`.execute(db);
    await setPhase('ready', '1');
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('leaves the Frameleaf names out of the official ledger after the cutover', async () => {
    await cutOver();
    const ledger = await officialLedger();
    const cutoverLedger = await sql<{ name: string }>`
      SELECT name FROM immich_fork.migration_audit
      WHERE phase = 'ledger-cutover' AND details->>'classification' = 'legacy-fork'
    `.execute(db);

    expect(ledger.filter(({ name }) => LEGACY_FORK_MIGRATIONS.has(name))).toEqual([]);
    expect(cutoverLedger.rows.map(({ name }) => name)).toEqual(expect.arrayContaining(NEWER));
    await expect(repository.detectMigrationMode()).resolves.toBe('isolated');
  });

  it('waits while handed over, then applies them during the return without touching the certified ledger', async () => {
    await cutOver();
    const catalogAtCutover = await newerCatalog();
    const diffAtCutover = await newerManifestDiff();
    const checkpoint = await repository.getOfficialHandoffCheckpoint();
    await cutOverBeforeNewerMigrations();
    expect((await newerManifestDiff()).missing.length).toBeGreaterThan(0);
    const ledgerAtCutover = await officialLedger();

    // A restart while the library is handed over changes nothing: the official server starts on exactly
    // the schema the cutover checked.
    await expect(repository.applyIsolatedFrameleafMigrations('startup')).resolves.toEqual({
      applied: [],
      pending: NEWER,
      skipped: 'awaiting-return',
    });
    expect(await relationExists('public.classification_rule')).toBe(false);
    expect(await officialLedger()).toEqual(ledgerAtCutover);
    expect(await frameleafAudit()).toEqual([]);

    // The return: the residue first, then the Frameleaf migrations released since the cutover.
    await repository.reapplyPostCertifiedResidue();
    const ledgerAfterResidue = await officialLedger();
    await expect(repository.applyIsolatedFrameleafMigrations('return')).resolves.toEqual({
      applied: NEWER,
      pending: NEWER,
      skipped: null,
    });

    expect(await officialLedger()).toEqual(ledgerAfterResidue);
    expect(ledgerAfterResidue.filter(({ name }) => LEGACY_FORK_MIGRATIONS.has(name))).toEqual([]);
    expect(ledgerAfterResidue.filter(({ name }) => !POST_CERTIFIED_UPSTREAM_MIGRATIONS.has(name))).toEqual(
      ledgerAtCutover,
    );
    expect(await newerCatalog()).toEqual(catalogAtCutover);
    expect(await newerManifestDiff()).toEqual(diffAtCutover);
    expect(await relationExists('public."ml_workload_accounting_cloudJobId_idx"')).toBe(true);
    expect(await frameleafAudit()).toEqual(
      NEWER.map((name) => ({
        details: expect.objectContaining({ classification: 'legacy-fork', context: 'return' }),
        name,
        phase: ISOLATED_FRAMELEAF_AUDIT_PHASE,
      })),
    );
    await expect(repository.getOfficialHandoffCheckpoint()).resolves.toEqual(checkpoint);
    await expect(repository.detectMigrationMode()).resolves.toBe('isolated');

    // Running the return again finds nothing left to apply.
    await expect(repository.applyIsolatedFrameleafMigrations('return')).resolves.toEqual({
      applied: [],
      pending: [],
      skipped: null,
    });
    expect(await frameleafAudit()).toHaveLength(NEWER.length);
  });

  it('applies them at the next startup once the library is active again, exactly once across concurrent servers', async () => {
    await cutOver();
    const catalogAtCutover = await newerCatalog();
    await cutOverBeforeNewerMigrations();
    await setPhase('active', '2');
    const ledgerBefore = await officialLedger();
    const other = await connectToSameDatabase(db);
    try {
      const otherRepository = new DatabaseRepository(other, LoggingRepository.create(), new ConfigRepository());

      const results = await Promise.all([
        repository.applyIsolatedFrameleafMigrations('startup'),
        otherRepository.applyIsolatedFrameleafMigrations('startup'),
      ]);

      expect(results.flatMap(({ applied }) => applied)).toEqual(NEWER);
      expect(results.every(({ skipped }) => skipped === null)).toBe(true);
    } finally {
      await other.destroy();
    }

    expect(await officialLedger()).toEqual(ledgerBefore);
    expect(await newerCatalog()).toEqual(catalogAtCutover);
    expect(await frameleafAudit()).toEqual(
      NEWER.map((name) => ({
        details: expect.objectContaining({ classification: 'legacy-fork', context: 'startup' }),
        name,
        phase: ISOLATED_FRAMELEAF_AUDIT_PHASE,
      })),
    );
    await expect(repository.detectMigrationMode()).resolves.toBe('isolated');
    await expect(repository.applyIsolatedFrameleafMigrations('startup')).resolves.toEqual({
      applied: [],
      pending: [],
      skipped: null,
    });
  });

  it('applies a Frameleaf migration released after the return at a later startup', async () => {
    await cutOver();
    await setPhase('active', '2');
    const catalogAtCutover = await newerCatalog();
    // Only 620 is newer than this library's return.
    await removeFrameleafCloud(db);
    await sql`DELETE FROM immich_fork.migration_audit WHERE name = ${FRAMELEAF_CLOUD}`.execute(db);

    await expect(repository.applyIsolatedFrameleafMigrations('startup')).resolves.toEqual({
      applied: [FRAMELEAF_CLOUD],
      pending: [FRAMELEAF_CLOUD],
      skipped: null,
    });

    expect(await newerCatalog()).toEqual(catalogAtCutover);
  });

  it('rolls back every migration and ledger row when one fails, and applies them all on the next attempt', async () => {
    await cutOver();
    const catalogAtCutover = await newerCatalog();
    await cutOverBeforeNewerMigrations();
    await setPhase('active', '2');
    const ledgerBefore = await officialLedger();
    repository.failAfter = FRAMELEAF_CLOUD;

    await expect(repository.applyIsolatedFrameleafMigrations('startup')).rejects.toThrow(
      `synthetic failure after ${FRAMELEAF_CLOUD}`,
    );

    expect(await relationExists('public.classification_rule')).toBe(false);
    expect(await frameleafAudit()).toEqual([]);
    expect(await officialLedger()).toEqual(ledgerBefore);

    delete repository.failAfter;
    await expect(repository.applyIsolatedFrameleafMigrations('startup')).resolves.toMatchObject({ applied: NEWER });
    expect(await newerCatalog()).toEqual(catalogAtCutover);
  });

  it('refuses a library that recorded a Frameleaf migration this version does not have', async () => {
    await cutOver();
    await setPhase('active', '2');
    await sql`
      INSERT INTO immich_fork.migration_audit (name, phase, status, details, "completedAt")
      VALUES ('2100000009990-FromANewerVersion', ${ISOLATED_FRAMELEAF_AUDIT_PHASE}, 'applied',
        '{"classification":"legacy-fork"}'::jsonb, now())
    `.execute(db);

    await expect(repository.applyIsolatedFrameleafMigrations('startup')).rejects.toThrow(
      'Downgrades are not supported',
    );
  });

  it('leaves a library that has not been cut over alone', async () => {
    await cutOver();
    await cutOverBeforeNewerMigrations();
    await setPhase('inactive', '1');

    await expect(repository.applyIsolatedFrameleafMigrations('startup')).resolves.toEqual({
      applied: [],
      pending: [],
      skipped: 'not-cut-over',
    });
    expect(await relationExists('public.classification_rule')).toBe(false);
  });

  it("records a face removed before the return as the owner's decision once, when 0000000000175 could not (FL-180)", async () => {
    const user = await mediumFactory.userWithClusterGroup(db);
    await db.insertInto('user').values(user).execute();
    const asset = mediumFactory.assetInsert({ ownerId: user.id });
    await db.insertInto('asset').values(asset).execute();
    const removedAt = '2026-07-15T02:03:04.000Z';
    const face = await sql<{ id: string }>`
      INSERT INTO public.asset_face
        ("assetId", "imageWidth", "imageHeight", "boundingBoxX1", "boundingBoxY1", "boundingBoxX2", "boundingBoxY2",
         "deletedAt")
      VALUES (${asset.id!}::uuid, 200, 100, 20, 10, 60, 50, ${removedAt}::timestamptz)
      RETURNING id
    `.execute(db);
    const faceId = face.rows[0]!.id;
    await cutOver();

    // On the return boot 0000000000175 finds no person groups (ClusterGroups is post-certified residue,
    // reverted at the cutover), so a library cut over before it existed has no decision for this face.
    const personGroupColumns = await sql<{ count: number }>`
      SELECT count(*)::int AS count FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'personGroupId' AND table_name IN ('asset_face', 'person')
    `.execute(db);
    expect(personGroupColumns.rows[0]!.count).toBe(0);
    const decisions = async () => {
      const result = await sql<Record<string, unknown>>`
        SELECT "ownerId", "actorId", action, "faceId", "assetId", "boxX1", "boxY1", "boxX2", "boxY2",
          "createdAt" = ${removedAt}::timestamptz AS "decidedWhenRemoved"
        FROM immich_fork.face_correction WHERE "faceId" = ${faceId}::uuid
      `.execute(db);
      return result.rows;
    };
    expect(await decisions()).toEqual([]);

    await repository.reapplyPostCertifiedResidue();
    await repository.applyIsolatedFrameleafMigrations('return');

    const expected = [
      {
        action: 'remove',
        actorId: user.id,
        assetId: asset.id,
        boxX1: 0.1,
        boxX2: 0.3,
        boxY1: 0.1,
        boxY2: 0.5,
        decidedWhenRemoved: true,
        faceId,
        ownerId: user.id,
      },
    ];
    expect(await decisions()).toEqual(expected);
    const audit = await sql<{ details: { faceDecisions: number } }>`
      SELECT details FROM immich_fork.migration_audit WHERE name = 'return-face-decision-carry-over'
    `.execute(db);
    expect(audit.rows).toEqual([{ details: expect.objectContaining({ faceDecisions: 1 }) }]);

    // Running the return again records nothing more.
    await repository.applyIsolatedFrameleafMigrations('return');
    expect(await decisions()).toEqual(expected);
    const auditAgain = await sql<{ count: number }>`
      SELECT count(*)::int AS count FROM immich_fork.migration_audit WHERE name = 'return-face-decision-carry-over'
    `.execute(db);
    expect(auditAgain.rows[0]!.count).toBe(1);
  });

  it('records faces removed while handed over at the return even without a Frameleaf ledger (FL-180)', async () => {
    const user = await mediumFactory.userWithClusterGroup(db);
    await db.insertInto('user').values(user).execute();
    const asset = mediumFactory.assetInsert({ ownerId: user.id });
    await db.insertInto('asset').values(asset).execute();
    const face = await sql<{ id: string }>`
      INSERT INTO public.asset_face
        ("assetId", "imageWidth", "imageHeight", "boundingBoxX1", "boundingBoxY1", "boundingBoxX2", "boundingBoxY2",
         "deletedAt")
      VALUES (${asset.id!}::uuid, 200, 100, 20, 10, 60, 50, now())
      RETURNING id
    `.execute(db);
    const faceId = face.rows[0]!.id;
    await cutOver();
    // A library cut over without the Frameleaf public ledger: nothing for the migrations to extend.
    await sql`DELETE FROM immich_fork.migration_audit WHERE phase = 'ledger-cutover'`.execute(db);
    await repository.reapplyPostCertifiedResidue();
    const ledgerBefore = await officialLedger();
    const removals = async () => {
      const result = await sql<{ action: string; ownerId: string }>`
        SELECT action, "ownerId" FROM immich_fork.face_correction WHERE "faceId" = ${faceId}::uuid
      `.execute(db);
      return result.rows;
    };

    await expect(repository.applyIsolatedFrameleafMigrations('return')).resolves.toEqual({
      applied: [],
      pending: [],
      skipped: 'no-frameleaf-schema',
    });
    expect(await removals()).toEqual([{ action: 'remove', ownerId: user.id }]);
    expect(await officialLedger()).toEqual(ledgerBefore);

    await repository.applyIsolatedFrameleafMigrations('return');
    expect(await removals()).toHaveLength(1);
  });
});
