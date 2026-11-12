import request from 'supertest';
import { vi } from 'vitest';
import { DateDoctorController } from 'src/controllers/date-doctor.controller.js';
import { DateDoctorService } from 'src/services/date-doctor.service.js';
import { ControllerContext, controllerSetup } from 'test/utils.js';

describe(DateDoctorController.name, () => {
  let ctx: ControllerContext;
  const service = { getFindings: vi.fn(), scan: vi.fn() };

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
});
