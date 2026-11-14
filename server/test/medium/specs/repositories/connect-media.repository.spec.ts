import { Kysely, sql } from 'kysely';
import { randomBytes, randomUUID } from 'node:crypto';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { DB } from 'src/schema/index.js';
import { ConnectUploadStartDto } from 'src/dtos/connect-media.dto.js';
import { AlbumUserRole, AssetStatus, AssetType, ChecksumAlgorithm, LibraryScope, Permission } from 'src/enum.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetUploadResourceRepository } from 'src/repositories/asset-upload-resource.repository.js';
import { ConnectMediaRepository } from 'src/repositories/connect-media.repository.js';
import { canonicalTestContext, expectCanonicalTables } from 'test/fixtures/canonical-database.js';
import { connectCompetitor, publicationBarrier } from 'test/fixtures/connect-concurrency.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});

const fixture = async () => {
  const ctx = canonicalTestContext(db);
  const { user } = await ctx.newUser();
  const { album } = await ctx.newAlbum({ ownerId: user.id, libraryScope: LibraryScope.Design });
  const client = await db
    .insertInto('oauth_client')
    .values({ name: 'test', redirectUris: ['https://example.org/callback'], logoUri: null, createdById: user.id })
    .returning('id')
    .executeTakeFirstOrThrow();
  const policy = {
    version: 1 as const,
    readAlbumIds: [album.id],
    allLibraryRead: false,
    writableAlbumIds: [album.id],
    writeWorkspaces: ['design' as const],
  };
  const grant = await db
    .insertInto('oauth_grant')
    .values({
      userId: user.id,
      clientId: client.id,
      scopes: ['boards:upload', 'albums:write', 'library:read'],
      resource: 'https://library.example/api/connect',
      accessTokenHash: randomBytes(32),
      refreshTokenHash: randomBytes(32),
      accessExpiresAt: new Date(Date.now() + 3_600_000),
      accessPolicy: policy,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  const auth: AuthDto = {
    user,
    apiKey: { id: grant.id, permissions: [Permission.AssetUpload] },
    oauthApp: {
      grantId: grant.id,
      clientId: client.id,
      clientName: 'test',
      scopes: grant.scopes,
      resource: grant.resource,
      accessPolicy: policy,
      policyRevision: 0,
    },
  };
  const dto = ConnectUploadStartDto.schema.parse({
    requestId: randomUUID(),
    albumId: album.id,
    workspace: 'design',
    filename: 'page.png',
    size: 10,
    sha256: randomBytes(32).toString('hex'),
    contentType: 'image/png',
    fileCreatedAt: '2026-11-13T00:00:00Z',
    fileModifiedAt: '2026-11-13T00:00:00Z',
  });
  return {
    ctx,
    user,
    album,
    grant,
    auth,
    dto,
    repo: new ConnectMediaRepository(db),
    uploads: new AssetUploadResourceRepository(db),
  };
};
const stage = async (f: Awaited<ReturnType<typeof fixture>>) => {
  const resource = await f.repo.start(f.auth, f.dto, 1000);
  await db
    .updateTable('asset_upload_resource')
    .set({
      state: 'verified',
      offset: f.dto.size,
      verifiedChecksum: Buffer.from(f.dto.sha256, 'hex'),
      legacyChecksum: randomBytes(20),
      finalPath: `/sanitized/${resource.id}.png`,
    })
    .where('id', '=', resource.id)
    .execute();
  return resource.id;
};
const commit = async (f: Awaited<ReturnType<typeof fixture>>, id: string) =>
  f.uploads.locked(id, f.user.id, (tx, resource) =>
    f.repo.commit(tx, f.auth, resource, { requestId: f.dto.requestId, sha256: f.dto.sha256 }, () =>
      f.uploads.publish(tx, resource, {
        asset: {
          ownerId: f.user.id,
          checksum: resource.verifiedChecksum!,
          checksumAlgorithm: ChecksumAlgorithm.sha256File,
          originalPath: resource.finalPath!,
          originalFileName: f.dto.filename,
          fileCreatedAt: new Date(f.dto.fileCreatedAt),
          fileModifiedAt: new Date(f.dto.fileModifiedAt),
          localDateTime: new Date(f.dto.fileCreatedAt),
          libraryScope: LibraryScope.Design,
          type: AssetType.Image,
        },
        lock: undefined,
      }),
    ),
  );

describe('Connect media real transactions on the canonical migration chain', () => {
  it('uploads into an explicit destination without permission to create more albums', async () => {
    const f = await fixture();
    const policy = { ...f.grant.accessPolicy!, writeWorkspaces: [] };
    await db.updateTable('oauth_grant').set({ accessPolicy: policy }).where('id', '=', f.grant.id).execute();
    f.auth.oauthApp!.accessPolicy = policy;
    const id = await stage(f);
    const receipt = await commit(f, id);
    expect(receipt.assetId).toBeTruthy();
    await expect(
      f.repo.createAlbum(f.auth, { requestId: randomUUID(), name: 'Not allowed', workspace: 'design' }),
    ).rejects.toThrow();
    await expect(
      f.repo.start(f.auth, { ...f.dto, workspace: 'photo', requestId: randomUUID() }, 1000),
    ).rejects.toThrow();
  });

  it('installs durable media receipts, hashed tickets and optional provenance', async () => {
    await expectCanonicalTables(db, ['connect_receipt', 'connect_rendition_ticket', 'connect_provenance']);
  });

  it('creates exactly one album for concurrent identical request IDs, atomically extending only the grant', async () => {
    const f = await fixture();
    const dto = { requestId: randomUUID(), name: 'Export', workspace: 'design' as const };
    const results = await Promise.all(Array.from({ length: 5 }, () => f.repo.createAlbum(f.auth, dto)));
    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    const receipts = await db.selectFrom('connect_receipt').selectAll().where('grantId', '=', f.grant.id).execute();
    expect(receipts).toHaveLength(1);
    const current = await db
      .selectFrom('oauth_grant')
      .selectAll()
      .where('id', '=', f.grant.id)
      .executeTakeFirstOrThrow();
    expect(current.accessPolicy?.readAlbumIds).toEqual([f.album.id, results[0].id]);
    expect(current.accessPolicy?.writableAlbumIds).toEqual([f.album.id, results[0].id]);
    expect(current.policyRevision).toBe(1);
    await expect(f.repo.createAlbum(f.auth, { ...dto, name: 'Changed' })).rejects.toThrow('Request ID payload changed');
  });

  it('creates one private resource for concurrent starts and never publishes any asset', async () => {
    const f = await fixture();
    const results = await Promise.all(Array.from({ length: 5 }, () => f.repo.start(f.auth, f.dto, 1000)));
    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    expect(results.every((result) => result.state === 'receiving' && result.offset === 0)).toBe(true);
    expect(await db.selectFrom('asset').select('id').where('ownerId', '=', f.user.id).execute()).toHaveLength(0);
    expect(await db.selectFrom('connect_receipt').selectAll().where('grantId', '=', f.grant.id).execute()).toHaveLength(
      1,
    );
    await expect(f.repo.start(f.auth, { ...f.dto, size: 11 }, 1000)).rejects.toThrow('Request ID payload changed');
  });

  it('publishes once under concurrent commits and keeps a 30 day receipt without overwriting the original', async () => {
    const f = await fixture();
    const id = await stage(f);
    // Both concurrent callers succeed: the second recovers the first's recorded receipt.
    const [first, second] = await Promise.all([commit(f, id), commit(f, id)]);
    expect(second).toEqual(first);
    const retry = await commit(f, id);
    const assets = await db.selectFrom('asset').selectAll().where('ownerId', '=', f.user.id).execute();
    expect(assets).toHaveLength(1);
    expect(retry.assetId).toBe(assets[0].id);
    expect(assets[0].originalPath).toBe(`/sanitized/${id}.png`);
    expect(assets[0].libraryScope).toBe(LibraryScope.Design);
    expect(await db.selectFrom('album_asset').selectAll().where('albumId', '=', f.album.id).execute()).toHaveLength(1);
    const receipt = await db
      .selectFrom('connect_receipt')
      .selectAll()
      .where('grantId', '=', f.grant.id)
      .where('operation', '=', 'upload-commit')
      .executeTakeFirstOrThrow();
    expect(receipt.expiresAt.getTime() - receipt.createdAt.getTime()).toBeGreaterThanOrEqual(30 * 86_400_000 - 1000);
  });

  it.each(['revoke', 'narrow', 'quota'] as const)('rechecks live %s after bytes are staged', async (change) => {
    const f = await fixture();
    const id = await stage(f);
    switch (change) {
      case 'revoke': {
        await db.updateTable('oauth_grant').set({ revokedAt: new Date() }).where('id', '=', f.grant.id).execute();
        break;
      }
      case 'narrow': {
        await db
          .updateTable('oauth_grant')
          .set({ accessPolicy: { ...f.grant.accessPolicy!, writableAlbumIds: [] } })
          .where('id', '=', f.grant.id)
          .execute();
        break;
      }
      case 'quota': {
        await db.updateTable('user').set({ quotaSizeInBytes: 5 }).where('id', '=', f.user.id).execute();
        break;
      }
      // No default
    }
    await expect(commit(f, id)).rejects.toThrow();
    expect(await db.selectFrom('asset').select('id').where('ownerId', '=', f.user.id).execute()).toHaveLength(0);
    expect(
      (await db.selectFrom('asset_upload_resource').select('state').where('id', '=', id).executeTakeFirstOrThrow())
        .state,
    ).toBe('verified');
  });

  it.each(['trash', 'outside', 'photo', 'locked'] as const)(
    'denies %s duplicates with one generic conflict and preserves the original',
    async (kind) => {
      const f = await fixture();
      const { asset } = await f.ctx.newAsset({
        ownerId: f.user.id,
        checksum: Buffer.from(f.dto.sha256, 'hex'),
        libraryScope: kind === 'photo' ? LibraryScope.Personal : LibraryScope.Design,
        ...(kind === 'trash' && { status: AssetStatus.Trashed, deletedAt: new Date() }),
      });
      if (kind !== 'outside')
        await db.insertInto('album_asset').values({ albumId: f.album.id, assetId: asset.id }).execute();
      if (kind === 'locked')
        await db
          .insertInto('asset_lock')
          .values({ assetId: asset.id, reason: 'marked' as never, lockedBy: f.user.id, previousVisibility: null })
          .execute();
      const id = await stage(f);
      await expect(commit(f, id)).rejects.toThrow('Connect operation unavailable');
      const kept = await db.selectFrom('asset').selectAll().where('id', '=', asset.id).executeTakeFirstOrThrow();
      expect(kept.originalPath).toBe(asset.originalPath);
      expect(kept.status).toBe(asset.status ?? AssetStatus.Active);
      expect(kept.libraryScope).toBe(asset.libraryScope);
      expect(await db.selectFrom('asset').select('id').where('ownerId', '=', f.user.id).execute()).toHaveLength(1);
    },
  );

  it('rechecks destination ancestor privacy after staging and leaves no publication on denial', async () => {
    const f = await fixture();
    const { album: parent } = await f.ctx.newAlbum({ ownerId: f.user.id });
    await new AlbumRepository(db).reparent(f.album.id, parent.id);
    const id = await stage(f);
    await db.updateTable('album').set({ isLocked: true }).where('id', '=', parent.id).execute();
    await expect(commit(f, id)).rejects.toThrow('Connect operation unavailable');
    expect(await db.selectFrom('asset').select('id').where('ownerId', '=', f.user.id).execute()).toHaveLength(0);
    expect(
      await db
        .selectFrom('connect_receipt')
        .select('id')
        .where('grantId', '=', f.grant.id)
        .where('operation', '=', 'upload-commit')
        .execute(),
    ).toHaveLength(0);
  });

  it.each(['ancestor privacy', 'hierarchy'] as const)(
    'holds destination %s until the upload receipt commits',
    async (change) => {
      const f = await fixture();
      const { album: parent } = await f.ctx.newAlbum({ ownerId: f.user.id });
      await new AlbumRepository(db).reparent(f.album.id, parent.id);
      const id = await stage(f);
      const competing = await connectCompetitor(db);
      const barrier = publicationBarrier();
      const requireResult = f.repo.requireResult.bind(f.repo);
      vi.spyOn(f.repo, 'requireResult').mockImplementation(async (...args) => {
        const result = await requireResult(...args);
        await barrier.hold();
        return result;
      });
      const write = commit(f, id);
      await Promise.race([barrier.ready, write]);
      try {
        await expect(
          competing.transaction().execute(async (tx) => {
            await sql`set local lock_timeout = '300ms'`.execute(tx);
            if (change === 'ancestor privacy')
              await tx.updateTable('album').set({ isLocked: true }).where('id', '=', parent.id).execute();
            else await new AlbumRepository(tx).reparentIn(tx, parent.id, null);
          }),
        ).rejects.toThrow(/lock timeout/);
      } finally {
        barrier.release();
        await write;
        await competing.destroy();
      }
      expect(
        await db
          .selectFrom('connect_receipt')
          .select('requestId')
          .where('grantId', '=', f.grant.id)
          .where('operation', '=', 'upload-commit')
          .execute(),
      ).toHaveLength(1);
    },
  );

  it.each(['membership', 'owner', 'ancestor'] as const)(
    'retains duplicate source %s authority through the receipt',
    async (change) => {
      const f = await fixture();
      const { album: parent } = await f.ctx.newAlbum({ ownerId: f.user.id });
      const { album: source } = await f.ctx.newAlbum({ ownerId: f.user.id, parentId: parent.id });
      const policy = { ...f.grant.accessPolicy!, readAlbumIds: [source.id] };
      await db.updateTable('oauth_grant').set({ accessPolicy: policy }).where('id', '=', f.grant.id).execute();
      const { asset } = await f.ctx.newAsset({
        ownerId: f.user.id,
        checksum: Buffer.from(f.dto.sha256, 'hex'),
        libraryScope: LibraryScope.Design,
      });
      await db.insertInto('album_asset').values({ albumId: source.id, assetId: asset.id }).execute();
      const id = await stage(f);
      const competing = await connectCompetitor(db);
      const barrier = publicationBarrier();
      const requireResult = f.repo.requireResult.bind(f.repo);
      vi.spyOn(f.repo, 'requireResult').mockImplementation(async (...args) => {
        const result = await requireResult(...args);
        await barrier.hold();
        return result;
      });
      const write = commit(f, id);
      await Promise.race([barrier.ready, write]);
      try {
        await expect(
          competing.transaction().execute(async (tx) => {
            await sql`set local lock_timeout = '300ms'`.execute(tx);
            switch (change) {
              case 'membership': {
                await new AlbumRepository(tx).removeAssetIds(source.id, [asset.id]);
                break;
              }
              case 'owner': {
                await tx
                  .updateTable('album_user')
                  .set({ role: AlbumUserRole.Editor })
                  .where('albumId', '=', source.id)
                  .where('userId', '=', f.user.id)
                  .execute();
                break;
              }
              case 'ancestor': {
                await tx.updateTable('album').set({ isLocked: true }).where('id', '=', parent.id).execute();
                break;
              }
              // No default
            }
          }),
        ).rejects.toThrow(/lock timeout/);
      } finally {
        barrier.release();
        expect(await write).toMatchObject({ assetId: asset.id, status: 'duplicate' });
        await competing.destroy();
      }
    },
  );

  it('cleans expired tickets in bounded batches without deleting live tickets or receipt tombstones', async () => {
    const f = await fixture();
    const id = await stage(f);
    const receipt = await commit(f, id);
    const now = new Date();
    const expired = [randomBytes(32), randomBytes(32), randomBytes(32)];
    const live = randomBytes(32);
    await db
      .insertInto('connect_rendition_ticket')
      .values([
        ...expired.map((tokenHash) => ({
          tokenHash,
          assetId: receipt.assetId,
          grantId: f.grant.id,
          variant: 'preview' as const,
          expiresAt: new Date(now.getTime() - 1000),
        })),
        {
          tokenHash: live,
          assetId: receipt.assetId,
          grantId: f.grant.id,
          variant: 'preview',
          expiresAt: new Date(now.getTime() + 60_000),
        },
      ])
      .execute();
    await db
      .updateTable('connect_receipt')
      .set({ expiresAt: new Date(now.getTime() - 1000) })
      .where('grantId', '=', f.grant.id)
      .execute();
    const competing = await connectCompetitor(db);
    const barrier = publicationBarrier();
    const locked = competing.transaction().execute(async (tx) => {
      await tx
        .selectFrom('connect_rendition_ticket')
        .select('tokenHash')
        .where('tokenHash', '=', expired[0])
        .forUpdate()
        .execute();
      await barrier.hold();
    });
    await Promise.race([barrier.ready, locked]);
    try {
      expect(await f.repo.deleteExpiredTickets(now, 1)).toBe(1);
      expect(await f.repo.deleteExpiredTickets(now, 10)).toBe(1);
      expect(await f.repo.deleteExpiredTickets(now, 10)).toBe(0);
    } finally {
      barrier.release();
      await locked;
      await competing.destroy();
    }
    expect(await f.repo.deleteExpiredTickets(now, 10)).toBe(1);
    expect(
      (
        await db.selectFrom('connect_rendition_ticket').select('tokenHash').where('grantId', '=', f.grant.id).execute()
      ).map(({ tokenHash }) => tokenHash),
    ).toEqual([live]);
    expect(
      await db.selectFrom('connect_receipt').select('id').where('grantId', '=', f.grant.id).execute(),
    ).toHaveLength(2);
    expect(await commit(f, id)).toMatchObject({ assetId: receipt.assetId });
  });

  it('accepts an already authorized duplicate without changing its original or charging quota', async () => {
    const f = await fixture();
    const { asset } = await f.ctx.newAsset({
      ownerId: f.user.id,
      checksum: Buffer.from(f.dto.sha256, 'hex'),
      libraryScope: LibraryScope.Design,
    });
    await db.insertInto('album_asset').values({ albumId: f.album.id, assetId: asset.id }).execute();
    const id = await stage(f);
    const receipt = await commit(f, id);
    expect(receipt).toEqual({ assetId: asset.id, status: 'duplicate', sha256: f.dto.sha256 });
    expect(
      (await db.selectFrom('asset').select('originalPath').where('id', '=', asset.id).executeTakeFirstOrThrow())
        .originalPath,
    ).toBe(asset.originalPath);
    expect(
      (await db.selectFrom('user').select('quotaUsageInBytes').where('id', '=', f.user.id).executeTakeFirstOrThrow())
        .quotaUsageInBytes,
    ).toBe(f.user.quotaUsageInBytes);
  });
});
