import {
  createUserAdmin,
  deleteUserAdmin,
  restoreUserAdmin,
  updateUserAdmin,
  UserStatus,
  type UserAdminCreateDto,
  type UserAdminDeleteDto,
  type UserAdminResponseDto,
  type UserAdminUpdateDto,
} from '@immich/sdk';
import { modalManager, toastManager, type ActionItem } from '@immich/ui';
import {
  mdiDeleteRestore,
  mdiInformationOutline,
  mdiLockReset,
  mdiLockSmart,
  mdiPencilOutline,
  mdiPlusBoxOutline,
  mdiTrashCanOutline,
} from '@mdi/js';
import { DateTime } from 'luxon';
import type { MessageFormatter } from 'svelte-i18n';
import { goto } from '$app/navigation';
import AccountDeleteDialog from '$lib/components/frameleaf/AccountDeleteDialog.svelte';
import AccountPasswordResetDialog from '$lib/components/frameleaf/AccountPasswordResetDialog.svelte';
import AccountPinDialog from '$lib/components/frameleaf/AccountPinDialog.svelte';
import AccountRestoreDialog from '$lib/components/frameleaf/AccountRestoreDialog.svelte';
import { accountLifecycle } from '$lib/frameleaf/accounts';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { serverConfigManager } from '$lib/managers/server-config-manager.svelte';
import { Route } from '$lib/route';
import type { HeaderButtonActionItem } from '$lib/types';
import { handleError } from '$lib/utils/handle-error';
import { getFormatter } from '$lib/utils/i18n';

export const getUserAdminsActions = ($t: MessageFormatter) => {
  const Create: ActionItem = {
    title: $t('create_user'),
    icon: mdiPlusBoxOutline,
    onAction: () => goto(Route.newUser()),
    shortcuts: { shift: true, key: 'n' },
  };

  return { Create };
};

export const getUserAdminActions = ($t: MessageFormatter, user: UserAdminResponseDto) => {
  const Detail: ActionItem = {
    icon: mdiInformationOutline,
    title: $t('details'),
    onAction: () => goto(Route.viewUser(user)),
  };

  const Update: ActionItem = {
    icon: mdiPencilOutline,
    title: $t('edit'),
    // As the detail header's Edit account: only an active account can be edited.
    $if: () => accountLifecycle(user) === 'active',
    onAction: () => goto(Route.editUser(user)),
  };

  const Delete: ActionItem = {
    icon: mdiTrashCanOutline,
    title: $t('delete'),
    color: 'danger',
    $if: () => authManager.user.id !== user.id && !user.deletedAt,
    onAction: () => modalManager.show(AccountDeleteDialog, { user }),
    shortcuts: { key: 'Backspace' },
    shortcutOptions: { ignoreInputFields: true },
  };

  const getDeleteDate = (deletedAt: string): Date =>
    DateTime.fromISO(deletedAt).plus({ days: serverConfigManager.value.userDeleteDelay }).toJSDate();

  const Restore: HeaderButtonActionItem = {
    icon: mdiDeleteRestore,
    title: $t('restore'),
    color: 'primary',
    data: {
      title: $t('admin.user_restore_scheduled_removal', { values: { date: getDeleteDate(user.deletedAt!) } }),
    },
    $if: () => !!user.deletedAt && user.status === UserStatus.Deleted,
    onAction: () => modalManager.show(AccountRestoreDialog, { user }),
  };

  const ResetPassword: ActionItem = {
    icon: mdiLockReset,
    title: $t('reset_password'),
    $if: () => authManager.user.id !== user.id,
    onAction: () => modalManager.show(AccountPasswordResetDialog, { user }),
  };

  const ResetPinCode: ActionItem = {
    icon: mdiLockSmart,
    title: $t('reset_pin_code'),
    onAction: () => modalManager.show(AccountPinDialog, { user, mode: 'clear' }),
  };

  return { Detail, Update, Delete, Restore, ResetPassword, ResetPinCode };
};

export const handleCreateUserAdmin = async (dto: UserAdminCreateDto) => {
  const $t = await getFormatter();

  try {
    const response = await createUserAdmin({ userAdminCreateDto: dto });
    eventManager.emit('UserAdminCreate', response);
    toastManager.primary();
    return response;
  } catch (error) {
    handleError(error, $t('errors.unable_to_create_user'));
  }
};

export const handleUpdateUserAdmin = async (user: UserAdminResponseDto, dto: UserAdminUpdateDto) => {
  const $t = await getFormatter();

  try {
    const response = await updateUserAdmin({ id: user.id, userAdminUpdateDto: dto });
    eventManager.emit('UserAdminUpdate', response);
    toastManager.primary();
    return true;
  } catch (error) {
    handleError(error, $t('errors.unable_to_update_user'));
    return false;
  }
};

export const handleDeleteUserAdmin = async (user: UserAdminResponseDto, dto: UserAdminDeleteDto) => {
  const $t = await getFormatter();

  try {
    const result = await deleteUserAdmin({ id: user.id, userAdminDeleteDto: dto });
    eventManager.emit('UserAdminDelete', result);
    toastManager.primary();
    return true;
  } catch (error) {
    handleError(error, $t('errors.unable_to_delete_user'));
  }
};

export const handleRestoreUserAdmin = async (user: UserAdminResponseDto) => {
  const $t = await getFormatter();

  try {
    const response = await restoreUserAdmin({ id: user.id });
    eventManager.emit('UserAdminRestore', response);
    toastManager.primary();
    return true;
  } catch (error) {
    handleError(error, $t('errors.unable_to_restore_user'));
    return false;
  }
};

// TODO move password reset server-side
const generatePassword = (length: number = 16) => {
  let generatedPassword = '';

  const characterSet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ,.-{}+!#$%/()=?';

  for (let i = 0; i < length; i++) {
    let randomNumber = crypto.getRandomValues(new Uint32Array(1))[0];
    randomNumber /= 2 ** 32;
    randomNumber = Math.floor(randomNumber * characterSet.length);

    generatedPassword += characterSet[randomNumber];
  }

  return generatedPassword;
};

/**
 * FL-76: the reset itself, without any UI of its own. There is no server-side password reset
 * endpoint, so a password is generated here and sent through the admin update endpoint with
 * `shouldChangePassword`, which hashes it and forces a change at the next sign-in. The plain
 * value is returned to the caller so `AccountPasswordResetDialog` can show it once; it is
 * never stored, logged or emitted on an event.
 */
export const handleResetPasswordUserAdmin = async (user: UserAdminResponseDto): Promise<string | undefined> => {
  const $t = await getFormatter();

  try {
    const dto = { password: generatePassword(), shouldChangePassword: true };
    const response = await updateUserAdmin({ id: user.id, userAdminUpdateDto: dto });
    eventManager.emit('UserAdminUpdate', response);
    toastManager.primary();
    return dto.password;
  } catch (error) {
    handleError(error, $t('errors.unable_to_reset_password'));
  }
};
