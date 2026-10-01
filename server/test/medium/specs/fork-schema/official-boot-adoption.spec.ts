import { Kysely, sql } from 'kysely';
import { DatabaseLock } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { BACKFILL_PAUSE_AUDIT, ForkSchemaRepository } from 'src/repositories/fork-schema.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { getKyselyConfig } from 'src/utils/database.js';
import { restoreOfficialPublicSchema } from 'test/medium/specs/fork-schema/official-schema-fixture.js';
import { getKyselyDB } from 'test/utils.js';

/**
 * FL-289: swapping the container image is the whole upgrade. The first Frameleaf boot on a library the
 * official server created adopts it inside the boot migration lock, without maintenance mode, and the
 * API worker then starts the compatibility backfill once.
 */
const connectToSameDatabase = async (db: Kysely<DB>): Promise<Kysely<DB>> => {
  const database = await sql<{ name: string }>`SELECT current_database() AS name`.execute(db);
  const url = process.env.IMMICH_TEST_POSTGRES_URL!.replace('/mich', () => `/${database.rows[0]!.name}`);
  return new Kysely<DB>(getKyselyConfig({ connectionType: 'url', url }));
};

const forkState = async (db: Kysely<DB>) => {
  const { rows } = await sql<{ phase: string; schemaVersion: string }>`
    SELECT phase, "schemaVersion" FROM immich_fork.state WHERE id = 1
  `.execute(db);
  return rows[0];
};

/** Resolves once `count` backends of this database wait for the given advisory lock key. */
const waitForAdvisoryWaiters = async (db: Kysely<DB>, key: number, count = 1) => {
  await vi.waitFor(
    async () => {
      const { rows } = await sql<{ waiting: number }>`
        SELECT count(*)::int AS waiting
        FROM pg_locks
        WHERE locktype = 'advisory' AND NOT granted AND objid = ${key}::oid AND objsubid = 1
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
      `.execute(db);
      expect(rows[0]?.waiting).toBe(count);
    },
    { timeout: 10_000, interval: 50 },
  );
};

/** One session holds `key`, another blocks waiting for it, for the duration of `run`. */
const withAdvisoryWaiter = async <T>(db: Kysely<DB>, key: number, run: () => Promise<T>): Promise<T> => {
  const holder = await connectToSameDatabase(db);
  const waiter = await connectToSameDatabase(db);
  try {
    await sql`SELECT pg_advisory_lock(${key})`.execute(holder);
    const waiting = sql`SELECT pg_advisory_lock(${key})`.execute(waiter).catch(() => {});
    await waitForAdvisoryWaiters(db, key);
    try {
      return await run();
    } finally {
      // Closing the holder session releases its lock; the waiter then acquires and closes with it.
      await holder.destroy();
      await waiting;
    }
  } finally {
    await waiter.destroy();
  }
};

describe('automatic official-origin adoption at boot (FL-289)', () => {
  let db: Kysely<DB>;
  let repository: DatabaseRepository;

  beforeAll(async () => {
    db = await getKyselyDB('official_origin_boot_adoption');
    await restoreOfficialPublicSchema(db);
    repository = new DatabaseRepository(db, LoggingRepository.create(), new ConfigRepository());
    // The first Frameleaf boot on the official library, with maintenance mode off: the image swap.
    await expect(repository.detectMigrationMode()).resolves.toBe('official-origin');
    await repository.runOfficialMigrations();
    await repository.runForkMigrations();
    await sql`DELETE FROM public.system_metadata WHERE key = 'maintenance-mode'`.execute(db);
  });

  it('keeps requiring maintenance mode for the manual adoption', async () => {
    await expect(repository.isAwaitingOfficialAdoption()).resolves.toBe(true);
    await expect(repository.adoptOfficialOrigin()).rejects.toThrow('Adoption requires maintenance mode');
    await expect(forkState(db)).resolves.toEqual({ phase: 'inactive', schemaVersion: '1' });
  });

  it('refuses the boot adoption while another ordinary session is open, and names it', async () => {
    const otherServer = await connectToSameDatabase(db);
    try {
      await otherServer.transaction().execute(async (transaction) => {
        await sql`SET LOCAL application_name = 'official-immich'`.execute(transaction);
        await sql`SELECT 1`.execute(transaction);
        await expect(repository.adoptOfficialOrigin({ atBoot: true })).rejects.toThrow(
          /Adoption found 1 other database connection\(s\): official-immich from .+ \(idle in transaction\)/,
        );
      });
    } finally {
      await otherServer.destroy();
    }
    await expect(forkState(db)).resolves.toEqual({ phase: 'inactive', schemaVersion: '1' });
  });

  it('refuses the boot adoption while a session waits for some other advisory lock', async () => {
    await withAdvisoryWaiter(db, DatabaseLock.Migrations + 1, () =>
      expect(repository.adoptOfficialOrigin({ atBoot: true })).rejects.toThrow('stop every server'),
    );
    await expect(forkState(db)).resolves.toEqual({ phase: 'inactive', schemaVersion: '1' });
  });

  it('refuses a session waiting on the migrations lock for the manual adoption', async () => {
    await sql`
      INSERT INTO public.system_metadata (key, value) VALUES ('maintenance-mode', '{"isMaintenanceMode": true}'::jsonb)
    `.execute(db);
    try {
      await withAdvisoryWaiter(db, DatabaseLock.Migrations, () =>
        expect(repository.adoptOfficialOrigin()).rejects.toThrow('stop every server'),
      );
    } finally {
      await sql`DELETE FROM public.system_metadata WHERE key = 'maintenance-mode'`.execute(db);
    }
  });

  it('adopts at boot while a sibling worker only waits on the migrations lock', async () => {
    const result = await withAdvisoryWaiter(db, DatabaseLock.Migrations, () =>
      repository.adoptOfficialOrigin({ atBoot: true }),
    );

    expect(result.adopted).toBe(true);
    expect(result.applied.length).toBeGreaterThan(0);
    await expect(forkState(db)).resolves.toEqual({ phase: 'legacy', schemaVersion: '1' });
    await expect(repository.isAwaitingOfficialAdoption()).resolves.toBe(false);
    // A later boot (or the manual command) changes nothing.
    await expect(repository.adoptOfficialOrigin({ atBoot: true })).resolves.toEqual({
      adopted: false,
      applied: result.applied,
    });
  });

  it('starts the backfill of the adopted library exactly once across racing workers', async () => {
    const other = await connectToSameDatabase(db);
    try {
      const outcomes = await Promise.all([
        new ForkSchemaRepository(db).beginInitialBackfill(),
        new ForkSchemaRepository(other).beginInitialBackfill(),
      ]);
      expect(outcomes.map(({ outcome }) => outcome).toSorted()).toEqual(['not-legacy', 'started']);
    } finally {
      await other.destroy();
    }
    await expect(forkState(db)).resolves.toEqual({ phase: 'dual-write', schemaVersion: '1' });
  });

  it('leaves an operator pause recorded before any batch ran alone at the next boot', async () => {
    const forkSchema = new ForkSchemaRepository(db);
    await expect(forkSchema.transitionPhase('dual-write', 'legacy')).resolves.toBe(true);
    await expect(forkSchema.beginInitialBackfill()).resolves.toEqual({ outcome: 'started', phase: 'dual-write' });
    await expect(forkSchema.transitionPhase('dual-write', 'legacy')).resolves.toBe(true);
    await forkSchema.recordBackfillPause();

    await expect(forkSchema.beginInitialBackfill()).resolves.toEqual({ outcome: 'paused', phase: 'legacy' });
    await sql`DELETE FROM immich_fork.migration_audit WHERE name = ${BACKFILL_PAUSE_AUDIT}`.execute(db);
    await expect(forkSchema.transitionPhase('legacy', 'dual-write')).resolves.toBe(true);
  });

  it('leaves an operator pause alone at the next boot', async () => {
    const forkSchema = new ForkSchemaRepository(db);
    // The backfill ran a batch (which records progress), then the operator paused it.
    await forkSchema.claimBatch('privacy', 1);
    await expect(forkSchema.transitionPhase('dual-write', 'legacy')).resolves.toBe(true);

    await expect(forkSchema.beginInitialBackfill()).resolves.toEqual({ outcome: 'paused', phase: 'legacy' });
    await expect(forkState(db)).resolves.toEqual({ phase: 'legacy', schemaVersion: '1' });
  });
});
