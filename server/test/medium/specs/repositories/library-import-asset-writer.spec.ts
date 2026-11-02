import { CompiledQuery, Kysely, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { PhysicalFileType } from 'src/enum.js';
import { ImportDatabase } from 'src/immich-import/types.js';
import { CanonicalAssetWriter } from 'src/library-import/asset-writer.js';
import { destinationPlanFingerprint, parseDestinationImportPlan } from 'src/library-import/destination-plan.js';
import { verifyImportFiles } from 'src/library-import/files.js';
import fixture from 'src/library-import/fixtures/manager-plan-v1.json' with { type: 'json' };
import { manifestFingerprint, parseImportManifest } from 'src/library-import/manifest.js';
import { createImportedOwner } from 'src/library-import/owners.js';
import { LibraryImportJournal } from 'src/library-import/state.js';
import { DB } from 'src/schema/index.js';
import { getKyselyDB } from 'test/utils.js';

vi.mock('src/library-import/files.js', () => ({ verifyImportFiles: vi.fn() }));
let db: Kysely<DB>;
const wrap = (connection: Kysely<any>): ImportDatabase => ({
  query: async (statement, parameters = []) =>
    (await connection.executeQuery(CompiledQuery.raw(statement, parameters))).rows as Record<string, unknown>[],
  transaction: (body) => connection.transaction().execute((tx) => body(wrap(tx))),
});
const setup = async () => {
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
  const manifest = parseImportManifest({
    format: 'frameleaf-library-import',
    version: 2,
    source: plan.source,
    inventory: {
      complete: true,
      ownershipComplete: true,
      privacyComplete: true,
      writersStopped: true,
      revisionBefore: plan.source.revision,
      revisionAfter: plan.source.revision,
    },
    users: [{ id: 'owner', name: 'Synthetic owner' }],
    files: plan.files.map((file) => ({
      id: file.id,
      path: file.destinationPath,
      bytes: file.bytes,
      sha256: file.sha256,
      role: 'original',
    })),
    assets: [
      {
        id: 'photo',
        ownerId: 'owner',
        fileIds: ['jpeg', 'raw'],
        primaryFileId: 'raw',
        visibility: 'archive',
        metadata: {
          takenAt: '2020-07-01T12:34:56.123456Z',
          timeZone: 'America/Edmonton',
          description: 'Manual caption',
          rating: 5,
          latitude: 51.1,
          longitude: -114.1,
          favorite: true,
        },
      },
    ],
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
  await new LibraryImportJournal(wrap(db)).apply(
    binding,
    { kind: 'owner', sourceId: 'owner', destinationId: ownerId, recordSha256: 'd'.repeat(64) },
    (tx) =>
      createImportedOwner(tx, {
        operationId: binding.operationId,
        sourceUserId: 'owner',
        destinationUserId: ownerId,
        name: 'Synthetic owner',
        email: 'owner@example.test',
      }),
  );
  const context = { binding, plan, manifest, destinationId: plan.destinationId };
  const item = {
    sourceAssetId: 'photo',
    type: 'IMAGE',
    fileModifiedAt: '2020-07-02T01:02:03.456789Z',
    originalFileNames: { jpeg: 'camera.jpg', raw: 'camera.raw' },
  };
  vi.mocked(verifyImportFiles).mockResolvedValue({ files: 2, bytes: '17' });
  return { context, item, ownerId };
};
beforeAll(async () => {
  db = await getKyselyDB();
});
beforeEach(async () => {
  vi.mocked(verifyImportFiles).mockReset();
  await sql`TRUNCATE public.physical_file,public."user",public.cluster_group,public.user_audit,public.user_preference_history,
    public.frameleaf_library_import_mapping,public.frameleaf_library_import,public.frameleaf_immich_import CASCADE`.execute(
    db,
  );
  await sql`WITH g AS (INSERT INTO public.cluster_group DEFAULT VALUES RETURNING id)
    INSERT INTO public."user" (email,"clusterGroupId","isAdmin") SELECT 'bootstrap@example.test',id,true FROM g`.execute(
    db,
  );
});
afterAll(async () => db?.destroy());

it('commits the selected primary, every original, clocks, source metadata and exact quota once', async () => {
  const { context, item, ownerId } = await setup();
  const writer = new CanonicalAssetWriter(wrap(db), context);
  const id = await writer.write(item);
  expect(await writer.write(item)).toBe(id);
  const row = await db.selectFrom('asset').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  expect(row).toMatchObject({
    ownerId,
    originalFileName: 'camera.raw',
    isFavorite: true,
    visibility: 'archive',
    isExternal: false,
    libraryId: null,
    checksumAlgorithm: 'sha256',
  });
  const clocks = (
    await sql`SELECT to_char("fileCreatedAt" AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') AS taken,
    to_char("localDateTime" AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') AS local,
    to_char("fileModifiedAt" AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') AS modified FROM public.asset WHERE id=${id}::uuid`.execute(
      db,
    )
  ).rows[0];
  expect(clocks).toEqual({
    taken: '2020-07-01 12:34:56.123456',
    local: '2020-07-01 06:34:56.123456',
    modified: '2020-07-02 01:02:03.456789',
  });
  expect(await db.selectFrom('physical_file').selectAll().where('canonicalAssetId', '=', id).execute()).toHaveLength(2);
  expect(await db.selectFrom('asset_original').select('originalFileName').where('assetId', '=', id).execute()).toEqual([
    { originalFileName: 'camera.jpg' },
  ]);
  expect(
    await db
      .selectFrom('asset_exif')
      .select(['description', 'rating', 'lockedProperties', 'fileSizeInByte'])
      .where('assetId', '=', id)
      .executeTakeFirstOrThrow(),
  ).toEqual({
    description: 'Manual caption',
    rating: 5,
    fileSizeInByte: 3,
    lockedProperties: ['dateTimeOriginal', 'timeZone', 'description', 'rating', 'latitude', 'longitude'],
  });
  expect(
    (await db.selectFrom('user').select('quotaUsageInBytes').where('id', '=', ownerId).executeTakeFirstOrThrow())
      .quotaUsageInBytes,
  ).toBe(17);
  expect(verifyImportFiles).toHaveBeenCalled();
});

it('does not create database records when destination bytes cannot be verified', async () => {
  const { context, item } = await setup();
  vi.mocked(verifyImportFiles).mockRejectedValue(new Error('synthetic bytes changed'));
  await expect(new CanonicalAssetWriter(wrap(db), context).write(item)).rejects.toThrow();
  expect(await db.selectFrom('asset').select('id').execute()).toEqual([]);
  expect(await db.selectFrom('physical_file').select('id').execute()).toEqual([]);
});

it('rolls back originals, photo and quota together when a database write fails', async () => {
  const { context, item, ownerId } = await setup();
  const actual = wrap(db);
  const failing: ImportDatabase = {
    ...actual,
    transaction: (body) =>
      actual.transaction((tx) =>
        body({
          ...tx,
          query: async (statement, parameters) => {
            if (statement.includes('INSERT INTO public.asset_exif')) throw new Error('synthetic interruption');
            return tx.query(statement, parameters);
          },
        }),
      ),
  };
  await expect(new CanonicalAssetWriter(failing, context).write(item)).rejects.toThrow('ASSET_WRITE_FAILED');
  expect(await db.selectFrom('asset').select('id').execute()).toEqual([]);
  expect(await db.selectFrom('physical_file').select('id').execute()).toEqual([]);
  expect(
    (await db.selectFrom('user').select('quotaUsageInBytes').where('id', '=', ownerId).executeTakeFirstOrThrow())
      .quotaUsageInBytes,
  ).toBe(0);
  expect((await new LibraryImportJournal(wrap(db)).status()).mappings).toEqual([{ kind: 'owner', count: '1' }]);
  await expect(new CanonicalAssetWriter(wrap(db), context).write(item)).resolves.toEqual(expect.any(String));
});

it('recovers a committed photo after acknowledgement loss without charging or writing twice', async () => {
  const { context, item, ownerId } = await setup();
  const actual = wrap(db);
  const lost: ImportDatabase = {
    ...actual,
    transaction: async (body) => {
      await actual.transaction(body);
      throw new Error('synthetic acknowledgement loss');
    },
  };
  await expect(new CanonicalAssetWriter(lost, context).write(item)).rejects.toThrow('ASSET_WRITE_FAILED');
  const committed = await db.selectFrom('asset').select('id').executeTakeFirstOrThrow();
  expect(await new CanonicalAssetWriter(actual, context).write(item)).toBe(committed.id);
  expect(verifyImportFiles).toHaveBeenCalledOnce();
  expect(await db.selectFrom('asset').select('id').execute()).toHaveLength(1);
  expect(await db.selectFrom('physical_file').select('id').execute()).toHaveLength(2);
  expect(
    (await db.selectFrom('user').select('quotaUsageInBytes').where('id', '=', ownerId).executeTakeFirstOrThrow())
      .quotaUsageInBytes,
  ).toBe(17);
  await expect(
    new CanonicalAssetWriter(actual, context).write({
      ...item,
      originalFileNames: { ...item.originalFileNames, raw: 'changed.raw' },
    }),
  ).rejects.toThrow('IMPORT_MAPPING_CHANGED');
});

it.each(['quota', 'owner', 'timezone'])('refuses invalid destination state atomically: %s', async (kind) => {
  const { context, item, ownerId } = await setup();
  let expected: string;
  if (kind === 'quota') {
    await db.updateTable('user').set({ quotaSizeInBytes: 16 }).where('id', '=', ownerId).execute();
    expected = 'ASSET_QUOTA_EXCEEDED';
  } else if (kind === 'owner') {
    await sql`DELETE FROM public.frameleaf_library_import_mapping WHERE entity_kind='owner'`.execute(db);
    expected = 'ASSET_OWNER_MAPPING_REQUIRED';
  } else {
    context.manifest.assets[0].metadata.timeZone = 'unqualified/synthetic';
    context.binding.manifestSha256 = manifestFingerprint(context.manifest);
    await wrap(db).query('UPDATE public.frameleaf_library_import SET binding=$1::text::jsonb', [
      JSON.stringify(context.binding),
    ]);
    expected = 'ASSET_TIME_ZONE_UNSUPPORTED';
  }
  await expect(new CanonicalAssetWriter(wrap(db), context).write(item)).rejects.toThrow(expected);
  expect(await db.selectFrom('asset').select('id').execute()).toEqual([]);
  expect(await db.selectFrom('physical_file').select('id').execute()).toEqual([]);
  expect(
    (await db.selectFrom('user').select('quotaUsageInBytes').where('id', '=', ownerId).executeTakeFirstOrThrow())
      .quotaUsageInBytes,
  ).toBe(0);
});

it('refuses existing paths without overwriting their recorded identity or leaving other originals', async () => {
  const { context, item } = await setup();
  const planned = context.plan.files[1];
  const root = context.plan.roots.find((root) => root.id === planned.destinationRoot)!;
  const existing = {
    id: randomUUID(),
    type: PhysicalFileType.Original,
    checksum: Buffer.alloc(32, 7),
    sizeInBytes: 123,
    path: root.path + '/' + planned.destinationPath,
  };
  await db.insertInto('physical_file').values(existing).execute();
  await expect(new CanonicalAssetWriter(wrap(db), context).write(item)).rejects.toThrow('ASSET_WRITE_FAILED');
  expect(await db.selectFrom('asset').select('id').execute()).toEqual([]);
  expect(
    await db.selectFrom('physical_file').select(['id', 'checksum', 'sizeInBytes', 'path', 'type']).execute(),
  ).toEqual([existing]);
});

it.each(['locked', 'title', 'tags', 'sidecar', 'clock', 'trash'])(
  'refuses unsupported or incomplete source facts: %s',
  async (kind) => {
    const { context, item } = await setup();
    const asset = context.manifest.assets[0];
    switch (kind) {
      case 'locked': {
        asset.visibility = 'locked';
        break;
      }
      case 'title': {
        asset.metadata.title = 'Source title';
        break;
      }
      case 'tags': {
        asset.metadata.tags = ['source tag'];
        break;
      }
      case 'sidecar': {
        context.manifest.files[0].role = 'sidecar';
        break;
      }
      case 'clock': {
        delete asset.metadata.takenAt;
        break;
      }
      case 'trash': {
        asset.visibility = 'trash';
        break;
      }
    }
    context.binding.manifestSha256 = manifestFingerprint(context.manifest);
    const writer = new CanonicalAssetWriter(wrap(db), context);
    await expect(writer.write(item)).rejects.toThrow(
      /ASSET_(UNSUPPORTED_FIELDS|CAPTURE_CLOCK_REQUIRED|TRASH_STATE_INVALID)/,
    );
    expect(verifyImportFiles).not.toHaveBeenCalled();
    expect(await db.selectFrom('asset').select('id').execute()).toEqual([]);
  },
);
