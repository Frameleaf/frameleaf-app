import { Kysely, sql } from 'kysely';
import { randomBytes } from 'node:crypto';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { AlbumKind, AssetVisibility, LibraryScope } from 'src/enum.js';
import { ConnectRepository } from 'src/repositories/connect.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { OAuthAppRepository } from 'src/repositories/oauth-app.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { getKyselyConfig } from 'src/utils/database.js';
import { refreshConnectAuth } from 'src/utils/connect-policy.js';
import { emptyHiddenContentFilter } from 'src/utils/hidden-content.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let database: Kysely<DB>;
beforeAll(async () => {
  database = await getKyselyDB();
});

const setup = async () => {
  const { ctx } = newMediumService(BaseService, { database, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const { user: other } = await ctx.newUser();
  const { album } = await ctx.newAlbum({ ownerId: user.id, albumName: 'Selected' });
  const { album: outside } = await ctx.newAlbum({ ownerId: user.id, albumName: 'Outside' });
  const { album: child } = await ctx.newAlbum({ ownerId: user.id, albumName: 'Child', parentId: album.id });
  const { album: shared } = await ctx.newAlbum({ ownerId: other.id, albumName: 'Shared with me' });
  await ctx.newAlbumUser({ albumId: shared.id, userId: user.id });
  const policy = {
    version: 1 as const,
    readAlbumIds: [album.id],
    allLibraryRead: false,
    writableAlbumIds: [album.id],
    writeWorkspaces: [],
  };
  const oauth = new OAuthAppRepository(database);
  const client = await oauth.createClient(
    { name: 'Test', redirectUris: ['https://app.example/callback'], logoUri: null },
    500,
  );
  const grant = await oauth.createGrant({
    userId: user.id,
    clientId: client!.id,
    scopes: ['library:read', 'albums:write'],
    resource: 'https://library.example/api/connect',
    accessPolicy: policy,
    policyRevision: 1,
    refreshTokenHash: randomBytes(32),
    accessTokenHash: randomBytes(32),
    accessExpiresAt: new Date(Date.now() + 3600000),
  });
  const auth: AuthDto = {
    user: { ...user, quotaUsageInBytes: 0 },
    oauthApp: {
      grantId: grant.id,
      clientId: client!.id,
      clientName: 'Test',
      resource: grant.resource,
      scopes: grant.scopes,
      accessPolicy: policy,
      policyRevision: 1,
    },
  };
  const sut = new ConnectRepository(database);
  const add = async (albumId: string, values: Parameters<typeof ctx.newAsset>[0] = {}) => {
    const { asset } = await ctx.newAsset({ ownerId: user.id, ...values });
    await ctx.newAlbumAsset({ albumId, assetId: asset.id });
    return asset;
  };
  return { ctx, sut, auth, user, other, album, outside, child, shared, add, policy, grant };
};

describe('Connect query privacy', () => {
  it('filters ownership, exact selected membership, Hidden, Locked and Trash before totals and paging', async () => {
    const { sut, auth, user, other, album, outside, child, shared, add } = await setup();
    const visible = await add(album.id);
    const visible2 = await add(album.id);
    await add(album.id, { ownerId: other.id });
    await add(album.id, { visibility: AssetVisibility.Hidden });
    await add(album.id, { visibility: AssetVisibility.Locked });
    await add(album.id, { deletedAt: new Date() });
    await add(outside.id);
    await add(child.id);
    await add(shared.id, { ownerId: user.id });
    const first = await sut.search(auth, { page: 1, size: 1 });
    const second = await sut.search(auth, { page: 2, size: 1 });
    expect(first.total).toBe(2);
    expect(second.total).toBe(2);
    expect(new Set([...first.items, ...second.items].map((asset) => asset.id))).toEqual(
      new Set([visible.id, visible2.id]),
    );
    expect(await sut.search(auth, { page: 3, size: 1 })).toMatchObject({ items: [], total: 2 });
    expect(Object.keys(first.items[0]).sort()).toEqual([
      'createdAt',
      'description',
      'duration',
      'height',
      'id',
      'title',
      'type',
      'updatedAt',
      'width',
    ]);
  });

  it('hides rule-suppressed assets and never exposes another owner under whole-library permission', async () => {
    const { sut, auth, other, album, add, grant } = await setup();
    const clean = await add(album.id);
    const hidden = await add(album.id);
    await database.updateTable('asset').set({ is_nsfw: true }).where('id', '=', hidden.id).execute();
    await add(album.id, { ownerId: other.id });
    auth.hiddenContent = { ...emptyHiddenContentFilter(auth.user.id), includeNsfw: true };
    await database
      .updateTable('oauth_grant')
      .set({ accessPolicy: { ...auth.oauthApp!.accessPolicy!, allLibraryRead: true } })
      .where('id', '=', grant.id)
      .execute();
    expect((await sut.search(auth, { page: 1, size: 50 })).items.map((item) => item.id)).toEqual([clean.id]);
    await expect(sut.asset(auth, hidden.id)).rejects.toThrow('Asset not found');
  });

  it('applies narrowing and revocation immediately even with an old request auth object', async () => {
    const { sut, auth, album, add, policy, grant } = await setup();
    const asset = await add(album.id);
    await expect(sut.asset(auth, asset.id)).resolves.toMatchObject({ id: asset.id });
    await sut.narrowPolicy(auth.user.id, grant.id, { ...policy, readAlbumIds: [] });
    await expect(sut.asset(auth, asset.id)).rejects.toThrow('Asset not found');
    expect((await refreshConnectAuth(database, auth)).oauthApp!.policyRevision).toBe(2);
    await database.updateTable('oauth_grant').set({ revokedAt: new Date() }).where('id', '=', grant.id).execute();
    await expect(refreshConnectAuth(database, auth)).rejects.toThrow();
  });

  it('holds source privacy rows through an additive write transaction', async () => {
    const { sut, auth, album, add } = await setup();
    const asset = await add(album.id);
    const {
      rows: [{ name }],
    } = await sql<{ name: string }>`select current_database() name`.execute(database);
    const url = new URL(process.env.IMMICH_TEST_POSTGRES_URL!);
    url.pathname = `/${name}`;
    const competing = new Kysely<DB>(getKyselyConfig({ connectionType: 'url', url: url.href }));
    let release!: () => void;
    let checked!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      checked = resolve;
    });
    const write = sut.withGrantWrite(auth, async (current) => {
      await sut.requireReadableAssets(current, [asset.id]);
      checked();
      await held;
    });
    await ready;
    try {
      await expect(
        competing.transaction().execute(async (tx) => {
          await sql`set local lock_timeout = '300ms'`.execute(tx);
          await tx
            .updateTable('asset')
            .set({ visibility: AssetVisibility.Hidden })
            .where('id', '=', asset.id)
            .execute();
        }),
      ).rejects.toThrow(/lock timeout/);
    } finally {
      release();
      await write;
      await competing.destroy();
    }
  });

  it('rejects shared, locked and trashed target albums at consent and write time', async () => {
    const { sut, auth, album, shared, outside, policy } = await setup();
    await expect(sut.validateAlbums(auth.user.id, { ...policy, readAlbumIds: [shared.id] })).rejects.toThrow();
    await expect(sut.requireWritableAlbum(auth, outside.id)).rejects.toThrow();
    await database.updateTable('album').set({ isLocked: true }).where('id', '=', album.id).execute();
    await expect(sut.requireWritableAlbum(auth, album.id)).rejects.toThrow();
    await database
      .updateTable('album')
      .set({ isLocked: false, deletedAt: new Date() })
      .where('id', '=', album.id)
      .execute();
    await expect(sut.validateAlbums(auth.user.id, policy)).rejects.toThrow();
  });

  it('allows mixed-workspace albums for reading but never as writable destinations', async () => {
    const { sut, auth, album, policy } = await setup();
    await database.updateTable('album').set({ libraryScope: LibraryScope.Both }).where('id', '=', album.id).execute();
    await expect(sut.validateAlbums(auth.user.id, { ...policy, writableAlbumIds: [] })).resolves.toBeUndefined();
    await expect(sut.validateAlbums(auth.user.id, policy)).rejects.toThrow();
    expect((await sut.availableAlbums(auth.user.id)).find((item) => item.id === album.id)).toMatchObject({
      canWrite: false,
    });
  });

  it('does not delegate through an owned album inside a shared space', async () => {
    const { sut, ctx, auth, policy } = await setup();
    const { album: space } = await ctx.newAlbum({ ownerId: auth.user.id, kind: AlbumKind.Space });
    const { album } = await ctx.newAlbum({ ownerId: auth.user.id, parentId: space.id });
    await expect(sut.validateAlbums(auth.user.id, { ...policy, readAlbumIds: [album.id] })).rejects.toThrow();
  });

  it('requires writable membership as well as readable membership for tags', async () => {
    const { sut, auth, outside, album, add, grant, policy } = await setup();
    const asset = await add(album.id);
    await database
      .updateTable('oauth_grant')
      .set({ accessPolicy: { ...policy, writableAlbumIds: [outside.id] } })
      .where('id', '=', grant.id)
      .execute();
    await expect(sut.requireReadableAssets(auth, [asset.id], true)).rejects.toThrow();
    await database.insertInto('album_asset').values({ albumId: outside.id, assetId: asset.id }).execute();
    await expect(sut.requireReadableAssets(auth, [asset.id], true)).resolves.toBeUndefined();
  });
});
