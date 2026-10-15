import request from 'supertest';
import { IntegrityAdminController } from 'src/controllers/integrity-admin.controller.js';
import { IntegrityReport, Permission } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { IntegrityService } from 'src/services/integrity.service.js';
import { ControllerContext, automock, controllerSetup, mockBaseService } from 'test/utils.js';

describe(IntegrityAdminController.name, () => {
  let ctx: ControllerContext;
  const service = mockBaseService(IntegrityService);

  beforeAll(async () => {
    ctx = await controllerSetup(IntegrityAdminController, [
      { provide: LoggingRepository, useValue: automock(LoggingRepository, { strict: false }) },
      { provide: IntegrityService, useValue: service },
    ]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    ctx.reset();
  });

  describe('GET /admin/integrity/runs (FL-81)', () => {
    it('returns when each check last completed, for an administrator with maintenance', async () => {
      const runs = {
        [IntegrityReport.ChecksumFail]: null,
        [IntegrityReport.MissingFile]: '2026-09-20T10:00:00.000Z',
        [IntegrityReport.UntrackedFile]: null,
      };
      service.getIntegrityCheckRuns.mockResolvedValue(runs);

      const { status, body } = await request(ctx.getHttpServer()).get('/admin/integrity/runs');

      expect(status).toBe(200);
      expect(body).toEqual(runs);
      expect(ctx.authenticate).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ adminRoute: true, permission: Permission.Maintenance }),
        }),
      );
    });
  });
  describe('POST /admin/integrity/report/:type/clear (FL-366)', () => {
    it("empties one check's list for an administrator with maintenance", async () => {
      service.clearIntegrityReports.mockResolvedValue({ cleared: 3 });

      const { status, body } = await request(ctx.getHttpServer()).post(
        `/admin/integrity/report/${IntegrityReport.UntrackedFile}/clear`,
      );

      expect(status).toBe(200);
      expect(body).toEqual({ cleared: 3 });
      expect(service.clearIntegrityReports).toHaveBeenCalledWith(IntegrityReport.UntrackedFile);
      expect(ctx.authenticate).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ adminRoute: true, permission: Permission.Maintenance }),
        }),
      );
    });

    it('rejects a type that is not a check', async () => {
      const { status } = await request(ctx.getHttpServer()).post('/admin/integrity/report/everything/clear');

      expect(status).toBe(400);
      expect(service.clearIntegrityReports).not.toHaveBeenCalled();
    });
  });

  describe('POST /admin/integrity/report/:id/dismiss (FL-366)', () => {
    it('forgets one finding', async () => {
      const id = '01970000-0000-7000-8000-000000000001';

      const { status } = await request(ctx.getHttpServer()).post(`/admin/integrity/report/${id}/dismiss`);

      expect(status).toBe(204);
      expect(service.dismissIntegrityReport).toHaveBeenCalledWith(id);
    });
  });
});
