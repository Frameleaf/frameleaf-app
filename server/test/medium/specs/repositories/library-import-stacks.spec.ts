import { CompiledQuery, Kysely, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { AssetLockReason, AssetVisibility, JobName, QueueName } from 'src/enum.js';
import { ImportDatabase } from 'src/immich-import/types.js';
import { reconcileImportedAssets } from 'src/library-import/asset-reconciliation.js';
import { CanonicalAssetWriter } from 'src/library-import/asset-writer.js';
import { destinationPlanFingerprint, parseDestinationImportPlan } from 'src/library-import/destination-plan.js';
import { verifyImportFiles } from 'src/library-import/files.js';
import fixture from 'src/library-import/fixtures/manager-plan-v1.json' with { type: 'json' };
import { manifestFingerprint, parseImportManifest } from 'src/library-import/manifest.js';
import { createImportedOwner } from 'src/library-import/owners.js';
import { retainReviewedImportInputs } from 'src/library-import/reviewed-inputs.js';
import { reconcileImportedStacks } from 'src/library-import/stack-reconciliation.js';
import { CanonicalStackWriter } from 'src/library-import/stack-writer.js';
import { LibraryImportJournal } from 'src/library-import/state.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
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
const setup = async () => {
  const plan = parseDestinationImportPlan(fixture.plan);
  plan.owners = ['owner', 'viewer', 'editor', 'unrelated'].map((sourceId) => ({
    sourceId,
    destinationId: randomUUID(),
  }));
  const template = plan.files[0];
  plan.files = ['shared', 'private', 'outside'].map((id, index) => ({
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
    version: 4,
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
      type: 'IMAGE',
      fileModifiedAt: '2020-01-02T03:04:05Z',
      originalFileNames: { [file.id]: file.id + '.jpg' },
      visibility: 'timeline',
      metadata: { takenAt: '2020-01-02T03:04:05Z', timeZone: 'UTC' },
    })),
    albums: [],
    stacks: [{ id: 'source-stack', ownerId: 'owner', primaryAssetId: 'private', assetIds: ['shared', 'private'] }],
    losses: [],
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
  vi.mocked(verifyImportFiles).mockResolvedValue({ files: 1, bytes: '3' });
  const photos: Record<string, string> = {};
  for (const file of plan.files)
    photos[file.id] = await new CanonicalAssetWriter(wrap(db), context).write({
      sourceAssetId: file.id,
      type: 'IMAGE',
      fileModifiedAt: '2020-01-02T03:04:05Z',
      originalFileNames: { [file.id]: file.id + '.jpg' },
    });
  return {
    context,
    photos,
    users: Object.fromEntries(plan.owners.map((owner) => [owner.sourceId, owner.destinationId])),
  };
};
beforeAll(async () => {
  db = await getKyselyDB();
});
beforeEach(async () => {
  vi.mocked(verifyImportFiles).mockReset();
  await sql`TRUNCATE public.physical_file,public."user",public.cluster_group,public.album,public.album_audit,
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

it('retains the explicit primary and owner without changing original files, quotas or unrelated photos', async () => {
  const { context, photos, users } = await setup();
  const before = (
    await sql`SELECT id,"quotaSizeInBytes","quotaUsageInBytes" FROM public."user" ORDER BY id`.execute(db)
  ).rows;
  const writer = new CanonicalStackWriter(wrap(db), context);
  const id = await writer.write('source-stack');
  expect(await writer.write('source-stack')).toBe(id);
  expect((await sql`SELECT id,"ownerId","primaryAssetId" FROM public.stack`.execute(db)).rows).toEqual([
    { id, ownerId: users.owner, primaryAssetId: photos.private },
  ]);
  const members = (
    await sql<{ id: string }>`SELECT id FROM public.asset WHERE "stackId"=${id} ORDER BY id`.execute(db)
  ).rows.map((row) => row.id);
  expect(members).toEqual([photos.shared, photos.private].sort());
  expect((await sql`SELECT "stackId" FROM public.asset WHERE id=${photos.outside}`.execute(db)).rows).toEqual([
    { stackId: null },
  ]);
  expect(
    (await sql`SELECT id,"quotaSizeInBytes","quotaUsageInBytes" FROM public."user" ORDER BY id`.execute(db)).rows,
  ).toEqual(before);
  expect((await sql`SELECT count(*)::text AS count FROM public.physical_file`.execute(db)).rows).toEqual([
    { count: '3' },
  ]);
  const access = new AccessRepository(db);
  expect(await access.stack.checkOwnerAccess(users.owner, new Set([id]))).toEqual(new Set([id]));
  expect(await access.stack.checkOwnerAccess(users.unrelated, new Set([id]))).toEqual(new Set());
});

it.each(['owner-mapping', 'asset-mapping', 'foreign-owner', 'locked', 'already-stacked', 'changed-state'] as const)(
  'refuses %s without modifying retained destination relationships',
  async (kind) => {
    const { context, photos, users } = await setup();
    switch (kind) {
      case 'owner-mapping': {
        await sql`DELETE FROM frameleaf_library_import_mapping WHERE entity_kind='owner' AND source_id='owner'`.execute(
          db,
        );
        break;
      }
      case 'asset-mapping': {
        await sql`DELETE FROM frameleaf_library_import_mapping WHERE entity_kind='asset' AND source_id='shared'`.execute(
          db,
        );
        break;
      }
      case 'foreign-owner': {
        await sql`UPDATE public.asset SET "ownerId"=${users.unrelated} WHERE id=${photos.shared}`.execute(db);
        break;
      }
      case 'locked': {
        await sql`INSERT INTO public.asset_lock("assetId",reason,"lockedBy") VALUES(${photos.shared},${AssetLockReason.Marked},${users.owner})`.execute(
          db,
        );
        break;
      }
      case 'already-stacked': {
        const existing = randomUUID();
        await sql`INSERT INTO public.stack(id,"ownerId","primaryAssetId") VALUES(${existing},${users.owner},${photos.shared})`.execute(
          db,
        );
        await sql`UPDATE public.asset SET "stackId"=${existing} WHERE id=${photos.shared}`.execute(db);
        break;
      }
      case 'changed-state': {
        await sql`UPDATE public.asset SET visibility=${AssetVisibility.Archive} WHERE id=${photos.shared}`.execute(db);
        break;
      }
    }
    const before = (await sql`SELECT id,"ownerId","stackId",visibility FROM public.asset ORDER BY id`.execute(db)).rows;
    const stacks = (await sql`SELECT id,"ownerId","primaryAssetId" FROM public.stack ORDER BY id`.execute(db)).rows;
    await expect(new CanonicalStackWriter(wrap(db), context).write('source-stack')).rejects.toThrow(
      kind === 'owner-mapping' ? 'STACK_OWNER_MAPPING_REQUIRED' : 'STACK_ASSETS_INCOMPLETE',
    );
    expect(
      (await sql`SELECT id,"ownerId","stackId",visibility FROM public.asset ORDER BY id`.execute(db)).rows,
    ).toEqual(before);
    expect((await sql`SELECT id,"ownerId","primaryAssetId" FROM public.stack ORDER BY id`.execute(db)).rows).toEqual(
      stacks,
    );
  },
);

it('commits membership and recovery mapping together, including lost acknowledgements', async () => {
  const { context, photos } = await setup();
  const actual = wrap(db);
  const interrupted: ImportDatabase = {
    ...actual,
    transaction: (body) =>
      actual.transaction(async (tx) => {
        await body(tx);
        throw new Error('synthetic interruption');
      }),
  };
  await expect(new CanonicalStackWriter(interrupted, context).write('source-stack')).rejects.toThrow(
    'STACK_WRITE_FAILED',
  );
  expect((await sql`SELECT id FROM public.stack`.execute(db)).rows).toEqual([]);
  expect((await sql`SELECT id FROM public.asset WHERE "stackId" IS NOT NULL`.execute(db)).rows).toEqual([]);
  const lost: ImportDatabase = {
    ...actual,
    transaction: async (body) => {
      await actual.transaction(body);
      throw new Error('synthetic lost acknowledgement');
    },
  };
  await expect(new CanonicalStackWriter(lost, context).write('source-stack')).rejects.toThrow('STACK_WRITE_FAILED');
  const id = await new CanonicalStackWriter(actual, context).write('source-stack');
  expect((await sql`SELECT "primaryAssetId" FROM public.stack WHERE id=${id}`.execute(db)).rows).toEqual([
    { primaryAssetId: photos.private },
  ]);
  expect((await sql`SELECT count(*)::text AS count FROM public.stack`.execute(db)).rows).toEqual([{ count: '1' }]);
  expect(
    (
      await sql`SELECT count(*)::text AS count FROM frameleaf_library_import_mapping WHERE entity_kind='stack'`.execute(
        db,
      )
    ).rows,
  ).toEqual([{ count: '1' }]);
});

it('refuses changed source intent and writes after the verification boundary', async () => {
  const { context } = await setup();
  const changed = structuredClone(context);
  if (changed.manifest.version !== 4) throw new Error('Fixture version changed');
  changed.manifest.stacks[0].primaryAssetId = 'shared';
  expect(() => new CanonicalStackWriter(wrap(db), changed)).toThrow();
  const writer = new CanonicalStackWriter(wrap(db), context);
  await new LibraryImportJournal(wrap(db)).phase(context.binding, 'verifying');
  await expect(writer.write('source-stack')).rejects.toThrow('IMPORT_NOT_COPYING');
});

it('reconciles sealed photos after their declared stack has been written', async () => {
  const { context } = await setup();
  if (context.manifest.version !== 4) throw new Error('Fixture version changed');
  await new CanonicalStackWriter(wrap(db), context).write('source-stack');
  await new LibraryImportJournal(wrap(db)).phase(context.binding, 'verifying');
  vi.mocked(verifyImportFiles).mockResolvedValue({ files: 3, bytes: '9' });
  const inputs = context.manifest.assets.map((asset) => ({
    sourceAssetId: asset.id,
    type: asset.type,
    fileModifiedAt: asset.fileModifiedAt,
    originalFileNames: asset.originalFileNames,
  }));
  await expect(reconcileImportedAssets(wrap(db), context, inputs)).resolves.toMatchObject({
    assets: 3,
    originals: 3,
    bytes: '9',
  });
});

it('independently reconciles exact stack relationships without exposing media names', async () => {
  const { context } = await setup();
  await new CanonicalStackWriter(wrap(db), context).write('source-stack');
  await new LibraryImportJournal(wrap(db)).phase(context.binding, 'verifying');
  const report = await reconcileImportedStacks(wrap(db), context);
  expect(report).toMatchObject({
    format: 'frameleaf-stack-reconciliation',
    stacks: 1,
    memberships: 2,
    operationId: context.binding.operationId,
    manifestSha256: context.binding.manifestSha256,
  });
  expect(await reconcileImportedStacks(wrap(db), context)).toEqual(report);
  expect(JSON.stringify(report)).not.toContain('shared.jpg');
});

it.each([
  'primary',
  'membership',
  'foreign-member',
  'owner',
  'state',
  'mapping',
  'extra-stack',
  'extra-member',
  'lock',
  'elevated-owner',
] as const)('detects retained stack %s corruption independently', async (kind) => {
  const { context, photos, users } = await setup();
  const id = await new CanonicalStackWriter(wrap(db), context).write('source-stack');
  await new LibraryImportJournal(wrap(db)).phase(context.binding, 'verifying');
  switch (kind) {
    case 'primary': {
      await sql`UPDATE public.stack SET "primaryAssetId"=${photos.shared} WHERE id=${id}`.execute(db);
      break;
    }
    case 'membership': {
      await sql`UPDATE public.asset SET "stackId"=NULL WHERE id=${photos.shared}`.execute(db);
      break;
    }
    case 'foreign-member': {
      await sql`UPDATE public.asset SET "ownerId"=${users.unrelated},"stackId"=${id} WHERE id=${photos.outside}`.execute(
        db,
      );
      break;
    }
    case 'owner': {
      await sql`UPDATE public.stack SET "ownerId"=${users.unrelated} WHERE id=${id}`.execute(db);
      break;
    }
    case 'state': {
      await sql`UPDATE public.asset SET visibility=${AssetVisibility.Archive} WHERE "stackId"=${id}`.execute(db);
      break;
    }
    case 'mapping': {
      await sql`UPDATE frameleaf_library_import_mapping SET record_sha256=${'f'.repeat(64)} WHERE entity_kind='stack'`.execute(
        db,
      );
      break;
    }
    case 'extra-stack': {
      const extra = randomUUID();
      await sql`INSERT INTO public.stack(id,"ownerId","primaryAssetId") VALUES(${extra},${users.owner},${photos.outside})`.execute(
        db,
      );
      await sql`UPDATE public.asset SET "stackId"=${extra} WHERE id=${photos.outside}`.execute(db);
      break;
    }
    case 'extra-member': {
      await sql`UPDATE public.asset SET "stackId"=${id} WHERE id=${photos.outside}`.execute(db);
      break;
    }
    case 'lock': {
      await sql`INSERT INTO public.asset_lock("assetId",reason,"lockedBy") VALUES(${photos.shared},${AssetLockReason.Marked},${users.owner})`.execute(
        db,
      );
      break;
    }
    case 'elevated-owner': {
      await sql`UPDATE public."user" SET "isAdmin"=true WHERE id=${users.owner}`.execute(db);
      break;
    }
  }
  await expect(reconcileImportedStacks(wrap(db), context)).rejects.toThrow('STACK_RECONCILIATION_MISMATCH');
});

it('holds regeneration for the sealed stack cohort without changing its relationships', async () => {
  const { context } = await setup();
  await new CanonicalStackWriter(wrap(db), context).write('source-stack');
  await retainReviewedImportInputs(wrap(db), context, { manifest: context.manifest, plan: context.plan });
  await new LibraryImportJournal(wrap(db)).phase(context.binding, 'verifying');
  const before = (await sql`SELECT id,"stackId" FROM public.asset ORDER BY id`.execute(db)).rows;
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
  expect((await sql`SELECT id,"stackId" FROM public.asset ORDER BY id`.execute(db)).rows).toEqual(before);
  // FL-1265: every stage is inserted held, untouched, until activation releases it.
  expect(
    (
      await sql`SELECT count(*)::text AS count, bool_and(state='pending' AND attempt=0 AND "availableAt"='infinity') AS held
        FROM job`.execute(db)
    ).rows,
  ).toEqual([{ count: '12', held: true }]);
  expect((await sql`SELECT "enumerationDone" FROM job_run`.execute(db)).rows).toEqual([{ enumerationDone: false }]);
});
