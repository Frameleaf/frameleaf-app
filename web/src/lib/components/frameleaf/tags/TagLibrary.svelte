<script lang="ts">
  /**
   * One tag's page: its header (`TagPageHeader`) above the real library grid bound to the tag, with
   * the viewer. It is the heavy half of the Tags route (the grid, the selection bar, the viewer), so
   * the route's loader fetches it only when a tag is chosen and the list of tags opens without it.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import LibraryEmptyState from '$lib/components/frameleaf/LibraryEmptyState.svelte';
  import LibraryView from '$lib/components/frameleaf/LibraryView.svelte';
  import TagPageHeader from '$lib/components/frameleaf/tags/TagPageHeader.svelte';
  import TimelineAssetViewer from '$lib/components/timeline/TimelineAssetViewer.svelte';
  import Portal from '$lib/elements/Portal.svelte';
  import { namedArchiveName } from '$lib/frameleaf/archive-name';
  import type { FrameleafTagNode, FrameleafTagTree } from '$lib/frameleaf/tag-tree';
  import { ICON_SIZE } from '$lib/frameleaf/tokens';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import type { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
  import { navigate } from '$lib/utils/navigation';
  import { AssetVisibility } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiCheck, mdiTagMultipleOutline, mdiTagOutline } from '@mdi/js';
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

  /**
   * DISCOVERY-P4, TagsV2.jsx "Include tags inside": on a tag with tags inside it, the grid shows the
   * tag and every tag inside it (on, as the count and cover do) or only the items tagged with the tag
   * itself (off). Each tag's page opens with it on.
   */
  const hasInside = $derived(node.children.length > 0);
  let insideChoice = $state<{ id: string; on: boolean }>({ id: '', on: true });
  const inside = $derived(insideChoice.id === node.id ? insideChoice.on : true);
  const directOnly = $derived(hasInside && !inside);

  // Every Timeline item with the tag, one by one: stacks are not folded here, so the grid shows
  // exactly the items the tag's count is made of, including a tagged photo that is not its stack's cover.
  // Keyed on the tag's id alone: re-reading the tags (a new colour, a new count) must not reload the grid.
  const tagId = $derived(node.id);
  const options = $derived({
    visibility: AssetVisibility.Timeline,
    tagId,
    ...(directOnly && { withChildTags: false }),
  });
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

    {#snippet toolbarStart()}
      {#if hasInside}
        <!-- The hint says what the grid shows now, as the prototype's title does. -->
        <span
          class="tag-inside"
          title={inside
            ? $t('frameleaf_tags_include_inside_on', { values: { name: node.name } })
            : $t('frameleaf_tags_include_inside_off', { values: { name: node.name } })}
        >
          <Button pressed={inside} onclick={() => (insideChoice = { id: node.id, on: !inside })}>
            <Icon icon={inside ? mdiCheck : mdiTagMultipleOutline} size={ICON_SIZE.lg} aria-hidden="true" />
            {$t('frameleaf_tags_include_inside')}
          </Button>
        </span>
      {/if}
    {/snippet}

    {#snippet empty()}
      {#if directOnly && node.total > 0}
        <LibraryEmptyState
          icon={mdiTagOutline}
          title={$t('frameleaf_tags_none_itself_title', { values: { name: node.name } })}
          message={$t('frameleaf_tags_none_itself_message')}
        />
      {:else}
        <LibraryEmptyState
          icon={mdiTagOutline}
          title={$t('frameleaf_tags_no_photos_title')}
          message={$t('frameleaf_tags_no_photos_message')}
        />
      {/if}
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

<style>
  /*
   * TagsV2.jsx `.dv2-toolbar`: the count, then a gap, then "Include tags inside" beside Filter. The
   * toolbar's start slot holds it; on a wide screen the slot grows so the switch sits at its far end.
   */
  @media (min-width: 701px) {
    :global(.fl-toolbar-leading):has(> .tag-inside) {
      flex: 1 1 auto;
      justify-content: flex-end;
    }
  }
  .tag-inside {
    display: inline-flex;
  }
</style>
