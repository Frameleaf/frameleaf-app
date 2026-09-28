import request from 'supertest';
import { CloudAdminController } from 'src/controllers/cloud-admin.controller.js';
import { FrameleafCloudTourService } from 'src/services/frameleaf-cloud-tour.service.js';
import { FrameleafCloudService } from 'src/services/frameleaf-cloud.service.js';
import { FrameleafRemoteAccessService } from 'src/services/frameleaf-remote-access.service.js';
import { ControllerContext, controllerSetup, mockBaseService } from 'test/utils.js';

describe(CloudAdminController.name, () => {
  let ctx: ControllerContext;
  const service = mockBaseService(FrameleafCloudService);
  const remote = mockBaseService(FrameleafRemoteAccessService);
  const tour = mockBaseService(FrameleafCloudTourService);

  beforeAll(async () => {
    ctx = await controllerSetup(CloudAdminController, [
      { provide: FrameleafCloudService, useValue: service },
      { provide: FrameleafRemoteAccessService, useValue: remote },
      { provide: FrameleafCloudTourService, useValue: tour },
    ]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    remote.resetAllMocks();
    tour.resetAllMocks();
    ctx.reset();
  });

  it('requires authentication for every Frameleaf Cloud link route', async () => {
    for (const [method, path] of [
      ['get', '/admin/cloud/status'],
      ['get', '/admin/cloud/link'],
      ['post', '/admin/cloud/link'],
      ['delete', '/admin/cloud/link'],
      ['post', '/admin/cloud/link/continue'],
      ['delete', '/admin/cloud/link/pending'],
      ['put', '/admin/cloud/permissions'],
      ['put', '/admin/cloud/sign-in'],
      ['put', '/admin/cloud/remote-access'],
      ['post', '/admin/cloud/heartbeat'],
      ['get', '/admin/cloud/remote'],
      ['put', '/admin/cloud/remote'],
      ['post', '/admin/cloud/remote/test'],
      ['put', '/admin/cloud/remote/hostname'],
      ['post', '/admin/cloud/remote/hostname/check'],
      ['delete', '/admin/cloud/remote/hostname'],
      ['get', '/admin/cloud/tour'],
      ['put', '/admin/cloud/tour'],
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

  it('accepts only the showOnLocalLogin switch for Sign in with Frameleaf (FL-158)', async () => {
    const bad = await request(ctx.getHttpServer()).put('/admin/cloud/sign-in').send({ showOnLocalLogin: 'on' });
    expect(bad.status).toBe(400);
    const ok = await request(ctx.getHttpServer()).put('/admin/cloud/sign-in').send({ showOnLocalLogin: true });
    expect(ok.status).toBe(200);
    expect(service.updateSignIn.mock.calls[0][1]).toEqual({ showOnLocalLogin: true });
  });

  it('accepts only the two remote-access settings, as booleans (FL-161)', async () => {
    service.updateRemoteAccess.mockResolvedValue({ state: 'linked' } as never);
    const bad = await request(ctx.getHttpServer())
      .put('/admin/cloud/remote-access')
      .send({ allowOriginalsOverRelay: 'yes' });
    expect(bad.status).toBe(400);
    expect(service.updateRemoteAccess).not.toHaveBeenCalled();

    const ok = await request(ctx.getHttpServer())
      .put('/admin/cloud/remote-access')
      .send({ allowPasswordOverRelay: true, requireFrameleafSignIn: false });
    expect(ok.status).toBe(200);
    expect(service.updateRemoteAccess.mock.calls[0][1]).toEqual({ allowPasswordOverRelay: true });
  });

  describe('remote access (FL-165)', () => {
    it('changes only the switch, mode, direct port, port mapping and public address', async () => {
      remote.update.mockResolvedValue({ enabled: true } as never);
      const refused = [
        { enabled: 'yes' },
        { mode: 'direct' },
        { directPort: 80 },
        { directPort: 70_000 },
        { publicUrl: 'mine' },
      ];
      for (const body of refused) {
        const bad = await request(ctx.getHttpServer()).put('/admin/cloud/remote').send(body);
        expect(bad.status).toBe(400);
      }
      expect(remote.update).not.toHaveBeenCalled();

      const ok = await request(ctx.getHttpServer()).put('/admin/cloud/remote').send({
        enabled: true,
        mode: 'relay-and-direct',
        directPort: 4443,
        portMapping: false,
        publicUrl: 'custom',
        label: 'x',
      });
      expect(ok.status).toBe(200);
      expect(remote.update.mock.calls[0][1]).toEqual({
        enabled: true,
        mode: 'relay-and-direct',
        directPort: 4443,
        portMapping: false,
        publicUrl: 'custom',
      });
    });

    it('runs the self-check and answers 200', async () => {
      remote.test.mockResolvedValue({ lastTestOk: true } as never);
      const { status, body } = await request(ctx.getHttpServer()).post('/admin/cloud/remote/test');
      expect(status).toBe(200);
      expect(body).toEqual({ lastTestOk: true });
      expect(remote.test).toHaveBeenCalledTimes(1);
    });

    it('takes a hostname for the custom domain, and checks and removes it', async () => {
      remote.setCustomHostname.mockResolvedValue({} as never);
      const missing = await request(ctx.getHttpServer()).put('/admin/cloud/remote/hostname').send({});
      expect(missing.status).toBe(400);
      const ok = await request(ctx.getHttpServer())
        .put('/admin/cloud/remote/hostname')
        .send({ hostname: 'photos.example.com' });
      expect(ok.status).toBe(200);
      expect(remote.setCustomHostname.mock.calls[0][1]).toEqual({ hostname: 'photos.example.com' });

      remote.checkCustomHostname.mockResolvedValue({} as never);
      expect((await request(ctx.getHttpServer()).post('/admin/cloud/remote/hostname/check')).status).toBe(200);
      remote.removeCustomHostname.mockResolvedValue({} as never);
      expect((await request(ctx.getHttpServer()).delete('/admin/cloud/remote/hostname')).status).toBe(200);
    });
  });

  describe('FL-196 linked-server tour', () => {
    it('reads your tour', async () => {
      tour.getTour.mockResolvedValue({ seen: false, offer: true } as never);
      const { status, body } = await request(ctx.getHttpServer()).get('/admin/cloud/tour');
      expect(status).toBe(200);
      expect(body).toEqual({ seen: false, offer: true });
    });

    it('records how the tour ended', async () => {
      tour.markSeen.mockResolvedValue({ seen: true } as never);
      const { status } = await request(ctx.getHttpServer()).put('/admin/cloud/tour').send({ ending: 'skipped' });
      expect(status).toBe(200);
      expect(tour.markSeen).toHaveBeenCalledWith(undefined, { ending: 'skipped' });
    });

    it('accepts only the known endings', async () => {
      for (const body of [{}, { ending: 'closed' }, { ending: 1 }]) {
        const { status } = await request(ctx.getHttpServer()).put('/admin/cloud/tour').send(body);
        expect(status).toBe(400);
      }
      expect(tour.markSeen).not.toHaveBeenCalled();
    });
  });
});
