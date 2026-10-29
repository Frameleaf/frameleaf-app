import {
  createApiKey,
  deleteApiKey,
  rotateApiKey,
  updateApiKey,
  type ApiKeyCreateDto,
  type ApiKeyResponseDto,
  type ApiKeyUpdateDto,
} from '@frameleaf/sdk';
import { toastManager } from '@frameleaf/ui';
import { confirmFrameleaf } from '$lib/frameleaf/confirm';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { handleError } from '$lib/utils/handle-error';
import { getFormatter } from '$lib/utils/i18n';

/*
 * API key actions for the signed-in account. FL-67: the dialogs live in the Frameleaf account
 * access section (`$lib/components/frameleaf/access`); these functions keep the validation,
 * events and messages every caller shares. A key value is returned to the caller to show once
 * and is never kept here.
 */

export const handleCreateApiKey = async (dto: ApiKeyCreateDto) => {
  const $t = await getFormatter();

  try {
    if (!dto.name) {
      toastManager.warning($t('api_key_empty'));
      return;
    }

    if (dto.permissions.length === 0) {
      toastManager.warning($t('permission_empty'));
      return;
    }

    const response = await createApiKey({ apiKeyCreateDto: dto });
    // FL-67: listeners get the key without its value
    eventManager.emit('ApiKeyCreate', response.apiKey);

    return response;
  } catch (error) {
    handleError(error, $t('errors.unable_to_create_api_key'));
  }
};

export const handleUpdateApiKey = async (apiKey: { id: string }, dto: ApiKeyUpdateDto) => {
  const $t = await getFormatter();

  if (!dto.name) {
    toastManager.warning($t('api_key_empty'));
    return;
  }

  if (dto.permissions && dto.permissions.length === 0) {
    toastManager.warning($t('permission_empty'));
    return;
  }

  try {
    const response = await updateApiKey({ id: apiKey.id, apiKeyUpdateDto: dto });
    eventManager.emit('ApiKeyUpdate', response);
    toastManager.primary($t('saved_api_key'));
    return true;
  } catch (error) {
    handleError(error, $t('errors.unable_to_save_api_key'));
  }
};

/**
 * Replace a key's value after a confirmation. The old value stops working at once; the new one is
 * returned for the caller to show once.
 */
export const handleRotateApiKey = async (apiKey: ApiKeyResponseDto) => {
  const $t = await getFormatter();

  const confirmed = await confirmFrameleaf({
    title: $t('frameleaf_access_key_rotate_title', { values: { name: apiKey.name } }),
    prompt: $t('frameleaf_access_key_rotate_prompt', { values: { name: apiKey.name } }),
    confirmText: $t('frameleaf_access_key_replace'),
  });
  if (!confirmed) {
    return;
  }

  try {
    const response = await rotateApiKey({ id: apiKey.id });
    eventManager.emit('ApiKeyUpdate', response.apiKey);
    return response;
  } catch (error) {
    handleError(error, $t('errors.something_went_wrong'));
  }
};

export const handleDeleteApiKey = async (apiKey: ApiKeyResponseDto) => {
  const $t = await getFormatter();

  const confirmed = await confirmFrameleaf({
    title: $t('frameleaf_access_key_delete_title', { values: { name: apiKey.name } }),
    prompt: $t('frameleaf_access_key_delete_prompt', { values: { name: apiKey.name } }),
    confirmText: $t('frameleaf_access_key_delete'),
    danger: true,
  });
  if (!confirmed) {
    return;
  }

  try {
    await deleteApiKey({ id: apiKey.id });
    eventManager.emit('ApiKeyDelete', apiKey);
    toastManager.primary($t('removed_api_key', { values: { name: apiKey.name } }));
  } catch (error) {
    handleError(error, $t('errors.unable_to_remove_api_key'));
  }
};

/** FL-655: how a browser is named, from an access Save to Frameleaf added by signing in. */
export const extensionBrowser = (apiKey: Pick<ApiKeyResponseDto, 'signedInFrom'>) =>
  apiKey.signedInFrom === 'edge' ? 'Edge' : 'Chrome';

/**
 * FL-655: remove an access Save to Frameleaf added by signing in, after a confirmation. That browser
 * is signed out at once and keeps its waiting items until it signs in again.
 */
export const handleRemoveExtensionAccess = async (apiKey: ApiKeyResponseDto) => {
  const $t = await getFormatter();

  const confirmed = await confirmFrameleaf({
    title: $t('frameleaf_access_key_extension_remove_title', { values: { name: apiKey.name } }),
    prompt: $t('frameleaf_access_key_extension_remove_help', { values: { browser: extensionBrowser(apiKey) } }),
    confirmText: $t('frameleaf_access_key_extension_remove'),
    danger: true,
  });
  if (!confirmed) {
    return false;
  }

  try {
    await deleteApiKey({ id: apiKey.id });
    eventManager.emit('ApiKeyDelete', apiKey);
    toastManager.primary($t('frameleaf_access_key_extension_removed', { values: { name: apiKey.name } }));
    return true;
  } catch (error) {
    handleError(error, $t('errors.unable_to_remove_api_key'));
    return false;
  }
};
