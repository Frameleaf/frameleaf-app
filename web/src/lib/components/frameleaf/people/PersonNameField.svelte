<script lang="ts">
  import PersonAvatar from '$lib/components/frameleaf/PersonAvatar.svelte';
  import SearchPeople from '$lib/components/faces-page/PeopleSearch.svelte';
  import type { PersonResponseDto } from '@immich/sdk';
  import { t } from 'svelte-i18n';

  /**
   * Frameleaf inline person-name editor (FL-37), ported from the prototype's
   * `PersonNameEditor` in `design/frameleaf/template/src/People.jsx`.
   *
   * Suggestions come from the real `searchPerson` endpoint through the existing
   * `SearchPeople` component (the same one `EditNameInput` uses on the person page), so
   * no client-side fixture ever stands in for the recognition search. Committing a name
   * calls the caller's `onCommit`, which the People pages wire to the existing
   * `updatePerson` name-change flow, including its already-working merge-on-collision
   * prompt; this component owns no network call of its own.
   */

  interface Props {
    person: PersonResponseDto;
    placeholder?: string;
    onCommit: (name: string) => void;
    onCancel: () => void;
  }

  let { person, placeholder, onCommit, onCancel }: Props = $props();

  let value = $state(person.name ?? '');
  let searchedPeopleLocal: PersonResponseDto[] = $state([]);
  let showLoadingSpinner = $state(false);
  let active = $state(-1);
  let wrap: HTMLFormElement | undefined = $state();

  const suggestions = $derived(searchedPeopleLocal.filter((candidate) => candidate.id !== person.id && candidate.name));

  const commit = (name: string) => onCommit(name.trim());

  const onsubmit = (event: Event) => {
    event.preventDefault();
    commit(active >= 0 && suggestions[active] ? suggestions[active].name : value);
  };

  const onkeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    } else if (event.key === 'ArrowDown' && suggestions.length > 0) {
      event.preventDefault();
      active = (active + 1) % suggestions.length;
    } else if (event.key === 'ArrowUp' && suggestions.length > 0) {
      event.preventDefault();
      active = (active - 1 + suggestions.length) % suggestions.length;
    }
  };

  const onfocusout = (event: FocusEvent) => {
    const next = event.relatedTarget as Node | null;
    if (wrap && next && wrap.contains(next)) {
      return;
    }
    // Matches the production people grid's existing blur-to-save behaviour.
    commit(value);
  };
</script>

<form
  bind:this={wrap}
  class="name-field"
  autocomplete="off"
  {onsubmit}
  {onfocusout}
  {onkeydown}
  aria-label={$t('frameleaf_people_name_editor_label', { values: { name: person.name || $t('add_a_name') } })}
>
  <SearchPeople
    type="input"
    numberPeopleToSearch={6}
    bind:searchName={value}
    bind:searchedPeopleLocal
    bind:showLoadingSpinner
    placeholder={placeholder ?? $t('add_a_name')}
    onReset={() => (active = -1)}
    onSearch={() => (active = -1)}
  />
  <button type="submit" class="save" aria-label={$t('frameleaf_people_save_name')}>
    {$t('done')}
  </button>
  <button type="button" class="cancel" aria-label={$t('frameleaf_people_cancel_rename')} onclick={() => onCancel()}>
    {$t('cancel')}
  </button>
  {#if suggestions.length > 0}
    <ul class="suggestions" role="listbox" aria-label={$t('frameleaf_people_name_suggestions')}>
      {#each suggestions as suggestion, index (suggestion.id)}
        <li role="option" aria-selected={index === active}>
          <button
            type="button"
            class:active={index === active}
            onmousedown={(event) => event.preventDefault()}
            onclick={() => commit(suggestion.name)}
          >
            <PersonAvatar person={suggestion} size={24} />
            <span>{suggestion.name}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</form>

<style>
  .name-field {
    position: relative;
    display: flex;
    align-items: center;
    gap: 0.375rem;
  }
  .save,
  .cancel {
    flex-shrink: 0;
    min-width: 44px;
    padding: 0.375rem 0.5rem;
    font-size: var(--fl-font-small);
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .save:hover,
  .cancel:hover {
    background: color-mix(in srgb, var(--fl-raised), var(--fl-text) 8%);
  }
  .suggestions {
    position: absolute;
    inset-inline: 0;
    top: calc(100% + 0.25rem);
    z-index: 30;
    max-height: 14rem;
    overflow-y: auto;
    padding: 0.25rem;
    list-style: none;
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    box-shadow: var(--fl-shadow-2);
  }
  .suggestions button {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.375rem 0.5rem;
    text-align: start;
    color: var(--fl-text);
    background: transparent;
    border: 0;
    border-radius: var(--fl-radius-control);
  }
  .suggestions button:hover,
  .suggestions button.active {
    background: var(--fl-raised);
  }
</style>
