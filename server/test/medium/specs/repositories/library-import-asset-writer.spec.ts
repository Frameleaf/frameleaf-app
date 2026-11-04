import { CompiledQuery, Kysely, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { PhysicalFileType } from 'src/enum.js';
import { ImportDatabase } from 'src/immich-import/types.js';
import { reconcileImportedAssets } from 'src/library-import/asset-reconciliation.js';
import { CanonicalAssetWriter } from 'src/library-import/asset-writer.js';
import { destinationPlanFingerprint, parseDestinationImportPlan } from 'src/library-import/destination-plan.js';
import { verifyImportFiles } from 'src/library-import/files.js';
import fixture from 'src/library-import/fixtures/manager-plan-v1.json' with { type: 'json' };
import { manifestFingerprint, parseImportManifest } from 'src/library-import/manifest.js';
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
const setup = async (tags?: string[], locationRemoved = false, localDateTime?: string, rating: number | null = 5) => {
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
    version: localDateTime === undefined ? 2 : 3,
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
        ...(localDateTime === undefined
          ? {}
          : {
              localDateTime,
              type: 'IMAGE',
              fileModifiedAt: '2020-07-02T01:02:03.456789Z',
              originalFileNames: { jpeg: 'camera.jpg', raw: 'camera.raw' },
            }),
        id: 'photo',
        ownerId: 'owner',
        fileIds: ['jpeg', 'raw'],
        primaryFileId: 'raw',
        visibility: 'archive',
        metadata: {
          takenAt: '2020-07-01T12:34:56.123456Z',
          ...(localDateTime === undefined ? { timeZone: 'America/Edmonton' } : {}),
          description: 'Manual caption',
          rating,
          latitude: locationRemoved ? null : 51.1,
          longitude: locationRemoved ? null : -114.1,
          favorite: true,
          ...(tags === undefined ? {} : { tags }),
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

it.each([null, 0])('locks an explicit imported rating of %s without substituting a value', async (rating) => {
  const { context, item } = await setup(undefined, false, undefined, rating);
  const id = await new CanonicalAssetWriter(wrap(db), context).write(item);
  const exif = await db
    .selectFrom('asset_exif')
    .select(['rating', 'lockedProperties'])
    .where('assetId', '=', id)
    .executeTakeFirstOrThrow();
  expect(exif.rating).toBe(rating);
  expect(exif.lockedProperties).toContain('rating');
});

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

it('preserves an exact source wall clock and instant without inventing a named time zone', async () => {
  const { context, item } = await setup(undefined, false, '2020-07-01T18:19:56.123456');
  const id = await new CanonicalAssetWriter(wrap(db), context).write(item);
  const clocks = (
    await sql`SELECT to_char("fileCreatedAt" AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') AS taken,
    to_char("localDateTime" AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') AS local FROM public.asset WHERE id=${id}::uuid`.execute(
      db,
    )
  ).rows[0];
  expect(clocks).toEqual({ taken: '2020-07-01 12:34:56.123456', local: '2020-07-01 18:19:56.123456' });
  await new AssetRepository(db).upsertExif({
    exif: { assetId: id, timeZone: 'UTC', dateTimeOriginal: new Date('2030-01-01T00:00:00Z') },
    lockedPropertiesBehavior: 'skip',
  });
  const exif = await db
    .selectFrom('asset_exif')
    .select(['timeZone', 'lockedProperties'])
    .where('assetId', '=', id)
    .executeTakeFirstOrThrow();
  expect(exif.timeZone).toBeNull();
  expect(exif.lockedProperties).toEqual(expect.arrayContaining(['dateTimeOriginal', 'timeZone']));
  await new LibraryImportJournal(wrap(db)).phase(context.binding, 'verifying');
  await expect(reconcileImportedAssets(wrap(db), context, [item])).resolves.toMatchObject({ assets: 1, originals: 2 });
  await db
    .updateTable('asset')
    .set({ localDateTime: new Date('2020-07-01T18:20:56.123Z') })
    .where('id', '=', id)
    .execute();
  await expect(reconcileImportedAssets(wrap(db), context, [item])).rejects.toThrow('ASSET_RECONCILIATION_MISMATCH');
});

it('keeps source-removed coordinates empty when regeneration encounters embedded GPS', async () => {
  const { context, item } = await setup(undefined, true);
  const id = await new CanonicalAssetWriter(wrap(db), context).write(item);
  await new AssetRepository(db).upsertExif({
    exif: { assetId: id, latitude: 51.1, longitude: -114.1 },
    lockedPropertiesBehavior: 'skip',
  });
  const exif = await db
    .selectFrom('asset_exif')
    .select(['latitude', 'longitude', 'lockedProperties'])
    .where('assetId', '=', id)
    .executeTakeFirstOrThrow();
  expect(exif.latitude).toBeNull();
  expect(exif.longitude).toBeNull();
  expect(exif.lockedProperties).toEqual(expect.arrayContaining(['latitude', 'longitude']));
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

// A source's private item is Locked since 2026-11-04 (library-import-live-photos and -albums specs).
it.each(['title', 'multiple-sidecars', 'clock', 'trash'])(
  'refuses unsupported or incomplete source facts: %s',
  async (kind) => {
    const { context, item } = await setup();
    const asset = context.manifest.assets[0];
    switch (kind) {
      case 'title': {
        asset.metadata.title = 'Source title';
        break;
      }
      case 'multiple-sidecars': {
        context.manifest.files[0].role = 'sidecar';
        const original = context.plan.files[0];
        const extra = {
          ...original,
          id: 'extra-sidecar',
          sourcePath: 'extra.xmp',
          destinationPath: 'extra.xmp',
          sourceIdentity: { ...original.sourceIdentity, inode: '43' },
        };
        context.plan = parseDestinationImportPlan({ ...context.plan, files: [...context.plan.files, extra] });
        context.manifest.files.push({ ...context.manifest.files[0], id: extra.id, path: extra.sourcePath });
        asset.fileIds.push(extra.id);
        context.binding.planSha256 = destinationPlanFingerprint(context.plan);
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

it('preserves source tag paths, owner relationships and locks across replay', async () => {
  const values = ['Places/Canada', '旅行'];
  const { context, item, ownerId } = await setup(values);
  const writer = new CanonicalAssetWriter(wrap(db), context);
  const id = await writer.write(item);
  expect(await writer.write(item)).toBe(id);
  const exif = await db
    .selectFrom('asset_exif')
    .select(['tags', 'lockedProperties'])
    .where('assetId', '=', id)
    .executeTakeFirstOrThrow();
  expect(exif.tags).toEqual(values);
  expect(exif.lockedProperties).toContain('tags');
  expect(await db.selectFrom('tag').select(['userId', 'value']).orderBy('value').execute()).toEqual([
    { userId: ownerId, value: 'Places' },
    { userId: ownerId, value: 'Places/Canada' },
    { userId: ownerId, value: '旅行' },
  ]);
  const links = await db
    .selectFrom('tag_asset')
    .innerJoin('tag', 'tag.id', 'tag_asset.tagId')
    .select(['tag_asset.assetId', 'tag.userId', 'tag.value'])
    .orderBy('tag.value')
    .execute();
  expect(links).toEqual(values.map((value) => ({ assetId: id, userId: ownerId, value })));
  expect(await db.selectFrom('tag_closure').selectAll().execute()).toHaveLength(4);
});
it('preserves an explicit empty tag list against stale embedded metadata', async () => {
  const { context, item } = await setup([]);
  const id = await new CanonicalAssetWriter(wrap(db), context).write(item);
  const exif = await db
    .selectFrom('asset_exif')
    .select(['tags', 'lockedProperties'])
    .where('assetId', '=', id)
    .executeTakeFirstOrThrow();
  expect(exif.tags).toEqual([]);
  expect(exif.lockedProperties).toContain('tags');
  expect(await db.selectFrom('tag').selectAll().execute()).toEqual([]);
});
it('rolls back imported tags, closures and memberships with a quota failure', async () => {
  const { context, item, ownerId } = await setup(['Places/Canada']);
  await db.updateTable('user').set({ quotaSizeInBytes: 16 }).where('id', '=', ownerId).execute();
  await expect(new CanonicalAssetWriter(wrap(db), context).write(item)).rejects.toThrow('ASSET_QUOTA_EXCEEDED');
  expect(await db.selectFrom('tag').selectAll().execute()).toEqual([]);
  expect(await db.selectFrom('tag_closure').selectAll().execute()).toEqual([]);
  expect(await db.selectFrom('tag_asset').selectAll().execute()).toEqual([]);
  expect(await db.selectFrom('asset').selectAll().execute()).toEqual([]);
});

it('refuses an existing different tag parent without reparenting or leaving partial records', async () => {
  const { context, item, ownerId } = await setup(['Places/Canada']);
  const parent = await db
    .insertInto('tag')
    .values({ userId: ownerId, value: 'Existing' })
    .returningAll()
    .executeTakeFirstOrThrow();
  const child = await db
    .insertInto('tag')
    .values({ userId: ownerId, value: 'Places/Canada', parentId: parent.id })
    .returningAll()
    .executeTakeFirstOrThrow();
  await db
    .insertInto('tag_closure')
    .values([
      { id_ancestor: parent.id, id_descendant: parent.id },
      { id_ancestor: child.id, id_descendant: child.id },
      { id_ancestor: parent.id, id_descendant: child.id },
    ])
    .execute();
  const before = await db.selectFrom('tag').selectAll().orderBy('id').execute();
  await expect(new CanonicalAssetWriter(wrap(db), context).write(item)).rejects.toThrow('ASSET_TAGS_CONFLICT');
  expect(await db.selectFrom('tag').selectAll().orderBy('id').execute()).toEqual(before);
  expect(await db.selectFrom('tag_closure').selectAll().execute()).toHaveLength(3);
  expect(await db.selectFrom('asset').selectAll().execute()).toEqual([]);
  expect(await db.selectFrom('physical_file').selectAll().execute()).toEqual([]);
});

it.each(['Places', 'Places/Canada'])('refuses an existing custom-colored tag atomically: %s', async (value) => {
  const { context, item, ownerId } = await setup(['Places/Canada']);
  const parent = await db
    .insertInto('tag')
    .values({ userId: ownerId, value: 'Places', color: value === 'Places' ? '#112233' : null })
    .returningAll()
    .executeTakeFirstOrThrow();
  const child = await db
    .insertInto('tag')
    .values({
      userId: ownerId,
      value: 'Places/Canada',
      parentId: parent.id,
      color: value === 'Places/Canada' ? '#112233' : null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await db
    .insertInto('tag_closure')
    .values([
      { id_ancestor: parent.id, id_descendant: parent.id },
      { id_ancestor: child.id, id_descendant: child.id },
      { id_ancestor: parent.id, id_descendant: child.id },
    ])
    .execute();
  const before = await db.selectFrom('tag').selectAll().orderBy('id').execute();
  await expect(new CanonicalAssetWriter(wrap(db), context).write(item)).rejects.toThrow('ASSET_TAGS_CONFLICT');
  expect(await db.selectFrom('tag').selectAll().orderBy('id').execute()).toEqual(before);
  expect(await db.selectFrom('tag_closure').selectAll().execute()).toHaveLength(3);
  expect(await db.selectFrom('tag_asset').selectAll().execute()).toEqual([]);
  expect(await db.selectFrom('asset').selectAll().execute()).toEqual([]);
  expect(await db.selectFrom('physical_file').selectAll().execute()).toEqual([]);
  expect(
    (await db.selectFrom('user').select('quotaUsageInBytes').where('id', '=', ownerId).executeTakeFirstOrThrow())
      .quotaUsageInBytes,
  ).toBe(0);
});
