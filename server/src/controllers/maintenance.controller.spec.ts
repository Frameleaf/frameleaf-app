import { ForbiddenException } from '@nestjs/common';
import request from 'supertest';
import { MaintenanceController } from 'src/controllers/maintenance.controller.js';
import { MaintenanceAction } from 'src/enum.js';
import { MaintenanceService } from 'src/services/maintenance.service.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { errorDto } from 'test/medium/responses.js';
import { ControllerContext, controllerSetup, mockBaseService } from 'test/utils.js';

describe(MaintenanceController.name, () => {
  let ctx: ControllerContext;
  const service = mockBaseService(MaintenanceService);

  beforeAll(async () => {
    ctx = await controllerSetup(MaintenanceController, [{ provide: MaintenanceService, useValue: service }]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    ctx.reset();
  });

  describe('POST /admin/maintenance', () => {
    it('should require a backup file when action is restore', async () => {
      const { status, body } = await request(ctx.getHttpServer()).post('/admin/maintenance').send({
        action: MaintenanceAction.RestoreDatabase,
      });
      expect(status).toBe(400);
      expect(body).toEqual(
        errorDto.validationError([
          { path: ['restoreBackupFilename'], message: 'Backup filename is required when action is restore_database' },
        ]),
      );
      expect(ctx.authenticate).toHaveBeenCalled();
    });

    it.each(['start', 'select_database_restore'])(
      'confirms recently before %s issues maintenance authority',
      async (action) => {
        ctx.authenticate.mockResolvedValue(AuthFactory.create());
        const confirm = ctx.getAuthService().requireConfirmedRecently as unknown as {
          mockRejectedValueOnce: (e: Error) => void;
        };
        confirm.mockRejectedValueOnce(new ForbiddenException('confirmation_required'));
        const { status } = await request(ctx.getHttpServer()).post('/admin/maintenance').send({ action });
        expect(status).toBe(403);
        expect(service.startMaintenance).not.toHaveBeenCalled();
      },
    );

    it('confirms a restore recently and never passes the confirmation on to be stored', async () => {
      ctx.authenticate.mockResolvedValue(AuthFactory.create());
      service.startMaintenance.mockResolvedValue({ jwt: 'maintenance-token' } as never);
      const confirmation = { password: 'secret-password', code: '123456' };
      const { status } = await request(ctx.getHttpServer()).post('/admin/maintenance').send({
        action: MaintenanceAction.RestoreDatabase,
        restoreBackupFilename: 'backup.sql.gz',
        confirmation,
      });
      expect(status).toBeLessThan(300);
      expect(ctx.getAuthService().requireConfirmedRecently).toHaveBeenCalledWith(
        expect.anything(),
        confirmation,
        expect.anything(),
      );
      const [stored] = service.startMaintenance.mock.calls[0];
      expect(stored).not.toHaveProperty('confirmation');
      expect(stored).toMatchObject({ restoreBackupFilename: 'backup.sql.gz' });
    });
  });
});
