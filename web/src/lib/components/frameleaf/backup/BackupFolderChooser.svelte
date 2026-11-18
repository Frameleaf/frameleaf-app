<script lang="ts">
  /**
   * "Choose…" for a restore's "Save to another folder" (FL-1666): the folders this server can reach,
   * read the same way as the external folders chooser (`LibraryFormDialog`, FL-365), with its words.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import { browseLibraryFolders, type LibraryFolderBrowseResponseDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiChevronRight, mdiFolderOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  let {
    open = $bindable(false),
    start,
    onChoose,
  }: { open?: boolean; start?: string; onChoose: (path: string) => void } = $props();

  let browsing = $state<LibraryFolderBrowseResponseDto | null>(null);
  let error = $state('');

  const browse = async (path?: string) => {
    error = '';
    try {
      browsing = await browseLibraryFolders({ path });
    } catch (error_) {
      error = getServerErrorMessage(error_) ?? $t('frameleaf_libraries_browse_failed');
    }
  };

  let wasOpen = false;
  $effect(() => {
    if (open && !wasOpen) {
      void browse(start || undefined);
    }
    wasOpen = open;
  });
</script>

<Dialog bind:open title={$t('frameleaf_backup_browse_chooser_title')} closeLabel={$t('close')}>
  {#if error}
    <p class="error" role="alert">{error}</p>
  {:else if browsing}
    <p class="where"><code>{browsing.path}</code></p>
    {#if !browsing.readable}
      <p class="muted">{$t('frameleaf_libraries_browse_unreadable')}</p>
    {/if}
    <ul>
      {#if browsing.parent}
        <li>
          <button type="button" onclick={() => browse(browsing!.parent!)}>{$t('frameleaf_libraries_browse_up')}</button>
        </li>
      {/if}
      {#each browsing.folders as folder (folder.path)}
        <li>
          <button type="button" onclick={() => browse(folder.path)}>
            <Icon icon={mdiFolderOutline} size="18" aria-hidden />
            <span>{folder.name}</span>
            <Icon icon={mdiChevronRight} size="18" aria-hidden />
          </button>
        </li>
      {:else}
        <li class="muted">{$t('frameleaf_libraries_browse_empty')}</li>
      {/each}
    </ul>
  {/if}
  {#snippet actions()}
    <Button onclick={() => (open = false)}>{$t('frameleaf_cloud_cancel')}</Button>
    <Button
      variant="primary"
      disabled={!browsing || browsing.path === '/' || !browsing.readable}
      onclick={() => {
        if (browsing) {
          onChoose(browsing.path);
          open = false;
        }
      }}>{$t('frameleaf_libraries_browse_use')}</Button
    >
  {/snippet}
</Dialog>

<style>
  .where {
    margin: 0 0 var(--fl-space-3);
    overflow-wrap: anywhere;
  }
  .muted,
  .error {
    margin: 0 0 var(--fl-space-3);
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
  }
  .error {
    color: var(--fl-danger);
  }
  ul {
    display: grid;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li + li {
    border-top: 1px solid var(--fl-border);
  }
  button {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--fl-space-3);
    width: 100%;
    min-height: var(--fl-control-height);
    padding: 0 var(--fl-space-2);
    color: var(--fl-text);
    font: inherit;
    font-size: var(--fl-font-callout);
    text-align: start;
    border-radius: var(--fl-radius-control);
  }
  button:hover {
    background: var(--fl-raised);
  }
  button:focus-visible {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }
  span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
