import { Reflector } from '@nestjs/core';
import { AccountEventAdminController, AccountEventController } from 'src/controllers/account-event.controller.js';
import { Permission } from 'src/enum.js';
import { getAuthenticatedOptions } from 'src/middleware/auth.guard.js';

const reflector = new Reflector();

describe('account activity route authority (FL-808)', () => {
  it('lets a member read only their own log, never through a shared link', () => {
    const options = getAuthenticatedOptions(reflector, AccountEventController.prototype.getMyActivity);
    expect(options).toMatchObject({ permission: Permission.UserRead, sharedLink: false });
    expect(options.admin).toBeFalsy();
  });

  it('keeps everyone’s log for administrators', () => {
    const options = getAuthenticatedOptions(reflector, AccountEventAdminController.prototype.getAccountActivityAdmin);
    expect(options).toMatchObject({ permission: Permission.AdminUserRead, admin: true, sharedLink: false });
  });
});
