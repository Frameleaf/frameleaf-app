<script lang="ts">
  /**
   * Frameleaf Explore destination (FL-50). The Frameleaf UI is the only UI here now: see
   * `$lib/components/frameleaf/ExplorePanel.svelte` for the section layout and
   * `$lib/frameleaf/explore.ts` for the shortcut/quality-score adapters it is built on. Every
   * section is real, already-accessible data gathered by `+page.ts` — there is no sample or
   * fixture data anywhere in this path.
   */
  import ExplorePanel from '$lib/components/frameleaf/ExplorePanel.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { Route } from '$lib/route';
  import { getAssetMediaUrl, memoryLaneTitle } from '$lib/utils';
  import { getAltText } from '$lib/utils/thumbnail-util';
  import { getNextAsset, getPreviousAsset } from '$lib/utils/asset-utils';
  import { toTimelineAsset } from '$lib/utils/timeline-util';
  import { getAssetInfo } from '@immich/sdk';
  import Portal from '$lib/elements/Portal.svelte';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  // Kept `$state` (not read straight off `data`) so a thumbnail-ready event can bump a
  // person's `updatedAt` in place and the avatar picks up the freshly generated image
  // without a full reload — the same cache-busting the legacy page relied on.
  let peopleCards = $state(data.peopleCards);
  const onPersonThumbnailReady = ({ id }: { id: string }) => {
    for (const card of peopleCards) {
      if (card.person.id === id) {
        card.person.updatedAt = new Date().toISOString();
      }
    }
  };

  let memories = $derived(
    data.memories.map((memory) => ({
      id: memory.id,
      title: $memoryLaneTitle(memory),
      href: Route.viewMemory({ id: memory.id, assetId: memory.assets[0].id }),
      alt: $getAltText(toTimelineAsset(memory.assets[0])),
      src: getAssetMediaUrl({ id: memory.assets[0].id }),
      count: memory.assets.length,
    })),
  );

  const onViewAsset = async (id: string) => {
    const asset = await getAssetInfo({ ...authManager.params, id });
    assetViewerManager.setAsset(asset);
  };

  /**
   * V-17: an item opened from "Recent captures" steps through that row, with its filmstrip; anything
   * else opens on its own. The address carries no item here, so the viewer moves by opening the
   * neighbour in place.
   */
  const recents = $derived(
    assetViewerManager.asset && data.recentCaptures.some(({ id }) => id === assetViewerManager.asset!.id)
      ? data.recentCaptures
      : [],
  );
  const assetCursor = $derived({
    current: assetViewerManager.asset!,
    nextAsset: getNextAsset(recents, assetViewerManager.asset),
    previousAsset: getPreviousAsset(recents, assetViewerManager.asset),
  });
  const filmstripAssets = $derived(recents.map((asset) => toTimelineAsset(asset)));
  const openInPlace = async ({ id }: { id: string }) => {
    assetViewerManager.setAsset(
      recents.find((asset) => asset.id === id) ?? (await getAssetInfo({ ...authManager.params, id })),
    );
  };
</script>

<OnEvents {onPersonThumbnailReady} />

<UserPageLayout title={data.meta.title}>
  <ExplorePanel
    people={peopleCards}
    places={data.places}
    things={data.things}
    recents={data.recentCaptures}
    libraryTotal={data.libraryTotal}
    {memories}
    albums={data.albums}
    bestPhotos={data.bestPhotosPreview}
    shortcutCounts={data.shortcutCounts}
    {onViewAsset}
  />
</UserPageLayout>

{#if assetViewerManager.isViewing}
  {#await import('$lib/components/asset-viewer/AssetViewer.svelte') then { default: AssetViewer }}
    <Portal target="body">
      <AssetViewer
        cursor={assetCursor}
        showNavigation={recents.length > 1}
        {filmstripAssets}
        onNavigateToAsset={openInPlace}
        onClose={() => assetViewerManager.showAssetViewer(false)}
        onAssetUpdate={(updatedAsset) => {
          // assetCursor is `$derived` from `assetViewerManager.asset`. Mutating cursor.current
          // locally would be lost on the next recompute; push the refreshed asset into the
          // manager so the derived cursor recomputes and the viewer reflects the change.
          assetViewerManager.setAsset(updatedAsset);
        }}
      />
    </Portal>
  {/await}
{/if}
