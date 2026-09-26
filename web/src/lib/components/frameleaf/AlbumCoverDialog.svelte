<script lang="ts">
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import Status from '$lib/components/frameleaf/Status.svelte';
  import { handleUpdateAlbumInfo } from '$lib/services/album.service';
  import { getAssetMediaUrl } from '$lib/utils';
  import {
    AssetMediaSize,
    AssetVisibility,
    searchAssets,
    type AlbumResponseDto,
    type AssetResponseDto,
  } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiCheckCircle } from '@mdi/js';
  import { t } from 'svelte-i18n';

  /**
   * Choose the cover of an album, a collection or a shared space (FL-53), ported from
   * `CoverDialog` in `design/frameleaf/template/src/CollectionHeader.jsx`.
   *
   * The choices are the album's own items, read with the existing metadata search rather
   * than a new endpoint; the chosen id is written with `PATCH /albums/{id}`
   * (`albumThumbnailAssetId`). A collection's own items are the union of its albums, so the
   * caller passes those album ids and the cover may come from any of them.
   */
  interface Props {
    album: AlbumResponseDto;
    /** Albums whose items may be used. The album itself for an album, its children for a collection. */
    albumIds: string[];
    open?: boolean;
    onUpdated: (album: AlbumResponseDto) => void;
  }

  let { album, albumIds, open = $bindable(false), onUpdated }: Props = $props();

  const PAGE = 120;

  let assets = $state<AssetResponseDto[]>([]);
  let loading = $state(false);
  let failed = $state(false);
  let choice = $state<string | null>(album.albumThumbnailAssetId);
  let saving = $state(false);

  const load = async () => {
    if (albumIds.length === 0) {
      assets = [];
      return;
    }
    loading = true;
    failed = false;
    try {
      const results = await searchAssets({
        metadataSearchDto: { albumIds, size: PAGE },
      });
      // An album cover is never a Locked photo (owner decision, September 22, 2026); an unlocked
      // session's search includes them, so they are left out of the choices.
      assets = results.assets.items.filter((asset) => asset.visibility !== AssetVisibility.Locked);
    } catch {
      failed = true;
    } finally {
      loading = false;
    }
  };

  $effect(() => {
    if (!open) {
      return;
    }

    choice = album.albumThumbnailAssetId;
    void load();
  });

  const save = async () => {
    if (!choice) {
      return;
    }
    saving = true;
    try {
      const updated = await handleUpdateAlbumInfo(album.id, { albumThumbnailAssetId: choice });
      if (updated) {
        onUpdated(updated);
        open = false;
      }
    } finally {
      saving = false;
    }
  };
</script>

<Dialog title={$t('frameleaf_album_cover_title')} closeLabel={$t('close')} bind:open>
  <div class="cover">
    {#if loading}
      <Status message={$t('loading')} busy />
    {:else if failed}
      <Status message={$t('frameleaf_album_cover_load_failed')} />
      <button type="button" class="retry" onclick={() => void load()}>{$t('retry')}</button>
    {:else if assets.length === 0}
      <Status message={$t('frameleaf_album_cover_empty')} />
    {:else}
      <div class="grid" role="radiogroup" aria-label={$t('frameleaf_album_cover_title')}>
        {#each assets as asset (asset.id)}
          <button
            type="button"
            role="radio"
            aria-checked={choice === asset.id}
            aria-label={asset.originalFileName}
            class:chosen={choice === asset.id}
            onclick={() => (choice = asset.id)}
          >
            <img src={getAssetMediaUrl({ id: asset.id, size: AssetMediaSize.Thumbnail })} alt="" loading="lazy" />
            {#if choice === asset.id}
              <span class="tick" aria-hidden="true"><Icon icon={mdiCheckCircle} size="20" /></span>
            {/if}
          </button>
        {/each}
      </div>
    {/if}
    <div class="buttons">
      <button type="button" disabled={saving} onclick={() => (open = false)}>{$t('cancel')}</button>
      <button type="button" class="primary" disabled={saving || !choice} onclick={() => void save()}>
        {$t('frameleaf_album_cover_use')}
      </button>
    </div>
  </div>
</Dialog>

<style>
  .cover {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    margin-block-start: 1rem;
    width: min(38rem, 100%);
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(5.5rem, 1fr));
    gap: 0.375rem;
    max-height: 22rem;
    overflow-y: auto;
  }
  .grid button {
    position: relative;
    aspect-ratio: 1;
    padding: 0;
    border: 2px solid transparent;
    border-radius: var(--fl-radius);
    overflow: hidden;
    background: var(--fl-raised);
  }
  .grid button.chosen {
    border-color: var(--fl-accent);
  }
  .grid img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .tick {
    position: absolute;
    inset-block-start: 0.25rem;
    inset-inline-end: 0.25rem;
    color: var(--fl-accent);
  }
  .buttons {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }
  .buttons button,
  .retry {
    padding: 0 1rem;
    min-height: 44px;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
  }
  .buttons .primary {
    background: var(--fl-accent);
    border-color: var(--fl-accent);
    color: var(--fl-accent-text);
  }
  .buttons button:disabled {
    opacity: 0.6;
  }
</style>
