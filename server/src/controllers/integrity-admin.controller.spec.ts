import { PassThrough, Readable, Writable } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import request from 'supertest';
import type { Response } from 'express';
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

  describe('CSV streaming lifecycle', () => {
    const controller = new IntegrityAdminController(automock(LoggingRepository, { strict: false }), service);
    const response = () => Object.assign(new PassThrough(), { header: vi.fn() });

    it('preserves CSV bytes and response headers', async () => {
      const csv = 'id,type,assetId,fileAssetId,path\n1,missing_file,,,"a,b"\n';
      service.getIntegrityReportCsv.mockReturnValue(Readable.from([csv]));
      const output = response();
      let received = '';
      output.on('data', (chunk: Buffer) => (received += chunk.toString()));
      await controller.getIntegrityReportCsv({ type: IntegrityReport.MissingFile }, output as unknown as Response);
      await setImmediate();
      expect(received).toBe(csv);
      expect(output.header).toHaveBeenCalledWith(
        expect.objectContaining({
          'Content-Type': 'text/csv',
          'Cache-Control': 'private, no-cache, no-transform',
          'Content-Disposition': expect.stringMatching(/^attachment; filename=".*-missing_file\.csv"$/),
        }),
      );
    });

    it('destroys a paused source when the response disconnects', async () => {
      const source = new PassThrough();
      service.getIntegrityReportCsv.mockReturnValue(source);
      const output = Object.assign(new Writable({ write() {} }), { header: vi.fn() });
      const streaming = Promise.resolve(
        controller.getIntegrityReportCsv({ type: IntegrityReport.MissingFile }, output as unknown as Response),
      );
      void streaming.catch(() => {});
      try {
        source.write('id,type,assetId,fileAssetId,path\n');
        output.destroy();
        await setImmediate();
        expect(source.destroyed).toBe(true);
        await expect(streaming).rejects.toMatchObject({ code: 'ERR_STREAM_PREMATURE_CLOSE' });
      } finally {
        source.destroy();
      }
    });

    it('owns source failures and closes the response', async () => {
      const source = new PassThrough();
      const failure = new Error('CSV reader failed');
      source.on('error', () => {});
      service.getIntegrityReportCsv.mockReturnValue(source);
      const output = response();
      const streaming = Promise.resolve(
        controller.getIntegrityReportCsv({ type: IntegrityReport.MissingFile }, output as unknown as Response),
      );
      void streaming.catch(() => {});
      source.destroy(failure);
      try {
        await expect(streaming).rejects.toBe(failure);
        expect(output.destroyed).toBe(true);
      } finally {
        output.destroy();
      }
    });
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
