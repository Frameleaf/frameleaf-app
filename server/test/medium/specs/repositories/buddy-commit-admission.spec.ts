import { ServiceUnavailableException } from '@nestjs/common';
import { sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import type { Request, Response } from 'express';
import { BuddyBackupPeerController } from 'src/controllers/buddy-backup-peer.controller.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { RateLimitRepository } from 'src/repositories/rate-limit.repository.js';
import { BuddyBackupPeerService } from 'src/services/buddy-backup-peer.service.js';
import { canonicalDatabaseUrl, expectCanonicalTables } from 'test/fixtures/canonical-database.js';
import { getKyselyDB } from 'test/utils.js';

vi.mock('src/services/base.service.js', () => ({ BaseService: class {} }));

it('persists shared commit admission through parsing, lock wait, success, failure and token replacement', async () => {
  const db = await getKyselyDB();
  const { rows } = await sql<{ name: string }>`SELECT current_database() AS name`.execute(db);
  const config = new ConfigRepository();
  const env = config.getEnv();
  vi.spyOn(config, 'getEnv').mockReturnValue({
    ...env,
    database: {
      ...env.database,
      config: { connectionType: 'url', url: canonicalDatabaseUrl(process.env.IMMICH_TEST_POSTGRES_URL!, rows[0].name) },
    },
  });
  const rates = Array.from({ length: 3 }, () => new RateLimitRepository(config));
  const pending = Promise.withResolvers<void>();
  const started = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const unblock = Promise.withResolvers<void>();
  const lockHeld = Promise.withResolvers<void>();
  const vaultId = randomUUID();
  const response = { setHeader: () => {} } as unknown as Response;
  const request = (onRead = () => {}) =>
    ({
      headers: { 'content-type': 'application/vnd.frameleaf.buddy+json' },
      destroy: () => {},
      *[Symbol.iterator]() {
        onRead();
        yield Buffer.from(JSON.stringify({ snapshot: { id: vaultId, sequence: 1 }, signature: 'test' }));
      },
    }) as unknown as Request;
  const peers = rates.map((repository, index) =>
    Object.assign(Object.create(BuddyBackupPeerService.prototype), {
      rates: repository,
      authorize: () => Promise.resolve({ grant: { exp: Math.floor(Date.now() / 1000) + 300 } }),
      assertAccess: () => Promise.resolve(),
      signed: (_access: unknown, data: unknown) => Promise.resolve(data),
      commit: async () => {
        started[index]?.resolve();
        if (index === 0) await pending.promise;
        else if (index === 1) {
          await db.transaction().execute(async (trx) => {
            await sql`SET LOCAL application_name = 'fl310-commit-admission'`.execute(trx);
            await sql`SELECT pg_advisory_xact_lock(310, 9)`.execute(trx);
            throw new Error('commit refused');
          });
        }
      },
    }),
  );
  const controllers = peers.map((peer) => new BuddyBackupPeerController(peer));
  const leases = async () =>
    (
      await sql<{ key: string; token: string; live: boolean }>`
    SELECT key, token, expires_at > clock_timestamp() AS live
    FROM public.frameleaf_upload_lease ORDER BY key
  `.execute(db)
    ).rows;
  const blocker = db.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(310, 9)`.execute(trx);
    lockHeld.resolve();
    await unblock.promise;
  });
  let first: Promise<unknown> | undefined;
  let second: Promise<unknown> | undefined;
  let secondFailure: Promise<unknown> | undefined;
  try {
    await expectCanonicalTables(db, ['frameleaf_upload_lease']);
    await Promise.race([lockHeld.promise, blocker]);
    const consumed = [false, false, false];
    first = controllers[0].commit(
      vaultId,
      request(() => (consumed[0] = true)),
      response,
    );
    second = controllers[1].commit(
      vaultId,
      request(() => (consumed[1] = true)),
      response,
    );
    secondFailure = expect(second).rejects.toThrow('commit refused');
    await Promise.race([Promise.all(started.map(({ promise }) => promise)), Promise.all([first, second])]);
    // Observe the actual waiter before asserting admission; no timing sleep stands in for lock acquisition.
    const deadline = Date.now() + 5000;
    for (;;) {
      const waiters = await sql<{ blocked: boolean }>`
        SELECT cardinality(pg_blocking_pids(pid)) > 0 AS blocked FROM pg_stat_activity
        WHERE datname = current_database() AND application_name = 'fl310-commit-admission'
      `.execute(db);
      if (waiters.rows.some(({ blocked }) => blocked)) break;
      expect(Date.now(), 'commit entered PostgreSQL lock wait').toBeLessThan(deadline);
      await setImmediate();
    }
    const admitted = await leases();
    expect(admitted.map(({ key, live }) => ({ key, live }))).toEqual([
      { key: 'buddy:download:0', live: true },
      { key: 'buddy:download:1', live: true },
    ]);
    expect(new Set(admitted.map(({ token }) => token)).size).toBe(2);
    await expect(
      controllers[2].commit(
        vaultId,
        request(() => (consumed[2] = true)),
        response,
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(consumed).toEqual([true, true, false]);
    const clients = await sql<{ count: number }>`
      SELECT count(DISTINCT pid)::int AS count FROM pg_stat_activity
      WHERE datname = current_database() AND application_name = 'frameleaf:admission'
    `.execute(db);
    expect(clients.rows[0].count).toBeGreaterThanOrEqual(3);
    expect(await leases()).toEqual(admitted);
    pending.resolve();
    await first;
    expect(await leases()).toHaveLength(1);
    await controllers[2].commit(vaultId, request(), response);
    expect(await leases()).toHaveLength(1);
    unblock.resolve();
    await blocker;
    await secondFailure;
    expect(await leases()).toEqual([]);
    await controllers[2].commit(vaultId, request(), response);
    expect(await leases()).toEqual([]);

    const oldRelease = await peers[0].streamSlot('download');
    const [old] = await leases();
    await sql`UPDATE public.frameleaf_upload_lease SET expires_at = clock_timestamp() - interval '1 second'
      WHERE key = ${old.key}`.execute(db);
    expect(await rates[1].isUploadStreamCurrent(old.key, old.token)).toBe(false);
    const newRelease = await peers[1].streamSlot('download');
    try {
      const [replacement] = await leases();
      expect(replacement.key).toBe(old.key);
      expect(replacement.token).not.toBe(old.token);
      expect(await rates[2].isUploadStreamCurrent(replacement.key, replacement.token)).toBe(true);
      await oldRelease();
      expect(await leases()).toEqual([replacement]);
      expect(await rates[2].isUploadStreamCurrent(replacement.key, replacement.token)).toBe(true);
    } finally {
      await newRelease();
    }
    expect(await leases()).toEqual([]);
  } finally {
    pending.resolve();
    unblock.resolve();
    await Promise.allSettled([first, second, secondFailure, blocker]);
    await Promise.all(rates.map((repository) => repository.onModuleDestroy()));
    vi.restoreAllMocks();
    await db.destroy();
  }
}, 15_000);
