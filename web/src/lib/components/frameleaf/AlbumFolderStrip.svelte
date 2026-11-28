<script lang="ts">
  /**
   * FL-1838 (prototype `AlbumPageV2.jsx`, approved 2026-11-27): on an album made from a folder with folders inside it,
   * a chip for each folder shown narrows the album to it, and "RAW hidden" says what the album leaves out and opens
   * "Folders in this album". Folders with an album of their own inside this one (FL-1837's "album inside") are among
   * the header's albums, so they get no chip.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { AlbumFolderDisplay, type AlbumFoldersResponseDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiEyeOffOutline } from '@mdi/js';
  import { locale, t } from 'svelte-i18n';

  interface Props {
    folders: AlbumFoldersResponseDto;
    /** The folder the album is narrowed to; undefined for all of it. */
    selected?: string;
    onSelect: (folder: string | undefined) => void;
    onOpenSettings?: () => void;
  }

  let { folders, selected, onSelect, onOpenSettings }: Props = $props();

  const chips = $derived(
    folders.folders.filter(
      ({ display }) => display !== AlbumFolderDisplay.Hidden && display !== AlbumFolderDisplay.Album,
    ),
  );
  const hidden = $derived(folders.folders.filter(({ display }) => display === AlbumFolderDisplay.Hidden));
  const count = (value: number) => value.toLocaleString($locale ?? undefined);
</script>

<div class="fl-album-folders" role="toolbar" aria-label={$t('frameleaf_album_folders_title')}>
  <div class="chips" role="group" aria-label={$t('frameleaf_album_folders_show')}>
    <Button pressed={!selected} onclick={() => onSelect(undefined)}>{$t('frameleaf_album_folders_all')}</Button>
    {#each chips as folder (folder.name)}
      <Button
        pressed={selected?.toLowerCase() === folder.name.toLowerCase()}
        onclick={() => onSelect(selected?.toLowerCase() === folder.name.toLowerCase() ? undefined : folder.name)}
      >
        {folder.name}<span class="chip-count">{count(folder.photos + folder.videos)}</span>
      </Button>
    {/each}
  </div>
  {#if hidden.length > 0 && onOpenSettings}
    <Button variant="quiet" onclick={onOpenSettings}>
      <Icon icon={mdiEyeOffOutline} size="16" />
      {$t('frameleaf_album_folders_hidden', { values: { folders: hidden.map(({ name }) => name).join(', ') } })}
    </Button>
  {/if}
</div>

<style>
  /* albums-v2.css `.ap2-folders`: 8px between controls, the hidden button at the end of the row. */
  .fl-album-folders {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding-block: 12px;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .chip-count {
    margin-inline-start: 6px;
    color: var(--fl-muted);
    font-variant-numeric: tabular-nums;
  }
</style>
