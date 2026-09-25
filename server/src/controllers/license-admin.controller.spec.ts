import request from 'supertest';
import { LicenseAdminController, LicenseController } from 'src/controllers/license-admin.controller.js';
import { FrameleafLicenseService } from 'src/services/frameleaf-license.service.js';
import { ControllerContext, controllerSetup, mockBaseService } from 'test/utils.js';

describe(LicenseAdminController.name, () => {
  let ctx: ControllerContext;
  const service = mockBaseService(FrameleafLicenseService);

  beforeAll(async () => {
    ctx = await controllerSetup(LicenseAdminController, [{ provide: FrameleafLicenseService, useValue: service }]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    ctx.reset();
  });

  it('requires authentication for every licence route', async () => {
    for (const [method, path] of [
      ['get', '/admin/license'],
      ['put', '/admin/license/activate'],
      ['put', '/admin/license/certificate'],
      ['delete', '/admin/license'],
      ['delete', '/admin/license/plan'],
      ['post', '/admin/license/refresh'],
    ] as const) {
      await request(ctx.getHttpServer())[method](path);
      expect(ctx.authenticate).toHaveBeenCalled();
      ctx.authenticate.mockClear();
    }
  });

  it('takes the key only in the request body', async () => {
    const { status } = await request(ctx.getHttpServer()).put('/admin/license/activate').send({});
    expect(status).toBe(400);
    expect(service.activate).not.toHaveBeenCalled();

    await request(ctx.getHttpServer()).put('/admin/license/activate').send({ key: 'FL-S8NL-49G8-J58U' });
    expect(service.activate.mock.calls[0][1]).toEqual({ key: 'FL-S8NL-49G8-J58U' });
  });
});

describe(LicenseController.name, () => {
  let ctx: ControllerContext;
  const service = mockBaseService(FrameleafLicenseService);

  beforeAll(async () => {
    ctx = await controllerSetup(LicenseController, [{ provide: FrameleafLicenseService, useValue: service }]);
    return () => ctx.close();
  });

  it('serves the prices to any signed-in account', async () => {
    service.getProducts.mockReturnValue({ currency: 'USD' } as never);
    const { status, body } = await request(ctx.getHttpServer()).get('/license/products');
    expect(ctx.authenticate).toHaveBeenCalled();
    expect(status).toBe(200);
    expect(body).toEqual({ currency: 'USD' });
  });
});
