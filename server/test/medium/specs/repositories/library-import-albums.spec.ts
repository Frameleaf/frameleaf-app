import { CompiledQuery, Kysely, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { AlbumUserRole, AssetLockReason } from 'src/enum.js';
import { ImportDatabase } from 'src/immich-import/types.js';
import { CanonicalAlbumWriter } from 'src/library-import/album-writer.js';
import { CanonicalAssetWriter } from 'src/library-import/asset-writer.js';
import { destinationPlanFingerprint, parseDestinationImportPlan } from 'src/library-import/destination-plan.js';
import { verifyImportFiles } from 'src/library-import/files.js';
import fixture from 'src/library-import/fixtures/manager-plan-v1.json' with { type: 'json' };
import { manifestFingerprint, parseImportManifest } from 'src/library-import/manifest.js';
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
const setup = async () => {
  const plan = parseDestinationImportPlan(fixture.plan);
  plan.owners = ['owner', 'viewer', 'editor', 'unrelated'].map((sourceId) => ({
    sourceId,
    destinationId: randomUUID(),
  }));
  const template = plan.files[0];
  plan.files = ['shared', 'private'].map((id, index) => ({
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
      visibility: 'timeline',
      metadata: { takenAt: '2020-01-02T03:04:05Z', timeZone: 'UTC' },
    })),
    albums: [
      {
        id: 'shared',
        ownerId: 'owner',
        name: 'Restricted source album',
        assetIds: ['shared'],
        members: [
          { userId: 'viewer', role: 'viewer' },
          { userId: 'editor', role: 'editor' },
        ],
      },
      { id: 'empty', ownerId: 'owner', name: 'Empty source album', assetIds: [], members: [] },
    ],
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
  await sql`TRUNCATE public.physical_file,public."user",public.cluster_group,public.album,public.user_audit,public.user_preference_history,
    public.frameleaf_library_import_mapping,public.frameleaf_library_import,public.frameleaf_immich_import CASCADE`.execute(
    db,
  );
  await sql`WITH g AS (INSERT INTO public.cluster_group DEFAULT VALUES RETURNING id)
    INSERT INTO public."user" (email,"clusterGroupId","isAdmin") SELECT 'bootstrap@example.test',id,true FROM g`.execute(
    db,
  );
});
afterAll(async () => db?.destroy());

it('preserves owner, roles, membership and unrelated-user isolation through the real access repository', async () => {
  const { context, photos, users } = await setup();
  const writer = new CanonicalAlbumWriter(wrap(db), context);
  const id = await writer.write('shared');
  expect(await writer.write('shared')).toBe(id);
  const access = new AccessRepository(db),
    albums = new Set([id]);
  expect(await access.album.checkOwnerAccess(users.owner, albums)).toEqual(albums);
  expect(await access.album.checkOwnerAccess(users.editor, albums)).toEqual(new Set());
  expect(await access.album.checkSharedAlbumAccess(users.viewer, albums, AlbumUserRole.Viewer)).toEqual(albums);
  expect(await access.album.checkSharedAlbumAccess(users.viewer, albums, AlbumUserRole.Editor)).toEqual(new Set());
  expect(await access.album.checkSharedAlbumAccess(users.editor, albums, AlbumUserRole.Editor)).toEqual(albums);
  expect(await access.album.checkSharedAlbumAccess(users.unrelated, albums, AlbumUserRole.Viewer)).toEqual(new Set());
  for (const user of [users.viewer, users.editor])
    expect(await access.asset.checkAlbumAccess(user, new Set(Object.values(photos)))).toEqual(new Set([photos.shared]));
  expect(await access.asset.checkAlbumAccess(users.unrelated, new Set(Object.values(photos)))).toEqual(new Set());
  expect(await db.selectFrom('album_asset').select('assetId').where('albumId', '=', id).execute()).toEqual([
    { assetId: photos.shared },
  ]);
  expect(
    await db
      .selectFrom('album')
      .select(['albumName', 'isActivityEnabled'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow(),
  ).toEqual({ albumName: 'Restricted source album', isActivityEnabled: false });
});

it('preserves empty private albums without granting access to other imported owners', async () => {
  const { context, users } = await setup();
  const id = await new CanonicalAlbumWriter(wrap(db), context).write('empty');
  expect(await db.selectFrom('album_user').select(['userId', 'role']).where('albumId', '=', id).execute()).toEqual([
    { userId: users.owner, role: AlbumUserRole.Owner },
  ]);
  expect(await db.selectFrom('album_asset').select('assetId').where('albumId', '=', id).execute()).toEqual([]);
});

it.each(['missing-photo', 'wrong-photo-owner', 'missing-member'])(
  'refuses incomplete or mismatched mappings without a partial album: %s',
  async (kind) => {
    const { context, photos, users } = await setup();
    if (kind === 'missing-photo')
      await sql`DELETE FROM public.frameleaf_library_import_mapping WHERE entity_kind='asset' AND source_id='shared'`.execute(
        db,
      );
    else if (kind === 'wrong-photo-owner')
      await db.updateTable('asset').set({ ownerId: users.unrelated }).where('id', '=', photos.shared).execute();
    else
      await sql`DELETE FROM public.frameleaf_library_import_mapping WHERE entity_kind='owner' AND source_id='viewer'`.execute(
        db,
      );
    await expect(new CanonicalAlbumWriter(wrap(db), context).write('shared')).rejects.toThrow(
      /ALBUM_(ASSETS_INCOMPLETE|OWNERS_INCOMPLETE)/,
    );
    expect(await db.selectFrom('album').select('id').execute()).toEqual([]);
    expect(await db.selectFrom('album_user').select('userId').execute()).toEqual([]);
  },
);

it('rolls back membership and grants on interruption, then recovers a committed album after lost acknowledgement', async () => {
  const { context } = await setup();
  const actual = wrap(db);
  const interrupted: ImportDatabase = {
    ...actual,
    transaction: (body) =>
      actual.transaction((tx) =>
        body({
          ...tx,
          query: async (statement, parameters) => {
            if (statement.includes('INSERT INTO public.album_asset')) throw new Error('synthetic interruption');
            return tx.query(statement, parameters);
          },
        }),
      ),
  };
  await expect(new CanonicalAlbumWriter(interrupted, context).write('shared')).rejects.toThrow('ALBUM_WRITE_FAILED');
  expect(await db.selectFrom('album').select('id').execute()).toEqual([]);
  expect(await db.selectFrom('album_user').select('userId').execute()).toEqual([]);
  const lost: ImportDatabase = {
    ...actual,
    transaction: async (body) => {
      await actual.transaction(body);
      throw new Error('synthetic lost acknowledgement');
    },
  };
  await expect(new CanonicalAlbumWriter(lost, context).write('shared')).rejects.toThrow('ALBUM_WRITE_FAILED');
  const committed = await db.selectFrom('album').select('id').executeTakeFirstOrThrow();
  expect(await new CanonicalAlbumWriter(actual, context).write('shared')).toBe(committed.id);
  expect(await db.selectFrom('album').select('id').execute()).toHaveLength(1);
  expect(await db.selectFrom('album_user').select('userId').execute()).toHaveLength(3);
});

it('refuses a target photo that became Locked before creating any album grants', async () => {
  const { context, photos, users } = await setup();
  await db
    .insertInto('asset_lock')
    .values({ assetId: photos.shared, reason: AssetLockReason.Marked, lockedBy: users.owner })
    .execute();
  await expect(new CanonicalAlbumWriter(wrap(db), context).write('shared')).rejects.toThrow('ALBUM_ASSETS_INCOMPLETE');
  expect(await db.selectFrom('album').select('id').execute()).toEqual([]);
  expect(await db.selectFrom('album_user').select('userId').execute()).toEqual([]);
});

it('refuses a source member entry that would replace or duplicate album ownership', async () => {
  const { context } = await setup();
  context.manifest.albums[0].members.push({ userId: 'owner', role: 'viewer' });
  context.binding.manifestSha256 = manifestFingerprint(context.manifest);
  await expect(new CanonicalAlbumWriter(wrap(db), context).write('shared')).rejects.toThrow(
    'ALBUM_OWNER_MEMBER_CONFLICT',
  );
  expect(await db.selectFrom('album').select('id').execute()).toEqual([]);
});
