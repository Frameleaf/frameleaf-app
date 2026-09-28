import { getConfig, updateConfig, type ServerFeaturesDto, type AdminConfigDto } from '@immich/sdk';
import { toastManager, type ActionItem } from '@immich/ui';
import { mdiContentCopy, mdiDownload, mdiUpload } from '@mdi/js';
import { isEqual } from 'lodash-es';
import type { MessageFormatter } from 'svelte-i18n';
import { forConfigSave } from '$lib/frameleaf/credentials';
import { redactConfigForExport } from '$lib/frameleaf/system-config-draft';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { copyToClipboard, downloadJson } from '$lib/utils';
import { handleError } from '$lib/utils/handle-error';
import { getFormatter } from '$lib/utils/i18n';

/**
 * Copy, export and import for the settings page. Copies and exports are of the saved settings
 * with secrets emptied and credentials removed from URLs (FL-66); an import goes into the settings
 * draft for review through `onImport` and is never saved directly.
 */
export const getSystemConfigActions = (
  $t: MessageFormatter,
  featureFlags: ServerFeaturesDto,
  config: AdminConfigDto,
  { onImport }: { onImport: (text: string) => void },
) => {
  // FL-67: copies and exports never carry a credential value. The server already returns them
  // empty; this keeps it true for a value typed into a form that has not been saved.
  const CopyToClipboard: ActionItem = {
    title: $t('copy_to_clipboard'),
    description: $t('admin.copy_config_to_clipboard_description'),
    icon: mdiContentCopy,
    onAction: () => copyToClipboard(redactConfigForExport(config)),
    shortcuts: { shift: true, key: 'c' },
  };

  const Download: ActionItem = {
    title: $t('export_as_json'),
    description: $t('admin.export_config_as_json_description'),
    icon: mdiDownload,
    onAction: () => downloadJson(redactConfigForExport(config), 'frameleaf-settings.json'),
    shortcuts: [
      { shift: true, key: 's' },
      { shift: true, key: 'd' },
    ],
  };

  const Upload: ActionItem = {
    title: $t('import_from_json'),
    description: $t('admin.import_config_from_json_description'),
    icon: mdiUpload,
    $if: () => !featureFlags.configFile,
    onAction: () => pickConfigFile(onImport),
    shortcuts: { shift: true, key: 'u' },
  };

  return { CopyToClipboard, Download, Upload };
};

/**
 * The one generic write path for settings forms. FL-67: credential values are emptied before the
 * save, which the server reads as "keep the stored credential"; credentials change only through
 * their own dialogs. The read-only `...Configured` flags are left out of both the comparison and
 * the save, so a section whose credential changed meanwhile is not saved again for nothing.
 */
export const handleSystemConfigSave = async (update: Partial<AdminConfigDto>) => {
  const $t = await getFormatter();
  const config = await getConfig();
  const adminConfigDto = forConfigSave({ ...config, ...update });

  if (isEqual(forConfigSave(config), adminConfigDto)) {
    return;
  }

  try {
    const newConfig = await updateConfig({ adminConfigDto });

    eventManager.emit('SystemConfigUpdate', newConfig);
    toastManager.primary($t('settings_saved'));
  } catch (error) {
    handleError(error, $t('errors.unable_to_save_settings'));
  }
};

const pickConfigFile = (onImport: (text: string) => void) => {
  const input = document.createElement('input');
  input.setAttribute('type', 'file');
  input.setAttribute('accept', '.json');
  input.setAttribute('style', 'display: none');

  input.addEventListener('change', ({ target }) => {
    const file = (target as HTMLInputElement).files?.[0];
    if (!file) {
      return;
    }
    file
      .text()
      .then((text) => onImport(text))
      .catch((error) => console.error('Error reading the settings file', error))
      .finally(() => input.remove());
  });
  document.body.append(input);
  input.click();
};
