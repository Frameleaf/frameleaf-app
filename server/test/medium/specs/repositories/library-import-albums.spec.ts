import { CompiledQuery, Kysely, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { AlbumUserRole, AssetLockReason, SharedLinkType } from 'src/enum.js';
import { ImportDatabase } from 'src/immich-import/types.js';
import { reconcileImportedAlbums } from 'src/library-import/album-reconciliation.js';
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
const setup = async (description?: string, locked = false) => {
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
      visibility: locked && file.id === 'shared' ? 'locked' : 'timeline',
      metadata: { takenAt: '2020-01-02T03:04:05Z', timeZone: 'UTC' },
    })),
    albums: [
      {
        id: 'shared',
        ownerId: 'owner',
        name: 'Restricted source album',
        ...(description === undefined ? {} : { description }),
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

it('keeps a source-Locked photo in its albums and verifies its lock', async () => {
  // Owner 2026-11-04: a source's private item imports Locked; a Locked item keeps its albums
  const { context, photos } = await readyAlbums(undefined, true);
  expect(
    await db.selectFrom('album_asset').select('albumId').where('assetId', '=', photos.shared).execute(),
  ).not.toEqual([]);
  expect(await db.selectFrom('asset_lock').select('assetId').execute()).toEqual([{ assetId: photos.shared }]);
  await expect(reconcileImportedAlbums(wrap(db), context)).resolves.toMatchObject({ albums: 2 });
  await sql`DELETE FROM public.asset_lock`.execute(db);
  await expect(reconcileImportedAlbums(wrap(db), context)).rejects.toThrow('ALBUM_RECONCILIATION_MISMATCH');
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

const readyAlbums = async (description?: string, locked = false) => {
  const fixture = await setup(description, locked);
  const albums: Record<string, string> = {};
  for (const album of fixture.context.manifest.albums) {
    albums[album.id] = await new CanonicalAlbumWriter(wrap(db), fixture.context).write(album.id);
  }
  await new LibraryImportJournal(wrap(db)).phase(fixture.context.binding, 'verifying');
  return { ...fixture, albums };
};

it.each(['Manual album description\nwith a second line', '', undefined])(
  'preserves and independently verifies the source description: %j',
  async (description) => {
    const { context, albums } = await readyAlbums(description);
    expect(
      await db.selectFrom('album').select('description').where('id', '=', albums.shared).executeTakeFirstOrThrow(),
    ).toEqual({ description: description ?? null });
    expect(await reconcileImportedAlbums(wrap(db), context)).toMatchObject({ albums: 2, grants: 4 });
  },
);

it.each(['changed', null])('refuses changed or lost description metadata: %j', async (description) => {
  const { context, albums } = await readyAlbums('Manual source description');
  await db.updateTable('album').set({ description }).where('id', '=', albums.shared).execute();
  await expect(reconcileImportedAlbums(wrap(db), context)).rejects.toThrow('ALBUM_RECONCILIATION_MISMATCH');
});

it('independently reconciles albums, memberships and permissions after restart without writing', async () => {
  const { context, albums, photos, users } = await readyAlbums();
  const first = await reconcileImportedAlbums(wrap(db), context);
  const legacyRecords = [
    {
      id: albums.empty,
      name: 'Empty source album',
      ownerId: users.owner,
      assetIds: [],
      grants: [{ userId: users.owner, role: 'owner' }],
    },
    {
      id: albums.shared,
      name: 'Restricted source album',
      ownerId: users.owner,
      assetIds: [photos.shared],
      grants: [
        { userId: users.owner, role: 'owner' },
        { userId: users.viewer, role: 'viewer' },
        { userId: users.editor, role: 'editor' },
      ].sort((a, b) => a.userId.localeCompare(b.userId)),
    },
  ].sort((a, b) => a.id.localeCompare(b.id));
  expect(first.sha256).toBe(createHash('sha256').update(JSON.stringify(legacyRecords)).digest('hex'));
  expect(first).toMatchObject({
    format: 'frameleaf-album-reconciliation',
    version: 1,
    operationId: context.binding.operationId,
    manifestSha256: context.binding.manifestSha256,
    planSha256: context.binding.planSha256,
    albums: 2,
    memberships: 1,
    grants: 4,
    sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(await reconcileImportedAlbums(wrap(db), context)).toEqual(first);
  expect((await new LibraryImportJournal(wrap(db)).status()).run?.status).toBe('verifying');
});

it.each([
  'member',
  'role',
  'membership',
  'owner',
  'name',
  'description',
  'activity',
  'mapping',
  'extra-album',
  'public-link',
  'lock',
  'cover',
])('refuses actual destination corruption instead of trusting mappings: %s', async (kind) => {
  const { context, albums, photos, users } = await readyAlbums();
  switch (kind) {
    case 'cover': {
      await sql`UPDATE public.album SET "albumThumbnailAssetId"=${photos.private}::uuid
          WHERE id=${albums.shared}::uuid`.execute(db);
      break;
    }
    case 'member': {
      await sql`INSERT INTO public.album_user("albumId","userId",role)
          VALUES(${albums.shared}::uuid,${users.unrelated}::uuid,'viewer')`.execute(db);
      break;
    }
    case 'role': {
      await sql`UPDATE public.album_user SET role='editor'
          WHERE "albumId"=${albums.shared}::uuid AND "userId"=${users.viewer}::uuid`.execute(db);
      break;
    }
    case 'membership': {
      await sql`INSERT INTO public.album_asset("albumId","assetId")
          VALUES(${albums.shared}::uuid,${photos.private}::uuid)`.execute(db);
      break;
    }
    case 'owner': {
      await sql`UPDATE public.asset SET "ownerId"=${users.unrelated}::uuid WHERE id=${photos.shared}::uuid`.execute(db);
      break;
    }
    case 'name': {
      await sql`UPDATE public.album SET "albumName"='changed' WHERE id=${albums.shared}::uuid`.execute(db);
      break;
    }
    case 'description': {
      await db.updateTable('album').set({ description: 'Unreviewed text' }).where('id', '=', albums.shared).execute();
      break;
    }
    case 'activity': {
      await sql`UPDATE public.album SET "isActivityEnabled"=true WHERE id=${albums.shared}::uuid`.execute(db);
      break;
    }
    case 'mapping': {
      await sql`UPDATE public.frameleaf_library_import_mapping SET record_sha256=${'f'.repeat(64)}
          WHERE entity_kind='album' AND source_id='shared'`.execute(db);
      break;
    }
    case 'extra-album': {
      await sql`INSERT INTO public.album("albumName") VALUES('unexpected')`.execute(db);
      break;
    }
    case 'public-link': {
      await sql`INSERT INTO public.shared_link("userId",key,type,"albumId")
          VALUES(${users.owner}::uuid,decode(${'b'.repeat(64)},'hex'),${SharedLinkType.Album},${albums.shared}::uuid)`.execute(
        db,
      );
      break;
    }
    case 'lock': {
      await sql`INSERT INTO public.asset_lock("assetId",reason,"lockedBy")
          VALUES(${photos.shared}::uuid,${AssetLockReason.Marked},${users.owner}::uuid)`.execute(db);
      break;
    }
  }
  await expect(reconcileImportedAlbums(wrap(db), context)).rejects.toThrow('ALBUM_RECONCILIATION_MISMATCH');
});

it('requires the verifying phase and an unchanged full binding', async () => {
  const { context } = await setup();
  await expect(reconcileImportedAlbums(wrap(db), context)).rejects.toThrow('IMPORT_NOT_VERIFYING');
  await new LibraryImportJournal(wrap(db)).phase(context.binding, 'verifying');
  await expect(
    reconcileImportedAlbums(wrap(db), {
      ...context,
      binding: { ...context.binding, operationId: randomUUID() },
    }),
  ).rejects.toThrow('IMPORT_BINDING_CHANGED');
});

it.each([
  ['description', 'unexpected'],
  ['order', 'asc'],
  ['libraryScope', 'design'],
  ['icon', 'unexpected'],
  ['color', 'red'],
  ['sortOrder', 1],
] as const)('refuses unexpected album metadata: %s', async (column, value) => {
  const { context, albums } = await readyAlbums();
  await sql`UPDATE public.album SET ${sql.ref(column)}=${value} WHERE id=${albums.shared}::uuid`.execute(db);
  await expect(reconcileImportedAlbums(wrap(db), context)).rejects.toThrow('ALBUM_RECONCILIATION_MISMATCH');
});

it.each(['album', 'member', 'membership', 'mapping'])('refuses a missing destination %s', async (kind) => {
  const { context, albums, users } = await readyAlbums();
  switch (kind) {
    case 'album': {
      await sql`DELETE FROM public.album WHERE id=${albums.shared}::uuid`.execute(db);
      break;
    }
    case 'member': {
      await sql`DELETE FROM public.album_user WHERE "albumId"=${albums.shared}::uuid
        AND "userId"=${users.viewer}::uuid`.execute(db);
      break;
    }
    case 'membership': {
      await sql`DELETE FROM public.album_asset WHERE "albumId"=${albums.shared}::uuid`.execute(db);
      break;
    }
    case 'mapping': {
      await sql`DELETE FROM public.frameleaf_library_import_mapping
        WHERE entity_kind='album' AND source_id='shared'`.execute(db);
      break;
    }
  }
  await expect(reconcileImportedAlbums(wrap(db), context)).rejects.toThrow('ALBUM_RECONCILIATION_MISMATCH');
});

it('redacts unexpected database diagnostics during readback', async () => {
  const { context } = await readyAlbums();
  const actual = wrap(db);
  const failing: ImportDatabase = {
    ...actual,
    transaction: (body) =>
      actual.transaction((tx) =>
        body({
          ...tx,
          query: (statement, parameters) => {
            if (statement.includes('FROM public.album ORDER')) throw new Error('synthetic private album name');
            return tx.query(statement, parameters);
          },
        }),
      ),
  };
  await expect(reconcileImportedAlbums(failing, context)).rejects.toThrow(
    /^Library import refused: ALBUM_RECONCILIATION_FAILED$/,
  );
});
