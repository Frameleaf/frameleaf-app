<script lang="ts">
  /**
   * The recovery kit for a key this server generated (FL-160): the prototype's "Recovery kit" step
   * (design/frameleaf/template/src/FrameleafCloud.jsx, `BackupSetup`). Shown once: the kit holds the key
   * as its recovery code, and the server never returns the key again. Download and Print keep a copy;
   * setup carries on only once the administrator confirms they did.
   */
  import './frameleaf-cloud.css';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import CloudBanner from '$lib/components/frameleaf/cloud/CloudBanner.svelte';
  import { downloadBlob } from '$lib/utils';
  import { Icon } from '@immich/ui';
  import { mdiDownloadOutline, mdiFileDocumentOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    kit: string;
    saved: boolean;
    onSavedChange: (saved: boolean) => void;
  };

  let { kit, saved, onSavedChange }: Props = $props();

  const download = () => downloadBlob(new Blob([kit], { type: 'text/plain' }), 'frameleaf-recovery-kit.txt');

  /** Prints the kit alone, from a hidden frame that is removed again. */
  const print = () => {
    const frame = document.createElement('iframe');
    frame.style.display = 'none';
    document.body.append(frame);
    const printed = frame.contentDocument;
    if (printed) {
      const pre = printed.createElement('pre');
      pre.textContent = kit;
      printed.body.append(pre);
      frame.contentWindow?.print();
    }
    frame.remove();
  };
</script>

<CloudBanner tone="warning" title={$t('frameleaf_cloud_backup_kit_once_title')}>
  {$t('frameleaf_cloud_backup_kit_once_body')}
</CloudBanner>
<pre class="fc-kit" data-testid="recovery-kit">{kit}</pre>
<div class="fc-actions">
  <Button onclick={download}>
    <Icon icon={mdiDownloadOutline} size="18" />
    {$t('frameleaf_cloud_backup_download')}
  </Button>
  <Button onclick={print}>
    <Icon icon={mdiFileDocumentOutline} size="18" />
    {$t('frameleaf_cloud_backup_print')}
  </Button>
</div>
<label class="fc-confirm">
  <input type="checkbox" checked={saved} onchange={(event) => onSavedChange(event.currentTarget.checked)} />
  {$t('frameleaf_cloud_backup_kit_saved')}
</label>
