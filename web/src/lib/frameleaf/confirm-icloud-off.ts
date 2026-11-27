import { getICloudSyncActivity } from '@frameleaf/sdk';
import { t } from 'svelte-i18n';
import { get } from 'svelte/store';
import { confirmFrameleaf } from '$lib/frameleaf/confirm';

/** Before iCloud Photos is turned off: warns when syncs are unfinished. Resolves false to keep it on. */
export const confirmICloudOff = async (): Promise<boolean> => {
  let running: number;
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
  return confirmFrameleaf({
    title: translate('frameleaf_icloud_setting_running_title'),
    prompt: translate('frameleaf_icloud_setting_running', { values: { count: running } }),
    confirmText: translate('frameleaf_icloud_setting_running_confirm'),
    danger: true,
  });
};
