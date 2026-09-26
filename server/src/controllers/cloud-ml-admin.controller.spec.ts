import request from 'supertest';
import { CloudMlAdminController } from 'src/controllers/cloud-ml-admin.controller.js';
import { MlWorkload } from 'src/enum.js';
import { CloudMlService } from 'src/services/cloud-ml.service.js';
import { ControllerContext, controllerSetup, mockBaseService } from 'test/utils.js';

describe(CloudMlAdminController.name, () => {
  let ctx: ControllerContext;
  const service = mockBaseService(CloudMlService);

  beforeAll(async () => {
    ctx = await controllerSetup(CloudMlAdminController, [{ provide: CloudMlService, useValue: service }]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
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
    ] as const) {
      await request(ctx.getHttpServer())[method](path);
      expect(ctx.authenticate).toHaveBeenCalled();
      ctx.authenticate.mockClear();
    }
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
