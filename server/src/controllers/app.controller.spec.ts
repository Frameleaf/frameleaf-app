import request from 'supertest';
import { AppController } from 'src/controllers/app.controller.js';
import { SystemConfigService } from 'src/services/system-config.service.js';
import { ControllerContext, controllerSetup, mockBaseService } from 'test/utils.js';

describe(AppController.name, () => {
  let ctx: ControllerContext;
  const service = mockBaseService(SystemConfigService);

  beforeAll(async () => {
    ctx = await controllerSetup(AppController, [{ provide: SystemConfigService, useValue: service }]);
    return () => ctx.close();
  });

  beforeEach(() => {
    ctx.reset();
  });

  describe('GET /.well-known/immich', () => {
    it('should not be an authenticated route', async () => {
      await request(ctx.getHttpServer()).post('/.well-known/immich');
      expect(ctx.authenticate).not.toHaveBeenCalled();
    });

    it('should return a 200 status code', async () => {
      // FL-161: the Frameleaf apps also find the server's instance id, public address and sign-in here
      const wellKnown = {
        api: { endpoint: '/api' },
        frameleaf: { instanceId: 'instance-1', publicUrl: 'https://r.k3v9.frameleaf-direct.net', signIn: true },
      };
      service.getWellKnown.mockResolvedValue(wellKnown);

      const { status, body } = await request(ctx.getHttpServer()).get('/.well-known/immich');
      expect(status).toBe(200);
      expect(body).toEqual(wellKnown);
    });
  });

  describe('GET /custom.css', () => {
    it('should not be an authenticated route', async () => {
      await request(ctx.getHttpServer()).post('/custom.css');
      expect(ctx.authenticate).not.toHaveBeenCalled();
    });

    it('should reply with text/css', async () => {
      const { status, headers } = await request(ctx.getHttpServer()).get('/custom.css');
      expect(status).toBe(200);
      expect(headers['content-type']).toEqual('text/css; charset=utf-8');
    });
  });
});
