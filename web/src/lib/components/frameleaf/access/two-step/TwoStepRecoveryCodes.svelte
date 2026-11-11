<script lang="ts">
  /**
   * FL-831: ten recovery codes with Download (.txt) and Print, and "I saved them somewhere safe" before
   * Done (the FL-776 prototype's `RecoveryCodes`). The codes live only in the open dialog: the server
   * never shows them again and the page never asks for them.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { serverConfigManager } from '$lib/managers/server-config-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { downloadRecoveryCodes, printRecoveryCodes, recoveryCodesText } from '$lib/frameleaf/two-step';
  import { Icon } from '@frameleaf/ui';
  import { mdiDownload, mdiPrinterOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  let { codes, saved = $bindable(false) }: { codes: string[]; saved?: boolean } = $props();

  const text = () =>
    recoveryCodesText(codes, {
      email: authManager.user.email,
      server: serverConfigManager.value.externalDomain || location.origin,
      heading: $t('frameleaf_two_step_file_heading'),
      note: $t('frameleaf_two_step_file_note'),
    });
</script>

<ol class="ts-codes" aria-label={$t('frameleaf_two_step_codes')}>
  {#each codes as code (code)}
    <li>{code}</li>
  {/each}
</ol>
<div class="ts-actions">
  <Button onclick={() => downloadRecoveryCodes(text())}
    ><Icon icon={mdiDownload} size="1.1em" aria-hidden />{$t('frameleaf_two_step_download')}</Button
  >
  <Button onclick={() => printRecoveryCodes(text(), $t('frameleaf_two_step_file_heading'))}
    ><Icon icon={mdiPrinterOutline} size="1.1em" aria-hidden />{$t('frameleaf_two_step_print')}</Button
  >
</div>
<label class="ts-saved">
  <input type="checkbox" bind:checked={saved} />
  <span>
    {$t('frameleaf_two_step_saved')}
    <small>{$t('frameleaf_two_step_saved_hint')}</small>
  </span>
</label>
