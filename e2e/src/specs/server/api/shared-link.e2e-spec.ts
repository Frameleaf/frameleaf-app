import {
  AlbumResponseDto,
  AssetMediaResponseDto,
  LoginResponseDto,
  SharedLinkResponseDto,
  SharedLinkType,
  createAlbum,
  deleteUserAdmin,
} from '@immich/sdk';
import { createUserDto, uuidDto } from 'src/fixtures.js';
import { makeRandomImage } from 'src/generators.js';
import { errorDto } from 'src/responses.js';
import { app, asBearerAuth, baseUrl, shareUrl, utils } from 'src/utils.js';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

const uploadWithKey = (key: string) =>
  request(app)
    .post('/assets')
    .query({ key })
    .attach('assetData', makeRandomImage(), 'guest.png')
    .field('fileCreatedAt', new Date().toISOString())
    .field('fileModifiedAt', new Date().toISOString());

describe('/shared-links', () => {
  let admin: LoginResponseDto;
  let asset1: AssetMediaResponseDto;
  let asset2: AssetMediaResponseDto;
  let user1: LoginResponseDto;
  let user2: LoginResponseDto;
  let album: AlbumResponseDto;
  let deletedAlbum: AlbumResponseDto;
  let linkWithDeletedAlbum: SharedLinkResponseDto;
  let linkWithPassword: SharedLinkResponseDto;
  let linkWithAlbum: SharedLinkResponseDto;
  let linkWithAssets: SharedLinkResponseDto;
  let linkWithMetadata: SharedLinkResponseDto;
  let linkWithoutMetadata: SharedLinkResponseDto;

  beforeAll(async () => {
    await utils.resetDatabase();

    admin = await utils.adminSetup();

    [user1, user2] = await Promise.all([
      utils.userSetup(admin.accessToken, createUserDto.user1),
      utils.userSetup(admin.accessToken, createUserDto.user2),
    ]);

    [asset1, asset2] = await Promise.all([utils.createAsset(user1.accessToken), utils.createAsset(user1.accessToken)]);

    [album, deletedAlbum] = await Promise.all([
      createAlbum({ createAlbumDto: { albumName: 'album' } }, { headers: asBearerAuth(user1.accessToken) }),
      createAlbum({ createAlbumDto: { albumName: 'deleted album' } }, { headers: asBearerAuth(user2.accessToken) }),
    ]);

    [linkWithDeletedAlbum, linkWithAlbum, linkWithAssets, linkWithPassword, linkWithMetadata, linkWithoutMetadata] =
      await Promise.all([
        utils.createSharedLink(user2.accessToken, {
          type: SharedLinkType.Album,
          albumId: deletedAlbum.id,
        }),
        utils.createSharedLink(user1.accessToken, {
          type: SharedLinkType.Album,
          albumId: album.id,
        }),
        utils.createSharedLink(user1.accessToken, {
          type: SharedLinkType.Individual,
          assetIds: [asset1.id],
        }),
        utils.createSharedLink(user1.accessToken, {
          type: SharedLinkType.Album,
          albumId: album.id,
          password: 'foo',
        }),
        utils.createSharedLink(user1.accessToken, {
          type: SharedLinkType.Individual,
          assetIds: [asset1.id],
          showMetadata: true,
          slug: 'metadata-slug',
        }),
        utils.createSharedLink(user1.accessToken, {
          type: SharedLinkType.Individual,
          assetIds: [asset1.id],
          showMetadata: false,
        }),
      ]);

    await deleteUserAdmin({ id: user2.userId, userAdminDeleteDto: {} }, { headers: asBearerAuth(admin.accessToken) });
  });

  describe('GET /share/:key', () => {
    it('should have correct asset count in meta tag for non-empty album', async () => {
      const resp = await request(shareUrl).get(`/${linkWithMetadata.key}`);
      expect(resp.status).toBe(200);
      expect(resp.header['content-type']).toContain('text/html');
      expect(resp.text).toContain(`<meta name="description" content="1 shared photos &amp; videos" />`);
    });

    it('should have correct asset count in meta tag for empty album', async () => {
      const resp = await request(shareUrl).get(`/${linkWithAlbum.key}`);
      expect(resp.status).toBe(200);
      expect(resp.header['content-type']).toContain('text/html');
      expect(resp.text).toContain(`<meta name="description" content="0 shared photos &amp; videos" />`);
    });

    it('should have correct asset count in meta tag for shared asset', async () => {
      const resp = await request(shareUrl).get(`/${linkWithAssets.key}`);
      expect(resp.status).toBe(200);
      expect(resp.header['content-type']).toContain('text/html');
      expect(resp.text).toContain(`<meta name="description" content="1 shared photos &amp; videos" />`);
    });

    it('should have fqdn og:image meta tag for shared asset', async () => {
      const resp = await request(shareUrl).get(`/${linkWithAssets.key}`);
      expect(resp.status).toBe(200);
      expect(resp.header['content-type']).toContain('text/html');
      expect(resp.text).toContain(`<meta property="og:image" content="http://127.0.0.1:2285`);
    });

    it('should leave out the og:image meta tag if Host header is not present (FL-190)', async () => {
      const resp = await request(shareUrl).get(`/${linkWithAssets.key}`).set('Host', '');
      expect(resp.status).toBe(200);
      expect(resp.header['content-type']).toContain('text/html');
      expect(resp.text).not.toContain('og:image');
      expect(resp.text).not.toContain('immich.app');
    });

    it('should return 404 for an invalid shared link', async () => {
      const resp = await request(shareUrl).get(`/invalid-key`);
      expect(resp.status).toBe(404);
      expect(resp.header['content-type']).toContain('text/html');
      expect(resp.text).not.toContain(`og:type`);
      expect(resp.text).not.toContain(`og:title`);
      expect(resp.text).not.toContain(`og:description`);
      expect(resp.text).not.toContain(`og:image`);
    });
  });

  describe('GET /s/:slug', () => {
    it('should work for slug auth', async () => {
      const resp = await request(baseUrl).get(`/s/${linkWithMetadata.slug}`);
      expect(resp.status).toBe(200);
      expect(resp.header['content-type']).toContain('text/html');
      expect(resp.text).toContain(`<meta name="description" content="1 shared photos &amp; videos" />`);
    });
  });

  describe('GET /shared-links', () => {
    it('should get all shared links created by user', async () => {
      const { status, body } = await request(app)
        .get('/shared-links')
        .set('Authorization', `Bearer ${user1.accessToken}`);

      expect(status).toBe(200);
      expect(body).toHaveLength(5);
      expect(body).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: linkWithAlbum.id }),
          expect.objectContaining({
            id: linkWithAssets.id,
            assets: expect.arrayContaining([expect.objectContaining({ id: asset1.id })]),
          }),
          expect.objectContaining({ id: linkWithPassword.id }),
          expect.objectContaining({ id: linkWithMetadata.id }),
          expect.objectContaining({ id: linkWithoutMetadata.id }),
        ]),
      );
    });

    it('should filter on albumId', async () => {
      const { status, body } = await request(app)
        .get(`/shared-links?albumId=${album.id}`)
        .set('Authorization', `Bearer ${user1.accessToken}`);

      expect(status).toBe(200);
      expect(body).toHaveLength(2);
      expect(body).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: linkWithAlbum.id }),
          expect.objectContaining({ id: linkWithPassword.id }),
        ]),
      );
    });

    it('should find 0 albums', async () => {
      const { status, body } = await request(app)
        .get(`/shared-links?albumId=${uuidDto.notFound}`)
        .set('Authorization', `Bearer ${user1.accessToken}`);

      expect(status).toBe(200);
      expect(body).toHaveLength(0);
    });

    it('should not get shared links created by other users', async () => {
      const { status, body } = await request(app)
        .get('/shared-links')
        .set('Authorization', `Bearer ${admin.accessToken}`);

      expect(status).toBe(200);
      expect(body).toEqual([]);
    });
  });

  describe('GET /shared-links/me', () => {
    it('should get data for correct shared link', async () => {
      const { status, body } = await request(app).get('/shared-links/me').query({ key: linkWithAlbum.key });

      expect(status).toBe(200);
      expect(body).toEqual(
        expect.objectContaining({
          album: expect.objectContaining({ id: album.id }),
          userId: user1.userId,
          type: SharedLinkType.Album,
        }),
      );
    });

    it('should return unauthorized for incorrect shared link', async () => {
      const { status, body } = await request(app)
        .get('/shared-links/me')
        .query({ key: linkWithAlbum.key + 'foo' });

      expect(status).toBe(401);
      expect(body).toEqual({ message: 'Invalid share key' });
    });

    it('says an expired link expired, with the same message and nothing about the link', async () => {
      const expired = await utils.createSharedLink(user1.accessToken, {
        type: SharedLinkType.Album,
        albumId: album.id,
      });
      const client = await utils.connectDatabase();
      await client.query(`UPDATE shared_link SET "expiresAt" = now() - interval '1 day' WHERE id = $1`, [expired.id]);

      const { status, body } = await request(app).get('/shared-links/me').query({ key: expired.key });

      expect(status).toBe(401);
      expect(body).toEqual({ message: 'Invalid share key', reason: 'expired' });
    });

    it('should return unauthorized if target has been soft deleted', async () => {
      const { status, body } = await request(app).get('/shared-links/me').query({ key: linkWithDeletedAlbum.key });

      expect(status).toBe(401);
      expect(body).toEqual({ message: 'Invalid share key' });
    });

    it('should return unauthorized for password protected link', async () => {
      const { status, body } = await request(app).get('/shared-links/me').query({ key: linkWithPassword.key });

      expect(status).toBe(401);
      expect(body).toEqual({ message: 'Password required' });
    });

    it('should get data for correct password protected link', async () => {
      const response = await request(app)
        .post('/shared-links/login')
        .send({ password: 'foo' })
        .query({ key: linkWithPassword.key });

      expect(response.status).toBe(201);

      const cookies = response.get('Set-Cookie') ?? [];
      expect(cookies).toHaveLength(1);
      expect(cookies[0]).toContain('immich_shared_link_token');

      const { status, body } = await request(app)
        .get('/shared-links/me')
        .query({ key: linkWithPassword.key })
        .set('Cookie', cookies);

      expect(status).toBe(200);
      expect(body).toEqual(
        expect.objectContaining({
          album: expect.objectContaining({ id: album.id }),
          userId: user1.userId,
          type: SharedLinkType.Album,
        }),
      );
    });

    it('should return metadata for individual shared link', async () => {
      const { status, body } = await request(app).get('/shared-links/me').query({ key: linkWithMetadata.key });

      expect(status).toBe(200);
      expect(body.assets).toHaveLength(1);
      expect(body.album).not.toBeDefined();
    });

    it('should not return metadata for album shared link without metadata', async () => {
      const { status, body } = await request(app).get('/shared-links/me').query({ key: linkWithoutMetadata.key });

      expect(status).toBe(200);
      expect(body.assets).toHaveLength(1);
      expect(body.album).not.toBeDefined();

      const asset = body.assets[0];
      expect(asset).not.toHaveProperty('exifInfo');
      expect(asset).not.toHaveProperty('fileCreatedAt');
      expect(asset).not.toHaveProperty('originalFilename');
      expect(asset).not.toHaveProperty('originalPath');
    });
  });

  describe('GET /shared-links/:id', () => {
    it('should get shared link by id', async () => {
      const { status, body } = await request(app)
        .get(`/shared-links/${linkWithAlbum.id}`)
        .set('Authorization', `Bearer ${user1.accessToken}`);

      expect(status).toBe(200);
      expect(body).toEqual(
        expect.objectContaining({
          album: expect.objectContaining({ id: album.id }),
          userId: user1.userId,
          type: SharedLinkType.Album,
        }),
      );
    });

    it('should not get shared link by id if user has not created the link or it does not exist', async () => {
      const { status, body } = await request(app)
        .get(`/shared-links/${linkWithAlbum.id}`)
        .set('Authorization', `Bearer ${admin.accessToken}`);

      expect(status).toBe(400);
      expect(body).toEqual(expect.objectContaining({ message: 'Shared link not found' }));
    });
  });

  describe('POST /shared-links', () => {
    it('should require a valid asset id', async () => {
      const { status, body } = await request(app)
        .post('/shared-links')
        .set('Authorization', `Bearer ${user1.accessToken}`)
        .send({ type: SharedLinkType.Individual, assetIds: [uuidDto.notFound] });

      expect(status).toBe(400);
      expect(body).toEqual(expect.objectContaining({ message: 'Not found or no asset.share access' }));
    });

    it('should create a shared link', async () => {
      const { status, body } = await request(app)
        .post('/shared-links')
        .set('Authorization', `Bearer ${user1.accessToken}`)
        .send({ type: SharedLinkType.Album, albumId: album.id });

      expect(status).toBe(201);
      expect(body).toEqual(
        expect.objectContaining({
          type: SharedLinkType.Album,
          userId: user1.userId,
        }),
      );
    });

    it('should create an album shared link when the client sends an empty assetIds array', async () => {
      const { status, body } = await request(app)
        .post('/shared-links')
        .set('Authorization', `Bearer ${user1.accessToken}`)
        .send({ type: SharedLinkType.Album, albumId: album.id, assetIds: [] });

      expect(status).toBe(201);
      expect(body).toEqual(expect.objectContaining({ type: SharedLinkType.Album, userId: user1.userId }));
    });
  });

  describe('PATCH /shared-links/:id', () => {
    it('should fail if invalid link', async () => {
      const { status, body } = await request(app)
        .patch(`/shared-links/${uuidDto.notFound}`)
        .set('Authorization', `Bearer ${user1.accessToken}`)
        .send({ description: 'foo' });

      expect(status).toBe(400);
      expect(body).toEqual(errorDto.badRequest());
    });

    it('should update shared link', async () => {
      const { status, body } = await request(app)
        .patch(`/shared-links/${linkWithAlbum.id}`)
        .set('Authorization', `Bearer ${user1.accessToken}`)
        .send({ description: 'foo' });

      expect(status).toBe(200);
      expect(body).toEqual(
        expect.objectContaining({
          type: SharedLinkType.Album,
          userId: user1.userId,
          description: 'foo',
        }),
      );
    });
  });

  describe('PUT /shared-links/:id/assets', () => {
    it('should not add assets to shared link (album)', async () => {
      const { status, body } = await request(app)
        .put(`/shared-links/${linkWithAlbum.id}/assets`)
        .set('Authorization', `Bearer ${user1.accessToken}`)
        .send({ assetIds: [asset2.id] });

      expect(status).toBe(400);
      expect(body).toEqual(errorDto.badRequest('Invalid shared link type'));
    });

    it('should add an assets to a shared link (individual)', async () => {
      const { status, body } = await request(app)
        .put(`/shared-links/${linkWithAssets.id}/assets`)
        .set('Authorization', `Bearer ${user1.accessToken}`)
        .send({ assetIds: [asset2.id] });

      expect(body).toEqual([{ assetId: asset2.id, success: true }]);
      expect(status).toBe(200);
    });
  });

  describe('DELETE /shared-links/:id/assets', () => {
    it('should not remove assets from a shared link (album)', async () => {
      const { status, body } = await request(app)
        .delete(`/shared-links/${linkWithAlbum.id}/assets`)
        .set('Authorization', `Bearer ${user1.accessToken}`)
        .send({ assetIds: [asset2.id] });

      expect(status).toBe(400);
      expect(body).toEqual(errorDto.badRequest('Invalid shared link type'));
    });

    it('should remove assets from a shared link (individual)', async () => {
      const { status, body } = await request(app)
        .delete(`/shared-links/${linkWithAssets.id}/assets`)
        .set('Authorization', `Bearer ${user1.accessToken}`)
        .send({ assetIds: [asset2.id] });

      expect(body).toEqual([{ assetId: asset2.id, success: true }]);
      expect(status).toBe(200);
    });
  });

  // FL-56: what a link allows is enforced on the server, whatever a client offers.
  describe('link permissions', () => {
    let owned: AssetMediaResponseDto;
    let outside: AssetMediaResponseDto;
    let shared: AlbumResponseDto;
    let other: AlbumResponseDto;
    let noDownload: SharedLinkResponseDto;
    let noUpload: SharedLinkResponseDto;
    let withUpload: SharedLinkResponseDto;

    beforeAll(async () => {
      [owned, outside] = await Promise.all([
        utils.createAsset(user1.accessToken),
        utils.createAsset(user1.accessToken),
      ]);
      [shared, other] = await Promise.all([
        createAlbum(
          { createAlbumDto: { albumName: 'guest album', assetIds: [owned.id] } },
          { headers: asBearerAuth(user1.accessToken) },
        ),
        createAlbum(
          { createAlbumDto: { albumName: 'private album', assetIds: [outside.id] } },
          { headers: asBearerAuth(user1.accessToken) },
        ),
      ]);
      [noDownload, noUpload, withUpload] = await Promise.all([
        utils.createSharedLink(user1.accessToken, {
          type: SharedLinkType.Album,
          albumId: shared.id,
          allowDownload: false,
          allowUpload: false,
        }),
        utils.createSharedLink(user1.accessToken, {
          type: SharedLinkType.Album,
          albumId: shared.id,
          allowDownload: true,
          allowUpload: false,
        }),
        utils.createSharedLink(user1.accessToken, {
          type: SharedLinkType.Album,
          albumId: shared.id,
          allowDownload: true,
          allowUpload: true,
        }),
      ]);
    });

    describe('allowDownload=false', () => {
      it('refuses the original of a shared item', async () => {
        // File routes answer every refusal, access included, with 404 (sendFile in utils/file.ts);
        // the access check itself is proven in the shared-link medium spec.
        const { status } = await request(app).get(`/assets/${owned.id}/original`).query({ key: noDownload.key });
        expect(status).toBe(404);
      });

      it('refuses an archive of the album or of its items', async () => {
        const info = await request(app)
          .post('/download/info')
          .query({ key: noDownload.key })
          .send({ albumId: shared.id });
        expect(info.status).toBe(400);

        const archive = await request(app)
          .post('/download/archive')
          .query({ key: noDownload.key })
          .send({ assetIds: [owned.id] });
        expect(archive.status).toBe(400);
      });

      it('still shows the shared item', async () => {
        const { status } = await request(app).get(`/assets/${owned.id}/thumbnail`).query({ key: noDownload.key });
        expect(status).toBe(200);
      });
    });

    it('lets a link that allows download take the original of a shared item only', async () => {
      const shareItem = await request(app).get(`/assets/${owned.id}/original`).query({ key: noUpload.key });
      expect(shareItem.status).toBe(200);

      const outsideItem = await request(app).get(`/assets/${outside.id}/original`).query({ key: noUpload.key });
      expect(outsideItem.status).toBe(404);
    });

    it('refuses an upload through a link that does not allow one', async () => {
      // The upload interceptor refuses before any byte is stored (requireUploadAccess).
      const { status } = await uploadWithKey(noUpload.key);
      expect(status).toBe(401);
    });

    describe('allowUpload=true', () => {
      it('adds the upload to the shared album and nowhere else', async () => {
        const { status, body } = await uploadWithKey(withUpload.key);
        expect(status).toBe(201);
        expect(body).toEqual(expect.objectContaining({ id: expect.any(String), status: 'created' }));

        // The link reads only what its album holds, so reading the upload through it proves where it went.
        const throughLink = await request(app).get(`/assets/${body.id}`).query({ key: withUpload.key });
        expect(throughLink.status).toBe(200);

        const album = await request(app)
          .get(`/albums/${shared.id}`)
          .set('Authorization', `Bearer ${user1.accessToken}`);
        expect(album.body.assetCount).toBe(2);
        const elsewhere = await request(app)
          .get(`/albums/${other.id}`)
          .set('Authorization', `Bearer ${user1.accessToken}`);
        expect(elsewhere.body.assetCount).toBe(1);
      });

      it('cannot reach or add to any other album', async () => {
        const read = await request(app).get(`/albums/${other.id}`).query({ key: withUpload.key });
        expect(read.status).toBe(400);

        // Adding to an album is not a shared-link route at all.
        const add = await request(app)
          .put(`/albums/${other.id}/assets`)
          .query({ key: withUpload.key })
          .send({ ids: [owned.id] });
        expect(add.status).toBe(403);

        const outsideItem = await request(app).get(`/assets/${outside.id}`).query({ key: withUpload.key });
        expect(outsideItem.status).toBe(400);
      });
    });

    it('refuses everything once the link is revoked', async () => {
      const revoked = await utils.createSharedLink(user1.accessToken, {
        type: SharedLinkType.Album,
        albumId: shared.id,
        allowDownload: true,
        allowUpload: true,
      });
      await request(app)
        .delete(`/shared-links/${revoked.id}`)
        .set('Authorization', `Bearer ${user1.accessToken}`)
        .expect(204);

      const me = await request(app).get('/shared-links/me').query({ key: revoked.key });
      expect(me.status).toBe(401);
      const original = await request(app).get(`/assets/${owned.id}/original`).query({ key: revoked.key });
      expect(original.status).toBe(401);
      const upload = await uploadWithKey(revoked.key);
      expect(upload.status).toBe(401);
    });
  });

  describe('DELETE /shared-links/:id', () => {
    it('should fail if invalid link', async () => {
      const { status, body } = await request(app)
        .delete(`/shared-links/${uuidDto.notFound}`)
        .set('Authorization', `Bearer ${user1.accessToken}`);

      expect(status).toBe(400);
      expect(body).toEqual(errorDto.badRequest());
    });

    it('should delete a shared link', async () => {
      const { status } = await request(app)
        .delete(`/shared-links/${linkWithAlbum.id}`)
        .set('Authorization', `Bearer ${user1.accessToken}`);

      expect(status).toBe(204);
    });
  });
});
