import { Kysely, type Transaction, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { AssetDevelopRevisionKind, AssetDevelopRevisionStatus } from 'src/dtos/asset-develop.dto.js';
import { AssetLockReason, AssetType, AssetVisibility, JobName, MediaOperationStatus, QueueName } from 'src/enum.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { assertPublicationMotionSource, publicationTransaction } from 'src/queue/transaction.js';
import { AssetDevelopRepository, type AssetDevelopRevision } from 'src/repositories/asset-develop.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { DB } from 'src/schema/index.js';
import {
  down,
  down as downRenderAttempt,
  up,
  up as upRenderAttempt,
} from 'src/schema/migrations/2100000003014-DevelopSourceBindings.js';
import { BaseService } from 'src/services/base.service.js';
import { assetSourceFingerprint } from 'src/utils/asset-source-authority.js';
import { defaultDevelopRecipe } from 'src/utils/develop-recipe.js';
import { developSourceVersion } from 'src/utils/develop-source-binding.js';
import { EditOperationEdit, editOperationCreate } from 'src/utils/edit-operation.js';
import { bindSourceReference } from 'test/fixtures/source-reference.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});
const setup = async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const { asset } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Image });
  const sut = ctx.get(AssetDevelopRepository);
  const create = async (extra = {}) =>
    sut.create({
      expectedSourceVersion: developSourceVersion(
        await sut.getSourceBinding(
          asset.id,
          user.id,
          (extra as { recipe?: ReturnType<typeof defaultDevelopRecipe> }).recipe ?? defaultDevelopRecipe(),
        ),
      ),
      assetId: asset.id,
      ownerId: user.id,
      recipe: defaultDevelopRecipe(),
      recipeVersion: 1,
      label: null,
      status: AssetDevelopRevisionStatus.Saved,
      ...extra,
    });
  return { ctx, user, asset, sut, create };
};

const admit = async (f: Awaited<ReturnType<typeof setup>>, revision: AssetDevelopRevision, allowLocked: boolean) => {
  const queue = `reference-admission-${randomUUID()}`;
  await new SqlQueueStore(db).initialize([queue], randomUUID());
  const jobs = new JobRepository({} as never, {} as never, {} as never, LoggingRepository.create(), db);
  jobs['handlers'][JobName.AssetDevelopRender] = { queueName: queue as QueueName } as never;
  return f.sut.admitReferenceRender(revision, allowLocked, async (tx, queued, sourcePolicy) => {
    const job = {
      name: JobName.AssetDevelopRender as const,
      data: { id: revision.id, renderGenerationId: queued.renderGenerationId!, sourcePolicy },
    };
    const operation = await new MediaOperationRepository(db).create(
      editOperationCreate({
        ownerId: f.user.id,
        assetId: f.asset.id,
        edit: EditOperationEdit.PhotoVersion,
        label: 'Fixture',
        revisionId: revision.id,
        job,
      }),
      tx,
    );
    await jobs.queueInTransaction(tx, { ...job, data: { ...job.data, operationId: operation.id } });
    return operation;
  });
};

it('captures exact parent and pixel-resource identity in a saved reference recipe', async () => {
  const f = await setup();
  const bound = await bindSourceReference(db, f.asset);
  const revision = await f.create();
  expect(revision).toMatchObject({
    sourceAssetId: f.asset.id,
    sourceBinding: {
      kind: 'bound',
      parent: { assetId: f.asset.id, reference: bound.sourceReference },
      input: { assetId: f.asset.id, reference: bound.sourceReference },
    },
  });
  expect(revision.sourceChecksum).toEqual(Buffer.from(bound.sourceReference.sha256, 'hex'));
});

it.each(['version', 'checksum'] as const)(
  'refuses publication and current selection after resource-only %s changes',
  async (field) => {
    const f = await setup();
    const { resource } = await bindSourceReference(db, f.asset);
    const revision = await f.create();
    await db
      .updateTable('photo_source_resource')
      .set(field === 'version' ? { version: 'e'.repeat(64) } : { checksum: Buffer.alloc(32, 9) })
      .where('id', '=', resource.id)
      .execute();
    await expect(f.sut.update(revision.id, { status: AssetDevelopRevisionStatus.Rendered })).rejects.toThrow('source');
    await expect(f.sut.setCurrent(f.asset.id, revision.id)).rejects.toThrow('source');
    expect((await f.sut.get(revision.id))?.isCurrent).toBe(false);
  },
);

it('does not rebind a cloned historical recipe to the current reference version', async () => {
  const f = await setup();
  const { resource } = await bindSourceReference(db, f.asset);
  const original = await f.create();
  await db
    .updateTable('photo_source_resource')
    .set({ version: 'e'.repeat(64) })
    .where('id', '=', resource.id)
    .execute();
  await expect(f.create({ sourceRevisionId: original.id })).rejects.toThrow('source');
  expect(await f.sut.listByAsset(f.asset.id)).toHaveLength(1);
});

it('pins the actual motion input and refuses a later pair replacement', async () => {
  const f = await setup();
  const { asset: motion } = await f.ctx.newAsset({ ownerId: f.user.id, type: AssetType.Video });
  const { sourceReference } = await bindSourceReference(db, motion);
  await db.updateTable('asset').set({ livePhotoVideoId: motion.id }).where('id', '=', f.asset.id).execute();
  const revision = await f.create({ recipe: { ...defaultDevelopRecipe(), keyFrame: { timeMs: 50 } } });
  expect(revision).toMatchObject({
    sourceAssetId: motion.id,
    sourceBinding: { kind: 'bound', input: { assetId: motion.id, reference: sourceReference } },
  });
  await db.updateTable('asset').set({ livePhotoVideoId: null }).where('id', '=', f.asset.id).execute();
  await expect(f.sut.update(revision.id, { status: AssetDevelopRevisionStatus.Rendered })).rejects.toThrow();
});

it('preserves managed saves and marks unknown historical references inactive instead of guessing a snapshot', async () => {
  const f = await setup();
  const managed = await f.create();
  expect(managed).toHaveProperty('sourceBinding', null);
  await bindSourceReference(db, f.asset);
  await sql`UPDATE asset_develop_revision SET "sourceBinding"='{"kind":"unbound-reference"}'::jsonb WHERE id=${managed.id}::uuid`.execute(
    db,
  );
  await expect(f.sut.setCurrent(f.asset.id, managed.id)).rejects.toThrow('source');
  expect(await f.sut.listByAsset(f.asset.id)).toHaveLength(1);
});

it('preserves a binding while cloning an unchanged recipe', async () => {
  const f = await setup();
  await bindSourceReference(db, f.asset);
  const original = await f.create();
  const cloned = await f.create({ sourceRevisionId: original.id });
  expect(cloned.id).not.toBe(original.id);
  expect(cloned.sourceBinding).toEqual(original.sourceBinding);
  expect(cloned.sourceChecksum).toEqual(original.sourceChecksum);
});

it('refuses a logical reference without its verified resource mapping', async () => {
  const f = await setup();
  await bindSourceReference(db, f.asset);
  await db.deleteFrom('source_original').where('assetId', '=', f.asset.id).execute();
  await expect(f.create()).rejects.toThrow('resource');
  expect(await f.sut.listByAsset(f.asset.id)).toHaveLength(0);
});

it('backfills only an unbound marker and refuses destructive downgrade while metadata is retained', async () => {
  await db.transaction().execute(async (tx) => {
    await sql`CREATE TEMP TABLE asset(id uuid PRIMARY KEY, "originalPath" text) ON COMMIT DROP`.execute(tx);
    await sql`CREATE TEMP TABLE asset_develop_revision(id integer PRIMARY KEY, "assetId" uuid, "sourceAssetId" uuid) ON COMMIT DROP`.execute(
      tx,
    );
    const id = '10000000-0000-4000-8000-000000000001';
    await sql`INSERT INTO asset VALUES (${id}::uuid, ${`frameleaf-source://${id}/${'b'.repeat(64)}`})`.execute(tx);
    await sql`INSERT INTO asset_develop_revision VALUES (1,${id}::uuid,NULL)`.execute(tx);
    await up(tx);
    const { rows } = await sql<{ sourceBinding: unknown }>`SELECT "sourceBinding" FROM asset_develop_revision`.execute(
      tx,
    );
    expect(rows[0].sourceBinding).toEqual({ kind: 'unbound-reference' });
    await expect(down(tx)).rejects.toThrow('Cannot discard retained develop source bindings');
    expect((await sql`SELECT "sourceBinding" FROM asset_develop_revision`.execute(tx)).rows).toHaveLength(1);
  });
});

it.each(['unchanged', 'cancelled', 'new-attempt'] as const)(
  'publishes a deferred source failure only for the original eligible attempt: %s',
  async (state) => {
    const f = await setup();
    await bindSourceReference(db, f.asset);
    const revision = await f.create({ status: AssetDevelopRevisionStatus.Queued });
    if (state === 'cancelled') await f.sut.requestCancel(revision.id);
    else if (state === 'new-attempt') await f.sut.beginAttempt(revision.id, 'test-renderer', 60);
    await f.sut.failSourceBinding(revision, 'source changed');
    const current = await f.sut.get(revision.id);
    expect(current?.status).toBe(
      state === 'unchanged'
        ? AssetDevelopRevisionStatus.Failed
        : state === 'new-attempt'
          ? AssetDevelopRevisionStatus.Rendering
          : revision.status,
    );
    expect(current?.error).toBe(state === 'unchanged' ? 'source changed' : null);
  },
);

it('holds the source-resource fence through canonical publication in the caller transaction', async () => {
  const f = await setup();
  const { resource } = await bindSourceReference(db, f.asset);
  const revision = await f.create();
  await db.transaction().execute(async (tx) => {
    const repository = new AssetDevelopRepository(tx);
    await repository.assertSourceBinding(revision);
    await repository.update(revision.id, { status: AssetDevelopRevisionStatus.Rendered });
    await repository.setCurrent(f.asset.id, revision.id);
    await expect(
      db.transaction().execute(async (other) => {
        await sql`SET LOCAL lock_timeout='100ms'`.execute(other);
        await other
          .updateTable('photo_source_resource')
          .set({ version: 'e'.repeat(64) })
          .where('id', '=', resource.id)
          .execute();
      }),
    ).rejects.toMatchObject({ code: '55P03' });
  });
  expect((await f.sut.get(revision.id))?.isCurrent).toBe(true);
  await db
    .updateTable('photo_source_resource')
    .set({ version: 'e'.repeat(64) })
    .where('id', '=', resource.id)
    .execute();
  await expect(f.sut.assertSourceBinding(revision)).rejects.toThrow('source');
});

it.each([undefined, 'e'.repeat(64)])(
  'refuses a reference save without the previewed source version: %s',
  async (expectedSourceVersion) => {
    const f = await setup();
    await bindSourceReference(db, f.asset);
    await expect(f.create({ expectedSourceVersion })).rejects.toMatchObject({
      response: { code: 'develop_source_changed' },
    });
    expect(await f.sut.listByAsset(f.asset.id)).toHaveLength(0);
  },
);

it('accepts the displayed still version but refuses it after a resource-only change', async () => {
  const f = await setup();
  const { resource } = await bindSourceReference(db, f.asset);
  const expectedSourceVersion = developSourceVersion(
    await f.sut.getSourceBinding(f.asset.id, f.user.id, defaultDevelopRecipe()),
  );
  expect(expectedSourceVersion).toMatch(/^[a-f0-9]{64}$/u);
  await f.create({ expectedSourceVersion });
  await db
    .updateTable('photo_source_resource')
    .set({ version: 'e'.repeat(64) })
    .where('id', '=', resource.id)
    .execute();
  await expect(f.create({ expectedSourceVersion })).rejects.toMatchObject({
    response: { code: 'develop_source_changed' },
  });
  expect(await f.sut.listByAsset(f.asset.id)).toHaveLength(1);
});

it('refuses a reference preview version after the original becomes a managed copy', async () => {
  const f = await setup();
  await bindSourceReference(db, f.asset);
  const expectedSourceVersion = developSourceVersion(
    await f.sut.getSourceBinding(f.asset.id, f.user.id, defaultDevelopRecipe()),
  );
  await db.updateTable('asset').set({ originalPath: '/managed/original.jpg' }).where('id', '=', f.asset.id).execute();
  await expect(f.create({ expectedSourceVersion })).rejects.toMatchObject({
    response: { code: 'develop_source_changed' },
  });
});

it('requires the selected motion version rather than a still preview version', async () => {
  const f = await setup();
  await bindSourceReference(db, f.asset);
  const { asset: motion } = await f.ctx.newAsset({ ownerId: f.user.id, type: AssetType.Video });
  await bindSourceReference(db, motion);
  await db.updateTable('asset').set({ livePhotoVideoId: motion.id }).where('id', '=', f.asset.id).execute();
  const recipe = { ...defaultDevelopRecipe(), keyFrame: { timeMs: 50 } };
  const stillVersion = developSourceVersion(
    await f.sut.getSourceBinding(f.asset.id, f.user.id, defaultDevelopRecipe()),
  );
  const motionVersion = developSourceVersion(await f.sut.getSourceBinding(f.asset.id, f.user.id, recipe));
  expect(motionVersion).not.toBe(stillVersion);
  await expect(f.create({ recipe, expectedSourceVersion: stillVersion })).rejects.toMatchObject({
    response: { code: 'develop_source_changed' },
  });
  const revision = await f.create({ recipe, expectedSourceVersion: motionVersion });
  expect(revision.sourceAssetId).toBe(motion.id);
});

it('refuses a stopped diagnostic from before a manual retry even when the attempt counter repeats', async () => {
  const f = await setup();
  const revision = await f.create({ status: AssetDevelopRevisionStatus.Queued });
  const old = (await f.sut.beginAttempt(revision.id, 'test-renderer', 60))!;
  await f.sut.update(revision.id, { status: AssetDevelopRevisionStatus.Queued, attempts: 0 });
  const current = (await f.sut.beginAttempt(revision.id, 'test-renderer', 60))!;
  expect(current.attempts).toBe(old.attempts);
  expect(current.renderAttemptId).not.toBe(old.renderAttemptId);
  await expect(f.sut.progressAttempt(old, 95)).resolves.toBe(false);
  await expect(f.sut.assertSourceBinding(old)).rejects.toThrow('binding changed');
  await f.sut.settleAttempt(old, { status: AssetDevelopRevisionStatus.Failed, error: 'late source failure' });
  expect((await f.sut.get(revision.id))?.status).toBe(AssetDevelopRevisionStatus.Rendering);
});

it('preserves render fences when a downgrade would discard attempt ownership', async () => {
  await db.transaction().execute(async (tx) => {
    await sql`CREATE TEMP TABLE asset_develop_revision(id integer PRIMARY KEY, "assetId" uuid, "sourceAssetId" uuid) ON COMMIT DROP`.execute(
      tx,
    );
    await upRenderAttempt(tx);
    const token = '10000000-0000-4000-8000-000000000001';
    await sql`INSERT INTO asset_develop_revision(id, "renderAttemptId") VALUES (1, ${token}::uuid)`.execute(tx);
    await expect(downRenderAttempt(tx)).rejects.toThrow('Cannot discard retained develop source bindings');
    expect(
      (await sql<{ renderAttemptId: string }>`SELECT "renderAttemptId" FROM asset_develop_revision`.execute(tx)).rows[0]
        .renderAttemptId,
    ).toBe(token);
  });
});

it('publishes bound motion output with the motion locks before source-resource locks in one transaction', async () => {
  const f = await setup();
  await bindSourceReference(db, f.asset);
  const { asset: motion } = await f.ctx.newAsset({ ownerId: f.user.id, type: AssetType.Video });
  const { sourceReference } = await bindSourceReference(db, motion);
  await db.updateTable('asset').set({ livePhotoVideoId: motion.id }).where('id', '=', f.asset.id).execute();
  const revision = await f.create({
    recipe: { ...defaultDevelopRecipe(), keyFrame: { timeMs: 50 } },
    status: AssetDevelopRevisionStatus.Queued,
  });
  const attempt = (await f.sut.beginAttempt(revision.id, 'test-renderer', 60))!;
  await db.transaction().execute((tx) =>
    publicationTransaction.run(tx, async () => {
      await sql`SET LOCAL statement_timeout='2000ms'`.execute(tx);
      const parent = await tx
        .selectFrom('asset')
        .select('checksum')
        .where('id', '=', f.asset.id)
        .executeTakeFirstOrThrow();
      const input = await tx
        .selectFrom('asset')
        .select('checksum')
        .where('id', '=', motion.id)
        .executeTakeFirstOrThrow();
      await assertPublicationMotionSource(f.asset.id, f.user.id, parent.checksum, motion.id, input.checksum);
      await f.sut.assertSourceBinding(attempt);
      await f.sut.update(attempt.id, {
        status: AssetDevelopRevisionStatus.Rendered,
        sourceChecksum: Buffer.from(sourceReference.sha256, 'hex'),
      });
      await f.sut.setCurrent(f.asset.id, attempt.id);
    }),
  );
  expect((await f.sut.get(attempt.id))?.isCurrent).toBe(true);
});

it.each(['fail', 'cancel'] as const)('refuses a deferred Activity %s after its worker lease expires', async (kind) => {
  const f = await setup();
  const revision = await f.create();
  const operations = f.ctx.get(MediaOperationRepository);
  const operation = await operations.create(
    editOperationCreate({
      ownerId: f.user.id,
      assetId: f.asset.id,
      revisionId: revision.id,
      edit: EditOperationEdit.PhotoVersion,
      label: 'fixture',
      job: { name: JobName.AssetDevelopRender, data: { id: revision.id } },
    }),
  );
  const claim = (await operations.beginJobQueueRun(operation.id, 60_000))!;
  await db
    .updateTable('media_operation')
    .set({ claimExpiresAt: sql<Date>`clock_timestamp()-interval '1 second'` })
    .where('id', '=', operation.id)
    .execute();
  await db.transaction().execute(async (tx) => {
    if (kind === 'fail')
      await expect(
        operations.fail(
          operation.id,
          claim.claimToken,
          { error: 'source changed', errorCode: 'source_changed' },
          { retry: false, requireActiveClaim: true, executor: tx },
        ),
      ).resolves.toBe(false);
    else {
      await operations.requestCancelWithin(tx, operation.id, f.user.id, claim.claimToken);
      await expect(
        operations.acknowledgeCancel(operation.id, claim.claimToken, {
          released: true,
          requireActiveClaim: true,
          executor: tx,
        }),
      ).resolves.toBe(false);
    }
  });
  expect([MediaOperationStatus.Failed, MediaOperationStatus.Cancelled]).not.toContain(
    (await operations.getForOwner(operation.id, f.user.id))?.status,
  );
});

it('keeps automatic retries in one generation and refuses stale manual-admission claims', async () => {
  const f = await setup();
  const generation = '10000000-0000-4000-8000-000000000001';
  const laterGeneration = '10000000-0000-4000-8000-000000000002';
  const revision = await f.create({ status: AssetDevelopRevisionStatus.Queued });
  await f.sut.update(revision.id, { renderGenerationId: generation });
  const first = (await f.sut.beginAttempt(revision.id, 'test-renderer', 60, generation))!;
  await f.sut.settleAttempt(first, { status: AssetDevelopRevisionStatus.Queued, error: 'renderer failed' });
  const retry = (await f.sut.beginAttempt(revision.id, 'test-renderer', 60, generation))!;
  expect(retry.renderAttemptId).not.toBe(first.renderAttemptId);
  expect(retry.renderGenerationId).toBe(generation);
  await f.sut.update(revision.id, {
    status: AssetDevelopRevisionStatus.Queued,
    attempts: 0,
    renderGenerationId: laterGeneration,
  });
  await expect(f.sut.beginAttempt(revision.id, 'test-renderer', 60, generation)).resolves.toBeUndefined();
  expect((await f.sut.get(revision.id))?.status).toBe(AssetDevelopRevisionStatus.Queued);
});

it('does not let a cancelled delivery alter another queued generation or a retried Activity intent', async () => {
  const f = await setup();
  const generation = '10000000-0000-4000-8000-000000000001';
  const laterGeneration = '10000000-0000-4000-8000-000000000002';
  const revision = await f.create({ status: AssetDevelopRevisionStatus.Queued });
  const operations = f.ctx.get(MediaOperationRepository);
  const operation = await operations.create(
    editOperationCreate({
      ownerId: f.user.id,
      assetId: f.asset.id,
      revisionId: revision.id,
      edit: EditOperationEdit.PhotoVersion,
      label: 'fixture',
      job: { name: JobName.AssetDevelopRender, data: { id: revision.id, renderGenerationId: generation } },
    }),
  );
  await operations.requestCancel(operation.id, f.user.id);
  await f.sut.update(revision.id, { renderGenerationId: laterGeneration });
  await f.sut.cancelQueuedAttempt(revision.id, generation, operation.id);
  expect((await f.sut.get(revision.id))?.status).toBe(AssetDevelopRevisionStatus.Queued);
  await f.sut.update(revision.id, { renderGenerationId: generation });
  await db
    .updateTable('media_operation')
    .set({ status: MediaOperationStatus.Queued, cancelRequestedAt: null })
    .where('id', '=', operation.id)
    .execute();
  await f.sut.cancelQueuedAttempt(revision.id, generation, operation.id);
  expect((await f.sut.get(revision.id))?.status).toBe(AssetDevelopRevisionStatus.Queued);
  await operations.requestCancel(operation.id, f.user.id);
  await f.sut.cancelQueuedAttempt(revision.id, generation, operation.id);
  expect((await f.sut.get(revision.id))?.status).toBe(AssetDevelopRevisionStatus.Cancelled);
});

it.each(['offline', 'hidden', 'deleted', 'owner'] as const)(
  'refuses a currently unavailable render parent: %s',
  async (state) => {
    const f = await setup();
    const revision = await f.create();
    const { user: other } = await f.ctx.newUser();
    await db
      .updateTable('asset')
      .set(
        state === 'offline'
          ? { isOffline: true }
          : state === 'hidden'
            ? { visibility: AssetVisibility.Hidden }
            : state === 'deleted'
              ? { deletedAt: new Date() }
              : { ownerId: other.id },
      )
      .where('id', '=', f.asset.id)
      .execute();
    await expect(f.sut.assertRenderSource(revision)).rejects.toThrow('unavailable');
  },
);

it('preserves an admitted Locked edit and fences a later unlock', async () => {
  const f = await setup();
  const revision = await f.create();
  await db
    .insertInto('asset_lock')
    .values({ assetId: f.asset.id, reason: AssetLockReason.Marked, lockedBy: f.user.id, previousVisibility: null })
    .execute();
  const policy = await f.sut.assertRenderSource(revision);
  await expect(f.sut.assertRenderSource(revision, policy)).resolves.toEqual(policy);
  await db.deleteFrom('asset_lock').where('assetId', '=', f.asset.id).execute();
  await expect(f.sut.assertRenderSource(revision, policy)).rejects.toThrow('policy changed');
});

it.each(['lock', 'offline', 'visibility'] as const)('fences render-time source policy changes: %s', async (change) => {
  const f = await setup();
  const revision = await f.create();
  const policy = await f.sut.assertRenderSource(revision);
  if (change === 'lock')
    await db
      .insertInto('asset_lock')
      .values({ assetId: f.asset.id, reason: AssetLockReason.Marked, lockedBy: f.user.id, previousVisibility: null })
      .execute();
  else
    await db
      .updateTable('asset')
      .set(change === 'offline' ? { isOffline: true } : { visibility: AssetVisibility.Archive })
      .where('id', '=', f.asset.id)
      .execute();
  await expect(f.sut.assertRenderSource(revision, policy)).rejects.toThrow(/unavailable|policy changed/);
});

it('admits an external reference rendition only against its verified source version', async () => {
  const f = await setup();
  const { resource, sourceReference } = await bindSourceReference(db, f.asset);
  const recipe = defaultDevelopRecipe();
  const expectedSourceVersion = developSourceVersion(await f.sut.getSourceBinding(f.asset.id, f.user.id, recipe));
  const input = {
    assetId: f.asset.id,
    ownerId: f.user.id,
    recipe,
    recipeVersion: 1,
    kind: AssetDevelopRevisionKind.External,
    label: null,
    status: AssetDevelopRevisionStatus.Saved,
    sourceChecksum: Buffer.from(sourceReference.sha256, 'hex'),
    expectedSourceVersion,
  };
  await db
    .updateTable('photo_source_resource')
    .set({ version: 'e'.repeat(64) })
    .where('id', '=', resource.id)
    .execute();
  await expect(f.sut.create(input)).rejects.toMatchObject({ response: { code: 'develop_source_changed' } });
  expect(await f.sut.listByAsset(f.asset.id)).toHaveLength(0);
  const accepted = await f.sut.create({
    ...input,
    expectedSourceVersion: developSourceVersion(await f.sut.getSourceBinding(f.asset.id, f.user.id, recipe)),
  });
  expect(accepted.kind).toBe(AssetDevelopRevisionKind.External);
  expect(accepted.sourceBinding).toMatchObject({ kind: 'bound', input: { reference: { version: 'e'.repeat(64) } } });
});

it('admits exactly one reference generation with its private current source policy', async () => {
  const f = await setup();
  await bindSourceReference(db, f.asset);
  const saved = await f.create();
  const admitted = await admit(f, saved, false);
  expect(admitted.revision.status).toBe(AssetDevelopRevisionStatus.Queued);
  expect(admitted.revision.renderGenerationId).toMatch(/^[a-f0-9-]{36}$/u);
  expect(admitted.sourcePolicy).toBe(assetSourceFingerprint(await f.sut.assertRenderSource(admitted.revision)));
  const recorded = await new MediaOperationRepository(db).getForWorker(admitted.operation.id);
  expect(recorded?.revisionId).toBe(saved.id);
  const queued = await db
    .selectFrom('job')
    .select('data')
    .where(sql<string>`data->>'operationId'`, '=', admitted.operation.id)
    .executeTakeFirstOrThrow();
  expect(queued.data).toMatchObject({
    id: saved.id,
    renderGenerationId: admitted.revision.renderGenerationId,
    sourcePolicy: admitted.sourcePolicy,
  });
  await expect(admit(f, saved, false)).rejects.toThrow('already queued or changed');
  expect((await f.sut.get(saved.id))?.renderGenerationId).toBe(admitted.revision.renderGenerationId);
});

it('requires elevation for a currently Locked reference and refuses a changed queued policy', async () => {
  const f = await setup();
  await bindSourceReference(db, f.asset);
  const saved = await f.create();
  await db
    .insertInto('asset_lock')
    .values({ assetId: f.asset.id, reason: AssetLockReason.Marked, lockedBy: f.user.id, previousVisibility: null })
    .execute();
  await expect(admit(f, saved, false)).rejects.toThrow('Unlock this photo');
  expect((await f.sut.get(saved.id))?.status).toBe(AssetDevelopRevisionStatus.Saved);
  const admitted = await admit(f, saved, true);
  await db.deleteFrom('asset_lock').where('assetId', '=', f.asset.id).execute();
  expect(assetSourceFingerprint(await f.sut.assertRenderSource(admitted.revision))).not.toBe(admitted.sourcePolicy);
});

it('renews policy and generation only after a failed reference is explicitly readmitted', async () => {
  const f = await setup();
  await bindSourceReference(db, f.asset);
  const saved = await f.create();
  const original = await admit(f, saved, false);
  await f.sut.update(saved.id, { status: AssetDevelopRevisionStatus.Failed });
  await db.updateTable('asset').set({ visibility: AssetVisibility.Archive }).where('id', '=', f.asset.id).execute();
  const failed = (await f.sut.get(saved.id))!;
  const retry = await admit(f, failed, false);
  expect(retry.revision.renderGenerationId).not.toBe(original.revision.renderGenerationId);
  expect(retry.sourcePolicy).not.toBe(original.sourcePolicy);
  await expect(
    f.sut.beginAttempt(saved.id, 'renderer', 300, original.revision.renderGenerationId!),
  ).resolves.toBeUndefined();
});

it('does not overwrite the winner of concurrent reference admissions', async () => {
  const f = await setup();
  await bindSourceReference(db, f.asset);
  const saved = await f.create();
  const results = await Promise.allSettled([admit(f, saved, false), admit(f, saved, false)]);
  const accepted = results.filter((result) => result.status === 'fulfilled');
  const refused = results.filter((result) => result.status === 'rejected');
  expect(accepted).toHaveLength(1);
  expect(refused).toHaveLength(1);
  expect([400, 409]).toContain(refused[0].reason.getStatus());
  expect((await f.sut.get(saved.id))?.renderGenerationId).toBe(accepted[0].value.revision.renderGenerationId);
});

it.each(['activity', 'queue'] as const)(
  'rolls back all reference admission state after a %s recording failure',
  async (stage) => {
    const f = await setup();
    await bindSourceReference(db, f.asset);
    const saved = await f.create();
    const queue = `reference-admission-${randomUUID()}`;
    await new SqlQueueStore(db).initialize([queue], randomUUID());
    const jobs = new JobRepository({} as never, {} as never, {} as never, LoggingRepository.create(), db);
    jobs['handlers'][JobName.AssetDevelopRender] = { queueName: queue as QueueName } as never;
    const operations = new MediaOperationRepository(db);
    const observed = vi.fn();
    operations.onChange(observed);
    const record = async (tx: Transaction<DB>, revision: typeof saved, sourcePolicy: string) => {
      const job = {
        name: JobName.AssetDevelopRender as const,
        data: { id: revision.id, renderGenerationId: revision.renderGenerationId!, sourcePolicy },
      };
      const operation = await operations.create(
        editOperationCreate({
          ownerId: f.user.id,
          assetId: f.asset.id,
          edit: EditOperationEdit.PhotoVersion,
          label: 'Fixture',
          revisionId: revision.id,
          job,
        }),
        tx,
      );
      if (stage === 'activity') throw new Error('recording interrupted');
      await jobs.queueInTransaction(tx, { ...job, data: { ...job.data, operationId: operation.id } });
      throw new Error('recording interrupted');
    };
    await expect(f.sut.admitReferenceRender(saved, false, record)).rejects.toThrow('recording interrupted');
    expect((await f.sut.get(saved.id))?.status).toBe(AssetDevelopRevisionStatus.Saved);
    expect((await f.sut.get(saved.id))?.renderGenerationId).toBe(saved.renderGenerationId);
    expect(await db.selectFrom('media_operation').select('id').where('assetId', '=', f.asset.id).execute()).toEqual([]);
    expect(await db.selectFrom('job').select('id').where('queue', '=', queue).execute()).toEqual([]);
    expect(observed).not.toHaveBeenCalled();
  },
);

it.each(['source-revoked', 'device-revoked', 'session-expired'] as const)(
  'rechecks Develop authority after waiting for a lock: %s',
  async (change) => {
    const f = await setup();
    const { resource } = await bindSourceReference(db, f.asset);
    const saved = await f.create();
    const source = await db
      .selectFrom('photo_source')
      .innerJoin('photo_source_run', 'photo_source_run.sourceId', 'photo_source.id')
      .select(['photo_source.id', 'photo_source.deviceId', 'photo_source.photoSessionId'])
      .where('photo_source_run.id', '=', resource.runId)
      .executeTakeFirstOrThrow();
    if (change === 'session-expired')
      await db
        .updateTable('session')
        .set({ expiresAt: new Date(Date.now() + 500) })
        .where('id', '=', source.photoSessionId)
        .execute();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const blocker = db.transaction().execute(async (tx) => {
      if (change === 'device-revoked')
        await tx.selectFrom('desktop_device').select('id').where('id', '=', source.deviceId).forUpdate().execute();
      await tx.selectFrom('photo_source').select('id').where('id', '=', source.id).forUpdate().execute();
      await tx.selectFrom('asset').select('id').where('id', '=', f.asset.id).forUpdate().execute();
      entered.resolve();
      await release.promise;
      if (change === 'source-revoked')
        await tx.updateTable('photo_source').set({ revokedAt: new Date() }).where('id', '=', source.id).execute();
      else if (change === 'device-revoked')
        await tx
          .updateTable('desktop_device')
          .set({ revokedAt: new Date() })
          .where('id', '=', source.deviceId)
          .execute();
    });
    await entered.promise;
    const pending = f.create();
    void pending.catch(() => {});
    try {
      await expect
        .poll(
          async () =>
            (
              await sql<{ waiting: boolean }>`SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()
          AND wait_event_type='Lock') AS waiting`.execute(db)
            ).rows[0].waiting,
        )
        .toBe(true);
      if (change === 'session-expired') await sql`SELECT pg_sleep(0.6)`.execute(db);
    } finally {
      release.resolve();
      await blocker;
    }
    await expect(pending).rejects.toThrow('source');
    await expect(f.sut.assertSourceBinding(saved)).rejects.toThrow('source');
    expect((await f.sut.listByAsset(f.asset.id)).map(({ id }) => id)).toEqual([saved.id]);
  },
);

it('locks source authority before waiting on a Develop asset', async () => {
  const f = await setup();
  const { resource } = await bindSourceReference(db, f.asset);
  const source = await db
    .selectFrom('photo_source_run')
    .select('sourceId')
    .where('id', '=', resource.runId)
    .executeTakeFirstOrThrow();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const blocker = db.transaction().execute(async (tx) => {
    await tx.selectFrom('asset').select('id').where('id', '=', f.asset.id).forUpdate().execute();
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const pending = f.create();
  void pending.catch(() => {});
  try {
    await expect
      .poll(
        async () =>
          (
            await sql<{ waiting: boolean }>`SELECT EXISTS (
      SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()
        AND wait_event_type='Lock') AS waiting`.execute(db)
          ).rows[0].waiting,
      )
      .toBe(true);
    await expect(
      db
        .transaction()
        .execute((tx) =>
          sql`SELECT id FROM photo_source WHERE id=${source.sourceId}::uuid FOR UPDATE NOWAIT`.execute(tx),
        ),
    ).rejects.toMatchObject({ code: '55P03' });
  } finally {
    release.resolve();
    await blocker;
    await pending;
  }
});

it('rechecks session expiry after waiting for the saved revision lock', async () => {
  const f = await setup();
  const { resource } = await bindSourceReference(db, f.asset);
  const saved = await f.create();
  const source = await db
    .selectFrom('photo_source')
    .innerJoin('photo_source_run', 'photo_source_run.sourceId', 'photo_source.id')
    .select('photo_source.photoSessionId')
    .where('photo_source_run.id', '=', resource.runId)
    .executeTakeFirstOrThrow();
  await db
    .updateTable('session')
    .set({ expiresAt: new Date(Date.now() + 500) })
    .where('id', '=', source.photoSessionId)
    .execute();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const blocker = db.transaction().execute(async (tx) => {
    await sql`SELECT id FROM asset_develop_revision WHERE id=${saved.id}::uuid FOR UPDATE`.execute(tx);
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const pending = f.sut.assertSourceBinding(saved);
  void pending.catch(() => {});
  try {
    await expect
      .poll(
        async () =>
          (
            await sql<{ waiting: boolean }>`SELECT EXISTS (
      SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()
        AND wait_event_type='Lock') AS waiting`.execute(db)
          ).rows[0].waiting,
      )
      .toBe(true);
    await sql`SELECT pg_sleep(0.6)`.execute(db);
  } finally {
    release.resolve();
    await blocker;
  }
  await expect(pending).rejects.toThrow('source');
});

it('rolls back reference admission when its source session expires while recording the job', async () => {
  const f = await setup();
  const { resource } = await bindSourceReference(db, f.asset);
  const saved = await f.create();
  const source = await db
    .selectFrom('photo_source')
    .innerJoin('photo_source_run', 'photo_source_run.sourceId', 'photo_source.id')
    .select('photo_source.photoSessionId')
    .where('photo_source_run.id', '=', resource.runId)
    .executeTakeFirstOrThrow();
  await db
    .updateTable('session')
    .set({ expiresAt: new Date(Date.now() + 500) })
    .where('id', '=', source.photoSessionId)
    .execute();
  await expect(
    f.sut.admitReferenceRender(saved, false, async (tx) => {
      await sql`SELECT pg_sleep(0.6)`.execute(tx);
      return {} as never;
    }),
  ).rejects.toThrow('source');
  expect((await f.sut.get(saved.id))?.status).toBe(AssetDevelopRevisionStatus.Saved);
});
