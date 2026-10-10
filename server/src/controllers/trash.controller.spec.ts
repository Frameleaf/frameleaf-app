import request from 'supertest';
import { TrashController } from 'src/controllers/trash.controller.js';
import { TrashService } from 'src/services/trash.service.js';
import { factory } from 'test/small.factory.js';
import { ControllerContext, controllerSetup, mockBaseService } from 'test/utils.js';

describe(TrashController.name, () => {
  let ctx: ControllerContext;
  const service = mockBaseService(TrashService);

  beforeAll(async () => {
    ctx = await controllerSetup(TrashController, [{ provide: TrashService, useValue: service }]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    ctx.reset();
  });

  describe('POST /trash/restore/assets', () => {
    it('should require asset ids', async () => {
      const { status, body } = await request(ctx.getHttpServer()).post('/trash/restore/assets').send({});

      expect(status).toBe(400);
      expect(body).toEqual(
        factory.responses.validationError([
          { path: ['ids'], message: 'Invalid input: expected array, received undefined' },
        ]),
      );
      expect(service.restoreAssets).not.toHaveBeenCalled();
    });

    it('should require valid asset ids', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .post('/trash/restore/assets')
        .send({ ids: ['invalid'] });

      expect(status).toBe(400);
      expect(body).toEqual(factory.responses.validationError([{ path: ['ids', 0], message: 'Invalid UUID' }]));
      expect(service.restoreAssets).not.toHaveBeenCalled();
    });
  });

  describe('GET /trash/items', () => {
    it('should refuse a page size above the limit', async () => {
      const { status } = await request(ctx.getHttpServer()).get('/trash/items').query({ size: 1001 });

      expect(status).toBe(400);
      expect(service.getItems).not.toHaveBeenCalled();
    });

    it('should refuse an unknown sort', async () => {
      const { status } = await request(ctx.getHttpServer()).get('/trash/items').query({ sort: 'random' });

      expect(status).toBe(400);
      expect(service.getItems).not.toHaveBeenCalled();
    });
  });

  describe('GET /trash/activity', () => {
    it('should require a known utility', async () => {
      const { status } = await request(ctx.getHttpServer()).get('/trash/activity').query({ tool: 'duplicates' });

      expect(status).toBe(400);
      expect(service.getUtilityActivity).not.toHaveBeenCalled();
    });

    it('should read the Large files history', async () => {
      service.getUtilityActivity.mockResolvedValue({ entries: [] });
      const { status } = await request(ctx.getHttpServer()).get('/trash/activity').query({ tool: 'large-files' });

      expect(status).toBe(200);
      expect(service.getUtilityActivity).toHaveBeenCalledWith(undefined, { tool: 'large-files' });
    });
  });

  describe('POST /trash/apply source', () => {
    it('should refuse an unknown source', async () => {
      const { status } = await request(ctx.getHttpServer())
        .post('/trash/apply')
        .send({ action: 'trash', ids: [factory.uuid()], token: 'token', source: 'somewhere' });

      expect(status).toBe(400);
      expect(service.apply).not.toHaveBeenCalled();
    });
  });

  describe('POST /trash/review', () => {
    it('should require a known action', async () => {
      const { status } = await request(ctx.getHttpServer()).post('/trash/review').send({ action: 'shred' });

      expect(status).toBe(400);
      expect(service.review).not.toHaveBeenCalled();
    });

    it('should require valid asset ids', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .post('/trash/review')
        .send({ action: 'delete', ids: ['invalid'] });

      expect(status).toBe(400);
      expect(body).toEqual(factory.responses.validationError([{ path: ['ids', 0], message: 'Invalid UUID' }]));
      expect(service.review).not.toHaveBeenCalled();
    });
  });

  describe('POST /trash/apply', () => {
    it('should require the review token', async () => {
      const { status } = await request(ctx.getHttpServer()).post('/trash/apply').send({ action: 'empty' });

      expect(status).toBe(400);
      expect(service.apply).not.toHaveBeenCalled();
    });
  });
});
