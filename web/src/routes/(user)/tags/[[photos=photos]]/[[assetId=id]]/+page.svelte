<script lang="ts">
  /**
   * Tags as collections (FL-46, redesigned). With no tag chosen the page is the index: a card per
   * top-level tag, or the whole tree as a list (`TagIndex`). With one chosen (`?path=<the tag's full
   * name>`, as before, so existing links keep working) it is that tag's page: its header
   * (`TagPageHeader`) above the real library grid bound to the tag, which brings Timeline, Browse
   * and Work, Filter, Slideshow, sorting, selection with the bulk actions, and the viewer on this
   * route (`/tags/photos/<id>?path=…`). That half is `TagLibrary`, which the loader fetches along
   * with the data when a tag is chosen, so the index does not carry the grid and the viewer (FL-139).
   *
   * The tag filter matches a tag and every tag inside it, which is also what the tag's count, cover
   * and dates describe. The loader answers "not found" for a tag that is gone or hidden while the
   * session is locked.
   */
  import { invalidateAll } from '$app/navigation';
  import { scrollMemory, scrollMemoryClearer } from '$lib/actions/scroll-memory';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import TagIndex from '$lib/components/frameleaf/tags/TagIndex.svelte';
  import Theme from '$lib/components/frameleaf/Theme.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import { buildTagTree, tagAndDescendantIds, tagAtPath } from '$lib/frameleaf/tag-tree';
  import type { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
  import { Route } from '$lib/route';
  import { getAssetInfo } from '@frameleaf/sdk';
  import { Theme as AppTheme, themeManager } from '@frameleaf/ui';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  const tree = $derived(buildTagTree(data.tags, data.statistics));
  const node = $derived(tagAtPath(tree, data.path));

  // The tag's page (the grid and the viewer) arrives with the data, and only when a tag is chosen.
  const TagLibrary = $derived(data.TagLibrary);
  let timelineManager = $state<TimelineManager>();
  // The selection bar's Tag offers the tags by their full names, as it does on an album.
  const tagOptions = $derived(data.tags.map(({ id, value }) => ({ id, name: value })));

  // Items gained or lost the tag, or left the Timeline: the counts, covers and dates are re-read.
  const refresh = () => void invalidateAll();

  /**
   * Tags changed on some items (the viewer's information panel says so). An item that no longer
   * carries this tag, or any tag inside it, leaves the grid at once instead of on the next visit.
   * Only a handful are looked up; a larger change is picked up by the re-read alone.
   */
  const onAssetsTag = async (ids: string[]) => {
    refresh();
    if (!node || !timelineManager || ids.length > 12) {
      return;
    }
    const carried = new Set(tagAndDescendantIds(node));
    try {
      const assets = await Promise.all(ids.map((id) => getAssetInfo({ id })));
      const gone = assets.filter((asset) => (asset.tags ?? []).every((tag) => !carried.has(tag.id)));
      if (gone.length > 0) {
        timelineManager.removeAssets(gone.map((asset) => asset.id));
      }
    } catch {
      // The counts above are re-read either way; the grid catches up when the page is next opened.
    }
  };
</script>

<OnEvents {onAssetsTag} onAssetsDelete={refresh} onAssetsArchive={refresh} onAssetsUnarchive={refresh} />

{#if node && TagLibrary}
  <!--
    The same shell as Photos: the header scrolls away with the photos under it. LibraryView is the
    page area's own child, so it carries the page gutter and the header spans the page (DISCOVERY-P4).
  -->
  <UserPageLayout scrollbar={false} use={[[scrollMemoryClearer, { routeStartsWith: Route.tags() }]]}>
    <TagLibrary {node} {tree} {tagOptions} bind:timelineManager onMutated={refresh} />
  </UserPageLayout>
{:else}
  <!-- Back from a tag finds the index where it was left, as the Albums page does. -->
  <UserPageLayout scrollbar={true} use={[[scrollMemory, { routeStartsWith: Route.tags() }]]}>
    <Theme theme={themeManager.value === AppTheme.Dark ? 'dark' : 'light'}>
      <!-- The page surface reaches the foot of the window however few tags there are. -->
      <div class="fl-page-fill">
        <TagIndex {tree} />
      </div>
    </Theme>
  </UserPageLayout>
{/if}

<style>
  /* As on the Albums page: everything below the top bar, less the layout's gutter above and below. */
  .fl-page-fill {
    min-height: calc(100dvh - var(--fl-topbar-height) - 1rem);
  }
  @media (max-width: 767px) {
    .fl-page-fill {
      min-height: calc(100dvh - var(--fl-topbar-height-phone) - 0.5rem - max(0.5rem, var(--fl-tabbar-space, 0px)));
    }
  }
</style>
