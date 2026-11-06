import { CompiledQuery, Kysely, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { ImportDatabase } from 'src/immich-import/types.js';
import { reconcileImportedAssets } from 'src/library-import/asset-reconciliation.js';
import { CanonicalAssetWriter } from 'src/library-import/asset-writer.js';
import { destinationPlanFingerprint, parseDestinationImportPlan } from 'src/library-import/destination-plan.js';
import { verifyImportFiles } from 'src/library-import/files.js';
import fixture from 'src/library-import/fixtures/manager-plan-v2.json' with { type: 'json' };
import { importFileSchema, manifestFingerprint, parseImportManifest } from 'src/library-import/manifest.js';
import { createImportedOwner } from 'src/library-import/owners.js';
import { LibraryImportJournal } from 'src/library-import/state.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
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
const setup = async (twoOwners: boolean, privateInTrash = false) => {
  const plan = parseDestinationImportPlan(fixture.plan);
  plan.owners = [{ ...plan.owners[0], destinationId: randomUUID() }];
  if (twoOwners) plan.owners.push({ sourceId: 'owner-2', destinationId: randomUUID() });
  if (!twoOwners && plan.version === 2)
    plan.files.push({
      ...plan.files[1],
      id: 'placement-3',
      sourceFileId: 'file-2',
      sourcePath: 'second.raw',
      destinationPath: 'second/photo.raw',
      bytes: '3',
      sha256: createHash('sha256').update('raw').digest('hex'),
      sourceIdentity: { ...plan.files[1].sourceIdentity, inode: '4', bytes: '3' },
    });
  const manifest = parseImportManifest({
    format: 'frameleaf-library-import',
    version: 3,
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
    files: [
      { id: 'file-1', path: 'camera.jpg', bytes: '14', sha256: plan.files[0].sha256, role: 'original' },
      ...(!twoOwners
        ? [{ id: 'file-2', path: 'second.raw', bytes: '3', sha256: plan.files[2].sha256, role: 'original' }]
        : []),
    ],
    assets: ['asset-1', 'asset-2'].map((id, index) => ({
      id,
      ownerId: plan.owners[twoOwners ? index : 0].sourceId,
      fileIds: !twoOwners && index === 1 ? ['file-1', 'file-2'] : ['file-1'],
      primaryFileId: !twoOwners && index === 1 ? 'file-2' : 'file-1',
      type: 'IMAGE',
      fileModifiedAt: '2020-01-02T03:04:05Z',
      originalFileNames: { 'file-1': id + '.jpg', ...(!twoOwners && index === 1 ? { 'file-2': id + '.raw' } : {}) },
      visibility: index === 0 ? 'archive' : privateInTrash ? 'trash' : 'hidden',
      ...(index === 1 && privateInTrash ? { locked: true } : {}),
      metadata: {
        takenAt: '2020-01-01T03:04:05Z',
        timeZone: 'UTC',
        description: 'Manual ' + id,
        favorite: index === 0,
        ...(index === 1 && privateInTrash ? { deletedAt: '2020-02-01T00:00:00Z' } : {}),
      },
    })),
    albums: [],
    losses: [],
  });
  const binding = {
    operationId: randomUUID(),
    source: plan.source,
    manifestSha256: manifestFingerprint(manifest),
    planSha256: destinationPlanFingerprint(plan),
  };
  const context = { binding, plan, manifest, destinationId: plan.destinationId };
  const journal = new LibraryImportJournal(wrap(db));
  await journal.begin(binding);
  for (const owner of plan.owners)
    await journal.apply(
      binding,
      {
        kind: 'owner',
        sourceId: owner.sourceId,
        destinationId: owner.destinationId,
        recordSha256: 'd'.repeat(64),
      },
      (tx) =>
        createImportedOwner(tx, {
          operationId: binding.operationId,
          sourceUserId: owner.sourceId,
          destinationUserId: owner.destinationId,
          name: owner.sourceId,
          email: owner.sourceId + '@example.test',
        }),
    );
  const inputs = manifest.assets.map((asset) => ({
    sourceAssetId: asset.id,
    type: 'IMAGE',
    fileModifiedAt: '2020-01-02T03:04:05Z',
    originalFileNames: 'originalFileNames' in asset ? asset.originalFileNames : {},
  }));
  return { context, inputs, journal };
};
beforeAll(async () => {
  db = await getKyselyDB();
});
beforeEach(async () => {
  await sql`TRUNCATE public.physical_file,public."user",public.cluster_group,public.user_audit,public.user_preference_history,public.tag_audit,public.tag_asset_audit,
    public.frameleaf_library_import_mapping,public.frameleaf_library_import,public.frameleaf_immich_import CASCADE`.execute(
    db,
  );
  await sql`WITH g AS (INSERT INTO public.cluster_group DEFAULT VALUES RETURNING id)
    INSERT INTO public."user" (email,"clusterGroupId","isAdmin") SELECT 'bootstrap@example.test',id,true FROM g`.execute(
    db,
  );
  vi.mocked(verifyImportFiles)
    .mockReset()
    .mockImplementation((_root, files) => {
      const inventory = importFileSchema.array().parse(files);
      expect(new Set(inventory.map((file) => file.id)).size).toBe(inventory.length);
      return Promise.resolve({
        files: inventory.length,
        bytes: String(inventory.reduce((n, file) => n + BigInt(file.bytes), 0n)),
      });
    });
});
afterAll(async () => db?.destroy());

it.each([false, true])(
  'retains independent originals, metadata, ownership and quotas with two owners=%s',
  async (twoOwners) => {
    const { context, inputs, journal } = await setup(twoOwners);
    const writer = new CanonicalAssetWriter(wrap(db), context);
    const ids = [];
    for (const input of inputs) ids.push(await writer.write(input));
    expect(await writer.write(inputs[0])).toBe(ids[0]);
    const access = new AccessRepository(db);
    for (const owner of context.plan.owners) {
      const owned = new Set(ids.filter((_id, index) => context.manifest.assets[index].ownerId === owner.sourceId));
      expect(await access.asset.checkOwnerAccess(owner.destinationId, new Set(ids), false)).toEqual(owned);
      expect(await access.asset.checkAlbumAccess(owner.destinationId, new Set(ids))).toEqual(new Set());
    }
    expect(await access.asset.checkOwnerAccess(randomUUID(), new Set(ids), false)).toEqual(new Set());
    const rows = await db
      .selectFrom('asset')
      .innerJoin('physical_file', 'physical_file.id', 'asset.physicalOriginalFileId')
      .innerJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .select([
        'asset.ownerId',
        'asset.originalFileName',
        'asset.visibility',
        'asset_exif.description',
        'physical_file.id',
        'physical_file.path',
      ])
      .orderBy('asset.originalFileName')
      .execute();
    expect(rows.map((row) => row.ownerId)).toEqual(
      context.manifest.assets.map(
        (asset) => context.plan.owners.find((owner) => owner.sourceId === asset.ownerId)!.destinationId,
      ),
    );
    expect(rows.map((row) => row.description)).toEqual(['Manual asset-1', 'Manual asset-2']);
    expect(rows.map((row) => row.visibility)).toEqual(['archive', 'hidden']);
    expect(new Set(rows.map((row) => row.path)).size).toBe(2);
    expect(new Set(rows.map((row) => row.id)).size).toBe(2);
    const mappings = await wrap(db).query(
      "SELECT source_id FROM public.frameleaf_library_import_mapping WHERE entity_kind='file' ORDER BY source_id",
    );
    expect(mappings.map((row) => row.source_id)).toEqual(
      twoOwners ? ['placement-1', 'placement-2'] : ['placement-1', 'placement-2', 'placement-3'],
    );
    const owners = await wrap(db).query(
      'SELECT "quotaUsageInBytes"::text AS bytes FROM public."user" WHERE NOT "isAdmin" ORDER BY id',
    );
    expect(owners.map((row) => row.bytes)).toEqual(twoOwners ? ['14', '14'] : ['31']);
    expect(await wrap(db).query('SELECT 1 FROM public.album_asset UNION ALL SELECT 1 FROM public.asset_lock')).toEqual(
      [],
    );
    await journal.phase(context.binding, 'verifying');
    expect(await reconcileImportedAssets(wrap(db), context, inputs)).toMatchObject({
      assets: 2,
      originals: twoOwners ? 2 : 3,
      bytes: twoOwners ? '28' : '31',
    });
    expect(
      importFileSchema
        .array()
        .parse(vi.mocked(verifyImportFiles).mock.calls.at(-1)![1])
        .map((file) => file.id),
    ).toEqual(expect.arrayContaining(['placement-1', 'placement-2']));
  },
);

it('recovers a lost commit acknowledgement without duplicating placements or quota', async () => {
  const { context, inputs } = await setup(true);
  const actual = wrap(db);
  let lost = false;
  const interrupted: ImportDatabase = {
    ...actual,
    transaction: async (body) => {
      const result = await actual.transaction(body);
      if (!lost) {
        lost = true;
        throw new Error('synthetic acknowledgement loss');
      }
      return result;
    },
  };
  await expect(new CanonicalAssetWriter(interrupted, context).write(inputs[0])).rejects.toThrow('ASSET_WRITE_FAILED');
  const writer = new CanonicalAssetWriter(actual, context);
  const id = await writer.write(inputs[0]);
  expect(await writer.write(inputs[0])).toBe(id);
  expect(await actual.query('SELECT id FROM public.physical_file')).toHaveLength(1);
  expect(
    await actual.query("SELECT source_id FROM public.frameleaf_library_import_mapping WHERE entity_kind='file'"),
  ).toHaveLength(1);
  expect(
    await actual.query('SELECT "quotaUsageInBytes"::text AS bytes FROM public."user" WHERE id=$1::uuid', [
      context.plan.owners[0].destinationId,
    ]),
  ).toEqual([{ bytes: '14' }]);
});

it('rolls back physical placement mappings and bytes accounting when quota refuses the photo', async () => {
  const { context, inputs } = await setup(true);
  const actual = wrap(db);
  const owner = context.plan.owners[0].destinationId;
  await actual.query('UPDATE public."user" SET "quotaSizeInBytes"=0 WHERE id=$1::uuid', [owner]);
  const writer = new CanonicalAssetWriter(actual, context);
  await expect(writer.write(inputs[0])).rejects.toThrow('ASSET_QUOTA_EXCEEDED');
  expect(await actual.query('SELECT id FROM public.asset')).toEqual([]);
  expect(await actual.query('SELECT id FROM public.physical_file')).toEqual([]);
  expect(
    await actual.query(
      "SELECT source_id FROM public.frameleaf_library_import_mapping WHERE entity_kind IN ('asset','file')",
    ),
  ).toEqual([]);
  expect(
    await actual.query('SELECT "quotaUsageInBytes"::text AS bytes FROM public."user" WHERE id=$1::uuid', [owner]),
  ).toEqual([{ bytes: '0' }]);
  await actual.query('UPDATE public."user" SET "quotaSizeInBytes"=100 WHERE id=$1::uuid', [owner]);
  await writer.write(inputs[0]);
  expect(
    await actual.query("SELECT source_id FROM public.frameleaf_library_import_mapping WHERE entity_kind='file'"),
  ).toEqual([{ source_id: 'placement-1' }]);
});

it.each(['missing', 'hash', 'swapped'])(
  'detects damaged physical placement mappings independently: %s',
  async (scenario) => {
    const { context, inputs, journal } = await setup(true);
    const actual = wrap(db);
    const writer = new CanonicalAssetWriter(actual, context);
    for (const input of inputs) await writer.write(input);
    await journal.phase(context.binding, 'verifying');
    switch (scenario) {
      case 'missing': {
        await actual.query(
          "DELETE FROM public.frameleaf_library_import_mapping WHERE entity_kind='file' AND source_id='placement-1'",
        );
        break;
      }
      case 'hash': {
        await actual.query(
          "UPDATE public.frameleaf_library_import_mapping SET record_sha256=$1 WHERE entity_kind='file' AND source_id='placement-1'",
          ['b'.repeat(64)],
        );
        break;
      }
      case 'swapped': {
        await actual.query(
          "UPDATE public.frameleaf_library_import_mapping SET destination_id=(SELECT destination_id FROM public.frameleaf_library_import_mapping WHERE entity_kind='file' AND source_id='placement-2') WHERE entity_kind='file' AND source_id='placement-1'",
        );
        break;
      }
      // No default
    }
    await expect(reconcileImportedAssets(actual, context, inputs)).rejects.toThrow('ASSET_RECONCILIATION_MISMATCH');
  },
);

it('imports a private item from the source Trash both trashed and Locked (FL-1230)', async () => {
  const { context, inputs, journal } = await setup(false, true);
  const writer = new CanonicalAssetWriter(wrap(db), context);
  const ids = [];
  for (const input of inputs) ids.push(await writer.write(input));
  const rows = await wrap(db).query(
    `SELECT a.id::text,a.visibility,a.status,a."deletedAt" IS NOT NULL AS trashed,
      EXISTS(SELECT 1 FROM public.asset_lock l WHERE l."assetId"=a.id) AS locked
    FROM public.asset a WHERE a.id=ANY($1::uuid[]) ORDER BY a."originalFileName"`,
    [ids],
  );
  expect(rows).toEqual([
    { id: ids[0], visibility: 'archive', status: 'active', trashed: false, locked: false },
    { id: ids[1], visibility: 'timeline', status: 'trashed', trashed: true, locked: true },
  ]);
  await journal.phase(context.binding, 'verifying');
  await expect(reconcileImportedAssets(wrap(db), context, inputs)).resolves.toMatchObject({ assets: 2 });
});
