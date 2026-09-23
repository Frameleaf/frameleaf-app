<script lang="ts">
  /**
   * The page tools of one settings section (FL-66), the template's `.cc-page-tools`. Every page
   * edits one settings draft and the settings bar saves them together, so a page no longer saves
   * on its own: "Reset this page" puts the section's defaults into the draft for review.
   *
   * `onBeforeSave` (a confirmation or a fix-up) runs before any save that changes one of `keys`;
   * resolving false stops that save and keeps the draft.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { getSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import type { AdminConfigDto } from '@immich/sdk';
  import { t } from 'svelte-i18n';

  type Props = {
    disabled?: boolean;
    keys: Array<keyof AdminConfigDto>;
    onBeforeSave?: () => boolean | Promise<boolean>;
  };

  let { disabled, keys, onBeforeSave }: Props = $props();

  const settingsDraft = getSystemConfigDraft();

  $effect(() => {
    const beforeSave = onBeforeSave;
    if (!settingsDraft || !beforeSave) {
      return;
    }
    return settingsDraft.registerGuard({ keys, beforeSave: () => beforeSave() });
  });

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
    margin-top: 1.25rem;
    padding-top: 0.875rem;
    border-top: 1px solid var(--fl-border);
  }
  .page-tools :global(button) {
    font-size: var(--fl-font-small);
  }
</style>
