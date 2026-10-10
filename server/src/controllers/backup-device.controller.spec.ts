import { Reflector } from '@nestjs/core';
import { BackupDeviceAdminController, BackupDeviceController } from 'src/controllers/backup-device.controller.js';
import { Permission } from 'src/enum.js';
import { getAuthenticatedOptions } from 'src/middleware/auth.guard.js';

const reflector = new Reflector();
describe('backup device route authority', () => {
  it.each(['registerBackupDevice', 'removeBackupDevice'] as const)(
    '%s requires user.update, not a read-only key',
    (method) => {
      expect(getAuthenticatedOptions(reflector, BackupDeviceController.prototype[method])).toMatchObject({
        permission: Permission.UserUpdate,
      });
    },
  );
  it('keeps read and reconciliation scopes separate from registry mutations', () => {
    expect(getAuthenticatedOptions(reflector, BackupDeviceController.prototype.listBackupDevices)).toMatchObject({
      permission: Permission.UserRead,
    });
    expect(
      getAuthenticatedOptions(reflector, BackupDeviceController.prototype.startBackupReconciliation),
    ).toMatchObject({ permission: Permission.AssetRead });
    expect(
      getAuthenticatedOptions(reflector, BackupDeviceAdminController.prototype.listAllBackupDevices),
    ).toMatchObject({ permission: Permission.AdminUserRead, admin: true });
  });
});
