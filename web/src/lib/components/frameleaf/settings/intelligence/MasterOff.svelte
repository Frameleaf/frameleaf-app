<script lang="ts">
  /**
   * Shown on a feature page while the one switch for every feature (`machineLearning.enabled`) is
   * off: this feature's own choices are kept, but nothing is read until that switch is on again.
   */
  import { goto } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { t } from 'svelte-i18n';
</script>

<Notice tone="warn" title={$t('frameleaf_intel_master_off_title')}>
  {$t('frameleaf_intel_master_off_body')}
  {#snippet action()}
    <Button onclick={() => goto(commandCenterUrl('intelligence'))}>{$t('frameleaf_intel_master_off_open')}</Button>
  {/snippet}
</Notice>
