<script lang="ts">
  /**
   * The Tags index ("tags as collections"): the Albums page with one card per top-level tag, its
   * cover made from the tag's newest photos, and the tree kept as an optional List view for a
   * library with hundreds of tags. Approved mock: `design/frameleaf/template/src/TagsV2.jsx`.
   *
   * "Find a tag" looks through every tag, nested ones included, and shows the matches as one flat
   * set that says where each sits. Cards or List and the order are remembered on this device, like
   * the Albums page's view. Creating, renaming, recolouring and deleting go through `TagDialog`;
   * moving a tag and tagging photos are on the tag's own page.
   *
   * Counts and covers come from `GET /tags/statistics`: Timeline items only, and a tag hidden while
   * the session is locked is not in the list at all.
   */
  import { goto, invalidateAll } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import EmptyState from '$lib/components/frameleaf/EmptyState.svelte';
  import Menu from '$lib/components/frameleaf/Menu.svelte';
  import MenuItem from '$lib/components/frameleaf/MenuItem.svelte';
  import TagCard from '$lib/components/frameleaf/tags/TagCard.svelte';
  import TagDialog, { type TagDialogRequest } from '$lib/components/frameleaf/tags/TagDialog.svelte';
  import TagTable from '$lib/components/frameleaf/tags/TagTable.svelte';
  import { tagResultMessage, type TagDialogResult } from '$lib/components/frameleaf/tags/tag-messages';
  import {
    normalizeTagsIndexView,
    tagListExpansion,
    tagsIndexView,
    type TagsIndexViewMode,
  } from '$lib/components/frameleaf/tags/tags-view';
  import {
    TAG_SORTS,
    expandableTagIds,
    findTags,
    sortTagNodes,
    tagInsideSummary,
    tagTrail,
    visibleTagRows,
    type FrameleafTagNode,
    type FrameleafTagTree,
    type TagSort,
  } from '$lib/frameleaf/tag-tree';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { Route } from '$lib/route';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiArrowCollapseAll,
    mdiArrowExpandAll,
    mdiDeleteOutline,
    mdiDotsHorizontal,
    mdiMagnify,
    mdiPaletteOutline,
    mdiPencilOutline,
    mdiPlus,
    mdiSortVariant,
    mdiTagOutline,
    mdiTagPlusOutline,
    mdiViewGridOutline,
    mdiViewListOutline,
  } from '@mdi/js';
  import { t } from 'svelte-i18n';

  let { tree }: { tree: FrameleafTagTree } = $props();

  const headingId = $props.id();

  const view = $derived(normalizeTagsIndexView($tagsIndexView));
  const setView = (mode: TagsIndexViewMode) => ($tagsIndexView = { ...view, view: mode });
  const setSort = (sort: TagSort) => ($tagsIndexView = { ...view, sort });
  const sortLabels = $derived<Record<TagSort, string>>({
    used: $t('frameleaf_tags_most_used'),
    name: $t('frameleaf_tags_sort_name'),
    newest: $t('frameleaf_tags_sort_newest'),
  });

  let search = $state('');
  let searchInput = $state<HTMLInputElement>();
  let status = $state('');
  let heading = $state<HTMLHeadingElement>();
  const query = $derived(search.trim());

  const total = $derived(tree.byId.size);
  const groupIds = $derived(expandableTagIds(tree));
  const summary = $derived(
    [
      $t('frameleaf_tags_count', { values: { count: total } }),
      groupIds.length > 0 ? $t('frameleaf_tags_group_count', { values: { count: groupIds.length } }) : '',
    ]
      .filter(Boolean)
      .join(' · '),
  );

  const matches = $derived(query ? findTags(tree, query, view.sort) : null);
  const cards = $derived(matches ?? sortTagNodes(tree.roots, view.sort));

  // The list opens one level deep; what the reader opens or closes after that is kept while the app is open.
  const expanded = tagListExpansion(authManager.authenticated ? authManager.user.id : '', () =>
    tree.roots.map((root) => root.id),
  );
  const rows = $derived(matches ?? visibleTagRows(tree, expanded, view.sort));
  const allExpanded = $derived(groupIds.every((id) => expanded.has(id)));
  const toggle = (node: FrameleafTagNode) => {
    if (expanded.has(node.id)) {
      expanded.delete(node.id);
    } else {
      expanded.add(node.id);
    }
  };
  const toggleAll = () => {
    if (allExpanded) {
      expanded.clear();
    } else {
      for (const id of groupIds) {
        expanded.add(id);
      }
    }
  };

  const noteFor = (node: FrameleafTagNode) => {
    const trail = tagTrail(node);
    if (matches && trail.length > 0) {
      return $t('frameleaf_tags_in_trail', { values: { path: trail.join(' › ') } });
    }
    const { names, more } = tagInsideSummary(node);
    return names.join(' · ') + (more > 0 ? ` +${more}` : '');
  };

  const clearSearch = () => {
    search = '';
    searchInput?.focus();
  };

  // Raw: the request carries tree nodes, which are compared by identity and must not be wrapped.
  let request = $state.raw<TagDialogRequest | null>(null);

  const onDone = async (result: TagDialogResult) => {
    if (result.type === 'created' && result.tag.parentId) {
      expanded.add(result.tag.parentId);
    }
    await invalidateAll();
    status = tagResultMessage($t, result);
  };

  const onDialogClosed = () => {
    request = null;
    // The dialog hands focus back to what opened it. When that was the menu of a tag that has just
    // been deleted there is nothing to hand it to, so the page's heading takes it.
    if (!document.activeElement || document.activeElement === document.body) {
      heading?.focus();
    }
  };
</script>

{#snippet menuFor(node: FrameleafTagNode)}
  <Menu label={$t('frameleaf_tags_actions_for', { values: { name: node.name } })} align="end">
    {#snippet trigger()}
      <Icon icon={mdiDotsHorizontal} size="18" aria-hidden />
    {/snippet}
    <MenuItem onSelect={() => (request = { type: 'rename', node })}>
      <Icon icon={mdiPencilOutline} size="18" aria-hidden />{$t('frameleaf_tags_rename')}
    </MenuItem>
    <MenuItem onSelect={() => (request = { type: 'color', node })}>
      <Icon icon={mdiPaletteOutline} size="18" aria-hidden />{$t('frameleaf_tags_color')}
    </MenuItem>
    <MenuItem onSelect={() => (request = { type: 'create', parentId: node.id })}>
      <Icon icon={mdiTagPlusOutline} size="18" aria-hidden />{$t('frameleaf_tags_new_inside')}
    </MenuItem>
    <div class="menu-separator" role="separator"></div>
    <MenuItem onSelect={() => (request = { type: 'delete', node })}>
      <span class="danger-item"><Icon icon={mdiDeleteOutline} size="18" aria-hidden />{$t('delete')}</span>
    </MenuItem>
  </Menu>
{/snippet}

<section class="tags" aria-labelledby={headingId}>
  <header class="head">
    <div class="heading">
      <h1 id={headingId} tabindex="-1" bind:this={heading}>{$t('tags')}</h1>
      <p>{summary}</p>
    </div>
    <div class="tools">
      <label class="search">
        <Icon icon={mdiMagnify} size="17" aria-hidden />
        <input
          type="search"
          bind:value={search}
          bind:this={searchInput}
          placeholder={$t('frameleaf_tags_find')}
          aria-label={$t('frameleaf_tags_find')}
        />
      </label>
      <div class="sort">
        <Menu label={$t('frameleaf_tags_sort')} align="end">
          {#snippet trigger()}
            <Icon icon={mdiSortVariant} size="17" aria-hidden />
            <span aria-hidden="true">{sortLabels[view.sort]}</span>
          {/snippet}
          {#each TAG_SORTS as sort (sort)}
            <MenuItem checked={view.sort === sort} onSelect={() => setSort(sort)}>{sortLabels[sort]}</MenuItem>
          {/each}
        </Menu>
      </div>
      <div class="view" role="group" aria-label={$t('view')}>
        <button
          type="button"
          aria-pressed={view.view === 'cards'}
          aria-label={$t('frameleaf_tags_view_cards')}
          title={$t('frameleaf_tags_view_cards')}
          onclick={() => setView('cards')}
        >
          <Icon icon={mdiViewGridOutline} size="18" aria-hidden />
        </button>
        <button
          type="button"
          aria-pressed={view.view === 'list'}
          aria-label={$t('frameleaf_tags_view_list')}
          title={$t('frameleaf_tags_view_list')}
          onclick={() => setView('list')}
        >
          <Icon icon={mdiViewListOutline} size="18" aria-hidden />
        </button>
      </div>
      <div class="new">
        <Button variant="primary" onclick={() => (request = { type: 'create', parentId: null })}>
          <Icon icon={mdiPlus} size="18" aria-hidden />
          {$t('frameleaf_tags_new')}
        </Button>
      </div>
    </div>
  </header>

  <p class="status" role="status" aria-live="polite">{status}</p>
  <p class="sr-only" role="status">
    {#if matches}{$t('frameleaf_tags_find_count', { values: { count: matches.length } })}{/if}
  </p>

  {#if total === 0}
    <EmptyState
      icon={mdiTagOutline}
      title={$t('frameleaf_tags_empty_title')}
      message={$t('frameleaf_tags_empty_description')}
      action={{
        label: $t('frameleaf_tags_new'),
        icon: mdiPlus,
        onClick: () => (request = { type: 'create', parentId: null }),
      }}
    />
  {:else if matches && matches.length === 0}
    <EmptyState
      icon={mdiTagOutline}
      title={$t('frameleaf_tags_find_none_title', { values: { query } })}
      message={$t('frameleaf_discovery_find_none_help')}
      secondaryAction={{ label: $t('frameleaf_discovery_find_clear'), onClick: clearSearch }}
    />
  {:else if view.view === 'cards'}
    <div class="grid">
      {#each cards as node (node.id)}
        <TagCard {node} note={noteFor(node)}>
          {#snippet actions()}{@render menuFor(node)}{/snippet}
        </TagCard>
      {/each}
    </div>
  {:else}
    {#if !matches && groupIds.length > 0}
      <div class="table-tools">
        <button type="button" class="text-button" onclick={toggleAll}>
          <Icon icon={allExpanded ? mdiArrowCollapseAll : mdiArrowExpandAll} size="15" aria-hidden />
          {allExpanded ? $t('frameleaf_tags_collapse_all') : $t('frameleaf_tags_expand_all')}
        </button>
      </div>
    {/if}
    <TagTable
      {rows}
      flat={!!matches}
      {expanded}
      onToggle={toggle}
      onOpen={(node) => void goto(Route.tags({ path: node.value }))}
      menu={menuFor}
    />
  {/if}
</section>

{#if request}
  {#key request}
    <TagDialog {request} {tree} {onDone} onClose={onDialogClosed} />
  {/key}
{/if}

<style>
  /*
   * The Albums page's rhythm (AlbumDirectory `.albums`). The search field and the view switch are
   * capsules; the sort menu and New tag keep the app's control corners, as the approved mock draws them.
   */
  .tags {
    padding: 18px 24px 64px;
    color: var(--fl-text);
  }
  .tags > :global(*) {
    max-width: 1400px;
    margin-inline: auto;
  }
  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--fl-space-4) var(--fl-space-5);
    margin-bottom: var(--fl-space-2);
  }
  .heading h1 {
    margin: 0;
    font-size: 1.5rem;
    font-weight: 700;
  }
  /* Focused only by script, when the card that had focus has been deleted. */
  .heading h1:focus {
    outline: none;
  }
  .heading p {
    margin: var(--fl-space-2) 0 0;
    color: var(--fl-muted);
    font-size: 0.875rem;
  }
  .tools {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fl-space-2);
  }
  .search {
    display: flex;
    align-items: center;
    gap: var(--fl-space-2);
    min-width: 15rem;
    padding-inline-start: var(--fl-space-3);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-pill);
    background: var(--fl-panel);
    color: var(--fl-muted);
  }
  .search input {
    flex: 1;
    min-width: 0;
    border: 0;
    background: transparent;
    color: var(--fl-text);
    font: inherit;
  }
  /* The field is the whole capsule, so the capsule wears the one focus ring in the input's place. */
  .search input:focus-visible {
    outline: none;
  }
  .search:has(input:focus-visible) {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }
  /* A two-way switch: the chosen view is the raised half. */
  .view {
    display: inline-flex;
    gap: 2px;
    padding: 3px;
    border-radius: var(--fl-radius-pill);
    background: var(--fl-raised);
  }
  .view button {
    display: grid;
    place-items: center;
    min-width: 42px;
    min-height: 38px;
    padding: 0 6px;
    border: 0;
    border-radius: var(--fl-radius-pill);
    background: transparent;
    color: var(--fl-muted);
  }
  .view button[aria-pressed='true'] {
    background: var(--fl-panel);
    color: var(--fl-text);
    box-shadow: var(--fl-shadow-1);
  }
  /* The line under the header keeps its row, as in the mock, so saying something never moves the cards. */
  .status {
    min-height: 18px;
    margin-block: 0 var(--fl-space-2);
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(164px, 1fr));
    gap: var(--fl-space-5) var(--fl-space-3);
    align-items: start;
  }
  .table-tools {
    display: flex;
    justify-content: flex-end;
    margin-block: 0 var(--fl-space-3);
  }
  /* A text button: its box (seen on focus) has a button's inset, and hangs out so the label ends on the table's edge. */
  .text-button {
    display: inline-flex;
    align-items: center;
    gap: var(--fl-space-2);
    min-height: 30px;
    margin-inline-end: calc(var(--fl-space-3) * -1);
    padding: 0 var(--fl-space-3);
    border: 0;
    border-radius: var(--fl-radius-sm);
    background: transparent;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .text-button:hover {
    color: var(--fl-text);
  }
  .menu-separator {
    height: 1px;
    margin: 0.25rem 0.375rem;
    background: var(--fl-border);
  }
  .danger-item {
    display: inline-flex;
    align-items: center;
    gap: 0.625rem;
    color: var(--fl-danger);
  }
  @media (max-width: 700px) {
    .tags {
      padding: 14px 16px 64px;
    }
    .head {
      flex-direction: column;
      align-items: flex-start;
    }
    .tools {
      width: 100%;
    }
    .search {
      min-width: 0;
      flex: 1 1 100%;
    }
    .new {
      margin-inline-start: auto;
    }
    .grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
  @media (pointer: coarse) {
    .view button {
      min-width: 44px;
      min-height: 42px;
    }
    .text-button {
      min-height: 44px;
    }
  }
</style>
