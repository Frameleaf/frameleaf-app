import { Kysely, sql } from 'kysely';
import { randomBytes } from 'node:crypto';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { AlbumKind, AlbumUserRole, AssetVisibility, LibraryScope } from 'src/enum.js';
import { publicationTransaction } from 'src/queue/transaction.js';
import { AlbumRepository, lockAlbumHierarchy } from 'src/repositories/album.repository.js';
import { ConnectRepository } from 'src/repositories/connect.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { OAuthAppRepository } from 'src/repositories/oauth-app.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { refreshConnectAuth } from 'src/utils/connect-policy.js';
import { emptyHiddenContentFilter } from 'src/utils/hidden-content.js';
import { connectCompetitor, publicationBarrier } from 'test/fixtures/connect-concurrency.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let database: Kysely<DB>;
beforeAll(async () => {
  database = await getKyselyDB();
});
afterAll(async () => {
  await database?.destroy();
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
    accessExpiresAt: new Date(Date.now() + 3_600_000),
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
    const competing = await connectCompetitor(database);
    const { ready, release, hold } = publicationBarrier();
    const write = sut.withGrantWrite(auth, async (current) => {
      await sut.requireReadableAssets(current, [asset.id]);
      await hold();
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

  it.each([
    'membership',
    'direct membership',
    'source owner',
    'target owner',
    'ancestor privacy',
    'hierarchy',
  ] as const)('holds %s authority through additive publication', async (change) => {
    const { sut, auth, album, outside, add, policy, grant } = await setup();
    const asset = await add(album.id);
    await new AlbumRepository(database).reparent(outside.id, album.id);
    await database
      .updateTable('oauth_grant')
      .set({ accessPolicy: { ...policy, writableAlbumIds: [outside.id] } })
      .where('id', '=', grant.id)
      .execute();
    const competing = await connectCompetitor(database);
    const barrier = publicationBarrier();
    const write = sut.withGrantWrite(auth, async (current) => {
      await sut.requireWritableAlbum(current, outside.id);
      await sut.requireReadableAssets(current, [asset.id]);
      await barrier.hold();
      await new AlbumRepository(database).addAssetIds(outside.id, [asset.id]);
    });
    await Promise.race([barrier.ready, write]);
    try {
      await expect(
        competing.transaction().execute(async (tx) => {
          await sql`set local lock_timeout = '300ms'`.execute(tx);
          if (change === 'membership') await new AlbumRepository(tx).removeAssetIds(album.id, [asset.id]);
          else if (change === 'direct membership')
            await tx
              .deleteFrom('album_asset')
              .where('albumId', '=', album.id)
              .where('assetId', '=', asset.id)
              .execute();
          else if (change === 'source owner' || change === 'target owner')
            await tx
              .updateTable('album_user')
              .set({ role: AlbumUserRole.Editor })
              .where('albumId', '=', change === 'source owner' ? album.id : outside.id)
              .where('userId', '=', auth.user.id)
              .execute();
          else if (change === 'ancestor privacy')
            await tx.updateTable('album').set({ isLocked: true }).where('id', '=', album.id).execute();
          else if (change === 'hierarchy') await new AlbumRepository(tx).reparentIn(tx, album.id, null);
        }),
      ).rejects.toThrow(/lock timeout/);
    } finally {
      barrier.release();
      await write;
      await competing.destroy();
    }
    expect(
      await database
        .selectFrom('album_asset')
        .select('assetId')
        .where('albumId', '=', outside.id)
        .where('assetId', '=', asset.id)
        .execute(),
    ).toHaveLength(1);
  });

  it.each(['album', 'owner', 'asset', 'membership'] as const)(
    'refuses a busy %s row without waiting behind a writer that may need hierarchy',
    async (kind) => {
      const { sut, auth, album, add } = await setup();
      const asset = await add(album.id);
      const competing = await connectCompetitor(database);
      const barrier = publicationBarrier();
      const writer = competing.transaction().execute(async (tx) => {
        if (kind === 'album') await tx.selectFrom('album').select('id').where('id', '=', album.id).forShare().execute();
        else if (kind === 'owner')
          await tx
            .selectFrom('album_user')
            .select('albumId')
            .where('albumId', '=', album.id)
            .where('userId', '=', auth.user.id)
            .forUpdate()
            .execute();
        else if (kind === 'asset')
          await tx.selectFrom('asset').select('id').where('id', '=', asset.id).forUpdate().execute();
        else if (kind === 'membership')
          await tx
            .selectFrom('album_asset')
            .select('assetId')
            .where('albumId', '=', album.id)
            .where('assetId', '=', asset.id)
            .forUpdate()
            .execute();
        await barrier.hold();
        await lockAlbumHierarchy(tx);
      });
      await Promise.race([barrier.ready, writer]);
      try {
        await expect(
          database.transaction().execute(async (tx) => {
            await sql`set local lock_timeout = '0'`.execute(tx);
            await sql`set local statement_timeout = '5s'`.execute(tx);
            await publicationTransaction.run(tx, () =>
              sut.withGrantWrite(auth, (current) => sut.requireReadableAssets(current, [asset.id])),
            );
          }),
        ).rejects.toThrow('Connect access is changing');
      } finally {
        barrier.release();
        await writer;
        await competing.destroy();
      }
    },
  );

  it('refuses a hierarchy lock inversion while a writer waits for the publication owner', async () => {
    const { sut, auth } = await setup();
    const competing = await connectCompetitor(database);
    const barrier = publicationBarrier();
    let writer!: Promise<void>;
    try {
      await database.transaction().execute(async (tx) => {
        await tx.selectFrom('user').select('id').where('id', '=', auth.user.id).forUpdate().execute();
        writer = competing.transaction().execute(async (other) => {
          await lockAlbumHierarchy(other);
          await barrier.hold();
          await other.selectFrom('user').select('id').where('id', '=', auth.user.id).forUpdate().execute();
        });
        await Promise.race([barrier.ready, writer]);
        barrier.release();
        await sql`set local lock_timeout = '1s'`.execute(tx);
        await expect(
          publicationTransaction.run(tx, () => sut.withGrantWrite(auth, () => Promise.resolve())),
        ).rejects.toThrow('Album hierarchy is changing');
      });
    } finally {
      barrier.release();
      await writer;
      await competing.destroy();
    }
  });

  it('denies publication when a hierarchy writer makes the destination private', async () => {
    const { sut, auth, album, outside, add, policy, grant } = await setup();
    const asset = await add(album.id);
    await database
      .updateTable('oauth_grant')
      .set({ accessPolicy: { ...policy, writableAlbumIds: [outside.id] } })
      .where('id', '=', grant.id)
      .execute();
    const competing = await connectCompetitor(database);
    const barrier = publicationBarrier();
    const mutation = competing.transaction().execute(async (tx) => {
      await lockAlbumHierarchy(tx);
      await new AlbumRepository(tx).reparentIn(tx, outside.id, album.id);
      await tx.updateTable('album').set({ isLocked: true }).where('id', '=', album.id).execute();
      await barrier.hold();
    });
    await Promise.race([barrier.ready, mutation]);
    const write = sut.withGrantWrite(auth, async (current) => {
      await sut.requireWritableAlbum(current, outside.id);
      await sut.requireReadableAssets(current, [asset.id]);
      await new AlbumRepository(database).addAssetIds(outside.id, [asset.id]);
    });
    const denied = expect(write).rejects.toThrow();
    barrier.release();
    await mutation;
    await denied;
    await expect(
      sut.withGrantWrite(auth, (current) => sut.requireWritableAlbum(current, outside.id)),
    ).rejects.toThrow();
    await competing.destroy();
    expect(
      await database.selectFrom('album_asset').select('assetId').where('albumId', '=', outside.id).execute(),
    ).toHaveLength(0);
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
