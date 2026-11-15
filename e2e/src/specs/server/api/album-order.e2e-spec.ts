import {
  AlbumResponseDto,
  AlbumUserRole,
  AssetMediaResponseDto,
  LoginResponseDto,
  SharedLinkType,
} from '@frameleaf/sdk';
import { createUserDto } from 'src/fixtures.js';
import { app, asBearerAuth, utils } from 'src/utils.js';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

/** FL-869 custom order and FL-881 text cards: who may arrange an album, and that everyone sees the result. */
describe('/albums/:id custom order and text cards', () => {
  let owner: LoginResponseDto;
  let viewer: LoginResponseDto;
  let editor: LoginResponseDto;
  let assets: AssetMediaResponseDto[];
  let album: AlbumResponseDto;
  let linkKey: string;

  beforeAll(async () => {
    await utils.resetDatabase();
    const admin = await utils.adminSetup();
    [owner, viewer, editor] = await Promise.all([
      utils.userSetup(admin.accessToken, createUserDto.user1),
      utils.userSetup(admin.accessToken, createUserDto.user2),
      utils.userSetup(admin.accessToken, createUserDto.user3),
    ]);
    assets = await Promise.all([
      utils.createAsset(owner.accessToken, { fileCreatedAt: '2026-01-01T00:00:00.000Z' }),
      utils.createAsset(owner.accessToken, { fileCreatedAt: '2026-01-02T00:00:00.000Z' }),
      utils.createAsset(owner.accessToken, { fileCreatedAt: '2026-01-03T00:00:00.000Z' }),
    ]);
    album = await utils.createAlbum(owner.accessToken, {
      albumName: 'Trip',
      assetIds: assets.map(({ id }) => id),
      albumUsers: [
        { userId: viewer.userId, role: AlbumUserRole.Viewer },
        { userId: editor.userId, role: AlbumUserRole.Editor },
      ],
    });
    const link = await utils.createSharedLink(owner.accessToken, {
      type: SharedLinkType.Album,
      albumId: album.id,
      allowUpload: true,
    });
    linkKey = link.key;
  });

  const orderedIds = async (query: string, auth?: string) => {
    const call = request(app).get(`/timeline/ordered?sort=custom&albumId=${album.id}${query}`);
    const { status, body } = await (auth ? call.set(asBearerAuth(auth)) : call);
    expect(status).toBe(200);
    return JSON.parse(typeof body === 'string' ? body : JSON.stringify(body)).id as string[];
  };

  it('lets an editor move a photo and turns custom order on', async () => {
    const { status } = await request(app)
      .put(`/albums/${album.id}/assets/order`)
      .set(asBearerAuth(editor.accessToken))
      .send({ assetIds: [assets[2].id], afterAssetId: null });
    expect(status).toBe(204);

    const { body } = await request(app).get(`/albums/${album.id}`).set(asBearerAuth(owner.accessToken));
    expect(body.isCustomOrder).toBe(true);
  });

  it('refuses a viewer and a shared link, even one that may upload', async () => {
    const asViewer = await request(app)
      .put(`/albums/${album.id}/assets/order`)
      .set(asBearerAuth(viewer.accessToken))
      .send({ assetIds: [assets[0].id], afterAssetId: null });
    expect(asViewer.status).toBe(400);

    const asLink = await request(app)
      .post(`/albums/${album.id}/text-cards?key=${linkKey}`)
      .send({ heading: 'Hello', body: '' });
    expect(asLink.status).toBe(403);
  });

  it('shows the same order to the owner, a viewer and a shared link', async () => {
    const forOwner = await orderedIds('', owner.accessToken);
    expect(forOwner[0]).toBe(assets[2].id);
    expect(await orderedIds('', viewer.accessToken)).toEqual(forOwner);
    expect(await orderedIds(`&key=${linkKey}`)).toEqual(forOwner);
  });

  it('keeps a card as plain text and shows it to a shared link', async () => {
    const created = await request(app)
      .post(`/albums/${album.id}/text-cards`)
      .set(asBearerAuth(owner.accessToken))
      .send({ heading: '<script>alert(1)</script>', body: 'Day one', afterAssetId: assets[2].id });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ heading: '<script>alert(1)</script>', afterAssetId: assets[2].id });

    const { status, body } = await request(app).get(`/albums/${album.id}/text-cards?key=${linkKey}`);
    expect(status).toBe(200);
    expect(body).toEqual([expect.objectContaining({ id: created.body.id, body: 'Day one' })]);

    const deleted = await request(app)
      .delete(`/albums/${album.id}/text-cards/${created.body.id}`)
      .set(asBearerAuth(editor.accessToken));
    expect(deleted.status).toBe(204);
    expect(await orderedIds('', owner.accessToken)).toHaveLength(3);
  });
});
