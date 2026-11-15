import request from 'supertest';
import { AlbumActionsController } from 'src/controllers/album-actions.controller.js';
import { AlbumActionsService } from 'src/services/album-actions.service.js';
import { newUuid } from 'test/small.factory.js';
import { ControllerContext, controllerSetup, mockBaseService } from 'test/utils.js';

describe(AlbumActionsController.name, () => {
  let ctx: ControllerContext;
  const service = mockBaseService(AlbumActionsService);

  beforeAll(async () => {
    ctx = await controllerSetup(AlbumActionsController, [{ provide: AlbumActionsService, useValue: service }]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    ctx.reset();
  });

  describe('POST /albums/:id/assets/move', () => {
    it('requires authentication', async () => {
      await request(ctx.getHttpServer()).post(`/albums/${newUuid()}/assets/move`);
      expect(ctx.authenticate).toHaveBeenCalled();
    });

    it('requires a target album and at least one asset', async () => {
      const id = newUuid();
      for (const body of [
        {},
        { targetAlbumId: newUuid(), assetIds: [] },
        { targetAlbumId: 'nope', assetIds: [newUuid()] },
      ]) {
        const { status } = await request(ctx.getHttpServer()).post(`/albums/${id}/assets/move`).send(body);
        expect(status).toBe(400);
      }
      expect(service.moveAssets).not.toHaveBeenCalled();
    });

    it('answers 200 with a result per asset', async () => {
      const [id, targetAlbumId, assetId] = [newUuid(), newUuid(), newUuid()];
      service.moveAssets.mockResolvedValue([{ id: assetId, success: true }]);

      const { status, body } = await request(ctx.getHttpServer())
        .post(`/albums/${id}/assets/move`)
        .send({ targetAlbumId, assetIds: [assetId] });

      expect(status).toBe(200);
      expect(body).toEqual([{ id: assetId, success: true }]);
      expect(service.moveAssets).toHaveBeenCalledWith(undefined, id, { targetAlbumId, assetIds: [assetId] });
    });
  });

  describe('POST /albums/:id/transfer', () => {
    it('requires a user id', async () => {
      const { status } = await request(ctx.getHttpServer()).post(`/albums/${newUuid()}/transfer`).send({});
      expect(status).toBe(400);
      expect(service.transfer).not.toHaveBeenCalled();
    });

    it('answers 204', async () => {
      const [id, userId] = [newUuid(), newUuid()];

      const { status } = await request(ctx.getHttpServer()).post(`/albums/${id}/transfer`).send({ userId });

      expect(status).toBe(204);
      expect(service.transfer).toHaveBeenCalledWith(undefined, id, { userId });
    });
  });
});
