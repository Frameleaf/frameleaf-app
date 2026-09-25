import { BadRequestException } from '@nestjs/common';
import request from 'supertest';
import { DatabaseBackupController } from 'src/controllers/database-backup.controller.js';
import { Permission } from 'src/enum.js';
import { DatabaseBackupService } from 'src/services/database-backup.service.js';
import { MaintenanceService } from 'src/services/maintenance.service.js';
import { errorDto } from 'test/medium/responses.js';
import { ControllerContext, automock, controllerSetup, mockBaseService } from 'test/utils.js';

describe(DatabaseBackupController.name, () => {
  let ctx: ControllerContext;
  const service = automock(DatabaseBackupService, { args: [{ setContext: () => {} }], strict: false });
  const maintenanceService = mockBaseService(MaintenanceService);

  beforeAll(async () => {
    ctx = await controllerSetup(DatabaseBackupController, [
      { provide: DatabaseBackupService, useValue: service },
      { provide: MaintenanceService, useValue: maintenanceService },
    ]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    maintenanceService.resetAllMocks();
    ctx.reset();
  });

  describe('POST /admin/database-backups/start-restore', () => {
    it('should not be an authenticated route', async () => {
      maintenanceService.startRestoreFlow.mockResolvedValue({ jwt: 'jwt' });

      await request(ctx.getHttpServer()).post('/admin/database-backups/start-restore').send();

      expect(ctx.authenticate).not.toHaveBeenCalled();
      expect(ctx.requireSetupAvailable).toHaveBeenCalled();
    });

    it('should not start a restore when setup is unavailable', async () => {
      ctx.requireSetupAvailable.mockRejectedValue(new BadRequestException('Admin setup is not available'));

      const { status, body } = await request(ctx.getHttpServer()).post('/admin/database-backups/start-restore').send();

      expect(status).toEqual(400);
      expect(body).toEqual(errorDto.badRequest('Admin setup is not available'));
      expect(maintenanceService.startRestoreFlow).not.toHaveBeenCalled();
    });
  });

  describe('restore verification (FL-71 CC-9)', () => {
    it('reads it for an administrator with maintenance, ahead of the filename route', async () => {
      service.getRestoreVerification.mockResolvedValue({
        metadataVerifiedAt: null,
        originalsVerifiedAt: null,
        verifiedBy: null,
        overdue: true,
        dueAt: null,
        intervalDays: 90,
      });

      const { status } = await request(ctx.getHttpServer()).get('/admin/database-backups/restore-verification');

      expect(status).toBe(200);
      expect(service.getRestoreVerification).toHaveBeenCalled();
      expect(service.downloadBackup).not.toHaveBeenCalled();
      expect(ctx.authenticate).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ adminRoute: true, permission: Permission.Maintenance }),
        }),
      );
    });

    it('records a test of at least one part', async () => {
      const { status } = await request(ctx.getHttpServer())
        .post('/admin/database-backups/restore-verification')
        .send({ metadata: false, originals: false });
      expect(status).toBe(400);

      await request(ctx.getHttpServer())
        .post('/admin/database-backups/restore-verification')
        .send({ metadata: true, originals: true });
      expect(service.recordRestoreVerification).toHaveBeenCalledWith(undefined, { metadata: true, originals: true });
    });
  });
});
