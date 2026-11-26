import type { ServerFeaturesDto, AdminConfigDto } from '@frameleaf/sdk';
import type { ActionItem } from '@frameleaf/ui';
import { mdiContentCopy, mdiDownload, mdiUpload } from '@mdi/js';
import type { MessageFormatter } from 'svelte-i18n';
import { redactConfigForExport } from '$lib/frameleaf/system-config-draft';
import { copyToClipboard, downloadJson } from '$lib/utils';

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
