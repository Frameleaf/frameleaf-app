import request from 'supertest';
import { ArchiveOperationController } from 'src/controllers/archive-operation.controller.js';
import { Permission } from 'src/enum.js';
import { ArchiveOperationService } from 'src/services/archive-operation.service.js';
import { ControllerContext, automock, controllerSetup } from 'test/utils.js';

describe(ArchiveOperationController.name, () => {
  let ctx: ControllerContext;
  const service = automock(ArchiveOperationService, { args: [{ setContext: () => {} }], strict: false });
  const requestKey = '6f1c1b0e-8d7a-4c2e-9b1a-0d3e5f7a9b2c';
  const assetId = '0b2c6b8e-1d7a-4c2e-9b1a-0d3e5f7a9b2c';
  const id = '1c2d3e4f-8d7a-4c2e-9b1a-0d3e5f7a9b2c';

  beforeAll(async () => {
    ctx = await controllerSetup(ArchiveOperationController, [{ provide: ArchiveOperationService, useValue: service }]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    ctx.reset();
  });

  const needsAssetUpdate = () =>
    expect(ctx.authenticate).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ permission: Permission.AssetUpdate }) }),
    );

  describe('POST /archive-operations', () => {
    it('needs asset update permission', async () => {
      await request(ctx.getHttpServer())
        .post('/archive-operations')
        .send({ requestKey, assetIds: [assetId] });
      needsAssetUpdate();
    });

    it('refuses an empty selection', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .post('/archive-operations')
        .send({ requestKey, assetIds: [] });
      expect(status).toBe(400);
      expect(body).toEqual(expect.objectContaining({ message: 'Validation failed' }));
      expect(service.create).not.toHaveBeenCalled();
    });
  });

  describe('POST /archive-operations/prepare', () => {
    it('is not matched as an id and only prepares the owner’s Timeline', async () => {
      const { status } = await request(ctx.getHttpServer())
        .post('/archive-operations/prepare')
        .send({ requestKey, scope: 'selected-owned-assets' });
      expect(status).toBe(400);
      expect(service.prepare).not.toHaveBeenCalled();
    });

    it('refuses a filter the server cannot freeze instead of dropping it', async () => {
      const { status } = await request(ctx.getHttpServer())
        .post('/archive-operations/prepare')
        .send({ requestKey, scope: 'matching-owned-timeline', filter: { isFavorite: true } });
      expect(status).toBe(400);
      expect(service.prepare).not.toHaveBeenCalled();
    });
  });

  describe('POST /archive-operations/:id/confirm', () => {
    it('needs asset update permission and a request key', async () => {
      await request(ctx.getHttpServer()).post(`/archive-operations/${id}/confirm`).send({ requestKey });
      needsAssetUpdate();
      expect(service.confirm).toHaveBeenCalledWith(undefined, id, requestKey);
    });
  });

  describe('POST /archive-operations/:id/undo', () => {
    it('needs asset update permission and a request key of its own', async () => {
      const { status } = await request(ctx.getHttpServer()).post(`/archive-operations/${id}/undo`).send({});
      expect(status).toBe(400);
      expect(service.undo).not.toHaveBeenCalled();
    });
  });

  describe('GET /archive-operations', () => {
    it('needs asset update permission', async () => {
      await request(ctx.getHttpServer()).get('/archive-operations');
      needsAssetUpdate();
    });
  });
});
