<script lang="ts">
  import ImageThumbnail from '$lib/components/assets/thumbnail/ImageThumbnail.svelte';
  import PeopleInfiniteScroll from '../PeopleInfiniteScroll.svelte';
  import { goto } from '$app/navigation';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import FrameleafButton from '$lib/components/frameleaf/Button.svelte';
  import ManagePersonCard from '$lib/components/frameleaf/people/ManagePersonCard.svelte';
  import { ToggleVisibility } from '$lib/constants';
  import { filterPeopleByName, sortPeopleForManage } from '$lib/frameleaf/people';
  import { frameleafShell } from '$lib/frameleaf/rollout';
  import { locale } from '$lib/stores/preferences.store';
  import { getPeopleThumbnailUrl } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import { getAllPeople, updatePeople, type PersonResponseDto } from '@immich/sdk';
  import { Button, IconButton, toastManager } from '@immich/ui';
  import { mdiClose, mdiEye, mdiEyeOff, mdiEyeSettings, mdiRestart } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import { SvelteMap } from 'svelte/reactivity';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  const { data }: Props = $props();

  let people = $derived(data.people.people);
  const totalPeopleCount = $derived(data.people.total);
  let nextPage = $state(data.people.hasNextPage ? 2 : null);
  let toggleVisibility = $state(ToggleVisibility.SHOW_ALL);
  let showLoadingSpinner = $state(false);
  const overrides = new SvelteMap<string, boolean>();

  const getNextVisibility = (toggleVisibility: ToggleVisibility) => {
    if (toggleVisibility === ToggleVisibility.SHOW_ALL) {
      return ToggleVisibility.HIDE_UNNANEMD;
    }
    return toggleVisibility === ToggleVisibility.HIDE_UNNANEMD ? ToggleVisibility.HIDE_ALL : ToggleVisibility.SHOW_ALL;
  };

  const handleToggleVisibility = () => {
    toggleVisibility = getNextVisibility(toggleVisibility);

    for (const person of people) {
      let isHidden = overrides.get(person.id) ?? person.isHidden;

      if (toggleVisibility === ToggleVisibility.HIDE_ALL) {
        isHidden = true;
      } else if (toggleVisibility === ToggleVisibility.SHOW_ALL) {
        isHidden = false;
      } else if (toggleVisibility === ToggleVisibility.HIDE_UNNANEMD && !person.name) {
        isHidden = true;
      }

      setHiddenOverride(person, isHidden);
    }
  };

  const handleSaveVisibility = async () => {
    showLoadingSpinner = true;
    const changed = Array.from(overrides, ([id, isHidden]) => ({ id, isHidden }));

    try {
      if (changed.length > 0) {
        const results = await updatePeople({ peopleUpdateDto: { people: changed } });
        const successCount = results.filter(({ success }) => success).length;
        const failCount = results.length - successCount;
        if (failCount > 0) {
          toastManager.warning($t('errors.unable_to_change_visibility', { values: { count: failCount } }));
        }
        toastManager.primary($t('visibility_changed', { values: { count: successCount } }));
      }

      for (const person of people) {
        const isHidden = overrides.get(person.id);
        if (isHidden !== undefined) {
          person.isHidden = isHidden;
        }
      }
      overrides.clear();

      await goto('/people');
    } catch (error) {
      handleError(error, $t('errors.unable_to_change_visibility', { values: { count: changed.length } }));
    } finally {
      showLoadingSpinner = false;
    }
  };

  const setHiddenOverride = (person: PersonResponseDto, isHidden: boolean) => {
    if (isHidden === person.isHidden) {
      overrides.delete(person.id);
      return;
    }
    overrides.set(person.id, isHidden);
  };

  const loadNextPage = async () => {
    if (!nextPage) {
      return;
    }
    try {
      const { people: newPeople, hasNextPage } = await getAllPeople({ withHidden: true, page: nextPage });
      people = people.concat(newPeople);
      nextPage = hasNextPage ? nextPage + 1 : null;
    } catch (error) {
      handleError(error, $t('errors.failed_to_load_people'));
    }
  };

  let toggleButtonOptions: Record<ToggleVisibility, { icon: string; label: string }> = $derived({
    [ToggleVisibility.HIDE_ALL]: { icon: mdiEyeOff, label: $t('hide_all_people') },
    [ToggleVisibility.HIDE_UNNANEMD]: { icon: mdiEyeSettings, label: $t('hide_unnamed_people') },
    [ToggleVisibility.SHOW_ALL]: { icon: mdiEye, label: $t('show_all_people') },
  });
  let toggleButton = $derived(toggleButtonOptions[getNextVisibility(toggleVisibility)]);

  // Frameleaf manage-people page (FL-37): the same `overrides` draft and `updatePeople`
  // bulk-visibility save as the legacy page, with a search field and one-shot batch
  // actions instead of the legacy cycling button, per `ManagePeople.jsx`.
  let frameleafSearch = $state('');
  const frameleafRows = $derived(sortPeopleForManage(filterPeopleByName(people, frameleafSearch)));
  const frameleafPending = $derived(overrides.size);
  const frameleafHiddenCount = $derived(
    frameleafRows.filter((person) => overrides.get(person.id) ?? person.isHidden).length,
  );
  const hideAllFrameleaf = () => {
    for (const person of people) {
      setHiddenOverride(person, true);
    }
  };
  const hideUnnamedFrameleaf = () => {
    for (const person of people) {
      if (!person.name) {
        setHiddenOverride(person, true);
      }
    }
  };
  const showAllFrameleaf = () => {
    for (const person of people) {
      setHiddenOverride(person, false);
    }
  };
</script>

<UserPageLayout title={$t('show_and_hide_people')} description={`(${totalPeopleCount.toLocaleString($locale)})`}>
  {#snippet buttons()}
    {#if $frameleafShell}
      <div class="frameleaf-manage-toolbar">
        <input
          type="search"
          class="frameleaf-manage-search"
          aria-label={$t('frameleaf_people_find_a_person')}
          placeholder={$t('frameleaf_people_find_a_person')}
          bind:value={frameleafSearch}
        />
        <FrameleafButton onclick={hideAllFrameleaf}>{$t('hide_all_people')}</FrameleafButton>
        <FrameleafButton onclick={hideUnnamedFrameleaf}>{$t('hide_unnamed_people')}</FrameleafButton>
        <FrameleafButton onclick={showAllFrameleaf}>{$t('show_all_people')}</FrameleafButton>
        <FrameleafButton disabled={frameleafPending === 0} onclick={() => overrides.clear()}>
          {$t('reset_people_visibility')}
        </FrameleafButton>
        <FrameleafButton variant="primary" disabled={frameleafPending === 0} onclick={handleSaveVisibility}>
          {frameleafPending > 0
            ? $t('frameleaf_people_save_changes_count', { values: { count: frameleafPending } })
            : $t('done')}
        </FrameleafButton>
        <FrameleafButton onclick={() => goto('/people')}>{$t('close')}</FrameleafButton>
      </div>
    {:else}
      <div class="flex items-center justify-end">
        <div class="flex items-center md:me-4">
          <IconButton
            shape="round"
            color="secondary"
            variant="ghost"
            aria-label={$t('close')}
            icon={mdiClose}
            onclick={() => goto('/people')}
          />
          <IconButton
            shape="round"
            color="secondary"
            variant="ghost"
            aria-label={$t('reset_people_visibility')}
            icon={mdiRestart}
            onclick={() => overrides.clear()}
          />
          <IconButton
            shape="round"
            color="secondary"
            variant="ghost"
            aria-label={toggleButton.label}
            icon={toggleButton.icon}
            onclick={handleToggleVisibility}
          />
        </div>
        <Button loading={showLoadingSpinner} onclick={handleSaveVisibility} size="small">{$t('done')}</Button>
      </div>
    {/if}
  {/snippet}

  {#if $frameleafShell}
    <p class="frameleaf-manage-summary">
      {$t('frameleaf_people_manage_summary', {
        values: { shown: frameleafRows.length - frameleafHiddenCount, hidden: frameleafHiddenCount },
      })}
    </p>
    <div class="frameleaf-manage-grid">
      <PeopleInfiniteScroll
        people={frameleafRows}
        hasNextPage={nextPage !== null && !frameleafSearch.trim()}
        {loadNextPage}
      >
        {#snippet children({ person })}
          {@const hidden = overrides.get(person.id) ?? person.isHidden}
          {@const changed = hidden !== person.isHidden}
          <ManagePersonCard {person} {hidden} {changed} onToggle={() => setHiddenOverride(person, !hidden)} />
        {/snippet}
      </PeopleInfiniteScroll>
    </div>
  {:else}
    <div class="flex flex-wrap gap-1 p-2 pb-8 md:px-8">
      <PeopleInfiniteScroll {people} hasNextPage={nextPage !== null} {loadNextPage}>
        {#snippet children({ person })}
          {@const hidden = overrides.get(person.id) ?? person.isHidden}
          <button
            type="button"
            class="group relative size-full"
            onclick={() => setHiddenOverride(person, !hidden)}
            aria-pressed={hidden}
            aria-label={person.name ? $t('hide_named_person', { values: { name: person.name } }) : $t('hide_person')}
          >
            <ImageThumbnail
              {hidden}
              shadow
              url={getPeopleThumbnailUrl(person)}
              altText={person.name}
              widthStyle="100%"
              hiddenIconClass="text-white group-hover:text-black transition-colors"
              preload={false}
            />
            {#if person.name}
              <span
                class="text-white-shadow absolute inset-s-0 bottom-2 w-full px-1 text-center font-medium text-white select-text"
              >
                {person.name}
              </span>
            {/if}
          </button>
        {/snippet}
      </PeopleInfiniteScroll>
    </div>
  {/if}
</UserPageLayout>

<style>
  .frameleaf-manage-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }
  .frameleaf-manage-search {
    padding: 0.4375rem 0.6875rem;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .frameleaf-manage-summary {
    padding: 0 0.5rem 0.5rem;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .frameleaf-manage-grid {
    padding: 0 0.5rem 2rem;
  }
</style>
