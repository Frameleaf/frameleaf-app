<script lang="ts">
  /**
   * FL-831: the QR code and the key to type instead (the FL-776 prototype's `Scan`). The QR holds the
   * authenticator key, so it is drawn locally and offers no copy or download of the picture.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import QrCode from '$lib/components/frameleaf/QrCode.svelte';
  import { groupKey } from '$lib/frameleaf/two-step';
  import { copyToClipboard } from '$lib/utils';
  import { Icon } from '@frameleaf/ui';
  import { mdiContentCopy } from '@mdi/js';
  import { t } from 'svelte-i18n';

  let { otpauthUri, secret }: { otpauthUri: string; secret: string } = $props();
</script>

<div class="ts-scan">
  <QrCode
    value={otpauthUri}
    size={196}
    label={$t('frameleaf_two_step_qr_label')}
    copyLabel=""
    downloadLabel=""
    errorLabel={$t('frameleaf_two_step_qr_error')}
    showActions={false}
  />
  <div class="ts-key">
    <strong>{$t('frameleaf_two_step_scan_cant')}</strong>
    <span class="ts-quiet">{$t('frameleaf_two_step_scan_key_hint')}</span>
    <code aria-label={$t('frameleaf_two_step_scan_key_label')}>{groupKey(secret)}</code>
    <Button onclick={() => void copyToClipboard(secret)}
      ><Icon icon={mdiContentCopy} size="1.1em" aria-hidden />{$t('frameleaf_two_step_copy_key')}</Button
    >
  </div>
</div>
<p class="ts-quiet">{$t('frameleaf_two_step_scan_private')}</p>
