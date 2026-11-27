<script lang="ts">
  /**
   * FL-1838 (prototype `AlbumPageV2.jsx`, approved 2026-11-27): on an album made from a folder with folders inside it,
   * a chip for each folder shown narrows the album to it, "RAW hidden" says what the album leaves out and opens
   * "Folders in this album", and the folders shown as albums inside this one are tiles that open them.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { getAssetMediaUrl } from '$lib/utils';
  import { AlbumFolderDisplay, AssetMediaSize, type AlbumFoldersResponseDto } from '@frameleaf/sdk';
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

{#if folders.albums.length > 0 && !selected}
  <section class="inside" aria-labelledby="fl-album-folders-inside">
    <h2 id="fl-album-folders-inside">{$t('frameleaf_album_folders_albums_inside')}</h2>
    <div class="albums">
      {#each folders.albums as inside (inside.name)}
        <button type="button" class="album fl-control" onclick={() => onSelect(inside.name)}>
          {#if inside.coverAssetId}
            <img
              src={getAssetMediaUrl({ id: inside.coverAssetId, size: AssetMediaSize.Thumbnail })}
              alt=""
              loading="lazy"
            />
          {:else}
            <span class="cover-empty"></span>
          {/if}
          <span class="album-text">
            <strong>{inside.name}</strong>
            <small>{$t('frameleaf_album_folders_items', { values: { count: inside.count } })}</small>
          </span>
        </button>
      {/each}
    </div>
  </section>
{/if}

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
  /* `.ap2-section`: a section heading 12px above what it heads, 24px between sections. */
  .inside {
    padding-block: 12px 24px;
  }
  h2 {
    margin: 0 0 12px;
    font-size: var(--fl-font-small);
    font-weight: 600;
    color: var(--fl-text);
  }
  .albums {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
  }
  .album {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 16px 8px 8px;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    text-align: start;
  }
  .album img,
  .cover-empty {
    width: 56px;
    height: 56px;
    object-fit: cover;
    border-radius: calc(var(--fl-radius) - 2px);
    background: var(--fl-border);
  }
  .album-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .album-text small {
    color: var(--fl-muted);
  }
</style>
