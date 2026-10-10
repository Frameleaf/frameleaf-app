<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import Portal from '$lib/elements/Portal.svelte';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { websocketEvents } from '$lib/stores/websocket';
  import { getAssetMediaUrl, handlePromiseError } from '$lib/utils';
  import { navigate } from '$lib/utils/navigation';
  import { toTimelineAsset } from '$lib/utils/timeline-util';
  import {
    AssetMediaSize,
    AssetTypeEnum,
    getReceivedItemShares,
    NotificationType,
    type AssetResponseDto,
    type ItemShareReceivedDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiPlayCircleOutline } from '@mdi/js';
  import { onDestroy, onMount, tick } from 'svelte';
  import { t } from 'svelte-i18n';

  /**
   * Sharing › Shared with you (FL-83 AL-30b, owner decision 2026-09-27): the items people in this
   * library shared with you one by one, from the prototype's "Share with people in this library"
   * ("They see it in their own Frameleaf. Nothing leaves this server.", `SharedLinks.jsx:533-535`).
   *
   * Grouped by who shared them, newest share first. `?assetId=` opens an item in the viewer over the
   * page, as the Command Center does, and the viewer moves through these items only. The server
   * leaves out anything that is locked, trashed or no longer shared, and a revoke on another device
   * drops the item here at once (`on_asset_hidden`). Share notifications link here with
   * `?section=shared-with-you`.
   */
  let items = $state<ItemShareReceivedDto[]>([]);
  let loaded = $state(false);
  let loading = $state(false);
  let loadFailed = $state(false);
  let section = $state<HTMLElement>();
  let loadId = 0;
  let hiddenDuringLoad = new Set<string>();

  const assets = $derived(items.map((item) => item.asset));
  const groups = $derived.by(() => {
    const byOwner = new Map<string, { owner: ItemShareReceivedDto['owner']; items: ItemShareReceivedDto[] }>();
    for (const item of items) {
      const group = byOwner.get(item.owner.id) ?? { owner: item.owner, items: [] };
      group.items.push(item);
      byOwner.set(item.owner.id, group);
    }
    return [...byOwner.values()];
  });

  const load = async () => {
    const request = ++loadId;
    hiddenDuringLoad = new Set();
    loading = true;
    try {
      const response = await getReceivedItemShares();
      if (request === loadId) {
        items = response.items.filter((item) => !hiddenDuringLoad.has(item.asset.id));
        loadFailed = false;
      }
    } catch {
      // Said once, inline, with Try again; no toast on top of it.
      if (request === loadId) {
        loadFailed = true;
      }
    } finally {
      if (request === loadId) {
        loaded = true;
        loading = false;
      }
    }
  };

  onMount(async () => {
    await load();
    if (page.url.searchParams.get('section') === 'shared-with-you') {
      await tick();
      section?.scrollIntoView({ block: 'start' });
    }
  });

  /* The viewer, opened from the address (`?assetId=`) ------------------------------------------ */
  onDestroy(() => assetViewerManager.showAssetViewer(false));
  const openId = $derived(page.url.searchParams.get('assetId'));
  $effect(() => {
    const asset = openId ? assets.find(({ id }) => id === openId) : undefined;
    if (asset) {
      assetViewerManager.setAsset(asset);
    } else if (loaded) {
      assetViewerManager.showAssetViewer(false);
    }
  });

  const cursor = $derived.by(() => {
    const current = assetViewerManager.asset;
    const index = current ? assets.findIndex(({ id }) => id === current.id) : -1;
    return {
      current: current!,
      nextAsset: index === -1 ? undefined : assets[index + 1],
      previousAsset: index > 0 ? assets[index - 1] : undefined,
    };
  });
  const filmstripAssets = $derived(assets.map((asset) => toTimelineAsset(asset)));
  const showViewer = $derived(
    assetViewerManager.isViewing && !!assetViewerManager.asset && assets.some(({ id }) => id === openId),
  );

  const open = (asset: AssetResponseDto) => handlePromiseError(navigate({ targetRoute: 'current', assetId: asset.id }));
  const closeViewer = () => {
    assetViewerManager.showAssetViewer(false);
    const params = new URLSearchParams(page.url.search);
    params.delete('assetId');
    const query = params.toString();
    handlePromiseError(goto(`${page.url.pathname}${query ? `?${query}` : ''}`, { noScroll: true, keepFocus: true }));
  };

  // A share revoked (or an item locked) elsewhere: drop it, and close the viewer if it was open.
  onDestroy(
    websocketEvents.on('on_asset_hidden', (assetId) => {
      hiddenDuringLoad.add(assetId);
      items = items.filter((item) => item.asset.id !== assetId);
      if (openId === assetId) {
        closeViewer();
      }
    }),
  );
  onDestroy(
    websocketEvents.on('on_notification', (notification) => {
      if (notification.type === NotificationType.ItemShare) {
        void load();
      }
    }),
  );

  const thumbnail = (asset: AssetResponseDto) =>
    getAssetMediaUrl({ id: asset.id, size: AssetMediaSize.Thumbnail, cacheKey: asset.thumbhash });
</script>

<section class="swy" id="shared-with-you" aria-labelledby="swy-title" bind:this={section}>
  <header>
    <h2 id="swy-title">{$t('frameleaf_sharing.shared_with_you_title')}</h2>
    <p>{$t('frameleaf_sharing.shared_with_you_intro')}</p>
  </header>

  {#if loadFailed}
    <div class="swy-error">
      <InlineError
        compact
        message={$t('frameleaf_sharing.shared_with_you_load_failed')}
        onRetry={load}
        retrying={loading}
      />
    </div>
  {:else if loaded && items.length === 0}
    <p class="swy-empty" role="status">{$t('frameleaf_sharing.shared_with_you_empty')}</p>
  {/if}

  {#each groups as group (group.owner.id)}
    <div
      class="swy-group"
      role="group"
      aria-label={$t('frameleaf_sharing.shared_with_you_from', { values: { name: group.owner.name } })}
    >
      <h3>
        {$t('frameleaf_sharing.shared_with_you_from', { values: { name: group.owner.name } })}
        <small>{$t('frameleaf_sharing.individual_items', { values: { count: group.items.length } })}</small>
      </h3>
      <ul class="swy-grid">
        {#each group.items as item (item.id)}
          <li>
            <button
              type="button"
              class="swy-tile"
              aria-label={item.asset.originalFileName}
              onclick={() => open(item.asset)}
            >
              <img src={thumbnail(item.asset)} alt="" loading="lazy" draggable="false" />
              {#if item.asset.type === AssetTypeEnum.Video}
                <span class="swy-play" aria-hidden="true"><Icon icon={mdiPlayCircleOutline} size="28" /></span>
              {/if}
            </button>
          </li>
        {/each}
      </ul>
    </div>
  {/each}
</section>

{#if showViewer}
  {#await import('$lib/components/asset-viewer/AssetViewer.svelte') then { default: AssetViewer }}
    <Portal target="body">
      <AssetViewer
        {cursor}
        showNavigation={assets.length > 1}
        {filmstripAssets}
        onClose={closeViewer}
        onAssetUpdate={(updated) => assetViewerManager.setAsset(updated)}
      />
    </Portal>
  {/await}
{/if}

<style>
  .swy {
    margin: 2rem 1rem 3rem;
    scroll-margin-top: 5rem;
  }
  .swy header h2 {
    margin: 0;
    font-size: 1.125rem;
    font-weight: 600;
  }
  .swy header p,
  .swy-empty {
    margin: var(--fl-space-2) 0 0;
    color: var(--fl-muted);
    font-size: 0.875rem;
  }
  .swy-error {
    margin-top: 1rem;
  }
  .swy-group {
    margin-top: 1.25rem;
  }
  .swy-group h3 {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    margin: 0 0 0.5rem;
    font-size: 0.9375rem;
    font-weight: 600;
  }
  .swy-group h3 small {
    color: var(--fl-muted);
    font-weight: 400;
  }
  .swy-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(8rem, 1fr));
    gap: 0.25rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .swy-tile {
    position: relative;
    display: block;
    width: 100%;
    aspect-ratio: 1;
    padding: 0;
    overflow: hidden;
    border: 0;
    border-radius: var(--fl-radius);
    background: var(--fl-raised);
    cursor: pointer;
  }
  .swy-tile img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .swy-tile:focus-visible {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }
  .swy-play {
    position: absolute;
    inset: auto 0.375rem 0.375rem auto;
    color: white;
    filter: drop-shadow(0 1px 2px rgb(0 0 0 / 0.5));
  }
</style>
