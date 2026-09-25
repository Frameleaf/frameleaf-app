import request from 'supertest';
import { CloudAdminController } from 'src/controllers/cloud-admin.controller.js';
import { FrameleafCloudService } from 'src/services/frameleaf-cloud.service.js';
import { ControllerContext, controllerSetup, mockBaseService } from 'test/utils.js';

describe(CloudAdminController.name, () => {
  let ctx: ControllerContext;
  const service = mockBaseService(FrameleafCloudService);

  beforeAll(async () => {
    ctx = await controllerSetup(CloudAdminController, [{ provide: FrameleafCloudService, useValue: service }]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    ctx.reset();
  });

  it('requires authentication for every Frameleaf Cloud link route', async () => {
    for (const [method, path] of [
      ['get', '/admin/cloud/status'],
      ['get', '/admin/cloud/link'],
      ['post', '/admin/cloud/link'],
      ['delete', '/admin/cloud/link'],
      ['delete', '/admin/cloud/link/pending'],
      ['put', '/admin/cloud/permissions'],
      ['post', '/admin/cloud/heartbeat'],
    ] as const) {
      await request(ctx.getHttpServer())[method](path);
      expect(ctx.authenticate).toHaveBeenCalled();
      ctx.authenticate.mockClear();
    }
  });

  it('reads the status', async () => {
    service.getStatus.mockResolvedValue({ state: 'not-configured' } as never);
    const { status, body } = await request(ctx.getHttpServer()).get('/admin/cloud/status');
    expect(status).toBe(200);
    expect(body).toEqual({ state: 'not-configured' });
  });

  it('accepts only the three permission toggles', async () => {
    const { status } = await request(ctx.getHttpServer())
      .put('/admin/cloud/permissions')
      .send({ allowRemoteEnable: 'yes' });
    expect(status).toBe(400);
    expect(service.updatePermissions).not.toHaveBeenCalled();

    const ok = await request(ctx.getHttpServer()).put('/admin/cloud/permissions').send({ allowBackupTrigger: false });
    expect(ok.status).toBe(200);
    expect(service.updatePermissions.mock.calls[0][1]).toEqual({ allowBackupTrigger: false });
  });
});
