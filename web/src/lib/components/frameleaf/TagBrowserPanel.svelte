<script lang="ts">
  /**
   * Frameleaf Tags browser (FL-46).
   *
   * Ported from the approved prototype (`design/frameleaf/template/src/Tags.jsx`), but built
   * against the real tag API instead of the prototype's slash-path/localStorage simulation:
   * nesting, colour and rename all call the existing `createTag` / `updateTag` / `deleteTag`
   * endpoints (`@immich/sdk`), and the tree comes from `$lib/frameleaf/tag-tree`. There is no
   * endpoint to re-parent an existing tag, so unlike the prototype this panel has no "move to
   * top level" action; nesting only happens when a tag is created.
   *
   * The tree, breadcrumb and per-node navigation reuse the existing, already-accessible
   * `Tree` / `TreeItems` / `Breadcrumbs` components from `shared-components/tree` (the same
   * ones the legacy tags page uses) rather than a new hand-rolled tree widget.
   *
   * The asset grid is deliberately not rendered inline here: "View in library" hands the
   * selection to the shared library session (`$lib/frameleaf/library-session`) and opens the
   * library at that filter, so the browser and the library share one selection/bulk-action
   * surface instead of each page owning its own.
   */
  import { goto, invalidateAll } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import Menu from '$lib/components/frameleaf/Menu.svelte';
  import MenuItem from '$lib/components/frameleaf/MenuItem.svelte';
  import Pane from '$lib/components/frameleaf/Pane.svelte';
  import Picker from '$lib/components/frameleaf/Picker.svelte';
  import Status from '$lib/components/frameleaf/Status.svelte';
  import type { ComboBoxOption } from '$lib/components/shared-components/Combobox.svelte';
  import Breadcrumbs from '$lib/components/shared-components/tree/Breadcrumbs.svelte';
  import TreeItemThumbnails from '$lib/components/shared-components/tree/TreeItemThumbnails.svelte';
  import TreeItems from '$lib/components/shared-components/tree/TreeItems.svelte';
  import { createLibrarySession, writeLibraryView } from '$lib/frameleaf/library-session';
  import { TAG_COLOR_SWATCHES, buildTagTree, flattenTagTree } from '$lib/frameleaf/tag-tree';
  import { Route } from '$lib/route';
  import { getAssetUrls } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import { joinPaths, TreeNode } from '$lib/utils/tree-utils';
  import { createTag, deleteTag, searchAssets, updateTag, type AssetResponseDto, type TagResponseDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import {
    mdiDeleteOutline,
    mdiImageMultipleOutline,
    mdiPencilOutline,
    mdiPlus,
    mdiTag,
    mdiTagMultiple,
    mdiTagOutline,
  } from '@mdi/js';
  import { t } from 'svelte-i18n';

  interface Props {
    tags: TagResponseDto[];
    /** The tag's full value ("Trips/Rockies 2026"), or "" when nothing is selected. */
    path: string;
  }

  let { tags, path }: Props = $props();

  const navTree = $derived(TreeNode.fromTags(tags));
  const navNode = $derived(navTree.traverse(path));
  const tagTree = $derived(buildTagTree(tags));
  const selected = $derived(navNode.id ? (tags.find((tag) => tag.id === navNode.id) ?? null) : null);
  const selectedNode = $derived(navNode.id ? (tagTree.byId.get(navNode.id) ?? null) : null);

  const getLink = (value: string) => Route.tags({ path: value });
  const handleNavigation = (name: string) => goto(getLink(joinPaths(path, name)));

  type DialogState =
    | { type: 'create'; parentId: string | null }
    | { type: 'rename'; tag: TagResponseDto }
    | { type: 'delete'; tag: TagResponseDto; childCount: number };

  let dialog = $state<DialogState | null>(null);
  // Bound to Dialog's own open/close (× button, Escape, backdrop click); each open* helper
  // below sets both this and `dialog` together, and this effect drops `dialog` in the other
  // direction so the form fields reset the next time a dialog opens.
  let dialogOpen = $state(false);
  $effect(() => {
    if (!dialogOpen) {
      dialog = null;
    }
  });
  let saving = $state(false);
  let formError = $state('');
  let status = $state('');

  let createName = $state('');
  let createParent = $state<ComboBoxOption | undefined>(undefined);
  let createColor = $state<string | null>(null);
  let renameName = $state('');

  let coverAssets = $state<AssetResponseDto[]>([]);
  let coverTotal = $state(0);

  const parentOptions = $derived<ComboBoxOption[]>(
    flattenTagTree(tagTree)
      .map((node) => ({ value: node.id, label: node.path.join(' / ') }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  );

  $effect(() => {
    const id = selected?.id;
    if (!id) {
      coverAssets = [];
      coverTotal = 0;
      return;
    }
    let cancelled = false;
    searchAssets({ metadataSearchDto: { filter: { tagIds: { any: [id] } }, size: 8 } })
      .then((response) => {
        if (cancelled) {
          return;
        }
        coverAssets = response.assets.items;
        coverTotal = response.assets.total;
      })
      .catch((error) => handleError(error, $t('errors.frameleaf_tags_unable_to_load')));
    return () => {
      cancelled = true;
    };
  });

  const viewInLibrary = () => {
    if (!selected) {
      return;
    }
    const session = createLibrarySession();
    session.state.query.filter = { tagIds: { any: [selected.id] } };
    const url = writeLibraryView(new URL(Route.photos(), window.location.origin), session.state);
    void goto(`${url.pathname}${url.search}`);
  };

  const openCreate = (parentId: string | null) => {
    createName = '';
    createColor = null;
    createParent = parentId ? parentOptions.find((option) => option.value === parentId) : undefined;
    formError = '';
    dialog = { type: 'create', parentId };
    dialogOpen = true;
  };
  const openRename = () => {
    if (!selected) {
      return;
    }
    renameName = selected.name;
    formError = '';
    dialog = { type: 'rename', tag: selected };
    dialogOpen = true;
  };
  const openDelete = () => {
    if (!selected) {
      return;
    }
    dialog = { type: 'delete', tag: selected, childCount: selectedNode?.children.length ?? 0 };
    dialogOpen = true;
  };
  const closeDialog = () => {
    dialog = null;
    dialogOpen = false;
    formError = '';
  };

  const setColor = async (tag: TagResponseDto, hex: string) => {
    try {
      await updateTag({ id: tag.id, tagUpdateDto: { color: hex } });
      await invalidateAll();
      status = $t('frameleaf_tags_color_changed', { values: { color: hex } });
    } catch (error) {
      handleError(error, $t('errors.frameleaf_tags_unable_to_save'));
    }
  };

  const submitCreate = async () => {
    const name = createName.trim();
    if (!name) {
      formError = $t('frameleaf_tags_name_required');
      return;
    }
    try {
      saving = true;
      const created = await createTag({
        tagCreateDto: { name, parentId: createParent?.value, color: createColor ?? undefined },
      });
      await invalidateAll();
      closeDialog();
      status = $t('frameleaf_tags_tag_created', { values: { name: created.name } });
      await goto(getLink(created.value));
    } catch (error) {
      handleError(error, $t('errors.frameleaf_tags_unable_to_save'));
    } finally {
      saving = false;
    }
  };

  const submitRename = async () => {
    if (dialog?.type !== 'rename') {
      return;
    }
    const name = renameName.trim();
    if (!name) {
      formError = $t('frameleaf_tags_name_required');
      return;
    }
    try {
      saving = true;
      const updated = await updateTag({ id: dialog.tag.id, tagUpdateDto: { name } });
      await invalidateAll();
      closeDialog();
      status = $t('frameleaf_tags_renamed', { values: { name: updated.name } });
      await goto(getLink(updated.value));
    } catch (error) {
      handleError(error, $t('errors.frameleaf_tags_unable_to_save'));
    } finally {
      saving = false;
    }
  };

  const submitDelete = async () => {
    if (dialog?.type !== 'delete') {
      return;
    }
    const removed = dialog.tag;
    const parentValue = navNode.parent ? navNode.parent.path : '';
    try {
      saving = true;
      await deleteTag({ id: removed.id });
      await invalidateAll();
      closeDialog();
      status = $t('frameleaf_tags_tag_deleted');
      if (selected?.id === removed.id) {
        await goto(getLink(parentValue));
      }
    } catch (error) {
      handleError(error, $t('errors.frameleaf_tags_unable_to_delete'));
    } finally {
      saving = false;
    }
  };
</script>

<div class="tag-browser">
  <header class="tag-browser-header">
    <div>
      <h1>{$t('tags')}</h1>
      <p>{$t('frameleaf_tags_subtitle', { values: { count: tags.length } })}</p>
    </div>
    <Button variant="primary" onclick={() => openCreate(null)}>
      <Icon icon={mdiPlus} size={16} aria-hidden="true" />
      {$t('frameleaf_tags_new')}
    </Button>
  </header>

  <Status message={status} />

  <div class="tag-browser-split">
    <Pane label={$t('frameleaf_tags_tree_label')}>
      {#if navTree.children.length > 0}
        <TreeItems tree={navTree} icons={{ default: mdiTagOutline, active: mdiTag }} active={navNode.path} {getLink} />
      {:else}
        <p class="tag-browser-empty">
          <Icon icon={mdiTagOutline} size={28} aria-hidden="true" />
          <strong>{$t('frameleaf_tags_empty_title')}</strong>
          <span>{$t('frameleaf_tags_empty_description')}</span>
        </p>
      {/if}
    </Pane>

    <Pane label={selected ? $t('frameleaf_tags_preview_of', { values: { tag: selected.name } }) : $t('frameleaf_tags_choose_title')}>
      {#if selected}
        <Breadcrumbs node={navNode} icon={mdiTagMultiple} title={$t('tags')} {getLink} />
        <div class="tag-browser-detail-title">
          <span class="tag-dot" style={`--dot-color:${selected.color ?? 'var(--fl-muted)'}`} aria-hidden="true"></span>
          <div>
            <h2>{selected.name}</h2>
          </div>
          <div class="tag-browser-detail-actions">
            <Button onclick={openRename}>
              <Icon icon={mdiPencilOutline} size={16} aria-hidden="true" />
              {$t('frameleaf_tags_rename')}
            </Button>
            <Menu label={$t('frameleaf_tags_color')}>
              {#snippet trigger()}
                <span class="tag-dot" style={`--dot-color:${selected.color ?? 'var(--fl-muted)'}`} aria-hidden="true"
                ></span>
                {$t('frameleaf_tags_color')}
              {/snippet}
              {#each TAG_COLOR_SWATCHES as swatch (swatch.id)}
                <MenuItem checked={selected.color === swatch.hex} onSelect={() => setColor(selected!, swatch.hex)}>
                  <span class="tag-dot" style={`--dot-color:${swatch.hex}`} aria-hidden="true"></span>
                  {swatch.id}
                </MenuItem>
              {/each}
            </Menu>
            <Button onclick={() => openCreate(selected!.id)}>
              <Icon icon={mdiPlus} size={16} aria-hidden="true" />
              {$t('frameleaf_tags_new_subtag')}
            </Button>
            <Button onclick={openDelete}>
              <Icon icon={mdiDeleteOutline} size={16} aria-hidden="true" />
              {$t('delete_tag')}
            </Button>
          </div>
        </div>

        {#if coverAssets.length > 0}
          <div class="tag-browser-strip" aria-label={$t('frameleaf_tags_preview_of', { values: { tag: selected.name } })}>
            {#each coverAssets as asset (asset.id)}
              <img src={getAssetUrls(asset).thumbnail} alt="" loading="lazy" />
            {/each}
          </div>
        {:else}
          <p class="tag-browser-strip-empty">{$t('frameleaf_tags_no_items')}</p>
        {/if}

        <div class="tag-browser-cta">
          <Button variant="primary" disabled={coverTotal === 0} onclick={viewInLibrary}>
            <Icon icon={mdiImageMultipleOutline} size={16} aria-hidden="true" />
            {$t('frameleaf_tags_show_all', { values: { count: coverTotal } })}
          </Button>
        </div>

        {#if selectedNode && selectedNode.children.length > 0}
          <h3 class="tag-browser-subheading">{$t('frameleaf_tags_subtags')}</h3>
          <TreeItemThumbnails items={navNode.children} icon={mdiTag} onClick={handleNavigation} />
        {/if}
      {:else}
        <div class="tag-browser-overview">
          <h2>{$t('frameleaf_tags_choose_title')}</h2>
          <p>{$t('frameleaf_tags_choose_description')}</p>
        </div>
      {/if}
    </Pane>
  </div>
</div>

{#if dialog}
  <Dialog title={dialog.type === 'create' ? $t('frameleaf_tags_new') : dialog.type === 'rename' ? $t('frameleaf_tags_rename') : $t('delete_tag')} closeLabel={$t('close')} bind:open={dialogOpen}>
    {#if dialog.type === 'create'}
      <form
        onsubmit={(event) => {
          event.preventDefault();
          void submitCreate();
        }}
      >
        <label>
          {$t('name')}
          <input type="text" bind:value={createName} maxlength="60" required />
        </label>
        <Picker label={$t('frameleaf_tags_parent')} options={parentOptions} bind:selectedOption={createParent} />
        <fieldset role="radiogroup" aria-label={$t('frameleaf_tags_color')}>
          <legend>{$t('frameleaf_tags_color')}</legend>
          {#each TAG_COLOR_SWATCHES as swatch (swatch.id)}
            <button
              type="button"
              role="radio"
              aria-checked={createColor === swatch.hex}
              aria-label={swatch.id}
              style={`--dot-color:${swatch.hex}`}
              class="tag-swatch"
              onclick={() => (createColor = swatch.hex)}
            ></button>
          {/each}
        </fieldset>
        {#if formError}<p role="alert">{formError}</p>{/if}
        <div class="tag-browser-dialog-actions">
          <Button onclick={closeDialog}>{$t('cancel')}</Button>
          <Button variant="primary" type="submit" disabled={saving}>{$t('create')}</Button>
        </div>
      </form>
    {:else if dialog.type === 'rename'}
      <form
        onsubmit={(event) => {
          event.preventDefault();
          void submitRename();
        }}
      >
        <label>
          {$t('name')}
          <input type="text" bind:value={renameName} maxlength="60" required />
        </label>
        {#if formError}<p role="alert">{formError}</p>{/if}
        <div class="tag-browser-dialog-actions">
          <Button onclick={closeDialog}>{$t('cancel')}</Button>
          <Button variant="primary" type="submit" disabled={saving}>{$t('save')}</Button>
        </div>
      </form>
    {:else}
      <p>
        {dialog.childCount > 0
          ? $t('frameleaf_tags_delete_confirm_with_children', { values: { tag: dialog.tag.name, count: dialog.childCount } })
          : $t('frameleaf_tags_delete_confirm', { values: { tag: dialog.tag.name } })}
      </p>
      <div class="tag-browser-dialog-actions">
        <Button onclick={closeDialog}>{$t('cancel')}</Button>
        <Button variant="primary" disabled={saving} onclick={() => void submitDelete()}>{$t('delete')}</Button>
      </div>
    {/if}
  </Dialog>
{/if}

<style>
  .tag-browser {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    color: var(--fl-text);
  }
  .tag-browser-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }
  .tag-browser-header h1 {
    font-size: 1.25rem;
  }
  .tag-browser-header p {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .tag-browser-split {
    display: grid;
    grid-template-columns: minmax(14rem, 20rem) 1fr;
    gap: 0.75rem;
    align-items: start;
  }
  @media (max-width: 62rem) {
    .tag-browser-split {
      grid-template-columns: 1fr;
    }
  }
  .tag-browser-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.375rem;
    padding: 2rem 1rem;
    color: var(--fl-muted);
    text-align: center;
  }
  .tag-browser-detail-title {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-block: 0.75rem;
  }
  .tag-browser-detail-title h2 {
    font-size: 1.0625rem;
  }
  .tag-browser-detail-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
    margin-inline-start: auto;
  }
  .tag-dot {
    display: inline-block;
    width: 0.75rem;
    height: 0.75rem;
    flex-shrink: 0;
    border-radius: 50%;
    background: var(--dot-color, var(--fl-muted));
  }
  .tag-browser-strip {
    display: flex;
    gap: 0.375rem;
    overflow-x: auto;
  }
  .tag-browser-strip img {
    width: 4.5rem;
    height: 4.5rem;
    object-fit: cover;
    border-radius: var(--fl-radius);
  }
  .tag-browser-strip-empty {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .tag-browser-cta {
    margin-block-start: 0.75rem;
  }
  .tag-browser-subheading {
    margin-block-start: 1rem;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .tag-browser-overview {
    color: var(--fl-muted);
  }
  .tag-browser-dialog-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-block-start: 1rem;
  }
  form label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    margin-block-end: 0.75rem;
  }
  form input[type='text'] {
    padding: 0.4375rem 0.6875rem;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  fieldset {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
    padding: 0;
    margin: 0 0 0.75rem;
    border: 0;
  }
  .tag-swatch {
    width: 1.75rem;
    height: 1.75rem;
    border-radius: 50%;
    background: var(--dot-color);
    border: 2px solid transparent;
  }
  .tag-swatch[aria-checked='true'] {
    border-color: var(--fl-text);
  }
</style>
