import request from 'supertest';
import { RawSupportController } from 'src/controllers/raw-support.controller.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { RawSupportService } from 'src/services/raw-support.service.js';
import { ControllerContext, automock, controllerSetup } from 'test/utils.js';

describe(RawSupportController.name, () => {
  let ctx: ControllerContext;
  const service = automock(RawSupportService, { args: [{ setContext: () => {} }], strict: false });

  beforeAll(async () => {
    ctx = await controllerSetup(RawSupportController, [
      { provide: RawSupportService, useValue: service },
      { provide: LoggingRepository, useValue: automock(LoggingRepository, { strict: false }) },
    ]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    ctx.reset();
  });

  describe('GET /media-health/raw', () => {
    it('should be an authenticated route', async () => {
      await request(ctx.getHttpServer()).get('/media-health/raw');
      expect(ctx.authenticate).toHaveBeenCalled();
    });

    it('should default the limit and parse a given one', async () => {
      await request(ctx.getHttpServer()).get('/media-health/raw');
      expect(service.getSummary).toHaveBeenLastCalledWith(undefined, { limit: 200 });
      await request(ctx.getHttpServer()).get('/media-health/raw').query({ limit: '25' });
      expect(service.getSummary).toHaveBeenLastCalledWith(undefined, { limit: 25 });
    });

    it('should reject an out-of-range limit', async () => {
      for (const limit of ['0', '501', 'many']) {
        const { status } = await request(ctx.getHttpServer()).get('/media-health/raw').query({ limit });
        expect(status).toBe(400);
      }
      expect(service.getSummary).not.toHaveBeenCalled();
    });
  });
});
