<script lang="ts">
  /**
   * The head of a tag's page, built like an album's (`AlbumHeader`): the path back, the tag's colour
   * as a tile that changes it, the name (click to rename), how much carries the tag, its actions
   * and the tags inside it. The page puts it above the library grid, which shows every photo with
   * the tag or with a tag inside it. Approved mock: `TagPage` in
   * `design/frameleaf/template/src/TagsV2.jsx`.
   *
   * The tag's address is its full name (`?path=`), so renaming or moving it replaces the address
   * rather than leaving the old one behind in history, and deleting it goes up one level.
   *
   * On a phone only "Tag photos" stays in the row; Colour and Move join the "…" menu.
   */
  import { goto, invalidateAll } from '$app/navigation';
  import Menu from '$lib/components/frameleaf/Menu.svelte';
  import MenuItem from '$lib/components/frameleaf/MenuItem.svelte';
  import TagCard from '$lib/components/frameleaf/tags/TagCard.svelte';
  import TagColourPicker from '$lib/components/frameleaf/tags/TagColourPicker.svelte';
  import TagDialog, { type TagDialogRequest } from '$lib/components/frameleaf/tags/TagDialog.svelte';
  import TagNameEdit from '$lib/components/frameleaf/tags/TagNameEdit.svelte';
  import { tagColorLabel, tagResultMessage, type TagDialogResult } from '$lib/components/frameleaf/tags/tag-messages';
  import { monthSpan } from '$lib/frameleaf/album-directory';
  import {
    cleanTagName,
    tagBreadcrumbs,
    tagNameTaken,
    type FrameleafTagNode,
    type FrameleafTagTree,
    type TagColorId,
  } from '$lib/frameleaf/tag-tree';
  import { Route } from '$lib/route';
  import { handleError } from '$lib/utils/handle-error';
  import { updateTag } from '@frameleaf/sdk';
  import { Icon, toastManager } from '@frameleaf/ui';
  import {
    mdiChevronRight,
    mdiDeleteOutline,
    mdiDotsHorizontal,
    mdiFolderMoveOutline,
    mdiPaletteOutline,
    mdiPlus,
    mdiTagPlusOutline,
  } from '@mdi/js';
  import { locale, t } from 'svelte-i18n';
  import { MediaQuery } from 'svelte/reactivity';

  let { node, tree }: { node: FrameleafTagNode; tree: FrameleafTagTree } = $props();

  /** Phones (the mock's `max-width: 700px`): the secondary actions live in the "…" menu. */
  const phone = new MediaQuery('max-width: 700px');
  const compact = $derived(phone.current);

  const crumbs = $derived(tagBreadcrumbs(node).slice(0, -1));
  const span = $derived(monthSpan(node.startDate ?? undefined, node.endDate ?? undefined, $locale ?? undefined));

  let status = $state('');
  let nameError = $state('');
  // Raw: the request carries tree nodes, which are compared by identity and must not be wrapped.
  let request = $state.raw<TagDialogRequest | null>(null);

  /** The tag's page under its new name or place: the old address is gone, so it is replaced. */
  const follow = (value: string) =>
    goto(Route.tags({ path: value }), { replaceState: true, invalidateAll: true, keepFocus: true, noScroll: true });

  const rename = async (typed: string) => {
    nameError = '';
    const name = cleanTagName(typed);
    if (!name) {
      nameError = $t('frameleaf_tags_name_invalid');
      return false;
    }
    if (tagNameTaken(tree, node.parent?.id ?? null, name, node.id)) {
      nameError = $t('frameleaf_tags_name_taken', { values: { name } });
      return false;
    }
    let updated;
    try {
      updated = await updateTag({ id: node.id, tagUpdateDto: { name } });
    } catch (error) {
      handleError(error, $t('errors.frameleaf_tags_unable_to_save'));
      return false;
    }
    await follow(updated.value);
    status = $t('frameleaf_tags_renamed', { values: { name: updated.name } });
    return true;
  };

  const recolor = async (color: TagColorId, hex: string) => {
    try {
      await updateTag({ id: node.id, tagUpdateDto: { color: hex } });
      await invalidateAll();
      status = $t('frameleaf_tags_color_changed', { values: { color: tagColorLabel($t, color) } });
    } catch (error) {
      handleError(error, $t('errors.frameleaf_tags_unable_to_save'));
    }
  };

  /**
   * Photos are picked in the Library, as they are for an album ("Select from library"): its
   * selection bar's Tag adds the tag, so the tag page keeps no picking mode of its own.
   */
  const tagPhotos = async () => {
    const hint = $t('frameleaf_tags_tag_photos_hint', { values: { name: node.name } });
    await goto(Route.photos());
    toastManager.primary(hint);
  };

  const onDone = async (result: TagDialogResult) => {
    switch (result.type) {
      case 'renamed':
      case 'moved': {
        await follow(result.tag.value);
        break;
      }
      case 'deleted': {
        const parent = result.node.parent;
        await goto(parent ? Route.tags({ path: parent.value }) : Route.tags(), {
          replaceState: true,
          invalidateAll: true,
        });
        // This page is gone with its tag, so the confirmation travels as a toast.
        toastManager.primary(tagResultMessage($t, result));
        return;
      }
      default: {
        await invalidateAll();
      }
    }
    status = tagResultMessage($t, result);
  };
</script>

<!-- A named region rather than a header: inside the page's main area a header is no landmark. -->
<section class="tag-header" aria-label={$t('frameleaf_tags_detail_label', { values: { name: node.name } })}>
  <nav class="crumbs" aria-label={$t('frameleaf_tags_breadcrumb_label')}>
    <a href={Route.tags()}>{$t('tags')}</a>
    {#each crumbs as crumb (crumb.id)}
      <span aria-hidden="true"><Icon icon={mdiChevronRight} size="16" /></span>
      <a href={Route.tags({ path: crumb.value })}>{crumb.name}</a>
    {/each}
    <span aria-hidden="true"><Icon icon={mdiChevronRight} size="16" /></span>
    <span aria-current="page">{node.name}</span>
  </nav>

  <div class="main">
    <div class="tile">
      <TagColourPicker color={node.color} variant="tile" onChange={(color, hex) => void recolor(color, hex)} />
    </div>
    <div class="text">
      <div class="title-row">
        <TagNameEdit
          label={$t('frameleaf_tags_edit_name')}
          value={node.name}
          error={nameError}
          onSave={rename}
          onCancel={() => (nameError = '')}
        />
      </div>
      <div class="summary">
        <span>{$t('frameleaf_tags_item_count', { values: { count: node.total } })}</span>
        {#if node.children.length > 0}
          <span>{$t('frameleaf_tags_inside_count', { values: { count: node.children.length } })}</span>
        {/if}
        {#if span}
          <span>{span}</span>
        {/if}
      </div>
    </div>
  </div>

  <div class="actions" role="toolbar" aria-label={$t('frameleaf_tags_actions')}>
    <button type="button" class="action primary" onclick={() => void tagPhotos()}>
      <Icon icon={mdiPlus} size="18" aria-hidden />
      <span>{$t('frameleaf_tags_tag_photos')}</span>
    </button>
    {#if !compact}
      <TagColourPicker color={node.color} variant="button" onChange={(color, hex) => void recolor(color, hex)} />
      <button type="button" class="action" onclick={() => (request = { type: 'move', node })}>
        <Icon icon={mdiFolderMoveOutline} size="18" aria-hidden />
        <span>{$t('move')}</span>
      </button>
    {/if}
    <span class="spacer"></span>
    <Menu label={$t('frameleaf_tags_more_actions')} align={compact ? 'start' : 'end'}>
      {#snippet trigger()}
        <span class="trigger-content"><Icon icon={mdiDotsHorizontal} size="18" aria-hidden /></span>
      {/snippet}
      {#if compact}
        <MenuItem onSelect={() => (request = { type: 'color', node })}>
          <Icon icon={mdiPaletteOutline} size="18" aria-hidden />{$t('frameleaf_tags_color')}
        </MenuItem>
        <MenuItem onSelect={() => (request = { type: 'move', node })}>
          <Icon icon={mdiFolderMoveOutline} size="18" aria-hidden />{$t('move')}
        </MenuItem>
      {/if}
      <MenuItem onSelect={() => (request = { type: 'create', parentId: node.id })}>
        <Icon icon={mdiTagPlusOutline} size="18" aria-hidden />{$t('frameleaf_tags_new_inside')}
      </MenuItem>
      <div class="menu-separator" role="separator"></div>
      <MenuItem onSelect={() => (request = { type: 'delete', node })}>
        <span class="danger-item"><Icon icon={mdiDeleteOutline} size="18" aria-hidden />{$t('delete_tag')}</span>
      </MenuItem>
    </Menu>
  </div>

  <p class="status" role="status" aria-live="polite">{status}</p>

  {#if node.children.length > 0}
    <section class="inside" aria-labelledby="{node.id}-inside">
      <div class="inside-head">
        <h2 id="{node.id}-inside">{$t('frameleaf_tags_inside_title')}</h2>
        <small>{$t('frameleaf_tags_count', { values: { count: node.children.length } })}</small>
      </div>
      <div class="inside-grid">
        {#each node.children as child (child.id)}
          <TagCard node={child} compact />
        {/each}
        <button type="button" class="new-tile" onclick={() => (request = { type: 'create', parentId: node.id })}>
          <Icon icon={mdiPlus} size="22" aria-hidden />
          <span>{$t('frameleaf_tags_new_here')}</span>
        </button>
      </div>
    </section>
  {/if}
</section>

{#if request}
  {#key request}
    <TagDialog {request} {tree} {onDone} onClose={() => (request = null)} />
  {/key}
{/if}

<style>
  /* The album header's layout and measures (AlbumHeader.svelte), so the two pages read as one family. */
  .tag-header {
    display: flex;
    flex-direction: column;
    gap: var(--fl-space-3);
    /*
     * The library puts its Timeline / Browse / Work switch beside a header that leaves room for it.
     * Asking for the whole row keeps the switch under the header for every tag, however few tags are
     * inside it, as it is under an album's.
     */
    inline-size: 100vw;
    max-inline-size: 100%;
    padding-block: var(--fl-space-4) var(--fl-space-1);
    color: var(--fl-text);
  }
  .crumbs {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    /* Each crumb carries its own inset, so the arrows sit evenly; the first one's text starts on the content edge. */
    margin-inline-start: calc(var(--fl-space-2) * -1);
    font-size: 0.75rem;
    color: var(--fl-muted);
  }
  .crumbs a,
  .crumbs span[aria-current='page'] {
    padding: var(--fl-space-1) var(--fl-space-2);
  }
  .crumbs a {
    border-radius: var(--fl-radius);
    color: var(--fl-muted);
    text-decoration: none;
  }
  .crumbs a:hover {
    background: var(--fl-raised);
    color: var(--fl-text);
  }
  .crumbs span[aria-current='page'] {
    color: var(--fl-text);
  }
  .main {
    display: flex;
    align-items: flex-start;
    /* Wide enough that the title's hover box stays 8px clear of the colour tile. */
    gap: var(--fl-space-5);
  }
  .text {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--fl-space-1);
    min-inline-size: 0;
  }
  .title-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fl-space-2);
  }
  /* The large title that shrinks as you scroll, as on an album (AlbumHeader `.title-row h1`). */
  .title-row :global(h1) {
    transform-origin: left bottom;
  }
  @supports (animation-timeline: scroll()) {
    .title-row :global(h1) {
      animation: fl-tag-title-shrink linear both;
      animation-timeline: scroll(nearest block);
      animation-range: 0 90px;
    }
    @media (prefers-reduced-motion: reduce) {
      .title-row :global(h1) {
        animation-name: fl-tag-title-fade;
      }
    }
  }
  @keyframes fl-tag-title-shrink {
    to {
      scale: 0.62;
      opacity: 0.2;
    }
  }
  @keyframes fl-tag-title-fade {
    to {
      opacity: 0.2;
    }
  }
  /*
   * The album header's summary line (AlbumHeader `.summary`): each fact after the first draws its
   * own separator dot in the middle of the gap before it. The box clips just outside its text, so
   * when the line wraps on a narrow screen the dot of whatever starts the new line is not drawn and
   * no line begins or ends with one.
   */
  .summary {
    --summary-gap: calc(2 * var(--fl-space-2) + 3px);
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fl-space-1) var(--summary-gap);
    margin-inline: calc(-1 * var(--fl-space-1));
    padding-inline: var(--fl-space-1);
    overflow-x: clip;
    font-size: 0.75rem;
    color: var(--fl-muted);
  }
  .summary > * {
    position: relative;
  }
  .summary > * + *::before {
    content: '';
    position: absolute;
    inset-block-start: calc(50% - 1.5px);
    inset-inline-start: calc(-0.5 * var(--summary-gap) - 1.5px);
    inline-size: 3px;
    block-size: 3px;
    border-radius: 50%;
    background: var(--fl-muted);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    /* 8px between buttons, 12px between the rows they wrap into, as on an album. */
    gap: var(--fl-space-3) var(--fl-space-2);
  }
  .action,
  .trigger-content {
    display: inline-flex;
    align-items: center;
    gap: var(--fl-space-2);
    white-space: nowrap;
  }
  .action {
    min-height: 44px;
    padding: 0 var(--fl-space-3);
    font: inherit;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .action:hover {
    background: color-mix(in srgb, var(--fl-raised), var(--fl-text) 8%);
  }
  .action.primary {
    font-weight: 600;
    color: var(--fl-accent-text);
    background: var(--fl-accent);
    border-color: var(--fl-accent);
  }
  .action.primary:hover {
    background: var(--fl-accent-hover);
    border-color: var(--fl-accent-hover);
  }
  .spacer {
    flex: 1;
  }
  @media (max-width: 700px) {
    /* A phone keeps the name and "Tag photos"; Colour is in the "…" menu beside it. */
    .tile,
    .spacer {
      display: none;
    }
  }
  .status {
    margin: 0;
    min-block-size: 1rem;
    font-size: 0.75rem;
    color: var(--fl-muted);
  }
  /* With nothing to say the line keeps no row (or gap) of its own; it stays in the page to be announced. */
  .status:empty {
    min-block-size: 0;
    margin-block-start: calc(var(--fl-space-3) * -1);
  }
  .inside {
    display: flex;
    flex-direction: column;
    gap: var(--fl-space-3);
    /* A section of its own: 20px under the actions to the rule, 16px from the rule to its heading. */
    margin-block-start: var(--fl-space-2);
    padding-block: var(--fl-space-4) var(--fl-space-1);
    border-block-start: 1px solid var(--fl-border);
  }
  .inside-head {
    display: flex;
    align-items: baseline;
    gap: var(--fl-space-2);
  }
  .inside-head h2 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    letter-spacing: -0.015em;
  }
  .inside-head small {
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .inside-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
    gap: var(--fl-space-5) var(--fl-space-3);
    align-items: start;
  }
  .new-tile {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--fl-space-2);
    width: 100%;
    aspect-ratio: 1;
    padding: 0 var(--fl-space-2);
    font: inherit;
    font-size: var(--fl-font-callout);
    font-weight: 500;
    color: var(--fl-muted);
    background: transparent;
    border: 1px dashed var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  .new-tile:hover {
    color: var(--fl-text);
    background: var(--fl-raised);
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
  /* Narrower windows: the tags inside become one row to swipe, so the photos stay within reach. */
  @media (max-width: 1000px) {
    .inside-grid {
      display: flex;
      gap: var(--fl-space-3);
      padding-block-end: var(--fl-space-1);
      overflow-x: auto;
      scroll-snap-type: x mandatory;
      scrollbar-width: none;
    }
    .inside-grid > :global(*) {
      flex: 0 0 132px;
      scroll-snap-align: start;
    }
    .new-tile {
      aspect-ratio: auto;
      height: 132px;
    }
  }
  @media (max-width: 700px) {
    .inside-grid > :global(*) {
      flex-basis: 118px;
    }
    .new-tile {
      height: 118px;
    }
  }
</style>
