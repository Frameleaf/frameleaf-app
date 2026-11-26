<script lang="ts">
  /**
   * Choose any of the user's people (FL-57): the "Move to…" step of fix incorrect match.
   * Composed from the prototype's searchable pickers, `SearchableSelect.jsx` (a find field over a
   * listbox) and the people list of `MergePeopleDialog` (People.jsx:434-536, face photo + name +
   * item count per row). It reaches everyone, not only the six with the most photos: with a query
   * it asks `searchPerson` (hidden people included), otherwise it pages through `getAllPeople`,
   * 50 at a time, with "Show more".
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import PersonAvatar from '$lib/components/frameleaf/PersonAvatar.svelte';
  import { isUnnamedPerson } from '$lib/frameleaf/people';
  import { handleError } from '$lib/utils/handle-error';
  import { getAllPeople, searchPerson, type PersonResponseDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiCheck } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  interface Props {
    /** The person the faces are coming from; not offered. */
    excludeId: string;
    label: string;
    onPick: (person: PersonResponseDto) => void;
    /** Without it there is no Cancel button, and Escape is left to the surrounding dialog. */
    onCancel?: () => void;
    /** FL-842: the person currently chosen, when picking does not end the step. */
    selectedId?: string;
    /** FL-842: leave out people who have no name yet. */
    namedOnly?: boolean;
  }

  let { excludeId, label, onPick, onCancel, selectedId, namedOnly = false }: Props = $props();

  const PAGE_SIZE = 50;

  let query = $state('');
  let people: PersonResponseDto[] = $state([]);
  let page = $state(1);
  let hasMore = $state(false);
  let loading = $state(false);
  let input: HTMLInputElement | undefined = $state();
  // only the newest request may answer, so a slow earlier search never replaces a later one
  let request = 0;

  const load = async (next: { query: string; page: number }) => {
    const current = ++request;
    loading = true;
    try {
      let found: PersonResponseDto[];
      let more = false;
      if (next.query.trim()) {
        found = await searchPerson({ name: next.query.trim(), withHidden: true });
      } else {
        const result = await getAllPeople({ withHidden: true, page: next.page, size: PAGE_SIZE });
        found = result.people;
        more = !!result.hasNextPage;
      }
      if (current !== request) {
        return;
      }
      const rows = found.filter((person) => person.id !== excludeId && !(namedOnly && isUnnamedPerson(person)));
      // a later page can repeat someone when the list shifted meanwhile
      const known = new Set(next.page === 1 ? [] : people.map(({ id }) => id));
      people = [...(next.page === 1 ? [] : people), ...rows.filter(({ id }) => !known.has(id))];
      hasMore = more;
      page = next.page;
    } catch (error) {
      handleError(error, $t('errors.failed_to_load_people'));
    } finally {
      if (current === request) {
        loading = false;
      }
    }
  };

  onMount(() => {
    input?.focus();
    void load({ query: '', page: 1 });
  });

  const onInput = () => void load({ query, page: 1 });

  const onKeydown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !onCancel) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    onCancel();
  };

  const nameOf = (person: PersonResponseDto) => (isUnnamedPerson(person) ? $t('unnamed_person') : person.name);
</script>

<div class="picker" role="group" aria-label={label}>
  <input
    bind:this={input}
    bind:value={query}
    type="search"
    class="search"
    aria-label={$t('frameleaf_people_find_a_person')}
    placeholder={$t('frameleaf_people_find_a_person')}
    oninput={onInput}
    onkeydown={onKeydown}
  />
  <ul class="list" aria-label={$t('people')}>
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
  <div class="footer">
    {#if hasMore && !query.trim()}
      <Button disabled={loading} onclick={() => void load({ query: '', page: page + 1 })}>
        {$t('frameleaf_people_show_more')}
      </Button>
    {/if}
    {#if onCancel}
      <Button variant="quiet" onclick={onCancel}>{$t('cancel')}</Button>
    {/if}
  </div>
</div>

<style>
  .picker {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .search {
    width: 100%;
    padding: 8px 12px;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 240px;
    margin: 0;
    padding: 0;
    overflow: auto;
    list-style: none;
  }
  .list button {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 6px 8px;
    color: var(--fl-text);
    text-align: start;
    background: none;
    border: 0;
    border-radius: var(--fl-radius-control);
  }
  .list button:hover,
  .list button:focus-visible {
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
  .empty {
    padding: 8px;
    color: var(--fl-muted);
  }
  .footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
</style>
