import request from 'supertest';
import { vi } from 'vitest';
import { DateDoctorController } from 'src/controllers/date-doctor.controller.js';
import { DateDoctorService } from 'src/services/date-doctor.service.js';
import { factory } from 'test/small.factory.js';
import { ControllerContext, controllerSetup } from 'test/utils.js';

describe(DateDoctorController.name, () => {
  let ctx: ControllerContext;
  const service = { getFindings: vi.fn(), scan: vi.fn(), preview: vi.fn(), apply: vi.fn(), undo: vi.fn() };

  beforeAll(async () => {
    ctx = await controllerSetup(DateDoctorController, [{ provide: DateDoctorService, useValue: service }]);
    return () => ctx.close();
  });

  beforeEach(() => {
    vi.resetAllMocks();
    ctx.reset();
  });

  it('requires authentication', async () => {
    await request(ctx.getHttpServer()).get('/date-doctor/findings');
    expect(ctx.authenticate).toHaveBeenCalled();
  });

  it('returns the findings, grouped', async () => {
    service.getFindings.mockResolvedValue({ total: 0, groups: [] });
    const { status, body } = await request(ctx.getHttpServer()).get('/date-doctor/findings');
    expect(status).toBe(200);
    expect(body).toEqual({ total: 0, groups: [] });
  });

  it('starts a scan', async () => {
    const { status } = await request(ctx.getHttpServer()).post('/date-doctor/scan');
    expect(status).toBe(204);
    expect(service.scan).toHaveBeenCalledOnce();
  });

  describe('FL-930 fixes', () => {
    const id = factory.uuid();

    it.each([
      ['neither findings nor photos', {}],
      ['both', { findings: [{ assetId: id, cause: 'missing-zone' }], assetIds: [id], shiftMinutes: 5 }],
      ['photos without a zone or shift', { assetIds: [id] }],
      ['an unknown zone', { assetIds: [id], timeZone: 'Mars/Olympus' }],
      ['an unknown cause', { findings: [{ assetId: id, cause: 'bad-vibes' }] }],
      ['a photo twice', { assetIds: [id, id], shiftMinutes: 5 }],
    ])('refuses %s', async (_, body) => {
      const { status } = await request(ctx.getHttpServer()).post('/date-doctor/apply').send(body);
      expect(status).toBe(400);
      expect(service.apply).not.toHaveBeenCalled();
    });

    it('previews with 200 and applies a selection’s zone', async () => {
      service.preview.mockResolvedValue({ items: [] });
      const preview = await request(ctx.getHttpServer())
        .post('/date-doctor/preview')
        .send({ assetIds: [id], timeZone: 'UTC+2' });
      expect(preview.status).toBe(200);
      expect(service.preview).toHaveBeenCalledWith(undefined, { assetIds: [id], timeZone: 'UTC+2' });

      await request(ctx.getHttpServer())
        .post('/date-doctor/apply')
        .send({ assetIds: [id], timeZone: 'Europe/Paris' });
      expect(service.apply).toHaveBeenCalledWith(undefined, { assetIds: [id], timeZone: 'Europe/Paris' });
    });

    it('undoes a batch by its id', async () => {
      const batchId = '019a5b5e-6f3c-7a1e-9b2d-3c4d5e6f7a8b';
      await request(ctx.getHttpServer()).post(`/date-doctor/batches/${batchId}/undo`);
      expect(service.undo).toHaveBeenCalledWith(undefined, batchId);
      const { status } = await request(ctx.getHttpServer()).post('/date-doctor/batches/not-an-id/undo');
      expect(status).toBe(400);
    });
  });
});
