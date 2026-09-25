<script lang="ts">
  /**
   * Frameleaf Tags browser (FL-46): a port of the prototype's `Tags` screen
   * (`design/frameleaf/template/src/Tags.jsx`, `discovery.css`), built on the real tag API instead
   * of the prototype's localStorage simulation:
   *
   * - create (`POST /tags`, with a parent and a colour), rename, recolour and "Move to top level"
   *   (`PUT /tags/:id` with `name`, `color` or `parentId: null`), delete (`DELETE /tags/:id`);
   * - counts from `GET /tags/statistics` (`$lib/frameleaf/tag-tree`): only Timeline items, so
   *   nothing archived, Locked or hidden, and a tag suppressed while locked is not listed at all;
   * - the chosen tag is the page address (`?path=`), so a deep link opens it and browser Back
   *   returns to the previous one; the keyboard tree is `DiscoveryTree`.
   *
   * "Show all" opens the library at the tag (its subtags included, as the tag filter matches them),
   * where the library's selection and bulk actions apply; tagging items stays in the viewer and the
   * selection bar.
   */
  import '$lib/frameleaf/discovery.css';
  import { goto, invalidateAll } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import DiscoveryTree from '$lib/components/frameleaf/DiscoveryTree.svelte';
  import Menu from '$lib/components/frameleaf/Menu.svelte';
  import MenuItem from '$lib/components/frameleaf/MenuItem.svelte';
  import Status from '$lib/components/frameleaf/Status.svelte';
  import { emptyDiscoveryQuery } from '$lib/components/discovery/query';
  import FormatMessage from '$lib/elements/FormatMessage.svelte';
  import { viewInLibraryHref } from '$lib/frameleaf/library-query-options';
  import {
    DEFAULT_TAG_COLOR,
    TAG_COLORS,
    buildTagTree,
    cleanTagName,
    expandableTagIds,
    flattenTagTree,
    mostUsedTags,
    tagAncestorIds,
    tagAtPath,
    tagBreadcrumbs,
    tagColorHex,
    tagColorId,
    tagDotColor,
    tagIdsRevealingMatches,
    tagMatches,
    tagNameTaken,
    type FrameleafTagNode,
    type TagColorId,
  } from '$lib/frameleaf/tag-tree';
  import { Route } from '$lib/route';
  import { getAssetUrls } from '$lib/utils';
  import { getServerErrorMessage, handleError } from '$lib/utils/handle-error';
  import {
    AssetVisibility,
    createTag,
    deleteTag,
    searchAssets,
    updateTag,
    type AssetResponseDto,
    type TagResponseDto,
    type TagStatisticsResponseDto,
  } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import {
    mdiArrowCollapseAll,
    mdiArrowExpandAll,
    mdiArrowUp,
    mdiChevronDown,
    mdiChevronRight,
    mdiDeleteOutline,
    mdiDotsHorizontal,
    mdiImageMultipleOutline,
    mdiImageOutline,
    mdiMagnify,
    mdiPaletteOutline,
    mdiPencilOutline,
    mdiTagOutline,
    mdiTagPlusOutline,
  } from '@mdi/js';
  import { SvelteSet } from 'svelte/reactivity';
  import { t } from 'svelte-i18n';

  interface Props {
    tags: TagResponseDto[];
    statistics: TagStatisticsResponseDto[];
    /** The chosen tag's full value ("Trips/Rockies 2026"), or "" for the overview. */
    path: string;
    /** The chosen tag's preview items, handed to the page so its viewer can open them. */
    covers?: AssetResponseDto[];
  }

  let { tags, statistics, path, covers = $bindable([]) }: Props = $props();

  const COVER_COUNT = 6;

  const tree = $derived(buildTagTree(tags, statistics));
  const node = $derived(tagAtPath(tree, path));
  const allNodes = $derived(flattenTagTree(tree));

  // Branches the reader opened; the chosen tag's ancestors open with it (a deep link shows its row).
  const expanded = new SvelteSet<string>();
  let focusedId = $state<string | null>(null);
  let search = $state('');
  let status = $state('');
  const query = $derived(search.trim().toLowerCase());

  $effect(() => {
    if (node) {
      for (const id of tagAncestorIds(node)) {
        expanded.add(id);
      }
    }
  });
  // Prototype: searching opens every ancestor of a match so it can be seen.
  $effect(() => {
    for (const id of tagIdsRevealingMatches(tree, query)) {
      expanded.add(id);
    }
  });

  const expandable = $derived(expandableTagIds(tree));
  const allExpanded = $derived(expandable.every((id) => expanded.has(id)));
  const toggleAll = () => {
    if (allExpanded) {
      expanded.clear();
    } else {
      for (const id of expandable) {
        expanded.add(id);
      }
    }
  };
  const toggle = (item: FrameleafTagNode) => {
    if (expanded.has(item.id)) {
      expanded.delete(item.id);
    } else {
      expanded.add(item.id);
    }
  };

  const choose = (item: FrameleafTagNode | null) =>
    goto(Route.tags(item ? { path: item.value } : undefined), { keepFocus: true, noScroll: true });

  const topTags = $derived(mostUsedTags(tree));
  const itemCount = (count: number) => $t('frameleaf_tags_item_count', { values: { count } });
  const colorLabel = (id: TagColorId) =>
    ({
      grey: $t('frameleaf_tags_color_grey'),
      green: $t('frameleaf_tags_color_green'),
      teal: $t('frameleaf_tags_color_teal'),
      blue: $t('frameleaf_tags_color_blue'),
      purple: $t('frameleaf_tags_color_purple'),
      pink: $t('frameleaf_tags_color_pink'),
      amber: $t('frameleaf_tags_color_amber'),
      red: $t('frameleaf_tags_color_red'),
    })[id];
  const nodeColorId = $derived(node ? tagColorId(node.color) : null);

  // The chosen tag's preview: its newest Timeline items, subtags included, like its count.
  $effect(() => {
    const id = node?.id;
    if (!id) {
      covers = [];
      return;
    }
    let cancelled = false;
    searchAssets({ metadataSearchDto: { tagIds: [id], visibility: AssetVisibility.Timeline, size: COVER_COUNT } })
      .then((response) => {
        if (!cancelled) {
          covers = response.assets.items;
        }
      })
      .catch((error) => handleError(error, $t('errors.frameleaf_tags_unable_to_load')));
    return () => {
      cancelled = true;
    };
  });

  const showAll = (item: FrameleafTagNode) =>
    // The Photos page when the buckets apply the whole condition, else the search results (M3).
    goto(viewInLibraryHref({ ...emptyDiscoveryQuery(), filter: { tagIds: { any: [item.id] } } }, location.origin));

  type DialogState =
    | { type: 'create'; parentId: string | null }
    | { type: 'rename'; node: FrameleafTagNode }
    | { type: 'delete'; node: FrameleafTagNode };

  let dialog = $state<DialogState | null>(null);
  let dialogOpen = $state(false);
  $effect(() => {
    if (!dialogOpen) {
      dialog = null;
    }
  });
  let saving = $state(false);
  let formError = $state('');
  let formName = $state('');
  let formParent = $state('');
  let formColor = $state<TagColorId>(DEFAULT_TAG_COLOR);
  let formElement = $state<HTMLFormElement>();

  const parentOptions = $derived(
    allNodes
      .map((item) => ({ id: item.id, label: item.path.join(' / ') }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  );

  const open = (next: DialogState) => {
    formError = '';
    formName = next.type === 'rename' ? next.node.name : '';
    formParent = next.type === 'create' ? (next.parentId ?? '') : '';
    formColor = DEFAULT_TAG_COLOR;
    dialog = next;
    dialogOpen = true;
  };
  const close = () => {
    dialogOpen = false;
    dialog = null;
  };

  const failed = (error: unknown, fallback: string) => {
    formError = getServerErrorMessage(error) ?? fallback;
  };

  const submitCreate = async () => {
    const name = cleanTagName(formName);
    if (!name) {
      formError = $t('frameleaf_tags_name_invalid');
      return;
    }
    const parentId = formParent || null;
    if (tagNameTaken(tree, parentId, name)) {
      formError = $t('frameleaf_tags_name_taken', { values: { name } });
      return;
    }
    saving = true;
    try {
      const created = await createTag({ tagCreateDto: { name, parentId, color: tagColorHex(formColor) } });
      if (parentId) {
        expanded.add(parentId);
      }
      await invalidateAll();
      close();
      focusedId = created.id;
      status = $t('frameleaf_tags_tag_created', { values: { name: created.name } });
      await goto(Route.tags({ path: created.value }), { noScroll: true });
    } catch (error) {
      failed(error, $t('errors.frameleaf_tags_unable_to_save'));
    } finally {
      saving = false;
    }
  };

  const submitRename = async (target: FrameleafTagNode) => {
    const name = cleanTagName(formName);
    if (!name) {
      formError = $t('frameleaf_tags_name_invalid');
      return;
    }
    if (tagNameTaken(tree, target.parent?.id ?? null, name, target.id)) {
      formError = $t('frameleaf_tags_name_taken', { values: { name } });
      return;
    }
    saving = true;
    try {
      const updated = await updateTag({ id: target.id, tagUpdateDto: { name } });
      await invalidateAll();
      close();
      status = $t('frameleaf_tags_renamed', { values: { name: updated.name } });
      await goto(Route.tags({ path: updated.value }), { keepFocus: true, noScroll: true });
    } catch (error) {
      failed(error, $t('errors.frameleaf_tags_unable_to_save'));
    } finally {
      saving = false;
    }
  };

  const submitDelete = async (target: FrameleafTagNode) => {
    saving = true;
    try {
      await deleteTag({ id: target.id });
      close();
      status = $t('frameleaf_tags_tag_deleted');
      // Prototype: the deleted tag's detail gives way to the overview.
      await goto(Route.tags(), { noScroll: true });
      await invalidateAll();
    } catch (error) {
      failed(error, $t('errors.frameleaf_tags_unable_to_delete'));
    } finally {
      saving = false;
    }
  };

  const setColor = async (target: FrameleafTagNode, color: TagColorId) => {
    try {
      await updateTag({ id: target.id, tagUpdateDto: { color: tagColorHex(color) } });
      await invalidateAll();
      status = $t('frameleaf_tags_color_changed', { values: { color: colorLabel(color) } });
    } catch (error) {
      handleError(error, $t('errors.frameleaf_tags_unable_to_save'));
    }
  };

  const moveToTop = async (target: FrameleafTagNode) => {
    try {
      const moved = await updateTag({ id: target.id, tagUpdateDto: { parentId: null } });
      await invalidateAll();
      status = $t('frameleaf_tags_moved');
      await goto(Route.tags({ path: moved.value }), { keepFocus: true, noScroll: true });
    } catch (error) {
      handleError(error, $t('errors.frameleaf_tags_unable_to_save'));
    }
  };

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    if (!dialog || saving) {
      return;
    }
    if (dialog.type === 'create') {
      void submitCreate();
    } else if (dialog.type === 'rename') {
      void submitRename(dialog.node);
    } else {
      void submitDelete(dialog.node);
    }
  };

  const dialogTitle = $derived(
    dialog?.type === 'create'
      ? dialog.parentId
        ? $t('frameleaf_tags_new_subtag')
        : $t('frameleaf_tags_new')
      : dialog?.type === 'rename'
        ? $t('frameleaf_tags_rename_title')
        : $t('delete_tag'),
  );
</script>

{#snippet dot(color: string | null, large = false)}
  <span class="dv-tag-dot" class:large style:--dv-swatch={tagDotColor(color)} aria-hidden="true"></span>
{/snippet}

<!-- Prototype `<main className="discovery dv-tags">`; the page layout already provides the main landmark. -->
<section class="fl-discovery dv-tags" aria-label={$t('tags')}>
  <header class="dv-header">
    <div>
      <h1>{$t('tags')}</h1>
      <p>{$t('frameleaf_tags_subtitle', { values: { count: tags.length } })}</p>
    </div>
    <div class="dv-header-actions">
      <label class="dv-search">
        <Icon icon={mdiMagnify} size="16" aria-hidden="true" />
        <input
          type="search"
          placeholder={$t('frameleaf_tags_find')}
          aria-label={$t('frameleaf_tags_find')}
          bind:value={search}
        />
      </label>
      <Button onclick={toggleAll}>
        <Icon icon={allExpanded ? mdiArrowCollapseAll : mdiArrowExpandAll} size="16" aria-hidden="true" />
        {allExpanded ? $t('frameleaf_tags_collapse_all') : $t('frameleaf_tags_expand_all')}
      </Button>
      <Button variant="primary" onclick={() => open({ type: 'create', parentId: null })}>
        <Icon icon={mdiTagPlusOutline} size="16" aria-hidden="true" />
        {$t('frameleaf_tags_new')}
      </Button>
    </div>
  </header>

  <Status message={status} />

  <div class="dv-split">
    <nav class="dv-pane dv-tree-pane" aria-label={$t('frameleaf_tags_tree_label')}>
      {#if tree.roots.length > 0}
        <DiscoveryTree
          roots={tree.roots}
          label={$t('tags')}
          {expanded}
          selectedId={node?.id ?? null}
          bind:focusedId
          count={(item) => item.total}
          isMatch={(item) => tagMatches(item, query)}
          expandLabel={(item) => $t('frameleaf_tags_expand_node', { values: { name: item.name } })}
          collapseLabel={(item) => $t('frameleaf_tags_collapse_node', { values: { name: item.name } })}
          onChoose={(item) => void choose(item)}
          onToggle={toggle}
        >
          {#snippet lead(item)}
            {@render dot(item.color)}
          {/snippet}
        </DiscoveryTree>
      {:else}
        <div class="dv-empty" role="status">
          <span class="dv-empty-icon"><Icon icon={mdiTagOutline} size="30" aria-hidden="true" /></span>
          <strong>{$t('frameleaf_tags_empty_title')}</strong>
          <p>{$t('frameleaf_tags_empty_description')}</p>
        </div>
      {/if}
    </nav>

    <section
      class="dv-pane dv-detail"
      aria-live="polite"
      aria-label={node
        ? $t('frameleaf_tags_detail_label', { values: { name: node.name } })
        : $t('frameleaf_tags_overview')}
    >
      {#if node}
        {@const crumbs = tagBreadcrumbs(node)}
        <nav class="dv-breadcrumb" aria-label={$t('frameleaf_tags_breadcrumb_label')}>
          <button type="button" onclick={() => void choose(null)}>{$t('tags')}</button>
          {#each crumbs as crumb, index (crumb.id)}
            <Icon icon={mdiChevronRight} size="14" aria-hidden="true" />
            {#if index === crumbs.length - 1}
              <span aria-current="page">{crumb.name}</span>
            {:else}
              <button type="button" onclick={() => void choose(crumb)}>{crumb.name}</button>
            {/if}
          {/each}
        </nav>

        <div class="dv-detail-title">
          {@render dot(node.color, true)}
          <div>
            <h2>{node.name}</h2>
            <p>
              {itemCount(node.count)}{node.total === node.count
                ? ''
                : ` · ${$t('frameleaf_tags_including_subtags', { values: { count: node.total } })}`}
            </p>
          </div>
          <div class="dv-detail-actions">
            <Button onclick={() => open({ type: 'rename', node: node! })}>
              <Icon icon={mdiPencilOutline} size="16" aria-hidden="true" />
              {$t('frameleaf_tags_rename')}
            </Button>
            <Menu label={$t('frameleaf_tags_change_color')}>
              {#snippet trigger()}
                <span class="dv-menu-trigger">
                  <Icon icon={mdiPaletteOutline} size="16" aria-hidden="true" />
                  {@render dot(node!.color)}
                  <span class="dv-menu-trigger-label">{$t('frameleaf_tags_color')}</span>
                  <Icon icon={mdiChevronDown} size="16" aria-hidden="true" />
                </span>
              {/snippet}
              {#each TAG_COLORS as option (option.id)}
                <MenuItem checked={nodeColorId === option.id} onSelect={() => void setColor(node!, option.id)}>
                  <span class="dv-menu-item">
                    {@render dot(option.hex)}
                    {colorLabel(option.id)}
                  </span>
                </MenuItem>
              {/each}
            </Menu>
            <Menu label={$t('frameleaf_tags_more_actions')} align="end">
              {#snippet trigger()}
                <Icon icon={mdiDotsHorizontal} size="18" aria-hidden="true" />
              {/snippet}
              <MenuItem onSelect={() => open({ type: 'create', parentId: node!.id })}>
                <span class="dv-menu-item">
                  <Icon icon={mdiTagPlusOutline} size="16" aria-hidden="true" />
                  {$t('frameleaf_tags_new_subtag')}
                </span>
              </MenuItem>
              <MenuItem disabled={!node.parent} onSelect={() => void moveToTop(node!)}>
                <span class="dv-menu-item">
                  <Icon icon={mdiArrowUp} size="16" aria-hidden="true" />
                  {$t('frameleaf_tags_move_top_level')}
                </span>
              </MenuItem>
              <div class="dv-menu-separator" role="separator"></div>
              <MenuItem onSelect={() => open({ type: 'delete', node: node! })}>
                <span class="dv-menu-danger">
                  <Icon icon={mdiDeleteOutline} size="16" aria-hidden="true" />
                  {$t('delete_tag')}
                </span>
              </MenuItem>
            </Menu>
          </div>
        </div>

        {#if covers.length > 0}
          <div class="dv-strip" aria-label={$t('frameleaf_tags_preview_of', { values: { tag: node.name } })}>
            {#each covers as asset (asset.id)}
              <img src={getAssetUrls(asset).thumbnail} alt="" loading="lazy" />
            {/each}
          </div>
        {:else}
          <div class="dv-strip-empty">
            <Icon icon={mdiImageOutline} size="22" aria-hidden="true" />
            <span>{$t('frameleaf_tags_no_items')}</span>
          </div>
        {/if}

        <div class="dv-detail-cta">
          <Button variant="primary" disabled={!node.total} onclick={() => void showAll(node!)}>
            <Icon icon={mdiImageMultipleOutline} size="16" aria-hidden="true" />
            {$t('frameleaf_tags_show_all', { values: { count: node.total } })}
          </Button>
        </div>

        {#if node.children.length > 0}
          <div class="dv-subtags">
            <h3>{$t('frameleaf_tags_subtags')}</h3>
            <div class="dv-chip-row">
              {#each node.children as child (child.id)}
                <button type="button" class="dv-chip" onclick={() => void choose(child)}>
                  {@render dot(child.color)}
                  {child.name}
                  <small>{child.total}</small>
                </button>
              {/each}
            </div>
          </div>
        {/if}
      {:else}
        <div class="dv-overview">
          <h2>{$t('frameleaf_tags_choose_title')}</h2>
          <p>{$t('frameleaf_tags_choose_description')}</p>
          {#if topTags.length > 0}
            <h3>{$t('frameleaf_tags_most_used')}</h3>
            <div class="dv-chip-row">
              {#each topTags as item (item.id)}
                <button type="button" class="dv-chip" onclick={() => void choose(item)}>
                  {@render dot(item.color)}
                  {item.path.join(' / ')}
                  <small>{item.total}</small>
                </button>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    </section>
  </div>

  {#if dialog}
    <Dialog title={dialogTitle} closeLabel={$t('close')} bind:open={dialogOpen}>
      <form class="dv-form" onsubmit={submit} bind:this={formElement}>
        {#if dialog.type === 'delete'}
          {@const target = dialog.node}
          <p>
            <FormatMessage
              key={target.children.length > 0
                ? 'frameleaf_tags_delete_confirm_with_children'
                : 'frameleaf_tags_delete_confirm'}
              values={{ tag: target.path.join(' / '), count: target.children.length }}
            >
              {#snippet children({ message })}<strong>{message}</strong>{/snippet}
            </FormatMessage>
            {target.total
              ? $t('frameleaf_tags_delete_items', { values: { count: target.total } })
              : $t('frameleaf_tags_delete_no_items')}
          </p>
        {:else}
          <label>
            {$t('name')}
            <input
              data-initial-focus
              bind:value={formName}
              maxlength="60"
              aria-invalid={formError ? true : undefined}
            />
          </label>
        {/if}
        {#if dialog.type === 'create'}
          <label>
            {$t('frameleaf_tags_parent')}
            <select bind:value={formParent}>
              <option value="">{$t('frameleaf_tags_parent_none')}</option>
              {#each parentOptions as option (option.id)}
                <option value={option.id}>{option.label}</option>
              {/each}
            </select>
          </label>
          <fieldset class="dv-swatches">
            <legend>{$t('frameleaf_tags_color')}</legend>
            {#each TAG_COLORS as option (option.id)}
              <button
                type="button"
                role="radio"
                aria-checked={formColor === option.id}
                aria-label={colorLabel(option.id)}
                title={colorLabel(option.id)}
                class="dv-swatch"
                class:on={formColor === option.id}
                style:--dv-swatch={option.hex}
                onclick={() => (formColor = option.id)}
              ></button>
            {/each}
          </fieldset>
        {/if}
        {#if formError}
          <p class="dv-error" role="alert">{formError}</p>
        {/if}
      </form>
      {#snippet actions()}
        <Button onclick={close}>{$t('cancel')}</Button>
        <!-- The footer sits outside the form (Dialog pins it), so it submits the form explicitly. -->
        <Button
          variant={dialog?.type === 'delete' ? 'danger' : 'primary'}
          disabled={saving}
          onclick={() => formElement?.requestSubmit()}
        >
          {dialog?.type === 'create' ? $t('create') : dialog?.type === 'rename' ? $t('save') : $t('delete')}
        </Button>
      {/snippet}
    </Dialog>
  {/if}
</section>
