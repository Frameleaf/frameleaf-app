import request from 'supertest';
import { AlbumCleanupController } from 'src/controllers/album-cleanup.controller.js';
import { AlbumCleanupService } from 'src/services/album-cleanup.service.js';
import { newUuid } from 'test/small.factory.js';
import { ControllerContext, controllerSetup, mockBaseService } from 'test/utils.js';

describe(AlbumCleanupController.name, () => {
  let ctx: ControllerContext;
  const service = mockBaseService(AlbumCleanupService);

  beforeAll(async () => {
    ctx = await controllerSetup(AlbumCleanupController, [{ provide: AlbumCleanupService, useValue: service }]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    ctx.reset();
  });

  it('requires authentication', async () => {
    await request(ctx.getHttpServer()).get('/albums/cleanup/snapshot');
    expect(ctx.authenticate).toHaveBeenCalled();
  });

  describe('POST /albums/cleanup/check', () => {
    it('starts a new scan', async () => {
      const { status } = await request(ctx.getHttpServer()).post('/albums/cleanup/check');
      expect(status).toBe(204);
      expect(service.check).toHaveBeenCalledOnce();
    });
  });

  describe('POST /albums/cleanup/apply', () => {
    it('refuses an empty list and unknown operations', async () => {
      const empty = await request(ctx.getHttpServer()).post('/albums/cleanup/apply').send({ operations: [] });
      expect(empty.status).toBe(400);
      const unknown = await request(ctx.getHttpServer())
        .post('/albums/cleanup/apply')
        .send({ operations: [{ type: 'shred', albumId: newUuid() }] });
      expect(unknown.status).toBe(400);
      expect(service.apply).not.toHaveBeenCalled();
    });

    it('passes the operations through', async () => {
      const operation = { type: 'rename', albumId: newUuid(), name: 'Patrick' };
      service.apply.mockResolvedValue({ runId: '0194d6a5-7a6e-7c2a-9cb4-0a1c2d3e4f50' });
      const { status, body } = await request(ctx.getHttpServer())
        .post('/albums/cleanup/apply')
        .send({ operations: [operation] });
      expect(status).toBe(200);
      expect(body.runId).toBe('0194d6a5-7a6e-7c2a-9cb4-0a1c2d3e4f50');
      expect(service.apply.mock.calls[0][1]).toEqual({ operations: [operation] });
    });
  });
});
