<script lang="ts">
  import Menu from '$lib/components/frameleaf/Menu.svelte';
  import MenuItem from '$lib/components/frameleaf/MenuItem.svelte';
  import { flattenAlbumTargets, loadAlbumTargets } from '$lib/frameleaf/album-targets';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { uploadManager } from '$lib/managers/upload-manager.svelte';
  import { fileUploadHandler, openFilePicker } from '$lib/utils/file-uploader';
  import { handleError } from '$lib/utils/handle-error';
  import { Icon } from '@immich/ui';
  import { mdiFolderOutline, mdiImageMultipleOutline, mdiTrayArrowUp } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  /**
   * Top bar upload control (FL-45), ported from the prototype's `UploadButton` in
   * `UploadPanel.jsx`. Offers file and whole-folder selection plus an explicit album
   * target, all handed to the real upload manager (`fileUploadHandler`) — nothing here
   * simulates a transfer. `defaultAlbumId` seeds the target with the album the caller is
   * already viewing, matching the drag-and-drop overlay's existing route-based default;
   * the person can still pick a different album or none from the menu.
   */
  let {
    defaultAlbumId,
    isLockedAssets = false,
  }: {
    defaultAlbumId?: string;
    isLockedAssets?: boolean;
  } = $props();

  type Target = { id: string; name: string };

  let targets: Target[] = $state([]);
  // Follows the page's album; a pick in the menu overrides it until the page's album changes.
  let target = $derived(defaultAlbumId ?? '');
  let open = $state(false);

  onMount(async () => {
    try {
      // A collection groups albums and is not itself a place to add photos; only albums and shared
      // spaces the person may add to are valid upload targets (the same list "Add to album" offers).
      const directory = await loadAlbumTargets(authManager.user.id, $t('unnamed_album'));
      targets = flattenAlbumTargets(directory)
        .map(({ id, name }) => ({ id, name }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      handleError(error, $t('errors.frameleaf_unable_to_load_albums'));
    }
  });

  const targetLabel = $derived(targets.find((entry) => entry.id === target)?.name);

  const pick = async (directory: boolean) => {
    const extensions = uploadManager.getExtensions();
    const files = await openFilePicker({
      multiple: true,
      extensions: directory ? undefined : extensions,
      directory,
    });
    if (files.length === 0) {
      return;
    }
    await fileUploadHandler({ files, albumId: target || undefined, isLockedAssets });
  };
</script>

<div class="upload-menu">
  <Menu label={$t('upload')} bind:open>
    {#snippet trigger()}
      <Icon icon={mdiTrayArrowUp} size="20" aria-hidden="true" />
      <!-- The prototype labels the button on wide screens; the trigger's name is `label` either way. -->
      <span class="upload-label" aria-hidden="true">{$t('upload')}</span>
    {/snippet}

    <MenuItem onSelect={() => pick(false)}>
      <Icon icon={mdiImageMultipleOutline} size="18" aria-hidden="true" />
      <span class="item-text">
        <strong>{$t('frameleaf_transfer_upload_files')}</strong>
        <small>{$t('frameleaf_transfer_upload_files_hint')}</small>
      </span>
    </MenuItem>
    <MenuItem onSelect={() => pick(true)}>
      <Icon icon={mdiFolderOutline} size="18" aria-hidden="true" />
      <span class="item-text">
        <strong>{$t('frameleaf_transfer_upload_folder')}</strong>
        <small>{$t('frameleaf_transfer_upload_folder_hint')}</small>
      </span>
    </MenuItem>

    {#if targets.length > 0}
      <div class="target">
        <label for="upload-target-select">{$t('frameleaf_transfer_add_to')}</label>
        <select id="upload-target-select" bind:value={target}>
          <option value="">{$t('frameleaf_transfer_library_only')}</option>
          {#each targets as entry (entry.id)}
            <option value={entry.id}>{entry.name}</option>
          {/each}
        </select>
        {#if targetLabel}
          <span class="hint">{$t('frameleaf_transfer_new_target_hint', { values: { album: targetLabel } })}</span>
        {/if}
      </div>
    {/if}
  </Menu>
</div>

<style>
  .upload-menu :global(.menu-root > button) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 44px;
    padding: 0.375rem;
    color: var(--fl-text, inherit);
    background: transparent;
    border: 1px solid transparent;
    border-radius: 999px;
  }
  .upload-menu :global(.menu-root > button:hover) {
    background: var(--fl-raised, rgb(0 0 0 / 6%));
  }
  .upload-menu :global(.menu-root > button) {
    gap: 0.375rem;
  }
  .upload-label {
    display: none;
    font-size: 0.875rem;
  }
  /* The prototype hides the label at 1000px and below. */
  @media (min-width: 62.5625rem) {
    .upload-label {
      display: inline;
    }
  }
  .item-text {
    display: flex;
    flex-direction: column;
    gap: 0.05rem;
    text-align: start;
  }
  .item-text small {
    color: var(--fl-muted);
    font-size: 0.75rem;
  }
  .target {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    padding: 0.5rem 0.625rem 0.375rem;
    margin-top: 0.25rem;
    border-top: 1px solid var(--fl-border);
    font-size: 0.75rem;
    color: var(--fl-muted);
  }
  .target select {
    padding: 0.35rem 0.5rem;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    font-size: 0.8125rem;
  }
  .target .hint {
    font-size: 0.6875rem;
  }
</style>
