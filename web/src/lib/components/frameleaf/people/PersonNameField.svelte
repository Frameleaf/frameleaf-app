<script lang="ts">
  import PersonAvatar from '$lib/components/frameleaf/PersonAvatar.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import { searchPerson, type PersonResponseDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiCheck, mdiClose } from '@mdi/js';
  import { onDestroy, onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  /**
   * Frameleaf inline person-name editor (FL-37), ported from the prototype's
   * `PersonNameEditor` (design/frameleaf/template/src/People.jsx:297-432): a combobox whose
   * listbox suggests existing names, Enter or the check button commits, Escape (with the list
   * closed) or leaving the editor cancels.
   *
   * PN-3: suggestions come from the real `searchPerson` endpoint (debounced, aborted when the
   * text changes) instead of the legacy `PeopleSearch` component. Committing calls the
   * caller's `onCommit`; the People pages own the `updatePerson` call and any merge prompt.
   */

  interface Props {
    person: Pick<PersonResponseDto, 'id' | 'name'>;
    placeholder?: string;
    /** Accessible name of the text field; defaults to "Name for {name}". */
    label?: string;
    onCommit: (name: string) => void;
    onCancel: () => void;
  }

  let { person, placeholder, label, onCommit, onCancel }: Props = $props();

  const SEARCH_DELAY = 200;
  const MAX_SUGGESTIONS = 6;

  // svelte-ignore state_referenced_locally
  let value = $state(person.name ?? '');
  let found: PersonResponseDto[] = $state([]);
  let active = $state(-1);
  let dismissed = $state(false);
  let input: HTMLInputElement | undefined = $state();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let request: AbortController | undefined;
  const formId = $props.id();
  const listId = `${formId}-suggestions`;

  const suggestions = $derived(
    found
      .filter((candidate) => candidate.id !== person.id && candidate.name && candidate.name !== value.trim())
      .slice(0, MAX_SUGGESTIONS),
  );
  const showList = $derived(!dismissed && suggestions.length > 0);

  const cancelSearch = () => {
    clearTimeout(timer);
    request?.abort();
    request = undefined;
  };

  const run = async (text: string) => {
    const controller = new AbortController();
    request = controller;
    try {
      const people = await searchPerson({ name: text.trim(), withHidden: false }, { signal: controller.signal });
      if (!controller.signal.aborted) {
        found = people;
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        handleError(error, $t('errors.cant_search_people'));
      }
    }
  };

  const search = (text: string) => {
    cancelSearch();
    if (!text.trim()) {
      found = [];
      return;
    }
    timer = setTimeout(() => void run(text), SEARCH_DELAY);
  };

  onMount(() => {
    input?.focus();
    input?.select();
  });
  onDestroy(cancelSearch);

  const commit = (name: string) => {
    cancelSearch();
    onCommit(name.trim());
  };
  const chosen = () => (showList && active >= 0 ? suggestions[active].name : value);

  const onsubmit = (event: Event) => {
    event.preventDefault();
    commit(chosen());
  };

  const onkeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (showList) {
        dismissed = true;
      } else {
        onCancel();
      }
    } else if (event.key === 'ArrowDown' && suggestions.length > 0) {
      event.preventDefault();
      dismissed = false;
      active = (active + 1) % suggestions.length;
    } else if (event.key === 'ArrowUp' && suggestions.length > 0) {
      event.preventDefault();
      dismissed = false;
      active = (active - 1 + suggestions.length) % suggestions.length;
    }
  };

  const onfocusout = (event: FocusEvent) => {
    // Focus moving to another control of this same editor (the buttons, a suggestion) is
    // not leaving it. Matched by id rather than `contains`, which happy-dom's proxied form
    // element answers wrongly.
    const next = event.relatedTarget;
    if (next instanceof Element && next.closest('form')?.id === formId) {
      return;
    }
    // FL-83 (PN-1): leaving the editor abandons the rename, as in the prototype.
    onCancel();
  };
</script>

<form id={formId} class="name-field" autocomplete="off" {onsubmit} {onfocusout}>
  <input
    bind:this={input}
    type="text"
    role="combobox"
    aria-autocomplete="list"
    aria-expanded={showList}
    aria-controls={listId}
    aria-activedescendant={showList && active >= 0 ? `${listId}-${active}` : undefined}
    aria-label={label ??
      $t('frameleaf_people_name_editor_label', { values: { name: person.name || $t('add_a_name') } })}
    placeholder={placeholder ?? $t('name')}
    maxlength={120}
    bind:value
    oninput={() => {
      active = -1;
      dismissed = false;
      search(value);
    }}
    {onkeydown}
  />
  <!-- FL-83 (PN-2): icon buttons, as in the prototype. The mousedown guard keeps focus on
       the input so a click here never reads as leaving the editor (which cancels). -->
  <button
    type="submit"
    class="icon"
    aria-label={$t('frameleaf_people_save_name')}
    onmousedown={(event) => event.preventDefault()}
  >
    <Icon icon={mdiCheck} size="16" aria-hidden="true" />
  </button>
  <button
    type="button"
    class="icon"
    aria-label={$t('frameleaf_people_cancel_rename')}
    onmousedown={(event) => event.preventDefault()}
    onclick={() => onCancel()}
  >
    <Icon icon={mdiClose} size="16" aria-hidden="true" />
  </button>
  {#if showList}
    <ul class="suggestions" role="listbox" id={listId} aria-label={$t('frameleaf_people_name_suggestions')}>
      {#each suggestions as suggestion, index (suggestion.id)}
        <!-- svelte-ignore a11y_click_events_have_key_events (the combobox input owns the keyboard) -->
        <li
          id="{listId}-{index}"
          role="option"
          aria-selected={index === active}
          class:active={index === active}
          onmousedown={(event) => event.preventDefault()}
          onclick={() => commit(suggestion.name)}
        >
          <PersonAvatar person={suggestion} size={24} />
          <span>{suggestion.name}</span>
        </li>
      {/each}
    </ul>
  {/if}
</form>

<style>
  /* template/src/people.css `.pp-name-editor`, `.pp-icon-button`, `.pp-suggestions`. */
  .name-field {
    position: relative;
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    max-width: 320px;
  }
  input {
    flex: 1;
    min-width: 0;
    min-height: 34px;
    padding: 6px 10px;
    border-radius: var(--fl-radius-control);
    font-size: var(--fl-font-size);
  }
  .icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    min-width: 44px;
    min-height: 44px;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .icon:hover {
    background: color-mix(in srgb, var(--fl-raised), var(--fl-text) 8%);
  }
  .suggestions {
    position: absolute;
    inset-inline: 0;
    top: calc(100% + 6px);
    z-index: 31;
    max-height: 240px;
    margin: 0;
    padding: 6px;
    overflow: auto;
    list-style: none;
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    box-shadow: var(--fl-shadow-2);
  }
  .suggestions li {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 44px;
    padding: 6px 8px;
    color: var(--fl-text);
    border-radius: var(--fl-radius-control);
    cursor: pointer;
    font-size: var(--fl-font-size);
  }
  .suggestions li:hover,
  .suggestions li.active {
    background: var(--fl-raised);
  }
  .suggestions li.active {
    box-shadow: inset 0 0 0 1px var(--fl-accent);
  }
</style>
