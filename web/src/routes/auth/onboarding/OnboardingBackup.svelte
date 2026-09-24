<script lang="ts">
  /**
   * Onboarding → Back up your phone (FL-80 ON-1, O-11): the prototype's phone → server illustration and
   * three points (`AuthScreens.jsx:1073-1110`), in place of the 3-2-1 server backup page.
   */
  import { Icon } from '@immich/ui';
  import { mdiCellphone, mdiServerOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  // This server, as the phone will reach it.
  const serverName = location.host;
</script>

<div class="ob-illustration">
  <div class="ob-device">
    <Icon icon={mdiCellphone} size="40" aria-hidden={true} />
    {$t('frameleaf_onboarding_backup_phone')}
  </div>
  <div class="ob-flow" aria-hidden="true"><i></i><i></i><i></i></div>
  <div class="ob-device">
    <Icon icon={mdiServerOutline} size="40" aria-hidden={true} />
    {serverName}
  </div>
</div>
<p>{$t('frameleaf_onboarding_backup_body')}</p>
<ul class="ob-list">
  <li>
    <strong>{$t('frameleaf_onboarding_backup_choose')}</strong> — {$t('frameleaf_onboarding_backup_choose_detail')}
  </li>
  <li><strong>{$t('frameleaf_onboarding_backup_wifi')}</strong> — {$t('frameleaf_onboarding_backup_wifi_detail')}</li>
  <li>
    <strong>{$t('frameleaf_onboarding_backup_originals')}</strong> — {$t(
      'frameleaf_onboarding_backup_originals_detail',
    )}
  </li>
</ul>
