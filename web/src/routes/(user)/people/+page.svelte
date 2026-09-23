<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { scrollMemory } from '$lib/actions/scroll-memory';
  import PeopleInfiniteScroll from './PeopleInfiniteScroll.svelte';
  import SearchPeople from '$lib/components/faces-page/PeopleSearch.svelte';
  import FrameleafButton from '$lib/components/frameleaf/Button.svelte';
  import MergeSuggestionBanner from '$lib/components/frameleaf/people/MergeSuggestionBanner.svelte';
  import PersonCard from '$lib/components/frameleaf/people/PersonCard.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import { QueryParameter, SessionStorageKey } from '$lib/constants';
  import { Route } from '$lib/route';
  import { getPersonActions } from '$lib/services/person.service';
  import { locale } from '$lib/stores/preferences.store';
  import { websocketEvents } from '$lib/stores/websocket';
  import { normalizeSearchString } from '$lib/utils/string-utils';
  import { handlePromiseError } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import { clearQueryParam } from '$lib/utils/navigation';
  import {
    getAllPeople,
    getMergeSuggestions,
    getPerson,
    mergePeople,
    searchPerson,
    updatePerson,
    type PersonMergeSuggestionDto,
    type PersonResponseDto,
  } from '@immich/sdk';
  import { Button, Icon, toastManager } from '@immich/ui';
  import { mdiAccountOff, mdiEyeOutline } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  let searchName = $state('');
  let currentPage = $state(1);
  let nextPage = $state(data.people.hasNextPage ? 2 : null);
  let searchedPeopleLocal: PersonResponseDto[] = $state([]);
  let innerHeight = $state(0);
  let searchPeopleElement = $state<ReturnType<typeof SearchPeople>>();

  onMount(() => {
    const getSearchedPeople = $page.url.searchParams.get(QueryParameter.SEARCHED_PEOPLE);
    if (getSearchedPeople) {
      searchName = getSearchedPeople;
      if (searchPeopleElement) {
        handlePromiseError(searchPeopleElement.searchPeople(true, searchName));
      }
    }

    // FL-57: guided merge-suggestion verdict flow.
    handlePromiseError(loadMergeSuggestions());

    return websocketEvents.on('on_person_thumbnail', (personId: string) => {
      for (const person of people) {
        if (person.id === personId) {
          person.updatedAt = new Date().toISOString();
        }
      }
    });
  });

  // FL-57: guided merge-suggestion verdicts (accept/reject/skip). The endpoint recomputes
  // suggestions from face-embedding similarity on every call — there is no persisted
  // "reject" or "skip" state on the server (see the FL-57 handoff report), so both verdicts
  // only affect what this session shows next: reject drops the pair, skip moves it behind
  // the others so it can resurface later in the same session.
  let mergeSuggestions: PersonMergeSuggestionDto[] = $state([]);
  let mergeSuggestionBusy = $state(false);
  const suggestionKey = (suggestion: PersonMergeSuggestionDto) => [suggestion.person.id, suggestion.suggestion.id].sort().join('|');

  const loadMergeSuggestions = async () => {
    try {
      const { suggestions } = await getMergeSuggestions();
      mergeSuggestions = suggestions;
    } catch (error) {
      // Non-critical: the People grid works fine without suggestions.
      handleError(error, $t('errors.failed_to_load_people'));
    }
  };

  const handleAcceptSuggestion = async (suggestion: PersonMergeSuggestionDto) => {
    mergeSuggestionBusy = true;
    try {
      // The named person's identity survives; between two named/two unnamed people the
      // order is otherwise arbitrary, matching `POST /people/merge`'s own "first defined
      // value wins" rule.
      const [survivorId, mergedId] = suggestion.person.name
        ? [suggestion.person.id, suggestion.suggestion.id]
        : [suggestion.suggestion.id, suggestion.person.id];
      await mergePeople({ mergePersonDto: { ids: [survivorId, mergedId] } });
      mergeSuggestions = mergeSuggestions.filter(
        (entry) => entry.person.id !== mergedId && entry.suggestion.id !== mergedId,
      );
      const survivor = await getPerson({ id: survivorId });
      people = people.filter((person) => person.id !== mergedId).map((person) => (person.id === survivorId ? survivor : person));
      toastManager.primary($t('frameleaf_people_merge_suggestion_merged_toast', { values: { name: survivor.name } }));
    } catch (error) {
      handleError(error, $t('errors.unable_to_save_name'));
    } finally {
      mergeSuggestionBusy = false;
    }
  };

  const handleRejectSuggestion = (suggestion: PersonMergeSuggestionDto) => {
    mergeSuggestions = mergeSuggestions.filter((entry) => suggestionKey(entry) !== suggestionKey(suggestion));
    toastManager.primary($t('frameleaf_people_merge_suggestion_rejected_toast'));
  };

  const handleSkipSuggestion = (suggestion: PersonMergeSuggestionDto) => {
    const key = suggestionKey(suggestion);
    const rest = mergeSuggestions.filter((entry) => suggestionKey(entry) !== key);
    mergeSuggestions = [...rest, suggestion];
  };

  const loadInitialScroll = () =>
    new Promise<void>((resolve) => {
      // Load up to previously loaded page when returning.
      let newNextPage = sessionStorage.getItem(SessionStorageKey.INFINITE_SCROLL_PAGE);
      if (newNextPage && nextPage) {
        let startingPage = nextPage,
          pagesToLoad = Number.parseInt(newNextPage) - nextPage;

        if (pagesToLoad) {
          handlePromiseError(
            Promise.all(
              Array.from({ length: pagesToLoad }, (_, i) => {
                return getAllPeople({ withHidden: true, page: startingPage + i });
              }),
            ).then((pages) => {
              for (const page of pages) {
                people = people.concat(page.people);
              }
              currentPage = startingPage + pagesToLoad - 1;
              nextPage = pages.at(-1)?.hasNextPage ? startingPage + pagesToLoad : null;
              resolve(); // wait until extra pages are loaded
            }),
          );
        } else {
          resolve();
        }
        sessionStorage.removeItem(SessionStorageKey.INFINITE_SCROLL_PAGE);
      }
    });

  const loadNextPage = async () => {
    if (!nextPage) {
      return;
    }

    try {
      const { people: newPeople, hasNextPage } = await getAllPeople({ withHidden: true, page: nextPage });
      people = people.concat(newPeople);
      if (nextPage !== null) {
        currentPage = nextPage;
      }
      nextPage = hasNextPage ? nextPage + 1 : null;
    } catch (error) {
      handleError(error, $t('errors.failed_to_load_people'));
    }
  };

  const handleSearch = async () => {
    const getSearchedPeople = $page.url.searchParams.get(QueryParameter.SEARCHED_PEOPLE);
    if (getSearchedPeople !== searchName) {
      $page.url.searchParams.set(QueryParameter.SEARCHED_PEOPLE, searchName);
      await goto($page.url, { keepFocus: true });
    }
  };

  const handleToggleHidden = async (detail: PersonResponseDto) => {
    try {
      const updatedPerson = await updatePerson({
        id: detail.id,
        personUpdateDto: { isHidden: !detail.isHidden },
      });

      people = people.map((person: PersonResponseDto) => (person.id === updatedPerson.id ? updatedPerson : person));

      toastManager.primary($t('changed_visibility_successfully'));
    } catch (error) {
      handleError(error, $t('errors.unable_to_hide_person'));
    }
  };

  const handleToggleFavorite = async (detail: PersonResponseDto) => {
    try {
      const updatedPerson = await updatePerson({
        id: detail.id,
        personUpdateDto: { isFavorite: !detail.isFavorite },
      });

      people = people.map((person: PersonResponseDto) => {
        if (person.id === updatedPerson.id) {
          return updatedPerson;
        }
        return person;
      });

      toastManager.primary(updatedPerson.isFavorite ? $t('added_to_favorites') : $t('removed_from_favorites'));
    } catch (error) {
      handleError(error, $t('errors.unable_to_add_remove_favorites', { values: { favorite: detail.isFavorite } }));
    }
  };

  const handleMergePeople = async (detail: PersonResponseDto) => {
    await goto(Route.viewPerson(detail, { previousRoute: Route.people(), action: 'merge' }));
  };

  const onResetSearchBar = async () => {
    await clearQueryParam(QueryParameter.SEARCHED_PEOPLE, $page.url);
  };

  let people = $derived(data.people.people);

  let countVisiblePeople = $derived(searchName ? searchedPeopleLocal.length : data.people.total - data.people.hidden);

  // People grid (FL-37): a "show hidden" toggle over the `people` list. The search endpoint
  // never returns hidden people (production does not pass `withHidden` to it), so a hidden
  // person stays out of the grid while a search is active.
  let showHiddenFrameleaf = $state(false);
  let editingIdFrameleaf: string | undefined = $state();
  let frameleafBase = $derived(searchName ? searchedPeopleLocal : people);
  let frameleafCards = $derived(
    frameleafBase.filter((person) => showHiddenFrameleaf || !person.isHidden),
  );
  let frameleafHiddenCount = $derived(people.filter((person) => person.isHidden).length);

  // FL-57: a Frameleaf rename commits immediately (inline editing has no separate
  // confirm step to gate on) rather than blocking on a legacy modal. If the new name
  // collides with an existing person, surface it through the same guided
  // accept/reject/skip verdict flow the merge-suggestion banner already offers, instead
  // of a second, disconnected "did you mean to merge" dialog. This replaces the old
  // `editingPerson`-gated `handleMerge` path, which only the deleted legacy name input
  // ever satisfied and so silently dropped every Frameleaf rename collision.
  const onNameChangeSubmit = async (name: string, targetPerson: PersonResponseDto) => {
    try {
      if (name === targetPerson.name) {
        return;
      }

      if (name === '') {
        await updateName(targetPerson.id, '');
        return;
      }

      await updateName(targetPerson.id, name);

      const personWithSimilarName = await findPeopleWithSimilarName(name, targetPerson.id);
      if (personWithSimilarName) {
        const renamed = { ...targetPerson, name };
        const key = suggestionKey({ person: renamed, suggestion: personWithSimilarName, distance: 0 });
        mergeSuggestions = [
          { person: renamed, suggestion: personWithSimilarName, distance: 0 },
          ...mergeSuggestions.filter((entry) => suggestionKey(entry) !== key),
        ];
      }
    } catch (error) {
      handleError(error, $t('errors.unable_to_save_name'));
    }
  };

  const updateName = async (id: string, name: string) => {
    await updatePerson({
      id,
      personUpdateDto: { name },
    });
  };

  const findPeopleWithSimilarName = async (name: string, personId: string) => {
    const searchResult = await searchPerson({ name, withHidden: true });
    const normalizedName = normalizeSearchString(name);
    return searchResult.find(
      (person) => normalizeSearchString(person.name) === normalizedName && person.id !== personId && person.name,
    );
  };

  const onPersonUpdate = (response: PersonResponseDto) => {
    people = people.map((person: PersonResponseDto) => {
      if (person.id === response.id) {
        return response;
      }
      return person;
    });
  };
</script>

<svelte:window bind:innerHeight />

<OnEvents {onPersonUpdate} />

<UserPageLayout
  title={$t('people')}
  description={countVisiblePeople === 0 && !searchName ? undefined : `(${countVisiblePeople.toLocaleString($locale)})`}
  use={[
    [
      scrollMemory,
      {
        routeStartsWith: Route.people(),
        beforeSave: () => {
          if (currentPage) {
            sessionStorage.setItem(SessionStorageKey.INFINITE_SCROLL_PAGE, currentPage.toString());
          }
        },
        beforeClear: () => {
          sessionStorage.removeItem(SessionStorageKey.INFINITE_SCROLL_PAGE);
        },
        beforeLoad: loadInitialScroll,
      },
    ],
  ]}
>
  {#snippet buttons()}
    {#if people.length > 0}
      <div class="flex items-center justify-center gap-2">
        <div class="hidden sm:block">
          <div class="h-10 w-40 lg:w-80">
            <SearchPeople
              bind:this={searchPeopleElement}
              type="searchBar"
              placeholder={$t('search_people')}
              onReset={onResetSearchBar}
              onSearch={handleSearch}
              bind:searchName
              bind:searchedPeopleLocal
            />
          </div>
        </div>
        <FrameleafButton
          variant={showHiddenFrameleaf ? 'primary' : 'default'}
          pressed={showHiddenFrameleaf}
          onclick={() => (showHiddenFrameleaf = !showHiddenFrameleaf)}
        >
          {showHiddenFrameleaf ? $t('frameleaf_people_hide_hidden') : $t('frameleaf_people_show_hidden')}
        </FrameleafButton>
        <Button
          leadingIcon={mdiEyeOutline}
          onclick={() => goto('/people/manage')}
          size="small"
          variant="ghost"
          color="secondary">{$t('show_and_hide_people')}</Button
        >
      </div>
    {/if}
  {/snippet}

  {#if mergeSuggestions.length > 0}
    <MergeSuggestionBanner
      suggestion={mergeSuggestions[0]}
      remaining={mergeSuggestions.length - 1}
      busy={mergeSuggestionBusy}
      onAccept={() => handleAcceptSuggestion(mergeSuggestions[0])}
      onReject={() => handleRejectSuggestion(mergeSuggestions[0])}
      onSkip={() => handleSkipSuggestion(mergeSuggestions[0])}
    />
  {/if}
  {#if frameleafCards.length > 0}
    <p class="frameleaf-people-summary">
      {$t('frameleaf_people_summary', {
        values: { count: frameleafCards.length, hidden: frameleafHiddenCount },
      })}
    </p>
    <div class="frameleaf-people-grid">
      <PeopleInfiniteScroll people={frameleafCards} hasNextPage={!!nextPage && !searchName} {loadNextPage}>
        {#snippet children({ person })}
          <PersonCard
            {person}
            editing={editingIdFrameleaf === person.id}
            onOpen={() => goto(Route.viewPerson(person, { previousRoute: Route.people() }))}
            onStartRename={() => (editingIdFrameleaf = person.id)}
            onCommitRename={async (name) => {
              editingIdFrameleaf = undefined;
              await onNameChangeSubmit(name, person);
            }}
            onCancelRename={() => (editingIdFrameleaf = undefined)}
            onToggleFavorite={() => handleToggleFavorite(person)}
            onToggleHide={() => handleToggleHidden(person)}
            onMerge={() => handleMergePeople(person)}
            onSetBirthday={() => getPersonActions($t, person).SetDateOfBirth.onAction()}
          />
        {/snippet}
      </PeopleInfiniteScroll>
    </div>
  {:else}
    <div class="flex min-h-[calc(66vh-11rem)] w-full place-content-center items-center dark:text-white">
      <div class="flex flex-col content-center items-center text-center">
        <Icon icon={mdiAccountOff} size="3.5em" />
        <p class="mt-5 line-clamp-2 max-w-lg overflow-hidden text-3xl font-medium">
          {$t(searchName ? 'search_no_people_named' : 'search_no_people', { values: { name: searchName } })}
        </p>
      </div>
    </div>
  {/if}
</UserPageLayout>

<style>
  .frameleaf-people-summary {
    padding: 0 0.5rem 0.5rem;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .frameleaf-people-grid {
    padding: 0 0.5rem 2rem;
  }
</style>
