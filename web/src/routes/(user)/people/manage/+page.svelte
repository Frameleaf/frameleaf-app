<script lang="ts">
  import PeopleInfiniteScroll from '../PeopleInfiniteScroll.svelte';
  import { beforeNavigate, goto } from '$app/navigation';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import FrameleafButton from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import ManagePersonCard from '$lib/components/frameleaf/people/ManagePersonCard.svelte';
  import { filterPeopleByName, sortPeopleForManage } from '$lib/frameleaf/people';
  import { locale } from '$lib/stores/preferences.store';
  import { handleError } from '$lib/utils/handle-error';
  import { getAllPeople, updatePeople, type PersonResponseDto } from '@immich/sdk';
  import { toastManager } from '@immich/ui';
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
  const overrides = new SvelteMap<string, boolean>();

  const handleSaveVisibility = async () => {
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

  // Manage-people page (FL-37): an `overrides` draft saved in one `updatePeople` bulk call,
  // with a search field and one-shot batch actions, per `ManagePeople.jsx`.
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

  // FL-83 (MP-3): leaving with unsaved visibility changes asks first, as the prototype's
  // "Discard changes?" dialog does. Close, the browser's back and any other in-app
  // navigation all go through the same guard; saving clears the draft before it navigates.
  let pendingNavigation = $state<URL | null>(null);
  let discardOpen = $state(false);

  beforeNavigate(({ cancel, to, type }) => {
    if (type === 'leave' || overrides.size === 0 || !to) {
      return;
    }
    cancel();
    pendingNavigation = to.url;
    discardOpen = true;
  });

  const leave = () => {
    if (overrides.size > 0) {
      pendingNavigation = null;
      discardOpen = true;
      return;
    }
    return goto('/people');
  };

  const keepEditing = () => {
    discardOpen = false;
    pendingNavigation = null;
  };

  const discardAndLeave = async () => {
    const destination = pendingNavigation ?? '/people';
    pendingNavigation = null;
    discardOpen = false;
    // With the draft cleared the guard above lets this navigation through.
    overrides.clear();
    await goto(destination);
  };
</script>

<UserPageLayout title={$t('show_and_hide_people')} description={`(${totalPeopleCount.toLocaleString($locale)})`}>
  {#snippet buttons()}
    <div class="frameleaf-manage-toolbar">
      <input
        type="search"
        class="frameleaf-manage-search"
        aria-label={$t('frameleaf_people_find_a_person')}
        placeholder={$t('frameleaf_people_find_a_person')}
        bind:value={frameleafSearch}
      />
      <!-- FL-83 (MP-1): the prototype's short batch labels, grouped for assistive tech. -->
      <div class="frameleaf-manage-batches" role="group" aria-label={$t('frameleaf_people_visibility_shortcuts')}>
        <FrameleafButton onclick={hideAllFrameleaf}>{$t('frameleaf_people_hide_all')}</FrameleafButton>
        <FrameleafButton onclick={hideUnnamedFrameleaf}>{$t('frameleaf_people_hide_unnamed')}</FrameleafButton>
        <FrameleafButton onclick={showAllFrameleaf}>{$t('frameleaf_people_show_all')}</FrameleafButton>
        <FrameleafButton disabled={frameleafPending === 0} onclick={() => overrides.clear()}>
          {$t('frameleaf_people_reset_visibility')}
        </FrameleafButton>
      </div>
      <FrameleafButton variant="primary" disabled={frameleafPending === 0} onclick={handleSaveVisibility}>
        {frameleafPending > 0
          ? $t('frameleaf_people_save_changes_count', { values: { count: frameleafPending } })
          : $t('done')}
      </FrameleafButton>
      <FrameleafButton onclick={() => void leave()}>{$t('close')}</FrameleafButton>
    </div>
  {/snippet}

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
</UserPageLayout>

{#if discardOpen}
  <Dialog title={$t('frameleaf_people_discard_title')} closeLabel={$t('close')} bind:open={discardOpen}>
    <div class="frameleaf-discard">
      <p>{$t('frameleaf_people_discard_body', { values: { count: frameleafPending } })}</p>
      <div class="frameleaf-discard-actions">
        <FrameleafButton onclick={keepEditing}>{$t('frameleaf_people_keep_editing')}</FrameleafButton>
        <FrameleafButton variant="primary" onclick={() => void discardAndLeave()}>
          {$t('frameleaf_people_discard')}
        </FrameleafButton>
      </div>
    </div>
  </Dialog>
{/if}

<style>
  .frameleaf-manage-toolbar,
  .frameleaf-manage-batches {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }
  .frameleaf-discard {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    margin-block-start: 1rem;
    width: min(26rem, calc(100vw - 4rem));
  }
  .frameleaf-discard p {
    margin: 0;
    font-size: 0.875rem;
    color: var(--fl-text);
  }
  .frameleaf-discard-actions {
    display: flex;
    justify-content: flex-end;
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
