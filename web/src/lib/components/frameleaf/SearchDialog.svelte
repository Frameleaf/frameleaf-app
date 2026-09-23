<script lang="ts" module>
  import { QueryType } from '$lib/constants';
  import type { DiscoverySearchDto } from '$lib/components/discovery/query';

  /**
   * The search modes the dialog offers. Each one is a production query type with a real DTO
   * field behind it; the prototype's extra "All text" mode has no server counterpart and is
   * deliberately absent rather than faked.
   */
  export const SEARCH_MODES: readonly {
    type: QueryType;
    labelKey: string;
    /** The DTO key this mode's text is written to. */
    field: keyof DiscoverySearchDto;
    /** The mode's example placeholder, from the production search copy. */
    placeholderKey: string;
  }[] = [
    {
      type: QueryType.SMART,
      labelKey: 'frameleaf_search_mode_smart',
      field: 'query',
      placeholderKey: 'search_by_context_example',
    },
    {
      type: QueryType.METADATA,
      labelKey: 'file_name_text',
      field: 'originalFileName',
      placeholderKey: 'search_by_filename_example',
    },
    {
      type: QueryType.DESCRIPTION,
      labelKey: 'description',
      field: 'description',
      placeholderKey: 'search_by_description_example',
    },
    { type: QueryType.OCR, labelKey: 'ocr', field: 'ocr', placeholderKey: 'search_by_ocr_example' },
    {
      type: QueryType.FULL_PATH,
      labelKey: 'full_path_or_folder',
      field: 'originalPath',
      placeholderKey: 'search_by_full_path_example',
    },
  ];
</script>

<script lang="ts">
  import { goto } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Chip from '$lib/components/frameleaf/Chip.svelte';
  import FilterPanel from '$lib/components/frameleaf/FilterPanel.svelte';
  import PersonAvatar from '$lib/components/frameleaf/PersonAvatar.svelte';
  import PetThumbnail from '$lib/components/frameleaf/pets/PetThumbnail.svelte';
  import SegmentedControl from '$lib/components/frameleaf/SegmentedControl.svelte';
  import {
    activeFilterCount,
    toSearchDto,
    withDiscoveryEnrichment,
    withDiscoveryFacet,
    withoutDiscoveryFilter,
    withoutDiscoveryFilters,
    type DiscoveryFilterSection,
    type DiscoveryQuery,
  } from '$lib/components/discovery/query';
  import {
    isCommandQuery,
    navigationCommands,
    searchCommands,
    type CommandItem,
  } from '$lib/frameleaf/command-palette';
  import { describeFilterChips, ENRICHMENT_QUICK_FILTERS } from '$lib/frameleaf/search-filters';
  import {
    emptyFilterPanelOptions,
    loadFilterPanelOptions,
    loadMatchingCount,
  } from '$lib/frameleaf/search-options';
  import '$lib/frameleaf/tokens.css';
  import { Route } from '$lib/route';
  import { searchStore } from '$lib/stores/search.svelte';
  import { handlePromiseError } from '$lib/utils';
  import { Icon, Theme as AppTheme, themeManager } from '@immich/ui';
  import { mdiChevronRight, mdiClose, mdiMagnify, mdiMapMarker, mdiTune } from '@mdi/js';
  import { onDestroy } from 'svelte';
  import { t } from 'svelte-i18n';

  /**
   * The Frameleaf library search dialog (FL-49), ported from
   * `design/frameleaf/template/src/SearchDialog.jsx`.
   *
   * It is the library's single search entry point (September 22, 2026 revision): the top bar
   * opens it, and it carries the search text and mode, a Go-to section over the command index,
   * the removable filter chips, the enrichment quick filters, and the full filter panel that
   * the results toolbar's Filter control deep-links into.
   *
   * Typing a leading ">" hands the text to the command palette, exactly as the prototype does,
   * so there is still only one place to start.
   */

  let {
    query: initialQuery,
    commandIndex = [],
    section = 'people',
    scopeLabel,
    onClose,
    onCommand,
    onOpenPalette,
    onSubmit,
  }: {
    query: DiscoveryQuery;
    commandIndex?: CommandItem[];
    /** The filter-panel section the Filter control deep-linked into. */
    section?: DiscoveryFilterSection;
    /** Already-translated name of the current scope, shown beside "Search in". */
    scopeLabel?: string;
    onClose: () => void;
    onCommand?: (command: CommandItem) => void;
    onOpenPalette?: (text: string) => void;
    /**
     * Applies the search. When omitted the dialog navigates to the search results route with
     * the DTO the query maps to.
     */
    onSubmit?: (query: DiscoveryQuery, dto: DiscoverySearchDto) => void;
  } = $props();

  let dialog = $state<HTMLDialogElement>();
  let query = $state<DiscoveryQuery>(structuredClone(initialQuery));
  let text = $state(initialQuery.text);
  let mode = $state<QueryType>(initialQuery.mode === 'smart' ? QueryType.SMART : QueryType.METADATA);
  let showFilters = $state(activeFilterCount(initialQuery) > 0);
  let options = $state(emptyFilterPanelOptions());
  let matching = $state<number | null>(null);

  const appTheme = $derived(themeManager.value === AppTheme.Dark ? 'dark' : 'light');
  const titleId = $props.id();

  let optionsController: AbortController | undefined;
  let countController: AbortController | undefined;

  const modeEntry = $derived(SEARCH_MODES.find((entry) => entry.type === mode) ?? SEARCH_MODES[0]);

  /** The query as it will be submitted: the panel's filters plus the typed text and mode. */
  const pending = $derived<DiscoveryQuery>({
    ...query,
    text,
    mode: mode === QueryType.SMART ? 'smart' : 'text',
  });

  const commandQuery = $derived(isCommandQuery(text));
  const chips = $derived(
    describeFilterChips($t, pending, {
      nameFor: (field, id) => {
        if (field === 'personIds') {
          return options.people.find((person) => person.id === id)?.name || undefined;
        }
        if (field === 'petIds') {
          const pet = options.pets.find((item) => item.id === id);
          return pet ? pet.name || $t('frameleaf_pets_unnamed') : undefined;
        }
        const list = field === 'tagIds' ? options.tags : field === 'albumIds' ? options.albums : [];
        return list.find((item) => item.value === id)?.label;
      },
    }),
  );

  const goTo = $derived(
    text.trim().length >= 2 && !commandQuery ? searchCommands(navigationCommands(commandIndex), text, 5) : [],
  );

  const recentSearches = $derived(searchStore.savedSearchTerms.slice(0, 4));

  $effect(() => {
    if (!dialog || dialog.open) {
      return;
    }
    const previous = document.activeElement;
    dialog.showModal();
    // Shortcut handlers elsewhere stand down while the search surface has focus.
    searchStore.isSearchEnabled = true;
    return () => {
      searchStore.isSearchEnabled = false;
      if (previous instanceof HTMLElement && previous.isConnected) {
        previous.focus({ preventScroll: true });
      }
    };
  });

  $effect(() => {
    optionsController?.abort();
    const controller = new AbortController();
    optionsController = controller;
    void loadFilterPanelOptions(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          options = result;
        }
      })
      .catch(() => {
        // An aborted load is the expected outcome when the dialog closes.
      });
  });

  $effect(() => {
    // Recomputed whenever the structured filter changes; the typed text is not part of the
    // statistics DTO, so it deliberately does not retrigger a count.
    const snapshot = { ...query, text: '', mode: 'text' as const };
    countController?.abort();
    const controller = new AbortController();
    countController = controller;
    matching = null;
    void loadMatchingCount(snapshot, controller.signal)
      .then((total) => {
        if (!controller.signal.aborted) {
          matching = total;
        }
      })
      .catch(() => {
        // Superseded by a newer request.
      });
  });

  let handedOff = false;
  $effect(() => {
    // Hand the text to the palette once per ">" prefix, the way the prototype does; without the
    // latch the effect would reopen the palette on every keystroke that keeps the prefix.
    if (commandQuery && onOpenPalette && !handedOff) {
      handedOff = true;
      onOpenPalette(text);
    } else if (!commandQuery) {
      handedOff = false;
    }
  });

  onDestroy(() => {
    optionsController?.abort();
    countController?.abort();
  });

  const rememberSearch = (term: string) => {
    const trimmed = term.trim();
    if (!trimmed) {
      return;
    }
    searchStore.savedSearchTerms = [
      trimmed,
      ...searchStore.savedSearchTerms.filter((item) => item.toLowerCase() !== trimmed.toLowerCase()),
    ].slice(0, 5);
  };

  const apply = () => {
    if (commandQuery) {
      onOpenPalette?.(text);
      return;
    }
    rememberSearch(text);
    const dto = toSearchDto(pending, modeEntry.field);
    if (onSubmit) {
      onSubmit(pending, dto);
    } else {
      handlePromiseError(goto(Route.search(dto)));
    }
    onClose();
  };

  const matchingLabel = $derived(
    matching === null
      ? $t('frameleaf_search_counting')
      : $t('frameleaf_search_matching_filters', { values: { count: matching } }),
  );
</script>

<dialog
  bind:this={dialog}
  class="search-dialog frameleaf"
  data-theme={appTheme}
  aria-labelledby={titleId}
  oncancel={(event) => {
    event.preventDefault();
    onClose();
  }}
>
  <form
    onsubmit={(event) => {
      event.preventDefault();
      apply();
    }}
  >
    <header>
      <h2 id={titleId}>{$t('frameleaf_search_title')}</h2>
      <Button variant="quiet" label={$t('close')} onclick={onClose}>
        <Icon icon={mdiClose} size="1.125em" aria-hidden={true} />
      </Button>
    </header>

    <div class="input-row">
      <Icon icon={mdiMagnify} size="1.375em" aria-hidden={true} />
      <!-- svelte-ignore a11y_autofocus -->
      <input
        autofocus
        type="text"
        aria-label={$t('frameleaf_search_query')}
        placeholder={$t(modeEntry.placeholderKey)}
        bind:value={text}
      />
      {#if text}
        <Button variant="quiet" label={$t('clear')} onclick={() => (text = '')}>
          <Icon icon={mdiClose} size="1em" aria-hidden={true} />
        </Button>
      {/if}
    </div>

    <SegmentedControl
      label={$t('frameleaf_search_mode')}
      value={mode}
      options={SEARCH_MODES.map((entry) => ({ value: entry.type, label: $t(entry.labelKey) }))}
      onChange={(value) => (mode = value as QueryType)}
    />

    {#if commandQuery}
      <p class="palette-hint" role="status">
        <Icon icon={mdiChevronRight} size="1.125em" aria-hidden={true} />
        {$t('frameleaf_search_command_hint')}
      </p>
    {/if}

    {#if scopeLabel}
      <p class="muted">{$t('frameleaf_search_scope', { values: { scope: scopeLabel } })}</p>
    {/if}

    {#if chips.length > 0}
      <section aria-label={$t('frameleaf_search_active_filters')}>
        <div class="section-heading">
          <h3>{$t('frameleaf_search_active_filters')}</h3>
          <Button variant="quiet" onclick={() => (query = withoutDiscoveryFilters(query))}>
            {$t('clear_all')}
          </Button>
        </div>
        <div class="chips">
          {#each chips as chip (chip.field)}
            <Chip
              label={chip.label}
              removeLabel={$t('frameleaf_search_remove_filter', { values: { filter: chip.label } })}
              onRemove={() => (query = withoutDiscoveryFilter(query, chip.field))}
            >
              {#snippet leading()}
                {#each chip.personIds.slice(0, 3) as id (id)}
                  <PersonAvatar person={options.people.find((person) => person.id === id)} size={22} />
                {/each}
              {/snippet}
            </Chip>
          {/each}
        </div>
      </section>
    {/if}

    {#if goTo.length > 0}
      <section aria-label={$t('frameleaf_search_go_to')}>
        <h3>{$t('frameleaf_search_go_to')}</h3>
        <div class="go-to">
          {#each goTo as command (command.id)}
            <button
              type="button"
              onclick={() => {
                onCommand?.(command);
                onClose();
              }}
            >
              {#if command.icon}<Icon icon={command.icon} size="1.125em" aria-hidden={true} />{/if}
              <span>
                {command.title}
                {#if command.subtitle}<small>{command.subtitle}</small>{/if}
              </span>
              <Icon icon={mdiChevronRight} size="1em" aria-hidden={true} />
            </button>
          {/each}
        </div>
      </section>
    {/if}

    {#if recentSearches.length > 0}
      <section aria-label={$t('recent_searches')}>
        <h3>{$t('recent_searches')}</h3>
        <div class="quick">
          {#each recentSearches as term (term)}
            <Button onclick={() => (text = term)}>{term}</Button>
          {/each}
        </div>
      </section>
    {/if}

    <section aria-label={$t('image_enrichment')}>
      <h3>{$t('image_enrichment')}</h3>
      <div class="quick">
        {#each ENRICHMENT_QUICK_FILTERS as item (item.value)}
          <Button
            pressed={query.imageEnrichment === item.value}
            onclick={() =>
              (query = withDiscoveryEnrichment(query, query.imageEnrichment === item.value ? undefined : item.value))}
          >
            {$t(item.labelKey)}
          </Button>
        {/each}
      </div>
    </section>

    {#if options.people.length > 0}
      <section aria-label={$t('people')}>
        <h3>{$t('people')}</h3>
        <div class="people">
          {#each options.people.slice(0, 12) as person (person.id)}
            <button type="button" onclick={() => (query = withDiscoveryFacet(query, 'personIds', person.id))}>
              <PersonAvatar {person} size={30} />
              <span>{person.name || $t('no_name')}</span>
            </button>
          {/each}
        </div>
      </section>
    {/if}

    {#if options.pets.length > 0}
      <!-- FL-58: the account's own pets, narrowing by their confirmed photos -->
      <section aria-label={$t('frameleaf_pets_title')}>
        <h3>{$t('frameleaf_pets_title')}</h3>
        <div class="people">
          {#each options.pets.slice(0, 12) as pet (pet.id)}
            <button type="button" onclick={() => (query = withDiscoveryFacet(query, 'petIds', pet.id))}>
              <PetThumbnail assetId={pet.featuredAssetId} cacheKey={pet.updatedAt} size={30} />
              <span>{pet.name || $t('frameleaf_pets_unnamed')}</span>
            </button>
          {/each}
        </div>
      </section>
    {/if}

    {#if options.cities.length > 0}
      <section aria-label={$t('places')}>
        <h3>{$t('places')}</h3>
        <div class="quick">
          {#each options.cities.slice(0, 6) as city (city)}
            <Button onclick={() => (query = withDiscoveryFacet(query, 'city', city))}>
              <Icon icon={mdiMapMarker} size="1em" aria-hidden={true} />
              {city}
            </Button>
          {/each}
        </div>
      </section>
    {/if}

    <section aria-label={$t('frameleaf_search_filters')}>
      <div class="section-heading">
        <h3>{$t('frameleaf_search_filters')}</h3>
        <Button pressed={showFilters} onclick={() => (showFilters = !showFilters)}>
          <Icon icon={mdiTune} size="1em" aria-hidden={true} />
          {showFilters ? $t('frameleaf_search_hide_filters') : $t('frameleaf_search_show_filters')}
        </Button>
      </div>
      {#if showFilters}
        <FilterPanel
          query={pending}
          {options}
          {section}
          {matchingLabel}
          {scopeLabel}
          onChange={(next) => {
            query = next;
            text = next.text;
          }}
        />
      {/if}
    </section>

    <footer>
      <span aria-live="polite">{matchingLabel}</span>
      <Button onclick={onClose}>{$t('cancel')}</Button>
      <Button variant="primary" type="submit">
        <Icon icon={mdiMagnify} size="1em" aria-hidden={true} />
        {$t('frameleaf_search_show_results')}
      </Button>
    </footer>
  </form>
</dialog>

<style>
  .search-dialog {
    width: min(56rem, calc(100vw - 2rem));
    max-height: calc(100dvh - 3rem);
    padding: 0;
    color: var(--fl-text);
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-dialog);
    box-shadow: var(--fl-shadow-2);
  }
  .search-dialog::backdrop {
    background: rgb(0 0 0 / 60%);
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
    max-height: calc(100dvh - 3rem);
    overflow-y: auto;
    padding: 1.125rem;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }
  h2 {
    font-size: 1.125rem;
    font-weight: 600;
  }
  h3 {
    font-size: 0.875rem;
    font-weight: 600;
  }
  .input-row {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.5rem 0.75rem;
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .input-row input {
    flex: 1;
    min-width: 0;
    min-height: 32px;
    font-size: 0.875rem;
    color: var(--fl-text);
    background: transparent;
    border: 0;
    outline: none;
  }
  .muted,
  .palette-hint {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  section {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .section-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }
  .chips,
  .quick {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .go-to {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }
  .go-to button {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    min-height: 44px;
    padding: 0.375rem 0.5rem;
    text-align: start;
    color: var(--fl-text);
    background: transparent;
    border: 0;
    border-radius: var(--fl-radius);
  }
  .go-to button:hover {
    background: var(--fl-raised);
  }
  .go-to span {
    display: flex;
    min-width: 0;
    flex-direction: column;
  }
  .go-to small,
  .people span {
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .people {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .people button {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    min-height: 44px;
    padding: 0.25rem 0.625rem 0.25rem 0.25rem;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-pill);
  }
  footer {
    position: sticky;
    bottom: 0;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.75rem;
    padding-top: 0.75rem;
    background: var(--fl-panel);
    border-top: 1px solid var(--fl-border);
  }
  footer span {
    margin-inline-end: auto;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
</style>
