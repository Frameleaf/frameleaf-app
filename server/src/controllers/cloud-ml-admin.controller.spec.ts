import request from 'supertest';
import { CloudMlAdminController } from 'src/controllers/cloud-ml-admin.controller.js';
import { MlWorkload } from 'src/enum.js';
import { CloudMlBatchService } from 'src/services/cloud-ml-batch.service.js';
import { CloudMlService } from 'src/services/cloud-ml.service.js';
import { ControllerContext, controllerSetup, mockBaseService } from 'test/utils.js';

describe(CloudMlAdminController.name, () => {
  let ctx: ControllerContext;
  const service = mockBaseService(CloudMlService);
  const batchService = mockBaseService(CloudMlBatchService);

  beforeAll(async () => {
    ctx = await controllerSetup(CloudMlAdminController, [
      { provide: CloudMlService, useValue: service },
      { provide: CloudMlBatchService, useValue: batchService },
    ]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    batchService.resetAllMocks();
    ctx.reset();
  });

  it('requires authentication for every Frameleaf Cloud processing route', async () => {
    for (const [method, path] of [
      ['get', '/admin/cloud/ml'],
      ['get', '/admin/cloud/ml/wallet'],
      ['get', '/admin/cloud/ml/catalog'],
      ['get', '/admin/cloud/ml/models'],
      ['put', '/admin/cloud/ml/models/tts'],
      ['get', '/admin/cloud/ml/consent'],
      ['get', '/admin/cloud/ml/settlements'],
      ['post', '/admin/cloud/ml/destination'],
      ['post', '/admin/cloud/ml/usage'],
      ['post', '/admin/cloud/ml/descriptions/estimate'],
      ['post', '/admin/cloud/ml/descriptions/batches'],
    ] as const) {
      await request(ctx.getHttpServer())[method](path);
      expect(ctx.authenticate).toHaveBeenCalled();
      ctx.authenticate.mockClear();
    }
  });

  it('estimates a description backfill without queueing anything (FL-163)', async () => {
    batchService.estimateBackfill.mockResolvedValue({ photos: 0 } as never);
    const { status } = await request(ctx.getHttpServer()).post('/admin/cloud/ml/descriptions/estimate');
    expect(status).toBe(200);
    expect(batchService.estimateBackfill).toHaveBeenCalled();
    expect(batchService.startBackfill).not.toHaveBeenCalled();
  });

  it('queues a kept estimate by its id alone (FL-163)', async () => {
    batchService.startBackfill.mockResolvedValue({ batches: 1, photos: 3, operationIds: ['op-1'] });
    const estimateId = '5f0c6f8e-2b1a-4c3d-9e8f-1a2b3c4d5e6f';
    const { status, body } = await request(ctx.getHttpServer())
      .post('/admin/cloud/ml/descriptions/batches')
      .send({ estimateId });
    expect(status).toBe(201);
    expect(body).toEqual({ batches: 1, photos: 3, operationIds: ['op-1'] });
    expect(batchService.startBackfill).toHaveBeenCalledWith({ estimateId });
  });

  it('refuses a backfill that names prices instead of a kept estimate (FL-163 review)', async () => {
    const { status } = await request(ctx.getHttpServer())
      .post('/admin/cloud/ml/descriptions/batches')
      .send({ modelId: 'ms_K6WT70CS', perPhotoP90Usd: 0.002, startupUsd: 0.02, maxTotalUsd: 100 });
    expect(status).toBe(400);
    expect(batchService.startBackfill).not.toHaveBeenCalled();
  });

  it('lists settled charges', async () => {
    service.getSettlements.mockResolvedValue({ items: [] });
    const { status, body } = await request(ctx.getHttpServer()).get('/admin/cloud/ml/settlements');
    expect(status).toBe(200);
    expect(body).toEqual({ items: [] });
  });

  it('adds the destination with workloads only; there is no URL or token to send', async () => {
    const { status } = await request(ctx.getHttpServer())
      .post('/admin/cloud/ml/destination')
      .send({ workloads: [MlWorkload.Enrichment] });
    expect(status).toBe(201);
    expect(service.createDestination).toHaveBeenCalledWith({
      name: 'Frameleaf Cloud',
      workloads: [MlWorkload.Enrichment],
    });
  });

  it('chooses a model per model group and refuses a group that does not exist (FL-186)', async () => {
    service.setModelChoice.mockResolvedValue({ choices: [] });
    const { status } = await request(ctx.getHttpServer())
      .put('/admin/cloud/ml/models/restoration-creative')
      .send({ modelId: 'ms_F1SSRED6' });
    expect(status).toBe(200);
    expect(service.setModelChoice).toHaveBeenCalledWith('restoration-creative', { modelId: 'ms_F1SSRED6' });

    const unknown = await request(ctx.getHttpServer())
      .put('/admin/cloud/ml/models/restoration')
      .send({ modelId: null });
    expect(unknown.status).toBe(400);
    const missing = await request(ctx.getHttpServer()).put('/admin/cloud/ml/models/tts').send({});
    expect(missing.status).toBe(400);
    expect(service.setModelChoice).toHaveBeenCalledTimes(1);
  });

  it('refuses a destination without workloads', async () => {
    const { status } = await request(ctx.getHttpServer()).post('/admin/cloud/ml/destination').send({ workloads: [] });
    expect(status).toBe(400);
    expect(service.createDestination).not.toHaveBeenCalled();
  });
});
