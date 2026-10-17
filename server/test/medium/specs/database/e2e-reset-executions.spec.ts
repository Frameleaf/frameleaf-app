import { CompiledQuery, Kysely, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Exercise the exact E2E predicate and admission function, not a test copy of its SQL.
// eslint-disable-next-line no-restricted-imports
import {
  type ResetExecutionBlocker,
  assertResetExecutionsStopped,
  drainAfterExecutorStop,
  getResetExecutionBlocker,
} from '../../../../../e2e/src/harness-reset-executions.mjs';
import { ChecksumAlgorithm, MediaOperationDestination, MediaOperationKind, MediaOperationStatus } from 'src/enum.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { recordStoppedAttempt } from 'src/utils/attempt-evidence.js';
import { JOB_QUEUE_CLAIMANT, JOB_QUEUE_EXECUTOR } from 'src/utils/edit-operation.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

describe('E2E fixture reset executor-stop authority', () => {
  let db: Kysely<DB>;
  let store: SqlQueueStore;
  let queue: string;
  let worker: string;
  let directory: string;
  const bytes = 'The executor may still be reading this original';
  const executionQuery = (text: string) => db.executeQuery<ResetExecutionBlocker>(CompiledQuery.raw(text));

  beforeEach(async () => {
    // The guard is deliberately instance-wide. Each control needs its own retained history.
    db = await getKyselyDB();
    directory = await mkdtemp(join(tmpdir(), 'fl333-reset-stop-'));
    queue = `reset-stop-${randomUUID()}`;
    worker = randomUUID();
    store = new SqlQueueStore(db);
    await store.initialize([queue], worker);
  });

  afterEach(async () => {
    try {
      await db?.destroy();
    } finally {
      if (directory) {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  const fixture = async (options: { admin?: boolean; linked?: boolean; sensitive?: boolean } = {}) => {
    const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
    const { user } = await ctx.newUser({ isAdmin: options.admin ?? true });
    const originalPath = join(directory, 'original.txt');
    await writeFile(originalPath, bytes);
    const { asset } = await ctx.newAsset({
      ownerId: user.id,
      originalPath,
      checksum: createHash('sha256').update(bytes).digest(),
      checksumAlgorithm: ChecksumAlgorithm.sha256File,
    });
    const operations = ctx.get(MediaOperationRepository);
    const operation = options.linked
      ? await operations.create({
          ownerId: user.id,
          assetId: asset.id,
          kind: MediaOperationKind.StudioExport,
          destination: MediaOperationDestination.Local,
          label: 'Reset safety control',
          snapshot: { executor: JOB_QUEUE_EXECUTOR },
          settings: {},
          claimedBy: JOB_QUEUE_CLAIMANT,
        })
      : undefined;
    if (operation) {
      expect(await operations.beginJobQueueRun(operation.id, 60_000)).toBeDefined();
    }
    await store.enqueue([
      {
        queue,
        name: 'reset-stop-control',
        data: { id: asset.id, ...(operation && { operationId: operation.id }) },
        safeToRetry: true,
        sensitive: options.sensitive ?? false,
        deadlineMs: 60_000,
      },
    ]);
    const [claim] = await store.claim(queue, worker);
    expect(claim).toBeDefined();

    const expire = async () => {
      // The only forced lifecycle field is elapsed lease time. Production recovery writes the
      // needs_attention job/attempt and linked failed/null-claim operation itself.
      await sql`update job set "leaseExpiresAt" = clock_timestamp() - interval '31 seconds'
        where id = ${claim.id}::uuid`.execute(db);
      await store.recoverExpired();
      expect((await sql`select state, token from job where id = ${claim.id}::uuid`.execute(db)).rows).toEqual([
        { state: 'needs_attention', token: null },
      ]);
      expect(await store.hasUnfinishedWork(queue)).toBe(false);
      expect(
        (
          await sql`select outcome, "finishedAt" is not null as finished from job_attempt
          where token = ${claim.token}::uuid`.execute(db)
        ).rows,
      ).toEqual([{ outcome: 'needs_attention', finished: true }]);
    };

    const clear = vi.fn(() => store.clear(queue, ['pending', 'waiting', 'failed', 'needs_attention', 'blocked']));
    const mutate = vi.fn(async () => {
      await db.deleteFrom('asset').where('id', '=', asset.id).execute();
      await unlink(originalPath);
    });
    const reset = async () => {
      const paused = await store.isPaused(queue);
      await store.pause(queue, true);
      try {
        // Same shared gate used before both E2E branches. Administrative clear is behind it,
        // and the pre-mutation assertion repeats after clear can have redacted the job payload.
        const unfinished = await drainAfterExecutorStop(executionQuery, async () => {
          const admin = await db.selectFrom('user').select('id').where('isAdmin', '=', true).executeTakeFirst();
          if (admin) {
            await clear();
          }
          return store.hasUnfinishedWork(queue);
        });
        if (unfinished) {
          throw new Error('Reset is still waiting for an active executor');
        }
        await assertResetExecutionsStopped(executionQuery);
        await mutate();
      } finally {
        await store.pause(queue, paused);
      }
    };
    const expectIntact = async () => {
      expect(clear).not.toHaveBeenCalled();
      expect(mutate).not.toHaveBeenCalled();
      expect(await readFile(originalPath, 'utf8')).toBe(bytes);
      expect(
        await db.selectFrom('asset').select(['id', 'ownerId', 'originalPath']).where('id', '=', asset.id).execute(),
      ).toEqual([{ id: asset.id, ownerId: user.id, originalPath }]);
      expect(await store.isPaused(queue)).toBe(false);
      if (operation) {
        expect(
          await db
            .selectFrom('media_operation')
            .select(['status', 'claimToken', 'errorCode', 'autoRetries'])
            .where('id', '=', operation.id)
            .executeTakeFirst(),
        ).toEqual({
          status: MediaOperationStatus.Failed,
          claimToken: null,
          errorCode: 'executor_stop_unconfirmed',
          autoRetries: 0,
        });
      }
    };
    return { claim, operation, expire, clear, mutate, reset, expectIntact };
  };

  it.each([
    { admin: true, cleared: false },
    { admin: false, cleared: false },
    { admin: true, cleared: true },
    { admin: false, cleared: true },
  ])(
    'refuses unconfirmed recovery before mutation (admin=$admin, previously cleared=$cleared)',
    async ({ admin, cleared }) => {
      const state = await fixture({ admin });
      await state.expire();
      if (cleared) {
        await store.clear(queue, ['needs_attention']);
      }
      await expect(state.reset()).rejects.toThrow('executor stop is unconfirmed for retained attempt');
      await state.expectIntact();
      expect((await sql`select state from job where id = ${state.claim.id}::uuid`.execute(db)).rows).toEqual([
        { state: cleared ? 'cancelled' : 'needs_attention' },
      ]);
      expect(
        (
          await sql`select key from system_metadata where key like 'frameleaf-%-stopped:%'
      or key like 'frameleaf-attempt-evidence:%'`.execute(db)
        ).rows,
      ).toEqual([]);
    },
  );

  it.each([false, true])(
    'retains a linked failed/null-claim operation and its originals (sensitive=$0)',
    async (sensitive) => {
      const state = await fixture({ admin: false, linked: true, sensitive });
      await state.expire();
      await expect(state.reset()).rejects.toThrow('executor stop is unconfirmed');
      await state.expectIntact();
      // Even after this attempt's real stop is acknowledged, the domain's unresolved error is
      // not silently erased. Sensitive recovery/old clear may have removed its correlation.
      await recordStoppedAttempt(db, state.claim.id, state.claim.token);
      await store.clear(queue, ['needs_attention']);
      expect((await sql`select data from job where id = ${state.claim.id}::uuid`.execute(db)).rows).toEqual([
        { data: {} },
      ]);
      await expect(state.reset()).rejects.toThrow(`retained operation ${state.operation!.id}`);
      await state.expectIntact();
    },
  );

  it('rejects unrelated tokens, jobs and worker identities, not just absent proof keys', async () => {
    const state = await fixture();
    await state.expire();
    await recordStoppedAttempt(db, state.claim.id, randomUUID());
    await recordStoppedAttempt(db, randomUUID(), state.claim.token);
    await sql`insert into system_metadata (key, value) values
      (${'frameleaf-worker-stopped:' + randomUUID()}, ${JSON.stringify({ workerId: worker, stoppedAt: Date.now() })}::text::jsonb),
      (${'frameleaf-worker-stopped:' + worker}, ${JSON.stringify({ workerId: randomUUID(), stoppedAt: Date.now() })}::text::jsonb)`.execute(
      db,
    );
    await expect(state.reset()).rejects.toThrow('executor stop is unconfirmed for retained attempt');
    await state.expectIntact();
    await sql`update system_metadata set value = jsonb_build_object('jobId', ${state.claim.id}::text)
      where key = ${'frameleaf-attempt-evidence:' + state.claim.token}`.execute(db);
    await sql`update system_metadata set value = jsonb_build_object('workerId', ${worker}::text)
      where key = ${'frameleaf-worker-stopped:' + worker}`.execute(db);
    await expect(state.reset()).rejects.toThrow('executor stop is unconfirmed for retained attempt');
    await state.expectIntact();
  });

  it.each(['attempt', 'worker'])('admits the retained attempt only after matching %s stopped proof', async (proof) => {
    const state = await fixture();
    await state.expire();
    await expect(state.reset()).rejects.toThrow('executor stop is unconfirmed');
    // This controls the shared SQL gate. A failed utils reset remains poisoned for the process;
    // recording proof does not silently revive that old reset or discard its original error.
    if (proof === 'attempt') {
      await recordStoppedAttempt(db, state.claim.id, state.claim.token);
    } else {
      await sql`insert into system_metadata (key, value) values (${'frameleaf-worker-stopped:' + worker},
        ${JSON.stringify({ workerId: worker, stoppedAt: Date.now() })}::text::jsonb)`.execute(db);
    }
    await expect(state.reset()).resolves.toBeUndefined();
    expect(state.clear).toHaveBeenCalledOnce();
    expect(state.mutate).toHaveBeenCalledOnce();
    expect((await sql`select state, data from job where id = ${state.claim.id}::uuid`.execute(db)).rows).toEqual([
      { state: 'cancelled', data: {} },
    ]);
    await expect(assertResetExecutionsStopped(executionQuery)).resolves.toBeUndefined();
  });

  it('allows normal completed-and-finished attempts without synthesizing extra proof', async () => {
    const state = await fixture();
    expect(await store.complete(state.claim, [])).toBe(true);
    expect(await getResetExecutionBlocker(executionQuery)).toBeUndefined();
    await expect(state.reset()).resolves.toBeUndefined();
    expect(state.mutate).toHaveBeenCalledOnce();
  });

  it('waits for an active cancellation request without clearing payloads or starting mutation', async () => {
    const state = await fixture();
    await sql`update job set "cancelRequestedAt" = now() where id = ${state.claim.id}::uuid`.execute(db);
    expect(await getResetExecutionBlocker(executionQuery)).toEqual({
      kind: 'attempt',
      id: state.claim.id,
      active: true,
    });
    await expect(state.reset()).rejects.toThrow('still waiting for an active executor');
    await state.expectIntact();
  });
});
