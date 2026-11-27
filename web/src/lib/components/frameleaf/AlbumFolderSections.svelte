<script lang="ts">
  /**
   * FL-1838 (prototype `AlbumPageV2.jsx` `.ap2-section`): below an album's main photos, each folder shown in a section
   * of its own, headed with its name and count. The first few show here; the rest open with the folder's chip.
   */
  import { getAssetMediaUrl } from '$lib/utils';
  import { AssetMediaSize, type AlbumFoldersResponseDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiPlay } from '@mdi/js';
  import { locale, t } from 'svelte-i18n';

  interface Props {
    folders: AlbumFoldersResponseDto;
    onOpen: (assetId: string) => void;
    onShowAll: (folder: string) => void;
  }

  let { folders, onOpen, onShowAll }: Props = $props();
</script>

{#each folders.sections as section (section.name)}
  <section class="fl-album-folder-section" aria-label={section.name}>
    <h2>
      {section.name}<span class="count">{section.count.toLocaleString($locale ?? undefined)}</span>
    </h2>
    <div class="grid">
      {#each section.items as item (item.id)}
        <button type="button" class="tile" onclick={() => onOpen(item.id)}>
          <img src={getAssetMediaUrl({ id: item.id, size: AssetMediaSize.Thumbnail })} alt="" loading="lazy" />
          {#if item.isVideo}
            <span class="badge" aria-label={$t('video')}><Icon icon={mdiPlay} size="14" /></span>
          {/if}
        </button>
      {/each}
    </div>
    {#if section.count > section.items.length}
      <button type="button" class="more fl-control" onclick={() => onShowAll(section.name)}>
        {$t('frameleaf_album_folders_section_more', { values: { count: section.count - section.items.length } })}
      </button>
    {/if}
  </section>
{/each}

<style>
  /* albums-v2.css: sections 24px apart, the heading 12px above its grid, tiles 2px apart as the timeline's. */
  .fl-album-folder-section {
    padding-block: 24px 12px;
  }
  h2 {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 0 12px;
    font-size: var(--fl-font-large, 1.125rem);
    font-weight: 600;
    color: var(--fl-text);
  }
  .count {
    padding: 0 8px;
    font-size: var(--fl-font-small);
    font-weight: 500;
    color: var(--fl-muted);
    background: var(--fl-raised);
    border-radius: 999px;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 2px;
  }
  .tile {
    position: relative;
    aspect-ratio: 1;
    padding: 0;
    border: 0;
    background: var(--fl-raised);
    cursor: pointer;
  }
  .tile img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .tile:focus-visible {
    outline: 2px solid var(--fl-accent);
    outline-offset: -2px;
  }
  .badge {
    position: absolute;
    inset-block-start: 8px;
    inset-inline-start: 8px;
    display: inline-flex;
    padding: 2px 6px;
    color: #fff;
    background: rgb(0 0 0 / 0.55);
    border-radius: 999px;
  }
  .more {
    margin-block-start: 12px;
    padding: 0;
    color: var(--fl-muted);
    background: none;
    border: 0;
    font-size: var(--fl-font-small);
    text-decoration: underline;
    cursor: pointer;
  }
</style>
