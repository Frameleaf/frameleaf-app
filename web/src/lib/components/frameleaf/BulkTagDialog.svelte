<script lang="ts">
  import BulkFormDialog from '$lib/components/frameleaf/BulkFormDialog.svelte';
  import type { BulkPayload } from '$lib/frameleaf/bulk-operations';
  import { t } from 'svelte-i18n';

  /**
   * Tag, ported from the prototype's `TagDialog`. Existing tags are chosen by id; a name that
   * matches nothing is created through the tag upsert endpoint when the action runs, so no tag is
   * created for a dialog the user cancels.
   */
  type TagOption = { id: string; name: string };

  let {
    count,
    options = [],
    open = $bindable(true),
    onSubmit,
  }: {
    count: number;
    options?: TagOption[];
    open?: boolean;
    onSubmit: (payload: BulkPayload) => void;
  } = $props();

  type Chosen = { id?: string; name: string };

  let chosen = $state<Chosen[]>([]);
  let query = $state('');
  let active = $state(0);

  const listId = $props.id();

  let needle = $derived(query.trim().toLowerCase());
  let chosenNames = $derived(new Set(chosen.map((tag) => tag.name.toLowerCase())));
  let matches = $derived(
    options
      .filter((option) => !chosenNames.has(option.name.toLowerCase()))
      .filter((option) => !needle || option.name.toLowerCase().includes(needle))
      .slice(0, 8),
  );
  let canCreate = $derived(
    !!needle && options.every((option) => option.name.toLowerCase() !== needle) && !chosenNames.has(needle),
  );
  let suggestions: (TagOption & { isNew?: boolean })[] = $derived([
    ...matches,
    ...(canCreate ? [{ id: '', name: query.trim(), isNew: true }] : []),
  ]);
  let highlighted = $derived(Math.min(active, Math.max(0, suggestions.length - 1)));

  const add = (tag: { id: string; name: string; isNew?: boolean }) => {
    if (chosenNames.has(tag.name.toLowerCase())) {
      return;
    }
    chosen = [...chosen, tag.isNew ? { name: tag.name } : { id: tag.id, name: tag.name }];
    query = '';
    active = 0;
  };
  const remove = (name: string) => (chosen = chosen.filter((tag) => tag.name !== name));

  const onKeyDown = (event: KeyboardEvent) => {
    switch (event.key) {
      case 'ArrowDown': {
        event.preventDefault();
        active = Math.min(suggestions.length - 1, highlighted + 1);

        break;
      }
      case 'ArrowUp': {
        event.preventDefault();
        active = Math.max(0, highlighted - 1);

        break;
      }
      case 'Enter': {
        // Enter chooses from the list; it must not submit the form with a half-typed tag.
        event.preventDefault();
        if (suggestions.length > 0) {
          add(suggestions[highlighted]);
        }

        break;
      }
      default: {
        if (event.key === 'Backspace' && !query && chosen.length > 0) {
          remove(chosen.at(-1)!.name);
        }
      }
    }
  };

  const submit = () =>
    onSubmit({
      tagIds: chosen.map((tag) => tag.id).filter((id): id is string => !!id),
      newTagNames: chosen.filter((tag) => !tag.id).map((tag) => tag.name),
    });
</script>

<BulkFormDialog
  bind:open
  title={$t('frameleaf_bulk_tag')}
  submitLabel={$t('frameleaf_bulk_tag_apply', { values: { count } })}
  valid={chosen.length > 0}
  onSubmit={submit}
>
  <ul class="chips" aria-label={$t('frameleaf_bulk_tag_chosen')}>
    {#each chosen as tag (tag.name)}
      <li class:is-new={!tag.id}>
        {tag.name}
        <button
          type="button"
          aria-label={$t('frameleaf_bulk_tag_remove', { values: { name: tag.name } })}
          onclick={() => remove(tag.name)}
        >
          &times;
        </button>
      </li>
    {:else}
      <li class="empty">{$t('frameleaf_bulk_tag_none_chosen')}</li>
    {/each}
  </ul>

  <label>
    {$t('frameleaf_bulk_tag_add')}
    <input
      role="combobox"
      aria-expanded={suggestions.length > 0}
      aria-controls={listId}
      aria-autocomplete="list"
      aria-activedescendant={suggestions.length > 0 ? `${listId}-${highlighted}` : undefined}
      autocomplete="off"
      placeholder={$t('frameleaf_bulk_tag_placeholder')}
      bind:value={query}
      oninput={() => (active = 0)}
      onkeydown={onKeyDown}
    />
  </label>
  <!-- A listbox of buttons: each option is one focusable element, so an option never wraps an
       interactive child and the combobox above keeps ownership of the keyboard. -->
  <div id={listId} role="listbox" class="listbox" aria-label={$t('frameleaf_bulk_tag_suggestions')}>
    {#each suggestions as tag, index (tag.isNew ? `new:${tag.name}` : tag.id)}
      <button
        type="button"
        id={`${listId}-${index}`}
        role="option"
        tabindex="-1"
        aria-selected={index === highlighted}
        onclick={() => add(tag)}
      >
        <span>{tag.name}</span>
        {#if tag.isNew}<small>{$t('frameleaf_bulk_tag_create')}</small>{/if}
      </button>
    {:else}
      <p class="empty">{$t('frameleaf_bulk_tag_no_matches')}</p>
    {/each}
  </div>
</BulkFormDialog>

<style>
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }
  .chips li {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: 999px;
    padding: 0.15rem 0.35rem 0.15rem 0.6rem;
    font-size: 0.8125rem;
  }
  .chips li.is-new {
    border-color: var(--fl-accent);
  }
  .chips button {
    background: transparent;
    border: 0;
    color: var(--fl-muted);
    min-height: 0;
    min-width: 1.5rem;
    line-height: 1;
  }
  .listbox {
    max-height: 12rem;
    overflow: auto;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
  }
  .listbox button {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
    width: 100%;
    background: transparent;
    border: 0;
    color: var(--fl-text);
    text-align: start;
    padding: 0.4rem 0.6rem;
    font-size: 0.875rem;
  }
  .listbox button[aria-selected='true'],
  .listbox button:hover {
    background: var(--fl-accent);
    color: var(--fl-accent-text);
  }
  .empty {
    margin: 0;
    color: var(--fl-muted);
    font-size: 0.75rem;
    padding: 0.4rem 0.6rem;
  }
</style>
