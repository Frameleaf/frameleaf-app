<script lang="ts">
  import SearchHistorySection from './SearchHistorySection.svelte';
  import { t } from 'svelte-i18n';
  import { fly } from 'svelte/transition';
  import { Button, Text, themeManager, Theme as AppTheme } from '@immich/ui';
  import Theme from '$lib/components/frameleaf/Theme.svelte';
  import FilterChip from '$lib/components/frameleaf/FilterChip.svelte';
  import { PeopleSearch } from './people-search.svelte';
  import {
    mdiAccount,
    mdiCalendarBlank,
    mdiChevronDown,
    mdiChevronUp,
    mdiImage,
    mdiMagnify,
    mdiMapMarker,
    mdiTagMultiple,
    mdiTune,
  } from '@mdi/js';
  import SearchLocationSection from './SearchLocationSection.svelte';
  import { getAllTags, type TagResponseDto } from '@immich/sdk';
  import SearchMediaSection from './SearchMediaSection.svelte';
  import SearchCameraSection from './SearchCameraSection.svelte';
  import SearchDateSection from './SearchDateSection.svelte';
  import SearchPeopleSection from './SearchPeopleSection.svelte';
  import SearchTagsSection from './SearchTagsSection.svelte';
  import SearchTextSection from './SearchTextSection.svelte';
  import SearchDisplaySection from './SearchDisplaySection.svelte';
  import SearchRatingsSection from './SearchRatingsSection.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import {
    getSearchDatePreset,
    getSearchDateTitle,
    getSearchMediaTitle,
    getSearchPeopleTitle,
    getSearchPlacesTitle,
    getSearchTagsTitle,
    getSearchTypeTitle,
  } from './search-bar-utils';
  import { onMount } from 'svelte';
  import { searchManager } from '$lib/managers/search-manager.svelte';
  import SearchButton from './SearchButton.svelte';

  interface Props {
    id: string;
    isOpen?: boolean;
    onSelectSearchTerm: (searchTerm: string) => void;
    onClearSearchTerm: (searchTerm: string) => void;
    onClearAllSearchTerms: () => void;
    onActiveSelectionChange: (selectedId: string | undefined) => void;
    onSearch: () => void;
  }

  let {
    id,
    isOpen = false,
    onSelectSearchTerm,
    onClearSearchTerm,
    onClearAllSearchTerms,
    onActiveSelectionChange,
    onSearch,
  }: Props = $props();

  let searchHistory = $state<SearchHistorySection>();

  let activeFilter = $state('type');
  let showAdvanced = $state(false);
  const peopleSearch = new PeopleSearch(
    () => isOpen && (activeFilter === 'people' || searchManager.filter.personIds.size > 0),
  );
  let tagsPromise = $state<Promise<TagResponseDto[]>>();
  let tags = $state<TagResponseDto[]>();

  let typeTitle = $derived(getSearchTypeTitle(searchManager.filter.queryType));
  let peopleTitle = $derived(
    peopleSearch.people ? getSearchPeopleTitle(peopleSearch.people, searchManager.filter.personIds) : undefined,
  );
  let selectedPeople = $derived(
    peopleSearch.people?.filter((person) => searchManager.filter.personIds.has(person.id)) ?? [],
  );

  function removePerson(personId: string) {
    // Keep focus inside the dropdown before removing its focused chip.
    document.querySelector<HTMLElement>(`#${CSS.escape(`${id}-people`)}`)?.focus();
    searchManager.filter.personIds.delete(personId);
  }

  let dateTitle = $derived(
    getSearchDateTitle(
      getSearchDatePreset(searchManager.filter.date.takenAfter, searchManager.filter.date.takenBefore),
      searchManager.filter.date.takenAfter,
      searchManager.filter.date.takenBefore,
    ),
  );
  let placesTitle = $derived(
    getSearchPlacesTitle(
      searchManager.filter.location.city,
      searchManager.filter.location.state,
      searchManager.filter.location.country,
    ),
  );
  let tagsTitle = $state<string>();
  let mediaTitle = $derived(getSearchMediaTitle(searchManager.filter.mediaType));

  let filters = [
    {
      name: 'type',
      icon: mdiMagnify,
      title: $t('search_type'),
      activeTitle: () => typeTitle,
    },
    {
      name: 'people',
      icon: mdiAccount,
      title: $t('people'),
      activeTitle: () => peopleTitle,
    },
    {
      name: 'date',
      icon: mdiCalendarBlank,
      title: $t('date'),
      activeTitle: () => dateTitle,
    },
    {
      name: 'places',
      icon: mdiMapMarker,
      title: $t('places'),
      activeTitle: () => placesTitle,
    },
    ...(authManager.authenticated && authManager.preferences.tags.enabled
      ? [
          {
            name: 'tags',
            icon: mdiTagMultiple,
            title: $t('tags'),
            activeTitle: () => tagsTitle,
          },
        ]
      : []),
    {
      name: 'media',
      icon: mdiImage,
      title: $t('media'),
      activeTitle: () => mediaTitle,
    },
  ];

  const advancedFiltersSet = $derived(
    searchManager.filter.display.isArchive ||
      searchManager.filter.display.isFavorite ||
      searchManager.filter.display.isNotInAlbum ||
      searchManager.filter.rating,
  );

  const clear = () => {
    searchManager.reset();
    tagsTitle = undefined;
  };

  onMount(() => {
    if (!searchManager.filter.tagIds?.size || tagsPromise) {
      return;
    }

    tagsPromise = getAllTags();
    void tagsPromise.then((res) => (tags = res));
  });

  $effect(() => {
    if (searchManager.filter.tagIds === null) {
      tagsTitle = $t('untagged');
    } else if (tags) {
      tagsTitle = getSearchTagsTitle(tags, searchManager.filter.tagIds);
    }
  });

  export function moveSelection(increment: 1 | -1) {
    if (searchHistory) {
      searchHistory.moveSelection(increment);
    }
  }

  export function clearSelection() {
    if (searchHistory) {
      searchHistory.clearSelection();
    }
  }

  export function selectActiveOption() {
    if (searchHistory) {
      searchHistory.selectActiveOption();
    }
  }
</script>

<div>
  {#if isOpen}
    <div
      transition:fly={{ y: 25, duration: 250 }}
      class="absolute z-1 max-h-[80svh] w-full overflow-y-scroll rounded-b-3xl bg-white shadow-[0_8px_20px_rgba(0,0,0,0.12)] transition-all dark:bg-immich-dark-gray dark:text-gray-300"
    >
      <div role="listbox" {id} aria-label={$t('recent_searches')}>
        <SearchHistorySection
          bind:this={searchHistory}
          {onSelectSearchTerm}
          {onClearSearchTerm}
          {onClearAllSearchTerms}
          {onActiveSelectionChange}
        />
      </div>
      <div class="px-5">
        <Text class="py-5" fontWeight="medium" aria-hidden={true}>{$t('filter_by')}</Text>
        <div class="flex flex-wrap gap-2">
          {#each filters as item (item.name)}
            <SearchButton
              id={`${id}-${item.name}`}
              active={activeFilter === item.name || Boolean(item.activeTitle())}
              leadingIcon={item.icon}
              class={activeFilter === item.name ? 'max-w-full border-2' : 'max-w-full'}
              onclick={() => (activeFilter = item.name)}
            >
              <span style="min-width: 0; overflow-wrap: anywhere">{item.activeTitle() ?? item.title}</span>
            </SearchButton>
          {/each}
        </div>
      </div>
      {#if selectedPeople.length > 0 || peopleSearch.failed}
        <Theme theme={themeManager.value === AppTheme.Dark ? 'dark' : 'light'}>
          <div class="flex flex-wrap gap-2 px-5 py-3" aria-label={$t('people')}>
            {#each selectedPeople as person (person.id)}
              <FilterChip
                {person}
                label={person.name || $t('unnamed_person')}
                removeLabel={`${$t('remove_person')}: ${person.name || $t('unnamed_person')}`}
                onRemove={() => removePerson(person.id)}
                onUnavailable={() => peopleSearch.discard(person.id)}
              />
            {/each}
            {#if peopleSearch.failed}
              <p role="alert">{$t('errors.failed_to_get_people')}</p>
              <Button onclick={() => peopleSearch.load()}>{$t('retry')}</Button>
            {/if}
          </div>
        </Theme>
      {/if}
      {#if activeFilter}
        <div class="px-5 pt-5">
          {#if activeFilter === 'type'}
            <SearchTextSection />
          {:else if activeFilter === 'people'}
            {#key peopleSearch.generation}
              <SearchPeopleSection
                people={peopleSearch.people ?? []}
                loading={peopleSearch.loading}
                onUnavailable={(id) => peopleSearch.discard(id)}
              />
            {/key}
          {:else if activeFilter === 'date'}
            <SearchDateSection />
          {:else if activeFilter === 'places'}
            <SearchLocationSection />
          {:else if activeFilter === 'tags'}
            <SearchTagsSection bind:title={tagsTitle} parentPromise={tagsPromise} />
          {:else if activeFilter === 'media'}
            <SearchMediaSection />
          {/if}
        </div>
      {/if}
      <div
        class="grid transition-[grid-template-rows] duration-200 ease-in-out {showAdvanced
          ? 'grid-rows-[1fr]'
          : 'grid-rows-[0fr]'}"
        inert={!showAdvanced}
      >
        <div class="overflow-hidden">
          <div class="my-5 h-px w-full bg-light-200 dark:bg-dark-600"></div>
          <div class="px-5">
            <SearchCameraSection />
            {#if authManager.authenticated && authManager.preferences.ratings.enabled}
              <SearchRatingsSection />
            {/if}
            <SearchDisplaySection />
          </div>
        </div>
      </div>
      <div class="my-5 h-px w-full bg-light-200 dark:bg-dark-600"></div>
      <div class="flex flex-wrap gap-2 px-5 pb-5">
        <Button
          size="small"
          variant={advancedFiltersSet ? 'outline' : 'ghost'}
          leadingIcon={mdiTune}
          trailingIcon={showAdvanced ? mdiChevronUp : mdiChevronDown}
          onclick={() => (showAdvanced = !showAdvanced)}>{$t('advanced_filters')}</Button
        >
        <div class="flex-1"></div>
        <Button
          size="small"
          shape="round"
          variant="outline"
          color="secondary"
          class="bg-transparent"
          onclick={() => clear()}>{$t('clear_all')}</Button
        >
        <Button size="small" shape="round" onclick={() => onSearch()}>{$t('search')}</Button>
      </div>
    </div>
  {/if}
</div>
