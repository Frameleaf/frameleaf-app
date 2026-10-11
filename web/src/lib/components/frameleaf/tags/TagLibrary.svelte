<script lang="ts">
  /**
   * One tag's page: its header (`TagPageHeader`) above the real library grid bound to the tag, with
   * the viewer. It is the heavy half of the Tags route (the grid, the selection bar, the viewer), so
   * the route's loader fetches it only when a tag is chosen and the list of tags opens without it.
   */
  import LibraryEmptyState from '$lib/components/frameleaf/LibraryEmptyState.svelte';
  import LibraryView from '$lib/components/frameleaf/LibraryView.svelte';
  import TagPageHeader from '$lib/components/frameleaf/tags/TagPageHeader.svelte';
  import TimelineAssetViewer from '$lib/components/timeline/TimelineAssetViewer.svelte';
  import Portal from '$lib/elements/Portal.svelte';
  import { namedArchiveName } from '$lib/frameleaf/archive-name';
  import type { FrameleafTagNode, FrameleafTagTree } from '$lib/frameleaf/tag-tree';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import type { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
  import { navigate } from '$lib/utils/navigation';
  import { AssetVisibility } from '@frameleaf/sdk';
  import { mdiTagOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  interface Props {
    node: FrameleafTagNode;
    tree: FrameleafTagTree;
    /** The selection bar's Tag offers the tags by their full names, as it does on an album. */
    tagOptions: { id: string; name: string }[];
    timelineManager?: TimelineManager;
    /** Items gained or lost the tag, or left the Timeline. */
    onMutated: () => void;
  }

  let { node, tree, tagOptions, timelineManager = $bindable(), onMutated }: Props = $props();

  let viewerInvisible = $state(false);
  // Every Timeline item with the tag, one by one: stacks are not folded here, so the grid shows
  // exactly the items the tag's count is made of, including a tagged photo that is not its stack's cover.
  // Keyed on the tag's id alone: re-reading the tags (a new colour, a new count) must not reload the grid.
  const tagId = $derived(node.id);
  const options = $derived({ visibility: AssetVisibility.Timeline, tagId });
</script>

{#key node.id}
  <LibraryView
    enableRouting
    selectAll="loaded"
    bind:timelineManager
    {options}
    destination={{ kind: 'tag', id: node.id }}
    downloadFileName={namedArchiveName(node.name, $t('frameleaf_archive_name_tag'))}
    {tagOptions}
    {onMutated}
    onOpen={(asset) => void navigate({ targetRoute: 'current', assetId: asset.id })}
  >
    <TagPageHeader {node} {tree} />

    {#snippet empty()}
      <LibraryEmptyState
        icon={mdiTagOutline}
        title={$t('frameleaf_tags_no_photos_title')}
        message={$t('frameleaf_tags_no_photos_message')}
      />
    {/snippet}

    {#snippet viewer()}
      <Portal target="body">
        {#if assetViewerManager.isViewing && timelineManager}
          <TimelineAssetViewer bind:invisible={viewerInvisible} {timelineManager} />
        {/if}
      </Portal>
    {/snippet}
  </LibraryView>
{/key}
