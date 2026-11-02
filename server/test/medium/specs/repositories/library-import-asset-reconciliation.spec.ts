import { CompiledQuery, Kysely, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { ImportDatabase } from 'src/immich-import/types.js';
import { reconcileImportedAssets } from 'src/library-import/asset-reconciliation.js';
import { CanonicalAssetWriter } from 'src/library-import/asset-writer.js';
import { destinationPlanFingerprint, parseDestinationImportPlan } from 'src/library-import/destination-plan.js';
import { verifyImportFiles } from 'src/library-import/files.js';
import fixture from 'src/library-import/fixtures/manager-plan-v1.json' with { type: 'json' };
import { importFileSchema, manifestFingerprint, parseImportManifest } from 'src/library-import/manifest.js';
import { createImportedOwner } from 'src/library-import/owners.js';
import { LibraryImportJournal } from 'src/library-import/state.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
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
const setup = async (
  visibility: 'archive' | 'hidden' | 'trash' = 'archive',
  empty = false,
  sealed = false,
  tags?: string[],
  twoOwners = false,
) => {
  const ownerId = randomUUID();
  const plan = parseDestinationImportPlan(fixture.plan);
  plan.owners = [{ sourceId: 'owner', destinationId: ownerId }];
  const primary = plan.files[0];
  plan.files = [
    {
      ...primary,
      id: 'jpeg',
      destinationPath: 'photo.jpg',
      bytes: '14',
      sourceIdentity: { ...primary.sourceIdentity, bytes: '14' },
    },
    {
      ...primary,
      id: 'raw',
      destinationPath: 'photo.raw',
      sha256: createHash('sha256').update('raw').digest('hex'),
      bytes: '3',
      sourceIdentity: { ...primary.sourceIdentity, inode: '42', bytes: '3' },
    },
  ];
  if (twoOwners) {
    plan.owners.push({ sourceId: 'other-owner', destinationId: randomUUID() });
    plan.files.push(
      ...plan.files.map((file) => ({
        ...file,
        id: 'other-' + file.id,
        sourcePath: 'other-' + file.sourcePath,
        destinationPath: 'other-' + file.destinationPath,
        sourceIdentity: { ...file.sourceIdentity, inode: String(BigInt(file.sourceIdentity.inode) + 100n) },
      })),
    );
  }
  if (empty) plan.files = [];
  const manifest = parseImportManifest({
    format: 'frameleaf-library-import',
    version: sealed ? 3 : 2,
    source: plan.source,
    inventory: {
      complete: true,
      ownershipComplete: true,
      privacyComplete: true,
      writersStopped: true,
      revisionBefore: plan.source.revision,
      revisionAfter: plan.source.revision,
    },
    users: plan.owners.map((owner) => ({ id: owner.sourceId, name: 'Synthetic ' + owner.sourceId })),
    files: plan.files.map((file) => ({
      id: file.id,
      path: file.destinationPath,
      bytes: file.bytes,
      sha256: file.sha256,
      role: 'original',
    })),
    assets: empty
      ? []
      : plan.owners.map((owner, index) => {
          const prefix = index === 0 ? '' : 'other-';
          return {
            ...(sealed
              ? {
                  type: 'IMAGE',
                  fileModifiedAt: '2020-07-02T01:02:03.456789Z',
                  originalFileNames: { [prefix + 'jpeg']: 'camera.jpg', [prefix + 'raw']: 'camera.raw' },
                }
              : {}),
            id: prefix + 'photo',
            ownerId: owner.sourceId,
            fileIds: [prefix + 'jpeg', prefix + 'raw'],
            primaryFileId: prefix + 'raw',
            visibility,
            metadata: {
              takenAt: '2020-07-01T12:34:56.123456Z',
              timeZone: 'America/Edmonton',
              description: 'Manual caption',
              rating: 5,
              latitude: 51.1,
              longitude: -114.1,
              favorite: true,
              ...(tags === undefined ? {} : { tags }),
              deletedAt: visibility === 'trash' ? '2020-08-01T00:00:00.123456Z' : undefined,
            },
          };
        }),
    albums: [],
    losses: [],
  });
  const binding = {
    operationId: randomUUID(),
    manifestSha256: manifestFingerprint(manifest),
    planSha256: destinationPlanFingerprint(plan),
    source: plan.source,
  };
  await new LibraryImportJournal(wrap(db)).begin(binding);
  for (const owner of plan.owners)
    await new LibraryImportJournal(wrap(db)).apply(
      binding,
      { kind: 'owner', sourceId: owner.sourceId, destinationId: owner.destinationId, recordSha256: 'd'.repeat(64) },
      (tx) =>
        createImportedOwner(tx, {
          operationId: binding.operationId,
          sourceUserId: owner.sourceId,
          destinationUserId: owner.destinationId,
          name: 'Synthetic ' + owner.sourceId,
          email: owner.sourceId + '@example.test',
        }),
    );
  const context = { binding, plan, manifest, destinationId: plan.destinationId };
  const item = {
    sourceAssetId: 'photo',
    type: 'IMAGE',
    fileModifiedAt: '2020-07-02T01:02:03.456789Z',
    originalFileNames: { jpeg: 'camera.jpg', raw: 'camera.raw' },
  };
  vi.mocked(verifyImportFiles).mockImplementation((_root, files) => {
    const inventory = importFileSchema.array().parse(files);
    return Promise.resolve({
      files: inventory.length,
      bytes: String(inventory.reduce((n, file) => n + BigInt(file.bytes), 0n)),
    });
  });
  return { context, item, ownerId };
};
beforeAll(async () => {
  db = await getKyselyDB();
});
beforeEach(async () => {
  vi.mocked(verifyImportFiles).mockReset();
  await sql`TRUNCATE public.physical_file,public."user",public.cluster_group,public.user_audit,public.user_preference_history,public.tag_audit,public.tag_asset_audit,
    public.frameleaf_library_import_mapping,public.frameleaf_library_import,public.frameleaf_immich_import CASCADE`.execute(
    db,
  );
  await sql`WITH g AS (INSERT INTO public.cluster_group DEFAULT VALUES RETURNING id)
    INSERT INTO public."user" (email,"clusterGroupId","isAdmin") SELECT 'bootstrap@example.test',id,true FROM g`.execute(
    db,
  );
});
afterAll(async () => db?.destroy());

const ready = async (visibility: 'archive' | 'hidden' | 'trash' = 'archive', tags?: string[]) => {
  const fixture = await setup(visibility, false, false, tags);
  const id = await new CanonicalAssetWriter(wrap(db), fixture.context).write(fixture.item);
  await new LibraryImportJournal(wrap(db)).phase(fixture.context.binding, 'verifying');
  return { ...fixture, id };
};

it('reconciles every original, microsecond clocks, manual metadata and quota after restart without writing', async () => {
  const { context, item } = await ready();
  const first = await reconcileImportedAssets(wrap(db), context, [item]);
  expect(first).toMatchObject({
    format: 'frameleaf-asset-reconciliation',
    version: 2,
    operationId: context.binding.operationId,
    manifestSha256: context.binding.manifestSha256,
    planSha256: context.binding.planSha256,
    assets: 1,
    originals: 2,
    bytes: '17',
    sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(await reconcileImportedAssets(wrap(db), context, [item])).toEqual(first);
  expect((await new LibraryImportJournal(wrap(db)).status()).run?.status).toBe('verifying');
});

it.each([
  'missing-owner-mapping',
  'visibility',
  'clock',
  'local-clock',
  'modified-clock',
  'caption',
  'metadata-lock',
  'favorite',
  'checksum',
  'original-name',
  'additional-name',
  'physical-path',
  'physical-size',
  'physical-checksum',
  'quota',
  'missing-original',
  'missing-exif',
  'mapping',
  'extra-file',
  'owner',
])('refuses independently observed destination corruption: %s', async (kind) => {
  const { context, item, id, ownerId } = await ready();
  switch (kind) {
    case 'missing-owner-mapping': {
      await sql`DELETE FROM frameleaf_library_import_mapping WHERE entity_kind='owner'`.execute(db);
      break;
    }
    case 'visibility': {
      await db
        .updateTable('asset')
        .set({ visibility: 'timeline' as any })
        .where('id', '=', id)
        .execute();
      break;
    }
    case 'clock': {
      await sql`UPDATE asset SET "fileCreatedAt"="fileCreatedAt"+interval '1 microsecond' WHERE id=${id}::uuid`.execute(
        db,
      );
      break;
    }
    case 'local-clock': {
      await sql`UPDATE asset SET "localDateTime"="localDateTime"+interval '1 microsecond' WHERE id=${id}::uuid`.execute(
        db,
      );
      break;
    }
    case 'modified-clock': {
      await sql`UPDATE asset SET "fileModifiedAt"="fileModifiedAt"+interval '1 microsecond' WHERE id=${id}::uuid`.execute(
        db,
      );
      break;
    }
    case 'caption': {
      await db.updateTable('asset_exif').set({ description: 'changed' }).where('assetId', '=', id).execute();
      break;
    }
    case 'metadata-lock': {
      await db.updateTable('asset_exif').set({ lockedProperties: [] }).where('assetId', '=', id).execute();
      break;
    }
    case 'favorite': {
      await db.updateTable('asset').set({ isFavorite: false }).where('id', '=', id).execute();
      break;
    }
    case 'checksum': {
      await db
        .updateTable('asset')
        .set({ checksum: Buffer.alloc(32) })
        .where('id', '=', id)
        .execute();
      break;
    }
    case 'original-name': {
      await db.updateTable('asset').set({ originalFileName: 'changed.raw' }).where('id', '=', id).execute();
      break;
    }
    case 'additional-name': {
      await db
        .updateTable('asset_original')
        .set({ originalFileName: 'changed.jpg' })
        .where('assetId', '=', id)
        .execute();
      break;
    }
    case 'physical-path': {
      await sql`UPDATE physical_file SET path=path||'.changed'`.execute(db);
      break;
    }
    case 'physical-size': {
      await sql`UPDATE physical_file SET "sizeInBytes"="sizeInBytes"+1`.execute(db);
      break;
    }
    case 'physical-checksum': {
      await db
        .updateTable('physical_file')
        .set({ checksum: Buffer.alloc(32) })
        .execute();
      break;
    }
    case 'quota': {
      await db.updateTable('user').set({ quotaUsageInBytes: 1 }).where('id', '=', ownerId).execute();
      break;
    }
    case 'missing-original': {
      await db.deleteFrom('asset_original').where('assetId', '=', id).execute();
      break;
    }
    case 'missing-exif': {
      await db.deleteFrom('asset_exif').where('assetId', '=', id).execute();
      break;
    }
    case 'mapping': {
      await sql`UPDATE frameleaf_library_import_mapping SET record_sha256=${'f'.repeat(64)} WHERE entity_kind='asset'`.execute(
        db,
      );
      break;
    }
    case 'extra-file': {
      await sql`INSERT INTO physical_file(type,checksum,"sizeInBytes",path) VALUES('original',decode(${'f'.repeat(64)},'hex'),1,'/synthetic/unexpected')`.execute(
        db,
      );
      break;
    }
    case 'owner': {
      await sql`UPDATE asset SET "ownerId"=(SELECT id FROM public."user" WHERE "isAdmin") WHERE id=${id}::uuid`.execute(
        db,
      );
      break;
    }
  }
  await expect(reconcileImportedAssets(wrap(db), context, [item])).rejects.toThrow('ASSET_RECONCILIATION_MISMATCH');
});

it('requires the full prepared inventory and refuses changed type, clocks and names', async () => {
  const { context, item } = await ready();
  for (const items of [
    [],
    [item, item],
    [{ ...item, type: 'VIDEO' }],
    [{ ...item, fileModifiedAt: '2021-01-01T00:00:00Z' }],
    [{ ...item, originalFileNames: { ...item.originalFileNames, raw: 'changed.raw' } }],
  ]) {
    await expect(reconcileImportedAssets(wrap(db), context, items)).rejects.toThrow('ASSET_RECONCILIATION_MISMATCH');
  }
});

it('requires a matching binding and verifying phase', async () => {
  const { context, item } = await setup();
  await expect(reconcileImportedAssets(wrap(db), context, [item])).rejects.toThrow('IMPORT_NOT_VERIFYING');
  await new LibraryImportJournal(wrap(db)).phase(context.binding, 'verifying');
  await expect(
    reconcileImportedAssets(wrap(db), { ...context, binding: { ...context.binding, operationId: randomUUID() } }, [
      item,
    ]),
  ).rejects.toThrow('IMPORT_BINDING_CHANGED');
});

it('rehashes every original through the reviewed root and refuses incomplete byte verification', async () => {
  const { context, item } = await ready();
  vi.mocked(verifyImportFiles).mockClear();
  await reconcileImportedAssets(wrap(db), context, [item]);
  expect(verifyImportFiles).toHaveBeenCalledTimes(1);
  expect(verifyImportFiles).toHaveBeenCalledWith(
    context.plan.roots[1].path,
    expect.arrayContaining(
      context.plan.files.map((file) => ({
        id: file.id,
        path: file.destinationPath,
        bytes: file.bytes,
        sha256: file.sha256,
        role: 'original',
      })),
    ),
    { device: context.plan.roots[1].device, inode: context.plan.roots[1].inode },
  );
  vi.mocked(verifyImportFiles).mockResolvedValue({ files: 1, bytes: '3' });
  await expect(reconcileImportedAssets(wrap(db), context, [item])).rejects.toThrow('ASSET_RECONCILIATION_MISMATCH');
});

it('redacts database and filesystem diagnostics', async () => {
  const { context, item } = await ready();
  const broken: ImportDatabase = {
    ...wrap(db),
    transaction: (body) =>
      wrap(db).transaction((tx) =>
        body({
          ...tx,
          query: () => Promise.reject(new Error('private path or caption')),
        }),
      ),
  };
  await expect(reconcileImportedAssets(broken, context, [item])).rejects.toThrow(
    /^Library import refused: ASSET_RECONCILIATION_FAILED$/,
  );
  vi.mocked(verifyImportFiles).mockRejectedValue(new Error('private filesystem diagnostic'));
  await expect(reconcileImportedAssets(wrap(db), context, [item])).rejects.toThrow(
    /^Library import refused: ASSET_RECONCILIATION_FAILED$/,
  );
});

it.each(['hidden', 'trash'] as const)('retains restricted state and trash clocks for %s photos', async (visibility) => {
  const { context, item } = await ready(visibility);
  expect(await reconcileImportedAssets(wrap(db), context, [item])).toMatchObject({
    assets: 1,
    originals: 2,
    bytes: '17',
  });
});

it('reconciles an owner with no photos and refuses unexpected quota usage', async () => {
  const { context, ownerId } = await setup('archive', true);
  await new LibraryImportJournal(wrap(db)).phase(context.binding, 'verifying');
  expect(await reconcileImportedAssets(wrap(db), context, [])).toMatchObject({ assets: 0, originals: 0, bytes: '0' });
  await db.updateTable('user').set({ quotaUsageInBytes: 1 }).where('id', '=', ownerId).execute();
  await expect(reconcileImportedAssets(wrap(db), context, [])).rejects.toThrow('ASSET_RECONCILIATION_MISMATCH');
});

it('writes and reconciles only the sealed version-three photo intent', async () => {
  const { context, item } = await setup('archive', false, true);
  const id = await new CanonicalAssetWriter(wrap(db), context).write(item);
  const asset = context.manifest.assets[0];
  if (!('originalFileNames' in asset)) throw new Error('Expected sealed photo intent');
  asset.originalFileNames = Object.fromEntries(Object.entries(asset.originalFileNames).toReversed());
  expect(manifestFingerprint(context.manifest)).toBe(context.binding.manifestSha256);
  expect(await new CanonicalAssetWriter(wrap(db), context).write(item)).toBe(id);
  await new LibraryImportJournal(wrap(db)).phase(context.binding, 'verifying');
  expect(await reconcileImportedAssets(wrap(db), context, [item])).toMatchObject({
    assets: 1,
    originals: 2,
    bytes: '17',
  });
  await expect(reconcileImportedAssets(wrap(db), context, [{ ...item, type: 'VIDEO' }])).rejects.toThrow(
    'ASSET_PREPARED_INTENT_CHANGED',
  );
});

it('reconciles authoritative imported tag metadata without rewriting it', async () => {
  const { context, item } = await ready('archive', ['Places/Canada', '旅行']);
  const before = await db.selectFrom('tag').selectAll().orderBy('id').execute();
  const report = await reconcileImportedAssets(wrap(db), context, [item]);
  expect(report).toMatchObject({ version: 2, assets: 1, tagNodes: 3, tagAssignments: 2 });
  expect(await db.selectFrom('tag').selectAll().orderBy('id').execute()).toEqual(before);
});

it.each(['membership', 'name', 'owner', 'parent', 'closure', 'extra'])(
  'refuses changed imported tag relationships: %s',
  async (kind) => {
    const { context, item } = await ready('archive', ['Places/Canada', '旅行']);
    switch (kind) {
      case 'membership': {
        await db.deleteFrom('tag_asset').execute();
        break;
      }
      case 'name': {
        await db.updateTable('tag').set({ value: 'changed' }).where('value', '=', '旅行').execute();
        break;
      }
      case 'owner': {
        const admin = await db.selectFrom('user').select('id').where('isAdmin', '=', true).executeTakeFirstOrThrow();
        await db.updateTable('tag').set({ userId: admin.id }).where('value', '=', '旅行').execute();
        break;
      }
      case 'parent': {
        await db.updateTable('tag').set({ parentId: null }).where('value', '=', 'Places/Canada').execute();
        break;
      }
      case 'closure': {
        await db.deleteFrom('tag_closure').execute();
        break;
      }
      case 'extra': {
        const owner = context.plan.owners[0].destinationId;
        await db.insertInto('tag').values({ userId: owner, value: 'unexpected' }).execute();
        break;
      }
    }
    await expect(reconcileImportedAssets(wrap(db), context, [item])).rejects.toThrow('ASSET_RECONCILIATION_MISMATCH');
  },
);

it('keeps identical imported tag names and relationships within each explicit owner', async () => {
  const { context, item } = await setup('archive', false, false, ['Places/Canada', '旅行'], true);
  const otherItem = {
    ...item,
    sourceAssetId: 'other-photo',
    originalFileNames: { 'other-jpeg': 'camera.jpg', 'other-raw': 'camera.raw' },
  };
  const writer = new CanonicalAssetWriter(wrap(db), context);
  const first = await writer.write(item);
  const second = await writer.write(otherItem);
  const named = await db.selectFrom('tag').select(['id', 'userId']).where('value', '=', '旅行').execute();
  expect(named).toHaveLength(2);
  expect(new Set(named.map((tag) => tag.userId))).toEqual(
    new Set(context.plan.owners.map((owner) => owner.destinationId)),
  );
  await new LibraryImportJournal(wrap(db)).phase(context.binding, 'verifying');
  expect(await reconcileImportedAssets(wrap(db), context, [item, otherItem])).toMatchObject({
    assets: 2,
    tagNodes: 6,
    tagAssignments: 4,
  });
  const firstTag = named.find((tag) => tag.userId === context.plan.owners[0].destinationId)!;
  const otherTag = named.find((tag) => tag.userId === context.plan.owners[1].destinationId)!;
  await db
    .updateTable('tag_asset')
    .set({ tagId: otherTag.id })
    .where('assetId', '=', first)
    .where('tagId', '=', firstTag.id)
    .execute();
  await expect(reconcileImportedAssets(wrap(db), context, [item, otherItem])).rejects.toThrow(
    'ASSET_RECONCILIATION_MISMATCH',
  );
  expect(await db.selectFrom('tag_asset').selectAll().where('assetId', '=', second).execute()).toHaveLength(2);
});
it.each([{ tags: [] }, { tags: ['Places/Canada', '旅行'] }])(
  'keeps imported tag intent when metadata is regenerated: %j',
  async ({ tags }) => {
    const { context, item, id } = await ready('archive', tags);
    const before = await reconcileImportedAssets(wrap(db), context, [item]);
    await new AssetRepository(db).upsertExif({
      exif: { assetId: id, tags: ['Stale embedded tag'] },
      lockedPropertiesBehavior: 'skip',
    });
    const exif = await db
      .selectFrom('asset_exif')
      .select(['tags', 'lockedProperties'])
      .where('assetId', '=', id)
      .executeTakeFirstOrThrow();
    expect(exif.tags).toEqual(tags);
    expect(exif.lockedProperties).toContain('tags');
    expect(await reconcileImportedAssets(wrap(db), context, [item])).toEqual(before);
  },
);
