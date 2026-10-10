<script lang="ts" module>
  import type { TagDialogResult } from '$lib/components/frameleaf/tags/tag-messages';
  import type { FrameleafTagNode } from '$lib/frameleaf/tag-tree';

  /** What the dialog is asked to do. A new tag may start inside a tag (`parentId`). */
  export type TagDialogRequest =
    | { type: 'create'; parentId: string | null }
    | { type: 'rename' | 'color' | 'move' | 'delete'; node: FrameleafTagNode };
</script>

<script lang="ts">
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import TagSwatches from '$lib/components/frameleaf/tags/TagSwatches.svelte';
  import FormatMessage from '$lib/elements/FormatMessage.svelte';
  import {
    DEFAULT_TAG_COLOR,
    cleanTagName,
    flattenTagTree,
    tagColorHex,
    tagColorId,
    tagDescendantCount,
    tagMoveProblem,
    tagMoveTargets,
    tagNameTaken,
    type FrameleafTagTree,
    type TagColorId,
  } from '$lib/frameleaf/tag-tree';
  import { handleError } from '$lib/utils/handle-error';
  import { createTag, deleteTag, updateTag } from '@frameleaf/sdk';
  import { untrack } from 'svelte';
  import { t } from 'svelte-i18n';

  /**
   * One dialog for every tag change that needs a form or a confirmation: New tag, Rename, Colour,
   * Move and Delete. It checks what can be checked here (a name without slashes, no tag of that name
   * in the same place, no move into the tag itself), writes through the tag API, and reports what
   * was done; the page decides where to go next.
   *
   * A refused or failed write keeps the dialog open with the reason, so nothing typed is lost.
   */
  let {
    request,
    tree,
    onDone,
    onClose,
  }: {
    request: TagDialogRequest;
    tree: FrameleafTagTree;
    onDone: (result: TagDialogResult) => void | Promise<void>;
    /** Called once the dialog has finished closing, whether it did anything or not. */
    onClose: () => void;
  } = $props();

  // The request does not change while the dialog is open: the page mounts one dialog per request.
  const initial = untrack(() => request);
  const node = initial.type === 'create' ? null : initial.node;
  const startParent = initial.type === 'create' ? initial.parentId : (node?.parent?.id ?? null);

  let open = $state(true);
  let saving = $state(false);
  let error = $state('');
  let name = $state(initial.type === 'rename' ? initial.node.name : '');
  let parentId = $state(startParent ?? '');
  // A new tag starts in the colour of the tag it goes inside, like the tags already there.
  let color = $state<TagColorId | null>(
    initial.type === 'create'
      ? (tagColorId(startParent ? tree.byId.get(startParent)?.color : null) ?? DEFAULT_TAG_COLOR)
      : tagColorId(node?.color),
  );
  let form = $state<HTMLFormElement>();

  const formId = $props.id();
  const parents = node ? tagMoveTargets(tree, node) : flattenTagTree(tree);
  // Indented under their parents, the way the list view draws the same tree.
  const optionLabel = (option: FrameleafTagNode) => `${'— '.repeat(option.depth)}${option.name}`;
  const pathOf = (target: FrameleafTagNode) => target.path.join(' › ');

  const title = $derived.by(() => {
    switch (initial.type) {
      case 'create': {
        const parent = startParent ? tree.byId.get(startParent) : undefined;
        return parent ? $t('frameleaf_tags_new_in', { values: { name: parent.name } }) : $t('frameleaf_tags_new');
      }
      case 'rename': {
        return $t('frameleaf_tags_rename_title');
      }
      case 'color': {
        return $t('frameleaf_tags_color_title');
      }
      case 'move': {
        return $t('frameleaf_tags_move_title', { values: { name: initial.node.name } });
      }
      default: {
        return $t('delete_tag');
      }
    }
  });

  const submitLabel = $derived(
    { create: $t('create'), rename: $t('save'), color: $t('save'), move: $t('move'), delete: $t('delete') }[
      initial.type
    ],
  );

  /** The typed name, cleaned, or null after saying what is wrong with it. */
  const checkedName = (under: string | null, exceptId?: string): string | null => {
    const clean = cleanTagName(name);
    if (!clean) {
      error = $t('frameleaf_tags_name_invalid');
      return null;
    }
    if (tagNameTaken(tree, under, clean, exceptId)) {
      error = $t('frameleaf_tags_name_taken', { values: { name: clean } });
      return null;
    }
    return clean;
  };

  const run = async (): Promise<TagDialogResult | null> => {
    switch (initial.type) {
      case 'create': {
        const under = parentId || null;
        const clean = checkedName(under);
        if (!clean) {
          return null;
        }
        const tag = await createTag({
          tagCreateDto: { name: clean, parentId: under, color: tagColorHex(color ?? DEFAULT_TAG_COLOR) },
        });
        return { type: 'created', tag };
      }
      case 'rename': {
        const clean = checkedName(initial.node.parent?.id ?? null, initial.node.id);
        if (!clean) {
          return null;
        }
        if (clean === initial.node.name) {
          open = false;
          return null;
        }
        return {
          type: 'renamed',
          tag: await updateTag({ id: initial.node.id, tagUpdateDto: { name: clean } }),
        };
      }
      case 'color': {
        if (!color || color === tagColorId(initial.node.color)) {
          open = false;
          return null;
        }
        return {
          type: 'recolored',
          tag: await updateTag({ id: initial.node.id, tagUpdateDto: { color: tagColorHex(color) } }),
        };
      }
      case 'move': {
        const under = parentId || null;
        const problem = tagMoveProblem(tree, initial.node, under);
        if (problem === 'same-place') {
          open = false;
          return null;
        }
        if (problem) {
          error =
            problem === 'name-taken'
              ? $t('frameleaf_tags_name_taken', { values: { name: initial.node.name } })
              : $t('frameleaf_tags_move_inside_itself');
          return null;
        }
        return {
          type: 'moved',
          tag: await updateTag({ id: initial.node.id, tagUpdateDto: { parentId: under } }),
        };
      }
      default: {
        await deleteTag({ id: initial.node.id });
        return { type: 'deleted', node: initial.node };
      }
    }
  };

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (saving) {
      return;
    }
    error = '';
    saving = true;
    try {
      let result: TagDialogResult | null;
      try {
        result = await run();
      } catch (error_) {
        // Said here rather than in a toast: the dialog is still open and covers the page behind it.
        // `handleError` words it for the customer (never the server's own message) without toasting.
        const fallback = $t(
          initial.type === 'delete' ? 'errors.frameleaf_tags_unable_to_delete' : 'errors.frameleaf_tags_unable_to_save',
        );
        error = handleError(error_, fallback, { notify: false }) ?? fallback;
        return;
      }
      if (result) {
        // The change is saved; the page re-reads the tags before the dialog steps aside.
        try {
          await onDone(result);
        } finally {
          open = false;
        }
      }
    } finally {
      saving = false;
    }
  };
</script>

<Dialog {title} closeLabel={$t('close')} bind:open onClosed={onClose}>
  <form id={formId} class="form" onsubmit={(event) => void submit(event)} bind:this={form}>
    {#if initial.type === 'create' || initial.type === 'rename'}
      <label>
        {$t('name')}
        <input
          data-initial-focus
          bind:value={name}
          maxlength="60"
          autocomplete="off"
          aria-invalid={error ? true : undefined}
        />
      </label>
    {/if}
    {#if initial.type === 'create' || initial.type === 'move'}
      <label>
        {$t('frameleaf_tags_inside')}
        <!-- A select holds its own value: nothing to focus first when the name field is there. -->
        <select bind:value={parentId} data-initial-focus={initial.type === 'move' ? '' : undefined}>
          <option value="">{$t('frameleaf_tags_parent_none')}</option>
          {#each parents as option (option.id)}
            <option value={option.id}>{optionLabel(option)}</option>
          {/each}
        </select>
      </label>
    {/if}
    {#if initial.type === 'create' || initial.type === 'color'}
      <TagSwatches value={color} initialFocus={initial.type === 'color'} onChange={(next) => (color = next)} />
    {/if}
    {#if initial.type === 'delete'}
      {@const inside = tagDescendantCount(initial.node)}
      <p>
        <FormatMessage
          key={inside > 0 ? 'frameleaf_tags_delete_confirm_inside' : 'frameleaf_tags_delete_confirm'}
          values={{ tag: pathOf(initial.node), count: inside }}
        >
          {#snippet children({ message })}<strong>{message}</strong>{/snippet}
        </FormatMessage>
        {initial.node.total === 0
          ? $t('frameleaf_tags_delete_no_items')
          : inside > 0
            ? $t('frameleaf_tags_delete_items_inside', { values: { count: initial.node.total } })
            : $t('frameleaf_tags_delete_items', { values: { count: initial.node.total } })}
      </p>
    {/if}
    {#if error}
      <p class="error" role="alert">{error}</p>
    {/if}
  </form>
  {#snippet actions()}
    <!-- A delete opens on Cancel, so Enter alone never deletes. -->
    <Button initialFocus={initial.type === 'delete'} onclick={() => (open = false)}>{$t('cancel')}</Button>
    <!-- The footer sits outside the form (Dialog pins it), so it submits the form explicitly. -->
    <Button
      variant={initial.type === 'delete' ? 'danger' : 'primary'}
      disabled={saving}
      onclick={() => form?.requestSubmit()}
    >
      {submitLabel}
    </Button>
  {/snippet}
</Dialog>

<style>
  .form {
    display: flex;
    flex-direction: column;
    gap: var(--fl-space-4);
  }
  label {
    display: flex;
    flex-direction: column;
    gap: var(--fl-space-2);
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  input,
  select {
    padding: 7px var(--fl-space-3);
    font-size: var(--fl-font-size);
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  p {
    margin: 0;
    line-height: 1.55;
  }
  .error {
    color: var(--fl-danger);
    font-size: var(--fl-font-small);
    /* The reason ("Try again in a moment.") comes on its own line. */
    white-space: pre-line;
  }
</style>
