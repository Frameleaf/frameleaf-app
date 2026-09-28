<script lang="ts">
  /**
   * The page tools of one settings section (FL-66), the template's `.cc-page-tools`. Every page
   * edits one settings draft and the settings bar saves them together, so a page no longer saves
   * on its own: "Reset this page" puts the section's defaults into the draft for review. Checks
   * that must run before a save are registered by the settings page, so they run whichever area
   * is open.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { getSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import type { AdminConfigDto } from '@immich/sdk';
  import { t } from 'svelte-i18n';

  type Props = {
    disabled?: boolean;
    keys: Array<keyof AdminConfigDto>;
  };

  let { disabled, keys }: Props = $props();

  const settingsDraft = getSystemConfigDraft();

  const resetPage = () => settingsDraft?.resetSection(keys);
</script>

{#if settingsDraft}
  <div class="page-tools">
    <Button {disabled} onclick={resetPage}>{$t('frameleaf_settings_draft_reset_page')}</Button>
  </div>
{/if}

<style>
  .page-tools {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 1rem;
    /* apple-style.css:1031-1034 `.cc-page-tools` */
    padding: 12px 0;
    border-top: 1px solid var(--fl-border);
  }
  .page-tools :global(button) {
    font-size: var(--fl-font-small);
  }
</style>
