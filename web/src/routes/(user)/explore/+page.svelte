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
  let people = $state(data.people.people);
  const onPersonThumbnailReady = ({ id }: { id: string }) => {
    for (const person of people) {
      if (person.id === id) {
        person.updatedAt = new Date().toISOString();
      }
    }
  };

  const getFieldItems = (field: string) => data.explore.find((item) => item.fieldName === field)?.items ?? [];

  let places = $derived(getFieldItems('exifInfo.city'));
  let recents = $derived(
    getFieldItems('createdAt')
      .sort((a, b) => new Date(b.value).getTime() - new Date(a.value).getTime())
      .map((item) => item.data),
  );
  let memories = $derived(
    data.memories.map((memory) => ({
      id: memory.id,
      title: $memoryLaneTitle(memory),
      href: Route.viewMemory({ id: memory.id, assetId: memory.assets[0].id }),
      alt: $getAltText(toTimelineAsset(memory.assets[0])),
      src: getAssetMediaUrl({ id: memory.assets[0].id }),
    })),
  );

  const onViewAsset = async (id: string) => {
    const asset = await getAssetInfo({ ...authManager.params, id });
    assetViewerManager.setAsset(asset);
  };

  const assetCursor = $derived({
    current: assetViewerManager.asset!,
  });
</script>

<OnEvents {onPersonThumbnailReady} />

<UserPageLayout title={data.meta.title}>
  <ExplorePanel
    {people}
    {places}
    {recents}
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
        showNavigation={false}
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
