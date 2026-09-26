import request from 'supertest';
import { CloudBackupAdminController } from 'src/controllers/cloud-backup-admin.controller.js';
import { CloudBackupService } from 'src/services/cloud-backup.service.js';
import { ControllerContext, controllerSetup } from 'test/utils.js';

describe(CloudBackupAdminController.name, () => {
  let ctx: ControllerContext;
  const service = {
    getStatus: vi.fn(),
    check: vi.fn(),
    generateKey: vi.fn(),
    setup: vi.fn(),
    unlock: vi.fn(),
    turnOff: vi.fn(),
    startRun: vi.fn(),
    pauseRun: vi.fn(),
    resumeRun: vi.fn(),
    cancelRun: vi.fn(),
  };
  const runId = '0192a4c1-5e2b-7c91-9a4d-2f6b1e0c8d55';

  beforeAll(async () => {
    ctx = await controllerSetup(CloudBackupAdminController, [{ provide: CloudBackupService, useValue: service }]);
    return () => ctx.close();
  });

  beforeEach(() => {
    for (const mock of Object.values(service)) {
      mock.mockReset();
    }
    ctx.reset();
  });

  it('requires authentication for every cloud backup route', async () => {
    for (const [method, path] of [
      ['get', '/admin/cloud/backup'],
      ['post', '/admin/cloud/backup/check'],
      ['post', '/admin/cloud/backup/key'],
      ['post', '/admin/cloud/backup/setup'],
      ['post', '/admin/cloud/backup/key/unlock'],
      ['delete', '/admin/cloud/backup'],
      ['post', '/admin/cloud/backup/runs'],
      ['post', `/admin/cloud/backup/runs/${runId}/pause`],
      ['post', `/admin/cloud/backup/runs/${runId}/resume`],
      ['post', `/admin/cloud/backup/runs/${runId}/cancel`],
    ] as const) {
      await request(ctx.getHttpServer())[method](path);
      expect(ctx.authenticate).toHaveBeenCalled();
      ctx.authenticate.mockClear();
    }
  });

  it('sets up with a key mode and a key, and refuses an unknown key mode or a missing key', async () => {
    service.setup.mockResolvedValue({ configured: true });
    const body = {
      target: 'byo-s3',
      s3: { endpoint: 'https://s3.example.test', bucket: 'family-backup', accessKeyId: 'a', secretAccessKey: 'b' },
      keyMode: 'own-memory',
      key: 'k',
      acknowledgement: 'I understand',
    };

    const { status } = await request(ctx.getHttpServer()).post('/admin/cloud/backup/setup').send(body);
    expect(status).toBe(200);
    expect(service.setup).toHaveBeenCalledWith(undefined, body);

    const unknown = await request(ctx.getHttpServer())
      .post('/admin/cloud/backup/setup')
      .send({ ...body, keyMode: 'escrowed' });
    expect(unknown.status).toBe(400);
    const missing = await request(ctx.getHttpServer())
      .post('/admin/cloud/backup/setup')
      .send({ ...body, key: '' });
    expect(missing.status).toBe(400);
    expect(service.setup).toHaveBeenCalledTimes(1);
  });

  it('unlocks with a key and refuses an empty one', async () => {
    service.unlock.mockResolvedValue({ keyLoaded: true });

    const { status, body } = await request(ctx.getHttpServer())
      .post('/admin/cloud/backup/key/unlock')
      .send({ key: 'k' });
    expect(status).toBe(200);
    expect(body).toEqual({ keyLoaded: true });

    const empty = await request(ctx.getHttpServer()).post('/admin/cloud/backup/key/unlock').send({});
    expect(empty.status).toBe(400);
  });

  it('acts on a run by its id and refuses an id that is not one', async () => {
    service.pauseRun.mockResolvedValue({});

    const { status } = await request(ctx.getHttpServer()).post(`/admin/cloud/backup/runs/${runId}/pause`);
    expect(status).toBe(200);
    expect(service.pauseRun).toHaveBeenCalledWith(runId);

    const invalid = await request(ctx.getHttpServer()).post('/admin/cloud/backup/runs/not-an-id/pause');
    expect(invalid.status).toBe(400);
  });
});
