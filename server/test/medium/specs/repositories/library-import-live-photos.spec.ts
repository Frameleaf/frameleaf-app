import { CompiledQuery, Kysely, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { AssetLockReason, JobName, QueueName } from 'src/enum.js';
import { ImportDatabase } from 'src/immich-import/types.js';
import { reconcileImportedAssets } from 'src/library-import/asset-reconciliation.js';
import { CanonicalAssetWriter } from 'src/library-import/asset-writer.js';
import { destinationPlanFingerprint, parseDestinationImportPlan } from 'src/library-import/destination-plan.js';
import { verifyImportFiles } from 'src/library-import/files.js';
import fixture from 'src/library-import/fixtures/manager-plan-v1.json' with { type: 'json' };
import { importFileSchema, manifestFingerprint, parseImportManifest } from 'src/library-import/manifest.js';
import { createImportedOwner } from 'src/library-import/owners.js';
import { retainReviewedImportInputs } from 'src/library-import/reviewed-inputs.js';
import { reconcileImportedStacks } from 'src/library-import/stack-reconciliation.js';
import { CanonicalStackWriter } from 'src/library-import/stack-writer.js';
import { LibraryImportJournal } from 'src/library-import/state.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { DB } from 'src/schema/index.js';
import { getKyselyDB } from 'test/utils.js';

vi.mock('src/library-import/files.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('src/library-import/files.js')>()),
  verifyImportFiles: vi.fn(),
}));
let db: Kysely<DB>;
const wrap = (connection: Kysely<any>): ImportDatabase => ({
  query: async (statement, parameters = []) =>
    (await connection.executeQuery(CompiledQuery.raw(statement, parameters))).rows as Record<string, unknown>[],
  transaction: (body) => connection.transaction().execute((tx) => body(wrap(tx))),
});
const setup = async (stacked = false, placements = false, locked = false, archived = false) => {
  let plan = parseDestinationImportPlan(fixture.plan);
  plan.owners = ['owner', 'viewer', 'editor', 'unrelated'].map((sourceId) => ({
    sourceId,
    destinationId: randomUUID(),
  }));
  const template = plan.files[0];
  plan.files = ['motion', 'still', 'outside'].map((id, index) => ({
    ...template,
    id,
    sourcePath: id + '.jpg',
    destinationPath: id + '.jpg',
    sha256: createHash('sha256').update(id).digest('hex'),
    bytes: '3',
    sourceIdentity: { ...template.sourceIdentity, bytes: '3', inode: String(100 + index) },
  }));
  const manifest = parseImportManifest({
    format: 'frameleaf-library-import',
    version: 5,
    source: plan.source,
    inventory: {
      complete: true,
      ownershipComplete: true,
      privacyComplete: true,
      writersStopped: true,
      revisionBefore: plan.source.revision,
      revisionAfter: plan.source.revision,
    },
    users: plan.owners.map((owner) => ({ id: owner.sourceId, name: owner.sourceId })),
    files: plan.files.map((file) => ({
      id: file.id,
      path: file.sourcePath,
      bytes: file.bytes,
      sha256: file.sha256,
      role: 'original',
    })),
    assets: plan.files.map((file) => ({
      id: file.id,
      ownerId: 'owner',
      fileIds: [file.id],
      primaryFileId: file.id,
      type: file.id === 'motion' ? 'VIDEO' : 'IMAGE',
      fileModifiedAt: '2020-01-02T03:04:05Z',
      originalFileNames: { [file.id]: file.id + '.jpg' },
      visibility: file.id === 'motion' ? 'hidden' : locked ? 'locked' : 'timeline',
      ...(file.id !== 'motion' && archived ? { archived: true } : {}),
      metadata: { takenAt: '2020-01-02T03:04:05Z', timeZone: 'UTC' },
    })),
    albums: [],
    stacks: stacked
      ? [{ id: 'stack', ownerId: 'owner', primaryAssetId: 'outside', assetIds: ['still', 'outside'] }]
      : [],
    livePhotos: [{ photoAssetId: 'still', videoAssetId: 'motion' }],
    losses: [],
  });
  if (placements)
    plan = parseDestinationImportPlan({
      ...plan,
      version: 2,
      files: plan.files.map((file) => ({
        ...file,
        id: 'placement-' + file.id,
        sourceAssetId: file.id,
        sourceFileId: file.id,
      })),
    });
  const binding = {
    operationId: randomUUID(),
    manifestSha256: manifestFingerprint(manifest),
    planSha256: destinationPlanFingerprint(plan),
    source: plan.source,
  };
  const journal = new LibraryImportJournal(wrap(db));
  await journal.begin(binding);
  for (const owner of plan.owners)
    await journal.apply(
      binding,
      { kind: 'owner', sourceId: owner.sourceId, destinationId: owner.destinationId, recordSha256: 'a'.repeat(64) },
      (tx) =>
        createImportedOwner(tx, {
          operationId: binding.operationId,
          sourceUserId: owner.sourceId,
          destinationUserId: owner.destinationId,
          name: owner.sourceId,
          email: owner.sourceId + '@example.test',
        }),
    );
  const context = { binding, plan, manifest, destinationId: plan.destinationId };
  vi.mocked(verifyImportFiles).mockImplementation((_root, input) => {
    const files = input as { bytes: string }[];
    return Promise.resolve({
      files: files.length,
      bytes: String(files.reduce((sum, file) => sum + BigInt(file.bytes), 0n)),
    });
  });
  const photos: Record<string, string> = {};
  const input = (sourceAssetId: string) => ({
    sourceAssetId,
    type: sourceAssetId === 'motion' ? 'VIDEO' : 'IMAGE',
    fileModifiedAt: '2020-01-02T03:04:05Z',
    originalFileNames: { [sourceAssetId]: sourceAssetId + '.jpg' },
  });
  const writer = new CanonicalAssetWriter(wrap(db), context);
  for (const id of ['motion', 'outside']) photos[id] = await writer.write(input(id));
  return {
    context,
    input,
    writer,
    photos,
    users: Object.fromEntries(plan.owners.map((owner) => [owner.sourceId, owner.destinationId])),
  };
};
beforeAll(async () => {
  db = await getKyselyDB();
});
beforeEach(async () => {
  vi.mocked(verifyImportFiles).mockReset();
  await sql`TRUNCATE public.job_run,public.job,public.physical_file,public."user",public.cluster_group,public.album,public.album_audit,
    public.album_user_audit,public.album_asset_audit,public.user_audit,public.user_preference_history,
    public.frameleaf_library_import_mapping,public.frameleaf_library_import,public.frameleaf_immich_import CASCADE`.execute(
    db,
  );
  await sql`WITH g AS (INSERT INTO public.cluster_group DEFAULT VALUES RETURNING id)
    INSERT INTO public."user" (email,"clusterGroupId","isAdmin") SELECT 'bootstrap@example.test',id,true FROM g`.execute(
    db,
  );
});
afterAll(async () => db?.destroy());

it('reconciles explicit Live Photo pairs with independent V2 file placements', async () => {
  const { context, writer, input, photos } = await setup(false, true);
  const id = await writer.write(input('still'));
  expect(await writer.write(input('still'))).toBe(id);
  expect((await sql`SELECT "livePhotoVideoId" FROM public.asset WHERE id=${id}`.execute(db)).rows).toEqual([
    { livePhotoVideoId: photos.motion },
  ]);
  await new LibraryImportJournal(wrap(db)).phase(context.binding, 'verifying');
  expect(
    await reconcileImportedAssets(
      wrap(db),
      context,
      ['motion', 'still', 'outside'].map((id) => input(id)),
    ),
  ).toMatchObject({
    assets: 3,
    originals: 3,
    bytes: '9',
  });
  expect(
    (
      await sql`SELECT source_id FROM public.frameleaf_library_import_mapping WHERE entity_kind='file' ORDER BY source_id`.execute(
        db,
      )
    ).rows,
  ).toEqual([{ source_id: 'placement-motion' }, { source_id: 'placement-outside' }, { source_id: 'placement-still' }]);
  const files = importFileSchema.array().parse(vi.mocked(verifyImportFiles).mock.calls.at(-1)![1]);
  expect(files.map((file) => file.id).sort()).toEqual(['placement-motion', 'placement-outside', 'placement-still']);
});

it('atomically retains the explicit motion original and stable replay without extra album access', async () => {
  const { context, writer, input, photos, users } = await setup();
  const id = await writer.write(input('still'));
  expect(await new CanonicalAssetWriter(wrap(db), context).write(input('still'))).toBe(id);
  expect((await sql`SELECT "livePhotoVideoId","ownerId" FROM public.asset WHERE id=${id}`.execute(db)).rows).toEqual([
    { livePhotoVideoId: photos.motion, ownerId: users.owner },
  ]);
  expect((await sql`SELECT visibility,type FROM public.asset WHERE id=${photos.motion}`.execute(db)).rows).toEqual([
    { visibility: 'hidden', type: 'VIDEO' },
  ]);
  expect((await sql`SELECT count(*)::text AS count FROM public.physical_file`.execute(db)).rows).toEqual([
    { count: '3' },
  ]);
  expect(
    (await sql`SELECT "quotaUsageInBytes"::text AS bytes FROM public."user" WHERE id=${users.owner}`.execute(db)).rows,
  ).toEqual([{ bytes: '9' }]);
  expect((await sql`SELECT * FROM public.album_asset WHERE "assetId"=${photos.motion}`.execute(db)).rows).toEqual([]);
});

it.each(['owner', 'type', 'visibility', 'deleted', 'lock', 'already-linked', 'fingerprint', 'album', 'stack'] as const)(
  'refuses changed motion %s without creating partial originals or relationships',
  async (kind) => {
    const { writer, input, photos, users } = await setup();
    switch (kind) {
      case 'owner': {
        await sql`UPDATE public.asset SET "ownerId"=${users.unrelated} WHERE id=${photos.motion}`.execute(db);
        break;
      }
      case 'type': {
        await sql`UPDATE public.asset SET type='IMAGE' WHERE id=${photos.motion}`.execute(db);
        break;
      }
      case 'visibility': {
        await sql`UPDATE public.asset SET visibility='timeline' WHERE id=${photos.motion}`.execute(db);
        break;
      }
      case 'deleted': {
        await sql`UPDATE public.asset SET "deletedAt"=now() WHERE id=${photos.motion}`.execute(db);
        break;
      }
      case 'lock': {
        await sql`INSERT INTO public.asset_lock("assetId",reason) VALUES(${photos.motion},${AssetLockReason.Marked})`.execute(
          db,
        );
        break;
      }
      case 'already-linked': {
        await sql`UPDATE public.asset SET "livePhotoVideoId"=${photos.motion} WHERE id=${photos.outside}`.execute(db);
        break;
      }
      case 'fingerprint': {
        await sql`UPDATE public.frameleaf_library_import_mapping SET record_sha256=${'c'.repeat(64)} WHERE entity_kind='asset' AND source_id='motion'`.execute(
          db,
        );
        break;
      }
      case 'album': {
        const albumId = randomUUID();
        await sql`INSERT INTO public.album(id,"albumName") VALUES(${albumId},'Synthetic')`.execute(db);
        await sql`INSERT INTO public.album_asset("albumId","assetId") VALUES(${albumId},${photos.motion})`.execute(db);
        break;
      }
      case 'stack': {
        const stackId = randomUUID();
        await sql`INSERT INTO public.stack(id,"ownerId","primaryAssetId") VALUES(${stackId},${users.owner},${photos.outside})`.execute(
          db,
        );
        await sql`UPDATE public.asset SET "stackId"=${stackId} WHERE id=${photos.motion}`.execute(db);
        break;
      }
      // No default
    }
    await expect(writer.write(input('still'))).rejects.toThrow('ASSET_LIVE_PHOTO_MOTION_INVALID');
    expect((await sql`SELECT count(*)::text AS count FROM public.physical_file`.execute(db)).rows).toEqual([
      { count: '2' },
    ]);
    expect(
      (
        await sql`SELECT source_id FROM public.frameleaf_library_import_mapping WHERE entity_kind='asset' AND source_id='still'`.execute(
          db,
        )
      ).rows,
    ).toEqual([]);
  },
);

it('requires the motion mapping before writing the still', async () => {
  const { context, writer, input } = await setup();
  await sql`DELETE FROM public.frameleaf_library_import_mapping WHERE operation_id=${context.binding.operationId} AND entity_kind='asset' AND source_id='motion'`.execute(
    db,
  );
  await expect(writer.write(input('still'))).rejects.toThrow('ASSET_LIVE_PHOTO_MOTION_INVALID');
});

it('rolls back a link and its new original after interrupted metadata insertion', async () => {
  const { context, input } = await setup();
  const interrupted: ImportDatabase = {
    query: wrap(db).query,
    transaction: (body) =>
      wrap(db).transaction((tx) =>
        body({
          ...tx,
          query: async (statement, parameters) => {
            if (statement.includes('INSERT INTO public.asset_exif')) throw new Error('synthetic interruption');
            return tx.query(statement, parameters);
          },
        }),
      ),
  };
  await expect(new CanonicalAssetWriter(interrupted, context).write(input('still'))).rejects.toThrow(
    'ASSET_WRITE_FAILED',
  );
  expect((await sql`SELECT count(*)::text AS count FROM public.physical_file`.execute(db)).rows).toEqual([
    { count: '2' },
  ]);
  await expect(new CanonicalAssetWriter(wrap(db), context).write(input('still'))).resolves.toEqual(expect.any(String));
});

it.each(['unchanged', 'missing', 'foreign-motion', 'visibility'] as const)(
  'independently reconciles %s Live Photo relationships',
  async (kind) => {
    const { context, input, writer, photos } = await setup();
    const id = await writer.write(input('still'));
    await new LibraryImportJournal(wrap(db)).phase(context.binding, 'verifying');
    switch (kind) {
      case 'missing': {
        await sql`UPDATE public.asset SET "livePhotoVideoId"=NULL WHERE id=${id}`.execute(db);
        break;
      }
      case 'foreign-motion': {
        await sql`UPDATE public.asset SET "livePhotoVideoId"=${photos.outside} WHERE id=${id}`.execute(db);
        break;
      }
      case 'visibility': {
        await sql`UPDATE public.asset SET visibility='timeline' WHERE id=${photos.motion}`.execute(db);
        break;
      }
      // No default
    }
    const result = reconcileImportedAssets(
      wrap(db),
      context,
      context.manifest.assets.map((asset) => input(asset.id)),
    );
    if (kind === 'unchanged') await expect(result).resolves.toMatchObject({ assets: 3, originals: 3, bytes: '9' });
    else await expect(result).rejects.toThrow();
  },
);

it('holds regeneration for the sealed Live Photo cohort without changing its relationships', async () => {
  const { context, writer, input } = await setup();
  await writer.write(input('still'));
  await retainReviewedImportInputs(wrap(db), context, { manifest: context.manifest, plan: context.plan });
  await new LibraryImportJournal(wrap(db)).phase(context.binding, 'verifying');
  const before = (await sql`SELECT id,"livePhotoVideoId" FROM public.asset ORDER BY id`.execute(db)).rows;
  const repository = new JobRepository({} as never, {} as never, {} as never, { setContext: vi.fn() } as never, db);
  const stages = [
    [JobName.AssetExtractMetadata, QueueName.MetadataExtraction],
    [JobName.AssetGenerateThumbnails, QueueName.ThumbnailGeneration],
    [JobName.SmartSearch, QueueName.SmartSearch],
    [JobName.AssetDetectFaces, QueueName.FaceDetection],
    [JobName.AssetEncodeVideo, QueueName.VideoConversion],
    [JobName.PersonGenerateThumbnail, QueueName.ThumbnailGeneration],
  ] as const;
  for (const [jobName, queueName] of stages)
    repository['handlers'][jobName] = { jobName, queueName, handler: vi.fn(), label: 'synthetic import' };
  const run = await repository.prepareImportedLibraryWork(context);
  expect(await repository.prepareImportedLibraryWork(context)).toBe(run);
  expect((await sql`SELECT id,"livePhotoVideoId" FROM public.asset ORDER BY id`.execute(db)).rows).toEqual(before);
  // FL-1265: every stage is inserted held, untouched, until activation releases it.
  expect(
    (
      await sql`SELECT count(*)::text AS count, bool_and(state='pending' AND attempt=0 AND "availableAt"='infinity') AS held
        FROM job`.execute(db)
    ).rows,
  ).toEqual([{ count: '13', held: true }]);
  expect((await sql`SELECT "enumerationDone" FROM job_run`.execute(db)).rows).toEqual([{ enumerationDone: false }]);
});

it('preserves a still stack alongside its explicit motion link', async () => {
  const { context, writer, input, photos } = await setup(true);
  const id = await writer.write(input('still'));
  const stackId = await new CanonicalStackWriter(wrap(db), context).write('stack');
  expect((await sql`SELECT "stackId","livePhotoVideoId" FROM public.asset WHERE id=${id}`.execute(db)).rows).toEqual([
    { stackId, livePhotoVideoId: photos.motion },
  ]);
  await new LibraryImportJournal(wrap(db)).phase(context.binding, 'verifying');
  await expect(reconcileImportedStacks(wrap(db), context)).resolves.toMatchObject({ stacks: 1, memberships: 2 });
  await expect(
    reconcileImportedAssets(
      wrap(db),
      context,
      context.manifest.assets.map((asset) => input(asset.id)),
    ),
  ).resolves.toMatchObject({ assets: 3, originals: 3 });
});

it('locks a private Live Photo and its stack as a whole, then reconciles and regenerates them', async () => {
  // Owner 2026-11-04: a source's private items import Locked; the motion part stays hidden
  const { context, writer, input, photos } = await setup(true, false, true);
  const id = await writer.write(input('still'));
  await new CanonicalStackWriter(wrap(db), context).write('stack');
  expect((await sql`SELECT "assetId"::text,reason FROM public.asset_lock ORDER BY "assetId"`.execute(db)).rows).toEqual(
    [id, photos.motion, photos.outside].sort().map((assetId) => ({ assetId, reason: AssetLockReason.Marked })),
  );
  expect((await sql`SELECT id::text,visibility FROM public.asset ORDER BY id`.execute(db)).rows).toEqual(
    [
      { id, visibility: 'timeline' },
      { id: photos.motion, visibility: 'hidden' },
      { id: photos.outside, visibility: 'timeline' },
    ].sort((a, b) => a.id.localeCompare(b.id)),
  );
  await retainReviewedImportInputs(wrap(db), context, { manifest: context.manifest, plan: context.plan });
  await new LibraryImportJournal(wrap(db)).phase(context.binding, 'verifying');
  await expect(reconcileImportedStacks(wrap(db), context)).resolves.toMatchObject({ stacks: 1, memberships: 2 });
  const inputs = context.manifest.assets.map((asset) => input(asset.id));
  await expect(reconcileImportedAssets(wrap(db), context, inputs)).resolves.toMatchObject({ assets: 3 });

  const repository = new JobRepository({} as never, {} as never, {} as never, { setContext: vi.fn() } as never, db);
  for (const [jobName, queueName] of [
    [JobName.AssetExtractMetadata, QueueName.MetadataExtraction],
    [JobName.AssetGenerateThumbnails, QueueName.ThumbnailGeneration],
    [JobName.SmartSearch, QueueName.SmartSearch],
    [JobName.AssetDetectFaces, QueueName.FaceDetection],
    [JobName.AssetEncodeVideo, QueueName.VideoConversion],
    [JobName.PersonGenerateThumbnail, QueueName.ThumbnailGeneration],
  ] as const)
    repository['handlers'][jobName] = { jobName, queueName, handler: vi.fn(), label: 'synthetic import' };
  await expect(repository.prepareImportedLibraryWork(context)).resolves.toEqual(expect.any(String));

  await sql`DELETE FROM public.asset_lock WHERE "assetId"=${photos.motion}`.execute(db);
  await expect(reconcileImportedAssets(wrap(db), context, inputs)).rejects.toThrow();
});

it('keeps a Locked archived Live Photo stack in the Archive for when it is unlocked', async () => {
  const { context, writer, input, photos } = await setup(true, false, true, true);
  const id = await writer.write(input('still'));
  await new CanonicalStackWriter(wrap(db), context).write('stack');
  expect((await sql`SELECT count(*)::int AS count FROM public.asset_lock`.execute(db)).rows).toEqual([{ count: 3 }]);
  expect(
    (
      await sql<{ id: string; visibility: string }>`SELECT id::text,visibility FROM public.asset ORDER BY id`.execute(
        db,
      )
    ).rows.map(({ id, visibility }) => [id, visibility]),
  ).toEqual(
    [
      [id, 'archive'],
      [photos.motion, 'hidden'],
      [photos.outside, 'archive'],
    ].sort(([a], [b]) => a.localeCompare(b)),
  );
  await new LibraryImportJournal(wrap(db)).phase(context.binding, 'verifying');
  await expect(reconcileImportedStacks(wrap(db), context)).resolves.toMatchObject({ stacks: 1 });
  await expect(
    reconcileImportedAssets(
      wrap(db),
      context,
      context.manifest.assets.map((asset) => input(asset.id)),
    ),
  ).resolves.toMatchObject({ assets: 3 });
});

it('recovers the committed pair after losing its acknowledgement', async () => {
  const { context, input, photos } = await setup();
  const lost: ImportDatabase = {
    query: wrap(db).query,
    transaction: async (body) => {
      await wrap(db).transaction(body);
      throw new Error('synthetic lost acknowledgement');
    },
  };
  await expect(new CanonicalAssetWriter(lost, context).write(input('still'))).rejects.toThrow('ASSET_WRITE_FAILED');
  const id = await new CanonicalAssetWriter(wrap(db), context).write(input('still'));
  expect((await sql`SELECT "livePhotoVideoId" FROM public.asset WHERE id=${id}`.execute(db)).rows).toEqual([
    { livePhotoVideoId: photos.motion },
  ]);
  expect((await sql`SELECT count(*)::text AS count FROM public.physical_file`.execute(db)).rows).toEqual([
    { count: '3' },
  ]);
});
