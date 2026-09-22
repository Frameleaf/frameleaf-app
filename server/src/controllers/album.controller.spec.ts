import request from 'supertest';
import { AlbumController } from 'src/controllers/album.controller.js';
import { AlbumService } from 'src/services/album.service.js';
import { factory } from 'test/small.factory.js';
import { ControllerContext, controllerSetup, mockBaseService } from 'test/utils.js';

describe(AlbumController.name, () => {
  let ctx: ControllerContext;
  const service = mockBaseService(AlbumService);

  beforeAll(async () => {
    ctx = await controllerSetup(AlbumController, [{ provide: AlbumService, useValue: service }]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    ctx.reset();
  });

  describe('GET /albums', () => {
    it('should reject an invalid shared param', async () => {
      const { status, body } = await request(ctx.getHttpServer()).get('/albums?isShared=invalid');
      expect(status).toEqual(400);
      expect(body).toEqual(
        factory.responses.validationError([
          { path: ['isShared'], message: 'Invalid option: expected one of "true"|"false"' },
        ]),
      );
    });

    it('should reject an invalid assetId param', async () => {
      const { status, body } = await request(ctx.getHttpServer()).get('/albums?assetId=invalid');
      expect(status).toEqual(400);
      expect(body).toEqual(factory.responses.validationError([{ path: ['assetId'], message: 'Invalid UUID' }]));
    });
  });

  describe('GET /albums/tree', () => {
    it('should return the album directory for the authenticated user', async () => {
      service.getTree.mockResolvedValue({ collections: [], albums: [], spaces: [] });
      const { status, body } = await request(ctx.getHttpServer()).get('/albums/tree');
      expect(status).toEqual(200);
      expect(body).toEqual({ collections: [], albums: [], spaces: [] });
      expect(service.getTree).toHaveBeenCalledWith(expect.objectContaining({ user: expect.anything() }));
    });
  });

  describe('GET /albums/icons', () => {
    it('should serve the icon catalogue as data', async () => {
      service.getIconCatalogue.mockReturnValue({ version: '7.4.47', names: ['mdiCameraOutline'], suggested: [] });
      const { status, body } = await request(ctx.getHttpServer()).get('/albums/icons');
      expect(status).toEqual(200);
      expect(body).toEqual({ version: '7.4.47', names: ['mdiCameraOutline'], suggested: [] });
    });
  });

  describe('POST /albums', () => {
    it('should reject an icon outside the catalogue', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .post('/albums')
        .send({ albumName: 'Trip', icon: 'mdiNotARealIcon' });
      expect(status).toEqual(400);
      expect(body).toEqual(
        factory.responses.validationError([
          { path: ['icon'], message: 'Invalid album icon: expected a Material Design Icons name' },
        ]),
      );
      expect(service.create).not.toHaveBeenCalled();
    });

    it('should reject an unknown kind', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .post('/albums')
        .send({ albumName: 'Trip', kind: 'subcollection' });
      expect(status).toEqual(400);
      expect(body).toEqual(factory.responses.validationError([{ path: ['kind'], message: expect.any(String) }]));
      expect(service.create).not.toHaveBeenCalled();
    });
  });

  describe('PUT /albums/:id/collection', () => {
    it('should require a valid album id', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .put('/albums/not-a-uuid/collection')
        .send({ collectionId: null });
      expect(status).toEqual(400);
      expect(body).toEqual(factory.responses.validationError([{ path: ['id'], message: 'Invalid UUID' }]));
    });

    it('should require collectionId to be a uuid or null', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .put(`/albums/${factory.uuid()}/collection`)
        .send({ collectionId: 'family' });
      expect(status).toEqual(400);
      expect(body).toEqual(factory.responses.validationError([{ path: ['collectionId'], message: 'Invalid UUID' }]));
      expect(service.moveToCollection).not.toHaveBeenCalled();
    });

    it('should pass a null destination through to take the album out of its collection', async () => {
      const id = factory.uuid();
      service.moveToCollection.mockResolvedValue({ id } as never);
      const { status } = await request(ctx.getHttpServer()).put(`/albums/${id}/collection`).send({ collectionId: null });
      expect(status).toEqual(200);
      expect(service.moveToCollection).toHaveBeenCalledWith(expect.anything(), id, { collectionId: null });
    });
  });
});
