import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { AssetStatus, QueueName } from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { QueueClaim } from 'src/queue/types.js';
import { AssetLocalEffectRepository, LocalEffectIntent } from 'src/repositories/asset-local-effect.repository.js';
import { DB } from 'src/schema/index.js';
import { canonicalTestContext, expectCanonicalTables } from 'test/fixtures/canonical-database.js';
import { getKyselyDB } from 'test/utils.js';

describe('C2 local effect authority on the canonical migration chain', () => {
  let db: Kysely<DB>;
  beforeEach(async () => {
    db = await getKyselyDB();
  });
  afterEach(async () => {
    await db.destroy();
  });

  it('C2 RED: installs the reserved durable stream, separate cursor, immutable effects and source epochs', async () => {
    await expectCanonicalTables(db, [
      'asset_local_effect_stream',
      'asset_local_effect_cursor',
      'asset_local_effect',
      'asset_source_epoch',
    ]);
  });

  async function fixture() {
    const ctx = canonicalTestContext(db);
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    return { user, asset, repo: new AssetLocalEffectRepository(db) };
  }
  const intent = (assetId: string, status: AssetStatus.Active | AssetStatus.Trashed): LocalEffectIntent => ({
    origin: { kind: status === AssetStatus.Trashed ? 'trash' : 'restore' },
    assets: [{ assetId, status, revoke: status === AssetStatus.Trashed }],
    stacks: [],
  });
  const change = (
    f: Awaited<ReturnType<typeof fixture>>,
    status: AssetStatus.Active | AssetStatus.Trashed,
    id = randomUUID(),
  ) =>
    db.transaction().execute(async (tx) => {
      await tx
        .updateTable('asset')
        .set({ status, deletedAt: status === AssetStatus.Trashed ? new Date() : null })
        .where('id', '=', f.asset.id)
        .execute();
      return f.repo.append(tx, f.user.id, id, intent(f.asset.id, status));
    });
  const run = <T>(claim: QueueClaim, callback: () => Promise<T>) =>
    queueExecution.run(
      {
        claim,
        signal: new AbortController().signal,
        progress: () => {},
        followups: [],
        adoptions: [],
        buffering: true,
        progressUnits: 0,
      },
      callback,
    );

  it('rolls back source mutation, epoch, immutable effect and counter together', async () => {
    const f = await fixture();
    await expect(
      db.transaction().execute(async (tx) => {
        await tx
          .updateTable('asset')
          .set({ status: AssetStatus.Trashed, deletedAt: new Date() })
          .where('id', '=', f.asset.id)
          .execute();
        await f.repo.append(tx, f.user.id, randomUUID(), intent(f.asset.id, AssetStatus.Trashed));
        throw new Error('rollback after effect');
      }),
    ).rejects.toThrow('rollback after effect');
    expect(
      (await db.selectFrom('asset').select('status').where('id', '=', f.asset.id).executeTakeFirstOrThrow()).status,
    ).toBe(AssetStatus.Active);
    expect(await AssetLocalEffectRepository.sourceEpochs(db, [f.asset.id])).toEqual([
      { assetId: f.asset.id, ownerId: f.user.id, epoch: '0' },
    ]);
    expect(await db.selectFrom('asset_local_effect_stream').select('ownerId').execute()).toEqual([]);
    expect((await change(f, AssetStatus.Trashed)).sequence).toBe('1');
  });

  it('restoration retains permanent old-source revocation and replay cannot allocate another effect', async () => {
    const f = await fixture();
    const removed = await change(f, AssetStatus.Trashed);
    const restored = await change(f, AssetStatus.Active);
    expect(restored.sequence).toBe('2');
    expect(restored.assets[0].sourceEpoch).toBe(removed.sequence);
    expect(restored.revocations).toEqual([]);
    const replay = await db
      .transaction()
      .execute((tx) => f.repo.append(tx, f.user.id, removed.effectId, intent(f.asset.id, AssetStatus.Trashed)));
    expect(replay).toEqual(removed);
    expect(await db.selectFrom('asset_local_effect').select('effectId').execute()).toHaveLength(2);
    expect(
      (await db.selectFrom('asset').select('status').where('id', '=', f.asset.id).executeTakeFirstOrThrow()).status,
    ).toBe(AssetStatus.Active);
    await expect(
      db
        .transaction()
        .execute((tx) => f.repo.append(tx, f.user.id, removed.effectId, intent(f.asset.id, AssetStatus.Active))),
    ).rejects.toThrow('asset_local_effect_conflict');
  });

  it('keeps decimal sequence and epochs exact beyond JavaScript safe integers', async () => {
    const f = await fixture();
    await change(f, AssetStatus.Trashed);
    await sql`UPDATE asset_local_effect_stream SET "nextSequence"=9007199254740993 WHERE "ownerId"=${f.user.id}::uuid`.execute(
      db,
    );
    const effect = await change(f, AssetStatus.Active);
    expect(effect.sequence).toBe('9007199254740993');
    expect(
      (
        await sql<{
          sequence: string;
        }>`SELECT "nextSequence"::text AS sequence FROM asset_local_effect_stream WHERE "ownerId"=${f.user.id}::uuid`.execute(
          db,
        )
      ).rows[0].sequence,
    ).toBe('9007199254740994');
  });

  it('does not block append on a dispatcher cursor and retries the exact failed head before any successor', async () => {
    const f = await fixture();
    const first = await change(f, AssetStatus.Trashed);
    const store = new SqlQueueStore(db);
    const worker = randomUUID();
    await store.initialize([QueueName.BackgroundTask], worker);
    expect(await f.repo.enqueuePending()).toBe(1);
    const [claim] = await store.claim(QueueName.BackgroundTask, worker);
    expect(claim).toBeDefined();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const delivered: string[] = [];
    const dispatch = run(claim, () =>
      f.repo.dispatch(f.user.id, async (bundle) => {
        delivered.push(bundle.sequence);
        entered.resolve();
        await release.promise;
        throw new Error('handler rejected');
      }),
    );
    const rejected = expect(dispatch).rejects.toThrow('handler rejected');
    await entered.promise;
    const restore = await change(f, AssetStatus.Active);
    expect(restore.sequence).toBe('2');
    release.resolve();
    await rejected;
    const cursor = await db
      .selectFrom('asset_local_effect_cursor')
      .select('acknowledgedSequence')
      .where('ownerId', '=', f.user.id)
      .executeTakeFirstOrThrow();
    expect(cursor.acknowledgedSequence).toBeNull();
    expect(
      await run(claim, () =>
        f.repo.dispatch(f.user.id, async (bundle) => {
          delivered.push(bundle.sequence);
        }),
      ),
    ).toBe(true);
    expect(
      await run(claim, () =>
        f.repo.dispatch(f.user.id, async (bundle) => {
          delivered.push(bundle.sequence);
        }),
      ),
    ).toBe(true);
    expect(delivered).toEqual([first.sequence, first.sequence, restore.sequence]);
    expect(await store.complete(claim, [])).toBe(true);
    expect((await AssetLocalEffectRepository.sourceEpochs(db, [f.asset.id]))[0].epoch).toBe(first.sequence);
  });

  it('refuses foreign current source facts and refuses dispatch without accepted queue authority', async () => {
    const f = await fixture();
    const { user } = await canonicalTestContext(db).newUser();
    await expect(
      db
        .transaction()
        .execute((tx) => f.repo.append(tx, user.id, randomUUID(), intent(f.asset.id, AssetStatus.Active))),
    ).rejects.toThrow('asset_local_effect_conflict');
    await change(f, AssetStatus.Trashed);
    await expect(f.repo.dispatch(f.user.id, async () => {})).rejects.toThrow('asset_local_effect_conflict');
  });
});
