<script lang="ts">
  import { goto } from '$app/navigation';
  import { page as appPage } from '$app/state';
  import { scrollMemory } from '$lib/actions/scroll-memory';
  import FrameleafButton from '$lib/components/frameleaf/Button.svelte';
  import BirthdayDialog from '$lib/components/frameleaf/people/BirthdayDialog.svelte';
  import MergePeopleDialog from '$lib/components/frameleaf/people/MergePeopleDialog.svelte';
  import MergeSuggestionBanner from '$lib/components/frameleaf/people/MergeSuggestionBanner.svelte';
  import PersonCard from '$lib/components/frameleaf/people/PersonCard.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import { QueryParameter } from '$lib/constants';
  import { filterPeopleByName, isUnnamedPerson, sortPeopleForGrid, type PeopleGridSort } from '$lib/frameleaf/people';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { toastAction, toastUndo } from '$lib/frameleaf/toast';
  import { ICON_SIZE } from '$lib/frameleaf/tokens';
  import { Route } from '$lib/route';
  import { websocketEvents } from '$lib/stores/websocket';
  import { handlePromiseError } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import { normalizeSearchString } from '$lib/utils/string-utils';
  import {
    AssetVisibility,
    deleteMergeVerdict,
    getAllPeople,
    getAssetStatistics,
    getMergeSuggestions,
    PersonMergeVerdict,
    searchPerson,
    setMergeVerdict,
    updatePerson,
    type PeopleListItemDto,
    type PersonMergeSuggestionDto,
    type PersonResponseDto,
  } from '@frameleaf/sdk';
  import { Icon, toastManager } from '@frameleaf/ui';
  import { mdiEyeOffOutline, mdiEyeOutline, mdiTuneVariant } from '@mdi/js';
  import { onDestroy, onMount, untrack } from 'svelte';
  import { t } from 'svelte-i18n';
  import PeopleInfiniteScroll from './PeopleInfiniteScroll.svelte';
  import { PEOPLE_CAP, PEOPLE_PAGE_SIZE } from './people-page';
  import type { PageData } from './$types';

  /**
   * The Frameleaf People library (FL-37), ported from `PeopleLibrary` in
   * design/frameleaf/template/src/People.jsx:651-979: summary line, "Find a person", the
   * Name / Photo count / Recently seen sort, a Hidden (N) switch, "Choose who appears", per-card
   * counts, the merge-suggestion banner (FL-57), inline rename, and the Frameleaf merge and
   * date-of-birth dialogs. Sorting and searching run over the whole list, so every page of
   * people is read up front rather than on scroll.
   */

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  let people: PeopleListItemDto[] = $state(untrack(() => data.people.people));
  let nextPage: number | null = $state(untrack(() => (data.people.hasNextPage ? 2 : null)));
  let search = $state(untrack(() => appPage.url.searchParams.get(QueryParameter.SEARCHED_PEOPLE) ?? ''));
  let sort: PeopleGridSort = $state('name');
  let showHidden = $state(false);
  let editingId: string | undefined = $state();
  let librarySize: number | undefined = $state();
  let dialog: { type: 'merge' | 'birthday'; person: PeopleListItemDto } | undefined = $state();
  let dialogOpen = $state(false);

  const nameOf = (person: { name: string }) => (isUnnamedPerson(person) ? $t('unnamed_person') : person.name);

  /**
   * What an action did: said in a toast at the foot of the page, where the person is looking. The
   * toast is a live region, so screen readers hear it once. `undo` puts the change back.
   */
  const announce = (message: string, undo?: () => unknown) => {
    if (undo) {
      toastUndo(message, undo);
    } else {
      toastManager.primary(message);
    }
  };

  const hiddenCount = $derived(people.filter((person) => person.isHidden).length);
  // The switch is only offered while somebody is hidden, so it cannot stay on with nothing to show.
  const showingHidden = $derived(showHidden && hiddenCount > 0);
  const visible = $derived(people.filter((person) => showingHidden || !person.isHidden));
  const cards = $derived(sortPeopleForGrid(filterPeopleByName(visible, search), sort));
  const summary = $derived(
    [
      $t('frameleaf_people_count', { values: { count: visible.length } }),
      librarySize === undefined ? '' : $t('frameleaf_people_library_size', { values: { count: librarySize } }),
      hiddenCount > 0 && !showingHidden ? $t('frameleaf_people_hidden_count', { values: { count: hiddenCount } }) : '',
    ]
      .filter(Boolean)
      .join(' · '),
  );

  // Sorting and search run over the whole list, so every page is read up front, in the largest
  // pages the API allows, up to a cap that keeps a very large library responsive.
  let truncated = $state(false);
  let loadGeneration = 0;
  let loadRequest: AbortController | undefined;

  /**
   * Reads the remaining pages. Each run owns a generation: a reload or leaving the page aborts
   * the previous run, and a stale run never writes, so pages from two runs are never mixed.
   */
  const loadAllPages = async () => {
    loadRequest?.abort();
    const request = new AbortController();
    loadRequest = request;
    const generation = ++loadGeneration;
    const current = () => generation === loadGeneration && !request.signal.aborted;
    try {
      while (nextPage && current()) {
        if (people.length >= PEOPLE_CAP) {
          truncated = true;
          nextPage = null;
          break;
        }
        const pageNumber = nextPage;
        const result = await getAllPeople(
          { withHidden: true, page: pageNumber, size: PEOPLE_PAGE_SIZE },
          { signal: request.signal },
        );
        if (!current()) {
          return;
        }
        const known = new Set(people.map(({ id }) => id));
        const added = result.people.filter(({ id }) => !known.has(id));
        people = people.concat(added);
        // A page that adds nobody new means the list shifted under us; stop rather than loop.
        nextPage = result.hasNextPage && added.length > 0 ? pageNumber + 1 : null;
      }
    } catch (error) {
      if (current()) {
        nextPage = null;
        handleError(error, $t('errors.failed_to_load_people'));
      }
    }
  };

  const reloadPeople = async () => {
    loadRequest?.abort();
    const generation = ++loadGeneration;
    try {
      const result = await getAllPeople({ withHidden: true, size: PEOPLE_PAGE_SIZE });
      if (generation !== loadGeneration) {
        return;
      }
      people = result.people;
      truncated = false;
      nextPage = result.hasNextPage ? 2 : null;
      await loadAllPages();
    } catch (error) {
      if (generation === loadGeneration) {
        handleError(error, $t('errors.failed_to_load_people'));
      }
    }
  };

  onDestroy(() => {
    loadGeneration++;
    loadRequest?.abort();
  });

  const loadLibrarySize = async () => {
    try {
      const { images, videos } = await getAssetStatistics({ visibility: AssetVisibility.Timeline });
      librarySize = images + videos;
    } catch {
      // The summary reads fine without the library size.
    }
  };

  const allLoaded = loadAllPages();

  onMount(() => {
    handlePromiseError(loadMergeSuggestions());
    handlePromiseError(loadLibrarySize());

    return websocketEvents.on('on_person_thumbnail', (personId: string) => {
      for (const person of people) {
        if (person.id === personId) {
          person.updatedAt = new Date().toISOString();
        }
      }
    });
  });

  const replacePerson = (updated: PersonResponseDto) => {
    people = people.map((person) => (person.id === updated.id ? { ...person, ...updated } : person));
  };

  // FL-57: guided merge-suggestion verdicts. "No" and "Ask me later" are stored on the server
  // (`PUT /people/merge-suggestions/verdicts`: "different" never suggests the pair again,
  // "later" skips it for 30 days) and can be undone from the toast (`DELETE` of the verdict).
  let mergeSuggestions: PersonMergeSuggestionDto[] = $state([]);
  let mergeSuggestionBusy = $state(false);
  const suggestionKey = (suggestion: PersonMergeSuggestionDto) =>
    [suggestion.person.id, suggestion.suggestion.id].sort().join('|');

  const loadMergeSuggestions = async () => {
    try {
      const { suggestions } = await getMergeSuggestions();
      mergeSuggestions = suggestions;
    } catch (error) {
      // Non-critical: the People grid works fine without suggestions.
      handleError(error, $t('errors.failed_to_load_people'));
    }
  };

  /** A merge is kept in the survivor's correction history, which is where it can be taken back. */
  const announceMerge = (merged: { name: string }, survivor: { id: string; name: string }) => {
    const message = $t('frameleaf_people_merged_status', { values: { from: nameOf(merged), into: nameOf(survivor) } });
    toastAction(message, {
      label: $t('frameleaf_people_merged_open'),
      onAction: () => goto(Route.viewPerson(survivor, { previousRoute: Route.people() })),
    });
  };

  // FL-57: "Yes, merge" answers `same`: the server merges (the named person survives) and keeps
  // the merge in the survivor's correction history.
  const handleAcceptSuggestion = async (suggestion: PersonMergeSuggestionDto) => {
    mergeSuggestionBusy = true;
    try {
      const { personId: survivorId, suggestionId: mergedId } = await setMergeVerdict({
        personMergeVerdictCreateDto: {
          personId: suggestion.person.id,
          suggestionId: suggestion.suggestion.id,
          verdict: PersonMergeVerdict.Same,
        },
      });
      const [survivor, merged] =
        survivorId === suggestion.person.id
          ? [suggestion.person, suggestion.suggestion]
          : [suggestion.suggestion, suggestion.person];
      mergeSuggestions = mergeSuggestions.filter(
        (entry) => entry.person.id !== mergedId && entry.suggestion.id !== mergedId,
      );
      // as the merge dialog does: open viewers, search chips and person pages follow the merge
      eventManager.emit('PersonFacesChange', { personIds: [survivorId, mergedId], removedPersonIds: [mergedId] });
      announceMerge(merged, survivor);
      await reloadPeople();
    } catch (error) {
      handleError(error, $t('errors.unable_to_merge_people'));
    } finally {
      mergeSuggestionBusy = false;
    }
  };

  const recordVerdict = async (suggestion: PersonMergeSuggestionDto, verdict: PersonMergeVerdict) => {
    // "ignore" is about the reviewed person alone: the server keeps it as that person paired with itself
    const pair =
      verdict === PersonMergeVerdict.Ignore
        ? { personId: suggestion.person.id, suggestionId: suggestion.person.id }
        : { personId: suggestion.person.id, suggestionId: suggestion.suggestion.id };
    mergeSuggestionBusy = true;
    try {
      await setMergeVerdict({ personMergeVerdictCreateDto: { ...pair, verdict } });
    } catch (error) {
      handleError(error, $t('frameleaf_people_verdict_error'));
      return;
    } finally {
      mergeSuggestionBusy = false;
    }

    const key = suggestionKey(suggestion);
    const removed =
      verdict === PersonMergeVerdict.Ignore
        ? mergeSuggestions.filter(
            (entry) => entry.person.id === suggestion.person.id || entry.suggestion.id === suggestion.person.id,
          )
        : [suggestion];
    const removedKeys = new Set(removed.map((entry) => suggestionKey(entry)));
    mergeSuggestions = mergeSuggestions.filter((entry) => !removedKeys.has(suggestionKey(entry)));
    const message =
      verdict === PersonMergeVerdict.Different
        ? $t('frameleaf_people_merge_suggestion_rejected_toast')
        : verdict === PersonMergeVerdict.Ignore
          ? $t('frameleaf_people_merge_suggestion_ignored_toast', { values: { name: nameOf(suggestion.person) } })
          : $t('frameleaf_people_merge_suggestion_later_toast');

    const undo = async () => {
      try {
        await deleteMergeVerdict({ personMergeVerdictDeleteDto: pair });
        mergeSuggestions = [...removed, ...mergeSuggestions.filter((entry) => suggestionKey(entry) !== key)];
        toastManager.primary($t('frameleaf_people_verdict_undone'));
      } catch (error) {
        handleError(error, $t('frameleaf_people_verdict_error'));
      }
    };
    toastUndo(message, () => void undo());
  };

  /** Hide, show and favorite are one field each, so their toast can put the old value back. */
  const setHidden = async (person: PeopleListItemDto, isHidden: boolean, undoable = true) => {
    try {
      replacePerson(await updatePerson({ id: person.id, personUpdateDto: { isHidden } }));
      announce(
        isHidden
          ? $t('frameleaf_people_hidden_status', { values: { name: nameOf(person) } })
          : $t('frameleaf_people_shown_status', { values: { name: nameOf(person) } }),
        undoable ? () => void setHidden(person, !isHidden, false) : undefined,
      );
    } catch (error) {
      handleError(error, $t('errors.unable_to_hide_person'));
    }
  };
  const handleToggleHidden = (person: PeopleListItemDto) => setHidden(person, !person.isHidden);

  const setFavorite = async (person: PeopleListItemDto, isFavorite: boolean, undoable = true) => {
    try {
      replacePerson(await updatePerson({ id: person.id, personUpdateDto: { isFavorite } }));
      announce(
        isFavorite
          ? $t('frameleaf_people_favorited_status', { values: { name: nameOf(person) } })
          : $t('frameleaf_people_unfavorited_status', { values: { name: nameOf(person) } }),
        undoable ? () => void setFavorite(person, !isFavorite, false) : undefined,
      );
    } catch (error) {
      handleError(error, $t('errors.unable_to_add_remove_favorites', { values: { favorite: !isFavorite } }));
    }
  };
  const handleToggleFavorite = (person: PeopleListItemDto) => setFavorite(person, !person.isFavorite);

  const openDialog = (type: 'merge' | 'birthday', person: PeopleListItemDto) => {
    dialog = { type, person };
    dialogOpen = true;
  };

  const findPeopleWithSameName = async (name: string, personId: string) => {
    const searchResult = await searchPerson({ name, withHidden: true });
    const normalizedName = normalizeSearchString(name);
    return searchResult.find(
      (person) => normalizeSearchString(person.name) === normalizedName && person.id !== personId && person.name,
    );
  };

  // FL-57: a rename commits immediately. If the new name matches another person, that pair
  // goes to the front of the merge-suggestion banner instead of a separate merge prompt.
  const onNameChangeSubmit = async (name: string, person: PeopleListItemDto, undoable = true) => {
    if (name === person.name) {
      return;
    }
    try {
      replacePerson(await updatePerson({ id: person.id, personUpdateDto: { name } }));
      announce(
        name
          ? isUnnamedPerson(person)
            ? $t('frameleaf_people_named_status', { values: { name } })
            : $t('frameleaf_people_renamed_status', { values: { from: person.name, to: name } })
          : $t('frameleaf_people_name_removed_status'),
        undoable ? () => void onNameChangeSubmit(person.name, { ...person, name }, false) : undefined,
      );
      if (!name) {
        return;
      }
      const sameName = await findPeopleWithSameName(name, person.id);
      if (sameName) {
        const renamed = { ...person, name };
        // a name match, not a face match: there is no reference face to show
        const entry = {
          person: renamed,
          suggestion: sameName,
          distance: 0,
          personEvidence: null,
          suggestionEvidence: null,
        };
        const key = suggestionKey(entry);
        mergeSuggestions = [entry, ...mergeSuggestions.filter((other) => suggestionKey(other) !== key)];
      }
    } catch (error) {
      handleError(error, $t('errors.unable_to_save_name'));
    }
  };

  const onPersonUpdate = (response: PersonResponseDto) => replacePerson(response);
</script>

<OnEvents {onPersonUpdate} />

<UserPageLayout
  title={$t('people')}
  description={summary}
  use={[[scrollMemory, { routeStartsWith: Route.people(), beforeScroll: () => allLoaded }]]}
>
  <section class="pl-page" aria-label={$t('frameleaf_people_library_label')}>
    <!-- In the page, as on Pets: the layout's title bar is one fixed row and cannot hold four controls on a phone. -->
    <div class="pl-toolbar">
      <input
        type="search"
        aria-label={$t('frameleaf_people_find_a_person')}
        placeholder={$t('frameleaf_people_find_a_person')}
        bind:value={search}
      />
      <select aria-label={$t('frameleaf_people_sort')} bind:value={sort}>
        <option value="name">{$t('name')}</option>
        <option value="count">{$t('frameleaf_people_sort_count')}</option>
        <option value="recent">{$t('frameleaf_people_sort_recent')}</option>
      </select>
      {#if hiddenCount > 0}
        <!-- A view switch, named for what it reveals; it is not offered when nobody is hidden. -->
        <FrameleafButton pressed={showingHidden} onclick={() => (showHidden = !showingHidden)}>
          <Icon icon={showingHidden ? mdiEyeOutline : mdiEyeOffOutline} size={ICON_SIZE.lg} aria-hidden="true" />
          {$t('frameleaf_people_hidden_toggle', { values: { count: hiddenCount } })}
        </FrameleafButton>
      {/if}
      <FrameleafButton onclick={() => goto('/people/manage')}>
        <Icon icon={mdiTuneVariant} size={ICON_SIZE.lg} aria-hidden="true" />
        {$t('frameleaf_people_choose_who_appears')}
      </FrameleafButton>
    </div>
    {#if mergeSuggestions.length > 0}
      <MergeSuggestionBanner
        suggestion={mergeSuggestions[0]}
        remaining={mergeSuggestions.length - 1}
        busy={mergeSuggestionBusy}
        onAccept={() => handleAcceptSuggestion(mergeSuggestions[0])}
        onReject={() => recordVerdict(mergeSuggestions[0], PersonMergeVerdict.Different)}
        onSkip={() => recordVerdict(mergeSuggestions[0], PersonMergeVerdict.Later)}
        onIgnore={() => recordVerdict(mergeSuggestions[0], PersonMergeVerdict.Ignore)}
      />
    {/if}
    {#if truncated}
      <p class="pl-status" role="status">{$t('frameleaf_people_truncated', { values: { count: people.length } })}</p>
    {/if}
    {#if cards.length > 0}
      <PeopleInfiniteScroll people={cards} hasNextPage={false} loadNextPage={() => {}}>
        {#snippet children({ person })}
          <PersonCard
            {person}
            editing={editingId === person.id}
            onOpen={() => goto(Route.viewPerson(person, { previousRoute: Route.people() }))}
            onStartRename={() => (editingId = person.id)}
            onCommitRename={async (name) => {
              editingId = undefined;
              await onNameChangeSubmit(name, person);
            }}
            onCancelRename={() => (editingId = undefined)}
            onToggleFavorite={() => handleToggleFavorite(person)}
            onToggleHide={() => handleToggleHidden(person)}
            onMerge={() => openDialog('merge', person)}
            onSetBirthday={() => openDialog('birthday', person)}
          />
        {/snippet}
      </PeopleInfiniteScroll>
    {:else if !nextPage}
      <p class="people-empty" role="status">
        {#if search.trim()}
          {$t('frameleaf_people_no_match')}
        {:else if hiddenCount > 0}
          {$t('frameleaf_people_everyone_hidden')}
        {:else}
          {$t('frameleaf_people_none_assigned')}
        {/if}
      </p>
    {/if}
  </section>
</UserPageLayout>

{#if dialog?.type === 'merge'}
  <MergePeopleDialog
    person={dialog.person}
    candidates={people}
    bind:open={dialogOpen}
    onMerged={async (target) => {
      announceMerge(dialog!.person, target);
      await reloadPeople();
    }}
  />
{:else if dialog?.type === 'birthday'}
  <BirthdayDialog
    person={dialog.person}
    bind:open={dialogOpen}
    onSaved={(updated, birthDate) => {
      replacePerson(updated);
      announce(
        birthDate
          ? $t('frameleaf_people_birthday_saved_for', { values: { name: nameOf(updated) } })
          : $t('frameleaf_people_birthday_removed_for', { values: { name: nameOf(updated) } }),
      );
    }}
  />
{/if}

<style>
  /* template/src/people.css `.pl-page`, `.pl-toolbar`, `.pl-status`. */
  .pl-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fl-space-3) var(--fl-space-2);
    padding-top: var(--fl-space-2);
  }
  .pl-toolbar input,
  .pl-toolbar select {
    min-height: var(--fl-control-height);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    background: var(--fl-raised);
    color: var(--fl-text);
    font: var(--fl-type-body);
  }
  .pl-toolbar input {
    flex: 1;
    min-width: 12rem;
    max-width: 24rem;
    padding: var(--fl-space-2) var(--fl-space-3);
  }
  .pl-toolbar input::placeholder {
    color: var(--fl-muted);
  }
  .pl-toolbar select {
    padding: 0 var(--fl-space-3);
    /* Pushes the buttons to the far side on a wide page. */
    margin-inline-end: auto;
  }
  .pl-toolbar input:focus-visible,
  .pl-toolbar select:focus-visible {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }
  .pl-page {
    display: flex;
    flex-direction: column;
    gap: var(--fl-space-3);
    /* With the layout's own 8px, the page's gutter: the toolbar and faces start under the title. */
    padding: 0 var(--fl-space-4) 2.5rem;
  }
  .pl-status {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .people-empty {
    padding: 3rem 1rem;
    color: var(--fl-muted);
    text-align: center;
  }
  @media (max-width: 767px) {
    .pl-page {
      padding-inline: var(--fl-space-2);
    }
  }
  @media (max-width: 700px) {
    .pl-toolbar input {
      flex: 1 1 100%;
      max-width: none;
    }
  }
</style>
