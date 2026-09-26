import request from 'supertest';
import { AnalyticsController } from 'src/controllers/analytics.controller.js';
import { AnalyticsService } from 'src/services/analytics.service.js';
import { ControllerContext, automock, controllerSetup } from 'test/utils.js';

describe(AnalyticsController.name, () => {
  let ctx: ControllerContext;
  const service = automock(AnalyticsService, { args: [{ setContext: () => {} }], strict: false });

  beforeAll(async () => {
    ctx = await controllerSetup(AnalyticsController, [{ provide: AnalyticsService, useValue: service }]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    ctx.reset();
  });

  describe('GET /analytics/scopes', () => {
    it('should be an authenticated route', async () => {
      await request(ctx.getHttpServer()).get('/analytics/scopes');
      expect(ctx.authenticate).toHaveBeenCalled();
    });
  });

  describe('GET /analytics', () => {
    it('should be an authenticated route', async () => {
      await request(ctx.getHttpServer()).get('/analytics');
      expect(ctx.authenticate).toHaveBeenCalled();
    });

    it('should default to the whole server over twelve months', async () => {
      await request(ctx.getHttpServer()).get('/analytics');
      expect(service.getReport).toHaveBeenCalledWith(undefined, { scope: 'all', range: 'year' });
    });

    it('should reject an unknown range', async () => {
      const { status } = await request(ctx.getHttpServer()).get('/analytics').query({ range: 'decade' });
      expect(status).toBe(400);
      expect(service.getReport).not.toHaveBeenCalled();
    });

    it('should pass the scope through for the service to authorize', async () => {
      const scope = 'library:44444444-4444-4444-8444-444444444444';
      await request(ctx.getHttpServer()).get('/analytics').query({ scope, range: '90days' });
      expect(service.getReport).toHaveBeenCalledWith(undefined, { scope, range: '90days' });
    });
  });
});
