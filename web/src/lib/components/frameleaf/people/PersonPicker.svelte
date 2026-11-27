<script lang="ts">
  /**
   * The one person picker (FL-1814; the prototype's `PersonPickerList` in `ComponentsSheet.jsx`).
   * Search finds anyone on the server by name, not only the people already loaded; the list shows
   * more on request, each person with their photo count; "Someone new…" is offered when the caller
   * can make one. The cursor is in the search field as it opens.
   *
   * It reads `GET /people/picker` (FL-1789): stored counts, so a page costs little however large the
   * library. Hidden people are included, as everywhere a person is chosen.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import PersonAvatar from '$lib/components/frameleaf/PersonAvatar.svelte';
  import { isUnnamedPerson } from '$lib/frameleaf/people';
  import { handleError } from '$lib/utils/handle-error';
  import { getPeoplePicker, type PeoplePickerItemDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiAccountPlusOutline, mdiCheck } from '@mdi/js';
  import { onDestroy, onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  interface Props {
    /** A person not to offer (the one the faces are coming from, the one being merged). */
    excludeId?: string;
    label: string;
    onPick: (person: PeoplePickerItemDto) => void;
    /** Without it there is no Cancel button, and Escape is left to the surrounding dialog. */
    onCancel?: () => void;
    /** The person currently chosen, when picking does not end the step. */
    selectedId?: string;
    /** Leave out people who have no name yet. */
    namedOnly?: boolean;
    /** Offers "Someone new…"; gets the name typed, or an empty one. */
    onNew?: (name: string) => void;
  }

  let { excludeId, label, onPick, onCancel, selectedId, namedOnly = false, onNew }: Props = $props();

  const PAGE_SIZE = 50;
  /** A name search waits for typing to pause, so a word is one request rather than one per letter. */
  const SEARCH_DELAY_MS = 200;

  let query = $state('');
  let people: PeoplePickerItemDto[] = $state([]);
  let page = $state(1);
  /** The search the list shows, which "Show more" continues even while a newer one is still pending. */
  let shownQuery = $state('');
  let hasMore = $state(false);
  let loading = $state(false);
  let input: HTMLInputElement | undefined = $state();
  // only the newest request may answer, so a slow earlier search never replaces a later one
  let request = 0;
  let inFlight: AbortController | undefined;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;

  const load = async (next: { query: string; page: number }) => {
    const current = ++request;
    inFlight?.abort();
    const controller = new AbortController();
    inFlight = controller;
    loading = true;
    try {
      const name = next.query.trim();
      const result = await getPeoplePicker(
        { withHidden: true, page: next.page, size: PAGE_SIZE, ...(name && { name }) },
        { signal: controller.signal },
      );
      if (current !== request) {
        return;
      }
      const rows = result.people.filter((person) => person.id !== excludeId && !(namedOnly && isUnnamedPerson(person)));
      // a later page can repeat someone when the list shifted meanwhile
      const known = new Set(next.page === 1 ? [] : people.map(({ id }) => id));
      people = [...(next.page === 1 ? [] : people), ...rows.filter(({ id }) => !known.has(id))];
      hasMore = result.hasNextPage;
      page = next.page;
      shownQuery = next.query;
    } catch (error) {
      if (current === request && !controller.signal.aborted) {
        handleError(error, $t('errors.failed_to_load_people'));
      }
    } finally {
      if (current === request) {
        loading = false;
      }
    }
  };

  onMount(() => {
    // Inside a dialog the dialog's initial focus does this too; inline (Fix recognition) only this does.
    input?.focus();
    void load({ query: '', page: 1 });
  });
  onDestroy(() => {
    clearTimeout(searchTimer);
    inFlight?.abort();
  });

  const onInput = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void load({ query, page: 1 }), SEARCH_DELAY_MS);
  };

  const onKeydown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !onCancel) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    onCancel();
  };

  const nameOf = (person: PeoplePickerItemDto) => (isUnnamedPerson(person) ? $t('unnamed_person') : person.name);
  const typed = $derived(query.trim());
</script>

<div class="picker" role="group" aria-label={label}>
  <input
    bind:this={input}
    bind:value={query}
    type="search"
    class="search"
    aria-label={$t('frameleaf_people_find_a_person')}
    placeholder={$t('frameleaf_people_find_a_person')}
    data-initial-focus
    oninput={onInput}
    onkeydown={onKeydown}
  />
  <ul class="list" aria-label={$t('people')} aria-busy={loading}>
    {#each people as person (person.id)}
      <li>
        <button
          type="button"
          class:selected={person.id === selectedId}
          aria-pressed={selectedId === undefined ? undefined : person.id === selectedId}
          onclick={() => onPick(person)}
        >
          <PersonAvatar {person} size={32} />
          <span class="name" class:unnamed={isUnnamedPerson(person)}>{nameOf(person)}</span>
          <small class="count">{$t('frameleaf_people_items_count', { values: { count: person.assetCount } })}</small>
          {#if person.id === selectedId}
            <Icon icon={mdiCheck} size="18" aria-hidden="true" />
          {/if}
        </button>
      </li>
    {:else}
      {#if !loading}
        <li class="empty">{$t('frameleaf_people_merge_no_match')}</li>
      {/if}
    {/each}
  </ul>
  {#if hasMore}
    <Button disabled={loading} onclick={() => void load({ query: shownQuery, page: page + 1 })}>
      {$t('frameleaf_people_show_more')}
    </Button>
  {/if}
  {#if onNew || onCancel}
    <div class="footer">
      {#if onNew}
        <button type="button" class="new" onclick={() => onNew(typed)}>
          <Icon icon={mdiAccountPlusOutline} size="18" aria-hidden="true" />
          {typed
            ? $t('frameleaf_people_picker_someone_new_named', { values: { name: typed } })
            : $t('frameleaf_people_fix_someone_new')}
        </button>
      {/if}
      {#if onCancel}
        <Button variant="quiet" onclick={onCancel}>{$t('cancel')}</Button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .picker {
    display: flex;
    flex-direction: column;
    gap: var(--fl-space-2);
  }
  .search {
    width: 100%;
    min-height: 44px;
    padding: var(--fl-space-2) var(--fl-space-3);
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 288px;
    margin: 0;
    padding: 0;
    overflow: auto;
    list-style: none;
  }
  .list button,
  .new {
    display: flex;
    align-items: center;
    gap: var(--fl-space-3);
    width: 100%;
    min-height: 44px;
    padding: var(--fl-space-1) var(--fl-space-2);
    color: var(--fl-text);
    font: inherit;
    text-align: start;
    background: none;
    border: 0;
    border-radius: var(--fl-radius-control);
    cursor: pointer;
  }
  .list button:hover,
  .list button:focus-visible,
  .new:hover,
  .new:focus-visible {
    background: var(--fl-raised);
  }
  .list button.selected {
    background: var(--fl-accent-soft);
    box-shadow: inset 0 0 0 1px var(--fl-accent);
  }
  .name {
    flex: 1;
    min-width: 0;
  }
  .name.unnamed {
    color: var(--fl-muted);
  }
  .count {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .empty {
    padding: var(--fl-space-2);
    color: var(--fl-muted);
  }
  .footer {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--fl-space-3);
  }
  .new {
    flex: 1;
    color: var(--fl-muted);
  }
</style>
