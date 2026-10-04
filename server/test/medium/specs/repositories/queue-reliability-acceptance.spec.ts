import { Kysely, sql } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import { randomBytes, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import postgres from 'postgres';
import { AssetVisibility } from 'src/enum.js';
import { freezeSelection } from 'src/queue/manifest.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { QUEUE_HIGH_WATER, QUEUE_TIMING, QueueIntent } from 'src/queue/types.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetUploadResourceRepository } from 'src/repositories/asset-upload-resource.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PartnerRepository } from 'src/repositories/partner.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { RateLimitRepository } from 'src/repositories/rate-limit.repository.js';
import { SearchRepository } from 'src/repositories/search.repository.js';
import { TagRepository } from 'src/repositories/tag.repository.js';
import { DB } from 'src/schema/index.js';
import { SearchService } from 'src/services/search.service.js';
import { recordStoppedAttempt } from 'src/utils/attempt-evidence.js';
import { canonicalDatabaseUrl } from 'test/fixtures/canonical-database.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

// Hosted PG19 only. Work is synthetic queue work; upload admission and metadata search use real SQL services.
describe('queue connection recovery and repeated database pressure', () => {
  let admin: Kysely<DB>;
  let url: string;
  const queueReliabilityPool = (name: string, max: number) =>
    new Kysely<DB>({
      dialect: new PostgresJSDialect({
        postgres: postgres(url, {
          max,
          connect_timeout: 3,
          connection: { application_name: name, statement_timeout: 5000, lock_timeout: 2000 },
        }),
      }),
    });
  const intent = (queue: string, extra: Partial<QueueIntent> = {}): QueueIntent => ({
    queue,
    name: 'pressure-item',
    data: {},
    safeToRetry: true,
    sensitive: false,
    deadlineMs: QUEUE_TIMING.opaqueDeadline,
    ...extra,
  });
  beforeAll(async () => {
    const template = await getKyselyDB();
    try {
      const { rows } = await sql<{ name: string }>`select current_database() name`.execute(template);
      url = canonicalDatabaseUrl(process.env.IMMICH_TEST_POSTGRES_URL!, rows[0].name);
    } finally {
      await template.destroy();
    }
    admin = queueReliabilityPool('reliability-admin', 1);
  });
  afterAll(async () => admin?.destroy());

  it('reconnects after real backend termination and reconciles rollback plus one retry without a NOTIFY listener', async () => {
    const connection = queueReliabilityPool('reliability-reconnect', 1);
    const store = new SqlQueueStore(connection);
    const queue = `disconnect-${randomUUID()}`;
    const worker = randomUUID();
    try {
      await store.initialize([queue], worker);
      await store.setConcurrency(queue, 1);
      const runId = await store.createRun('connection-loss', {});
      await store.enqueue(
        ['first', 'second', 'third'].map((id) => intent(queue, { runId, itemKey: id, rootItemKey: id })),
      );
      await store.finishEnumeration(runId);
      const [completed] = await store.claim(queue, worker);
      expect(await store.complete(completed, [])).toBe(true);
      const [lost] = await store.claim(queue, worker);
      const child = intent(queue, {
        name: 'after-reconnect',
        itemKey: lost.itemKey!,
        rootItemKey: lost.rootItemKey,
        runId,
        parentId: lost.id,
      });
      const entered = Promise.withResolvers<number>();
      const interrupted = store
        .complete(lost, [child], async (tx) => {
          await sql`update job set error = 'uncommitted adoption' where id = ${lost.id}::uuid`.execute(tx);
          const { rows } = await sql<{ pid: number }>`select pg_backend_pid() pid`.execute(tx);
          entered.resolve(rows[0].pid);
          await sql`select pg_sleep(30)`.execute(tx);
        })
        .then(() => ({ failed: false }))
        .catch(() => ({ failed: true }));
      const oldPid = await Promise.race([
        entered.promise,
        interrupted.then(() => {
          throw new Error('Publication ended before entering the interrupted transaction');
        }),
      ]);
      await vi.waitFor(
        async () => {
          const { rows } = await sql<{ wait: string | null }>`select wait_event as wait from pg_stat_activity
            where pid = ${oldPid} and state = 'active'`.execute(admin);
          expect(rows[0]?.wait).toBe('PgSleep');
        },
        { timeout: 2000, interval: 20 },
      );
      const { rows: killed } = await sql<{
        stopped: boolean;
      }>`select pg_terminate_backend(${oldPid}, 5000) stopped`.execute(admin);
      expect(killed).toEqual([{ stopped: true }]);
      expect(await interrupted).toEqual({ failed: true }); // The old SQL executor has actually stopped.

      // Reuse the same pool/store: a fresh facade alone must not conceal a poisoned connection.
      const { rows: reconnected } = await sql<{ pid: number }>`select pg_backend_pid() pid`.execute(connection);
      expect(reconnected[0].pid).not.toBe(oldPid);
      const { rows: rolledBack } = await sql<{ state: string; error: string | null; token: string }>`
        select state, error, token from job where id = ${lost.id}::uuid`.execute(connection);
      expect(rolledBack[0]).toEqual({
        state: 'active',
        error: null,
        token: lost.token,
      });
      expect((await sql`select id from job where "parentId" = ${lost.id}::uuid`.execute(connection)).rows).toEqual([]);
      await recordStoppedAttempt(connection, lost.id, lost.token);
      await sql`update job set "leaseExpiresAt" = clock_timestamp() - interval '1 second' where id = ${lost.id}::uuid`.execute(
        connection,
      );
      // Explicit scan calls model the fallback coordinator scan; there is no LISTEN client in this fixture.
      await store.recoverExpired();
      await store.recoverExpired();
      const staleAdoption = vi.fn();
      expect(await store.complete(lost, [child], staleAdoption)).toBe(false);
      expect(staleAdoption).not.toHaveBeenCalled();
      const [healthy] = await store.claim(queue, worker);
      expect(healthy.id).not.toBe(lost.id);
      expect(await store.complete(healthy, [])).toBe(true);
      await sql`update job set "availableAt" = now() where id = ${lost.id}::uuid`.execute(connection);
      const [retry] = await store.claim(queue, worker);
      expect(retry).toMatchObject({ id: lost.id, attempt: 2 });
      expect(retry.token).not.toBe(lost.token);
      expect(await store.complete(retry, [child])).toBe(true);
      const [following] = await store.claim(queue, worker);
      expect(following.name).toBe(child.name);
      expect(await store.complete(following, [])).toBe(true);
      await store.recoverExpired();
      expect(await store.claim(queue, worker)).toEqual([]);
      expect((await store.listRuns(100, 0)).find((run) => run.id === runId)).toMatchObject({
        total: 3,
        completed: 3,
        failed: 0,
        state: 'completed',
        enumerationDone: true,
        stageTotals: { total: 4, completed: 4 },
      });
      const { rows: attempts } = await sql<{ jobId: string; count: number }>`select a."jobId", count(*)::int count
        from job_attempt a join job j on j.id = a."jobId" where j.queue = ${queue} group by a."jobId"`.execute(
        connection,
      );
      expect(attempts).toHaveLength(4);
      expect(attempts.find(({ jobId }) => jobId === lost.id)?.count).toBe(2);
      expect(attempts.filter(({ jobId }) => jobId !== lost.id).every(({ count }) => count === 1)).toBe(true);
    } finally {
      await connection.destroy();
    }
  }, 30_000);

  it('bounds three 1,250-item runs while real upload admission and owner-scoped metadata search stay responsive', async () => {
    const execution = queueReliabilityPool('reliability-queue', 1);
    const api = queueReliabilityPool('reliability-api', 2);
    const store = new SqlQueueStore(execution);
    const queue = `pressure-${randomUUID()}`;
    const worker = randomUUID();
    const config = new ConfigRepository();
    const environment = config.getEnv();
    vi.spyOn(config, 'getEnv').mockReturnValue({
      ...environment,
      database: { ...environment.database, config: { connectionType: 'url', url } },
    });
    const admission = new RateLimitRepository(config);
    const uploads = new AssetUploadResourceRepository(api);
    const { sut: search, ctx } = newMediumService(SearchService, {
      database: api,
      real: [
        AccessRepository,
        AssetRepository,
        DatabaseRepository,
        SearchRepository,
        PartnerRepository,
        PersonRepository,
        TagRepository,
      ],
      mock: [LoggingRepository],
    });
    let interactions = 0;
    let maximumLive = 0;
    try {
      const { user } = await ctx.newUser();
      const { user: stranger } = await ctx.newUser();
      const { asset: visible } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newAsset({ ownerId: stranger.id });
      await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Locked });
      const auth = factory.auth({ user });
      await store.initialize([queue], worker);
      await store.setConcurrency(queue, 64);
      for (let round = 0; round < 3; round++) {
        const runId = await freezeSelection(
          execution,
          intent(queue),
          execution
            .selectFrom(sql<{ id: string }>`(select generate_series(1, 1250)::text id)`.as('selected'))
            .select('id'),
        );
        let resourceId: string | undefined;
        let finished = false;
        for (let batch = 0; batch < 40; batch++) {
          expect(await store.feedManifest(queue)).toBeLessThanOrEqual(250);
          const claims = await store.claim(queue, worker);
          expect(claims.length).toBeGreaterThan(0);
          expect(claims.length).toBeLessThanOrEqual(64);
          const { rows } = await sql<{ count: number }>`select count(*)::int count from job
            where queue = ${queue} and state in ('pending','waiting','active')`.execute(admin);
          maximumLive = Math.max(maximumLive, rows[0].count);
          expect(rows[0].count).toBeLessThanOrEqual(QUEUE_HIGH_WATER);
          const interact = async () => {
            const started = performance.now();
            if (!resourceId) {
              const resource = await uploads.create(randomUUID(), user.id, {
                checksum: randomBytes(32),
                contentType: 'image/jpeg',
                size: 4,
                metadata: { filename: `pressure-${round}.jpg`, fileCreatedAt: new Date(), fileModifiedAt: new Date() },
              });
              expect(resource.state).toBe('receiving');
              resourceId = resource.id;
            }
            const token = randomUUID();
            expect(await admission.claimUploadStream(resourceId, token)).toBe(true);
            try {
              expect(await admission.claimUploadStream(resourceId, randomUUID())).toBe(false);
              expect(await admission.isUploadStreamCurrent(resourceId, token)).toBe(true);
              expect((await uploads.get(resourceId, user.id)).ownerId).toBe(user.id);
              const result = await search.searchMetadata(auth, { size: 10 });
              expect(result.assets.items.map(({ id }) => id)).toEqual([visible.id]);
            } finally {
              await admission.releaseUploadStream(resourceId, token);
            }
            expect(performance.now() - started).toBeLessThan(5000);
            // Retain one selected claim until this request finishes, guaranteeing overlap.
            expect((await store.counts(queue)).active).toBeGreaterThan(0);
            interactions++;
          };
          const control = async () => {
            const started = performance.now();
            await store.pause(queue, true);
            expect(await store.claim(queue, worker)).toEqual([]);
            expect(await store.feedManifest(queue)).toBe(0);
            await store.pause(queue, false);
            expect(performance.now() - started).toBeLessThan(5000);
          };
          const outcomes = await Promise.allSettled([
            ...claims.slice(1).map(async (claim) => expect(await store.complete(claim, [])).toBe(true)),
            interact(),
            control(),
          ]);
          for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
          expect(await store.complete(claims[0], [])).toBe(true);
          const { rows: pools } = await sql<{ name: string; count: number; transactions: number }>`
            select application_name name, count(*)::int count,
              count(*) filter(where state = 'idle in transaction')::int transactions from pg_stat_activity
            where datname = current_database() and application_name in ('reliability-queue','reliability-api','frameleaf:admission')
            group by application_name`.execute(admin);
          expect(pools).toHaveLength(3);
          for (const pool of pools) {
            expect(pool.count).toBeLessThanOrEqual(pool.name === 'reliability-queue' ? 1 : 2);
            expect(pool.transactions).toBe(0);
          }
          const run = (await store.listRuns(100, 0)).find((value) => value.id === runId)!;
          if (run.finishedAt) {
            expect(run).toMatchObject({
              total: 1250,
              completed: 1250,
              state: 'completed',
              enumerationDone: true,
              active: 0,
              waiting: 0,
              retrying: 0,
              failed: 0,
              stageTotals: { total: 1250, completed: 1250 },
            });
            finished = true;
            break;
          }
        }
        expect(finished).toBe(true);
        const { rows: attempts } = await sql<{
          count: number;
          highest: number;
        }>`select count(*)::int count, max(a.attempt)::int highest
          from job_attempt a join job j on j.id = a."jobId" where j."runId" = ${runId}::uuid`.execute(admin);
        expect(attempts).toEqual([{ count: 1250, highest: 1 }]);
        await store.heartbeat(worker, []);
      }
      expect(interactions).toBeGreaterThanOrEqual(60);
      expect(maximumLive).toBeGreaterThan(500);
    } finally {
      await admission.onModuleDestroy();
      await Promise.all([execution.destroy(), api.destroy()]);
    }
    await vi.waitFor(
      async () => {
        const { rows } = await sql<{ count: number }>`select count(*)::int count from pg_stat_activity
        where datname = current_database() and application_name in ('reliability-queue','reliability-api','frameleaf:admission')`.execute(
          admin,
        );
        expect(rows).toEqual([{ count: 0 }]);
      },
      { timeout: 2000 },
    );
  }, 180_000);
});
