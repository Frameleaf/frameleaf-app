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
    startVerify: vi.fn(),
    startPrune: vi.fn(),
    listManifests: vi.fn(),
    listManifestItems: vi.fn(),
    startRestore: vi.fn(),
    storeEscrow: vi.fn(),
    removeEscrow: vi.fn(),
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
      ['post', '/admin/cloud/backup/verify'],
      ['post', '/admin/cloud/backup/prune'],
      ['get', '/admin/cloud/backup/manifests'],
      ['post', '/admin/cloud/backup/manifests/items'],
      ['post', '/admin/cloud/backup/restore'],
      ['put', '/admin/cloud/backup/escrow'],
      ['delete', '/admin/cloud/backup/escrow'],
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

  it('queues a sampled or full check and refuses any other depth', async () => {
    service.startVerify.mockResolvedValue({});

    const { status } = await request(ctx.getHttpServer()).post('/admin/cloud/backup/verify').send({ depth: 'full' });
    expect(status).toBe(200);
    expect(service.startVerify).toHaveBeenCalledWith(undefined, { depth: 'full' });

    const other = await request(ctx.getHttpServer()).post('/admin/cloud/backup/verify').send({ depth: 'quick' });
    expect(other.status).toBe(400);
  });

  it('asks whether a clean-up is a dry run', async () => {
    service.startPrune.mockResolvedValue({});

    const { status } = await request(ctx.getHttpServer()).post('/admin/cloud/backup/prune').send({ dryRun: true });
    expect(status).toBe(200);
    expect(service.startPrune).toHaveBeenCalledWith(undefined, { dryRun: true });

    const missing = await request(ctx.getHttpServer()).post('/admin/cloud/backup/prune').send({});
    expect(missing.status).toBe(400);
  });

  it('restores from a manifest key only, with a known scope and item ids', async () => {
    service.startRestore.mockResolvedValue({});
    const body = {
      manifestKey: 'm/20260926T030000Z.json.gz',
      scope: 'asset',
      assetIds: ['8c5c3a24-2f65-4a8e-b3d4-3f1c3cb0c3e1'],
    };

    const { status } = await request(ctx.getHttpServer()).post('/admin/cloud/backup/restore').send(body);
    expect(status).toBe(200);
    expect(service.startRestore).toHaveBeenCalledWith(undefined, body);

    for (const refused of [
      { ...body, manifestKey: '../frameleaf-backup.json' },
      { ...body, scope: 'everything' },
      { ...body, assetIds: ['not-an-id'] },
    ]) {
      const response = await request(ctx.getHttpServer()).post('/admin/cloud/backup/restore').send(refused);
      expect(response.status).toBe(400);
    }
    expect(service.startRestore).toHaveBeenCalledTimes(1);
  });

  it('stores an escrow copy only with a passphrase of at least twelve characters', async () => {
    service.storeEscrow.mockResolvedValue({});

    const { status } = await request(ctx.getHttpServer())
      .put('/admin/cloud/backup/escrow')
      .send({ passphrase: 'correct horse battery' });
    expect(status).toBe(200);
    expect(service.storeEscrow).toHaveBeenCalledWith(undefined, { passphrase: 'correct horse battery' });

    const short = await request(ctx.getHttpServer()).put('/admin/cloud/backup/escrow').send({ passphrase: 'short' });
    expect(short.status).toBe(400);
    expect(service.storeEscrow).toHaveBeenCalledTimes(1);
  });
});
