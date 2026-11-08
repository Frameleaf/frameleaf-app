import { getICloudSyncActivity } from '@frameleaf/sdk';
import { modalManager } from '@frameleaf/ui';
import { t } from 'svelte-i18n';
import { get } from 'svelte/store';

/** Before iCloud Photos is turned off: warns when syncs are unfinished. Resolves false to keep it on. */
export const confirmICloudOff = async (): Promise<boolean> => {
  let running = 0;
  try {
    ({ running } = await getICloudSyncActivity());
  } catch {
    // The warning is a courtesy: being unable to count must not stop an administrator turning this off.
    return true;
  }
  if (running === 0) {
    return true;
  }
  const translate = get(t);
  return modalManager.showDialog({
    title: translate('frameleaf_icloud_setting_running_title'),
    prompt: translate('frameleaf_icloud_setting_running', { values: { count: running } }),
    confirmText: translate('frameleaf_icloud_setting_running_confirm'),
  });
};
