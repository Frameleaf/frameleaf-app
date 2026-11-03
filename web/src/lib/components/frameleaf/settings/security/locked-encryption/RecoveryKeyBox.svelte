<script lang="ts">
  /**
   * FL-721 (prototype `TurnOn` recovery step, spec §11): the recovery key the server returned once,
   * with Download (a `frameleaf-recovery-key-<name>.txt` made in the browser), Copy and Print, and the
   * tick that says it is saved. The key is never stored or sent anywhere from here.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { downloadTextFile, printRecoveryKey, recoveryKeyFileName } from '$lib/frameleaf/locked-encryption';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { Icon } from '@frameleaf/ui';
  import { mdiContentCopy, mdiDownload, mdiPrinterOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import './locked-encryption.css';

  let { recoveryKey, saved = $bindable(false) }: { recoveryKey: string; saved?: boolean } = $props();

  let said = $state('');

  const fileLines = () => [
    $t('frameleaf_le_key_file_title'),
    recoveryKey,
    $t('frameleaf_le_key_file_body'),
    $t('frameleaf_le_key_file_account', { values: { name: authManager.user.name, email: authManager.user.email } }),
  ];

  const download = () => {
    const name = recoveryKeyFileName(authManager.user.name);
    downloadTextFile(name, `${fileLines().join('\n\n')}\n`);
    said = $t('frameleaf_le_key_downloaded', { values: { file: name } });
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(recoveryKey);
      said = $t('frameleaf_le_key_copied');
    } catch {
      said = $t('frameleaf_le_key_copy_failed');
    }
  };
  const print = () => {
    if (!printRecoveryKey($t('frameleaf_le_key_file_title'), fileLines())) {
      said = $t('frameleaf_le_key_print_blocked');
    }
  };
</script>

<div class="le-key">
  <code>{recoveryKey}</code>
  <div class="le-inline">
    <Button onclick={download}>
      <Icon icon={mdiDownload} size="16" aria-hidden />
      {$t('frameleaf_le_key_download')}
    </Button>
    <Button onclick={() => void copy()}>
      <Icon icon={mdiContentCopy} size="16" aria-hidden />
      {$t('frameleaf_le_key_copy')}
    </Button>
    <Button onclick={print}>
      <Icon icon={mdiPrinterOutline} size="16" aria-hidden />
      {$t('frameleaf_le_key_print')}
    </Button>
  </div>
  <small role="status">{said}</small>
</div>
<label class="le-check">
  <input type="checkbox" bind:checked={saved} />
  {$t('frameleaf_le_key_saved_check')}
</label>
