import request from 'supertest';
import { vi } from 'vitest';
import { LocationFillController } from 'src/controllers/location-fill.controller.js';
import { LocationFillService } from 'src/services/location-fill.service.js';
import { factory } from 'test/small.factory.js';
import { ControllerContext, controllerSetup } from 'test/utils.js';

describe(LocationFillController.name, () => {
  let ctx: ControllerContext;
  const service = {
    create: vi.fn(),
    getAll: vi.fn(),
    get: vi.fn(),
    getProposals: vi.fn(),
    apply: vi.fn(),
    undo: vi.fn(),
  };
  const base = '/users/me/location-fills';
  const runId = '01a2035e-0a5a-7051-a32b-b70220746416';

  beforeAll(async () => {
    ctx = await controllerSetup(LocationFillController, [{ provide: LocationFillService, useValue: service }]);
    return () => ctx.close();
  });

  beforeEach(() => {
    vi.resetAllMocks();
    ctx.reset();
  });

  it('requires authentication', async () => {
    await request(ctx.getHttpServer()).get(base);
    expect(ctx.authenticate).toHaveBeenCalled();
  });

  it.each([5, 15, 60])('starts a run with a %s minute gap', async (maxGapMinutes) => {
    const { status } = await request(ctx.getHttpServer()).post(base).send({ maxGapMinutes });
    expect(status).toBe(201);
    expect(service.create).toHaveBeenCalledWith(undefined, { maxGapMinutes });
  });

  it.each([
    ['no gap', {}],
    ['a gap that is not offered', { maxGapMinutes: 30 }],
    ['a date that is not one', { maxGapMinutes: 15, from: 'last summer' }],
    [
      'a range that ends before it starts',
      { maxGapMinutes: 15, from: '2024-07-02T00:00:00Z', to: '2024-07-01T00:00:00Z' },
    ],
  ])('refuses a run with %s', async (_, body) => {
    const { status } = await request(ctx.getHttpServer()).post(base).send(body);
    expect(status).toBe(400);
    expect(service.create).not.toHaveBeenCalled();
  });

  it('pages the proposals', async () => {
    service.getProposals.mockResolvedValue({ total: 0, hasNextPage: false, days: [] });
    const { status } = await request(ctx.getHttpServer()).get(`${base}/${runId}/proposals?page=2&size=50`);
    expect(status).toBe(200);
    expect(service.getProposals).toHaveBeenCalledWith(undefined, runId, { page: 2, size: 50 });
    await request(ctx.getHttpServer()).get(`${base}/${runId}/proposals`);
    expect(service.getProposals).toHaveBeenLastCalledWith(undefined, runId, { page: 1, size: 100 });
    const tooMany = await request(ctx.getHttpServer()).get(`${base}/${runId}/proposals?size=501`);
    expect(tooMany.status).toBe(400);
  });

  it('applies all, or the chosen photos once each', async () => {
    const id = factory.uuid();
    const all = await request(ctx.getHttpServer()).post(`${base}/${runId}/apply`).send({});
    expect(all.status).toBe(200);
    expect(service.apply).toHaveBeenCalledWith(undefined, runId, {});
    const some = await request(ctx.getHttpServer())
      .post(`${base}/${runId}/apply`)
      .send({ assetIds: [id] });
    expect(some.status).toBe(200);
    for (const assetIds of [[], [id, id], ['nope']]) {
      const refused = await request(ctx.getHttpServer()).post(`${base}/${runId}/apply`).send({ assetIds });
      expect(refused.status).toBe(400);
    }
    expect(service.apply).toHaveBeenCalledTimes(2);
  });

  it('undoes a run', async () => {
    const { status } = await request(ctx.getHttpServer()).post(`${base}/${runId}/undo`);
    expect(status).toBe(200);
    expect(service.undo).toHaveBeenCalledWith(undefined, runId);
  });
});
