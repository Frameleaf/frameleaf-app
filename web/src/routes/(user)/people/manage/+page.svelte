<script lang="ts">
  import PeopleInfiniteScroll from '../PeopleInfiniteScroll.svelte';
  import { goto } from '$app/navigation';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import FrameleafButton from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import Theme from '$lib/components/frameleaf/Theme.svelte';
  import ManagePersonCard from '$lib/components/frameleaf/people/ManagePersonCard.svelte';
  import { filterPeopleByName, isUnnamedPerson, sortPeopleForManage } from '$lib/frameleaf/people';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import { getAllPeople, updatePeople, type PersonResponseDto } from '@immich/sdk';
  import { Icon, Theme as AppTheme, themeManager, toastManager } from '@immich/ui';
  import { mdiArrowLeft, mdiCheck, mdiEyeOffOutline, mdiEyeOutline, mdiAccountOffOutline, mdiRestore } from '@mdi/js';
  import { onDestroy, untrack } from 'svelte';
  import { t } from 'svelte-i18n';
  import { SvelteMap } from 'svelte/reactivity';
  import type { PageData } from './$types';

  const { data }: { data: PageData } = $props();
  const theme = $derived(themeManager.value === AppTheme.Dark ? 'dark' : 'light');
  let blocked = $state(false);
  let people = $derived(blocked ? [] : data.people.people);
  let nextPage = $state(untrack(() => (data.people.hasNextPage ? 2 : null)));
  const overrides = new SvelteMap<string, boolean>();
  let saving = $state(false);
  let loadingAll = $state(false);
  let pageFailed = $state(false);
  /**
   * Hidden people confirmed by saves on this page, on top of the server's count. The summary
   * covers everyone (the server's `total`/`hidden`) until every page is loaded, then counts the
   * loaded list itself.
   */
  let savedHiddenDelta = $state(0);
  let failedCount = $state(0);
  let search = $state('');
  let confirmLeave = $state(false);
  let status = $state('');
  let retired = false;
  let pageRequest: AbortController | undefined;
  let pageLoad: Promise<void> | undefined;
  let allLoad: Promise<boolean> | undefined;
  let saveRequest: AbortController | undefined;
  const ownerId = untrack(() => (authManager.authenticated ? authManager.user.id : undefined));

  const retire = () => {
    blocked = true;
    pageRequest?.abort();
    saveRequest?.abort();
    people = [];
    nextPage = null;
    overrides.clear();
    failedCount = 0;
    pageFailed = false;
    loadingAll = false;
    confirmLeave = false;
    status = '';
  };
  const stopAccess = eventManager.on({
    SessionLocked: retire,
    SessionAccessChanged: ({ isElevated }) => {
      if (!isElevated) {
        retire();
      }
    },
    UserPinCodeReset: retire,
    AuthLogout: retire,
    SessionDelete: retire,
    AuthUserLoaded: (user) => {
      if (user.id !== ownerId) {
        retire();
      }
    },
  });
  $effect(() => {
    const currentId = authManager.authenticated ? authManager.user.id : undefined;
    if (ownerId && currentId !== ownerId) {
      retire();
    }
  });
  onDestroy(() => {
    retired = true;
    retire();
    stopAccess();
  });

  const rows = $derived(sortPeopleForManage(filterPeopleByName(people, search)));
  const pending = $derived(overrides.size);
  const draftHiddenDelta = $derived.by(() => {
    let delta = 0;
    for (const isHidden of overrides.values()) {
      delta += isHidden ? 1 : -1;
    }
    return delta;
  });
  const totalCount = $derived(nextPage === null ? people.length : Math.max(data.people.total, people.length));
  const hiddenCount = $derived(
    nextPage === null
      ? people.filter((person) => overrides.get(person.id) ?? person.isHidden).length
      : Math.min(totalCount, Math.max(0, data.people.hidden + savedHiddenDelta + draftHiddenDelta)),
  );
  const busy = $derived(saving || loadingAll);
  const leave = () => {
    if (saving) {
      return;
    }
    if (pending) {
      confirmLeave = true;
    } else {
      void goto('/people');
    }
  };
  const setHiddenOverride = (person: PersonResponseDto, isHidden: boolean) => {
    if (blocked || busy) {
      return;
    }
    if (isHidden === person.isHidden) {
      overrides.delete(person.id);
    } else {
      overrides.set(person.id, isHidden);
    }
  };
  const toggle = (person: PersonResponseDto, hidden: boolean) => {
    if (blocked || busy) {
      return;
    }
    setHiddenOverride(person, !hidden);
    const name = isUnnamedPerson(person) ? $t('unnamed_person') : person.name;
    status = $t(hidden ? 'frameleaf_people_will_be_shown' : 'frameleaf_people_will_be_hidden', { values: { name } });
  };
  /**
   * Hide all / Hide unnamed / Show all apply to everyone, as ManagePeople.jsx:56-84 does: the
   * remaining pages are read first (keeping every draft), then the shortcut drafts a change for
   * each person. Nothing is drafted when a page fails to load; Retry picks the load up again.
   */
  const batch = async (action: 'hide' | 'unnamed' | 'show') => {
    if (blocked || busy) {
      return;
    }
    if (!(await loadAllPages())) {
      return;
    }
    for (const person of people) {
      if (action !== 'unnamed' || isUnnamedPerson(person)) {
        setHiddenOverride(person, action !== 'show');
      }
    }
    status = $t(
      action === 'show'
        ? 'frameleaf_people_shown_draft'
        : action === 'unnamed'
          ? 'frameleaf_people_unnamed_draft'
          : 'frameleaf_people_hidden_draft',
    );
  };
  const reset = () => {
    if (blocked || busy) {
      return;
    }
    overrides.clear();
    failedCount = 0;
    status = $t('frameleaf_people_changes_reverted');
  };

  const handleSaveVisibility = async () => {
    if (blocked || retired || busy || !pending) {
      return;
    }
    saving = true;
    failedCount = 0;
    const request = new AbortController();
    saveRequest = request;
    const changed = Array.from(overrides, ([id, isHidden]) => ({ id, isHidden }));
    try {
      const results = await updatePeople({ peopleUpdateDto: { people: changed } }, { signal: request.signal });
      if (request.signal.aborted || retired) {
        return;
      }
      const successful = new Set(results.filter(({ success }) => success).map(({ id }) => id));
      const confirmed = changed.filter(({ id }) => successful.has(id));
      for (const { id, isHidden } of confirmed) {
        const person = people.find((person) => person.id === id);
        if (person) {
          person.isHidden = isHidden;
        }
        overrides.delete(id);
        savedHiddenDelta += isHidden ? 1 : -1;
      }
      failedCount = changed.length - confirmed.length;
      if (confirmed.length > 0) {
        toastManager.primary($t('visibility_changed', { values: { count: confirmed.length } }));
      }
      if (!failedCount) {
        await goto('/people');
      }
    } catch (error) {
      if (!request.signal.aborted && !retired) {
        failedCount = changed.length;
        handleError(error, $t('errors.unable_to_change_visibility', { values: { count: changed.length } }));
      }
    } finally {
      if (saveRequest === request) {
        saving = false;
        saveRequest = undefined;
      }
    }
  };
  /** Reads the next page; a call while one is in flight shares it rather than asking again. */
  const loadNextPage = (): Promise<void> => {
    if (pageLoad) {
      return pageLoad;
    }
    if (!nextPage || blocked || retired) {
      return Promise.resolve();
    }
    const load = readNextPage(nextPage);
    pageLoad = load;
    void load.finally(() => {
      if (pageLoad === load) {
        pageLoad = undefined;
      }
    });
    return load;
  };
  /**
   * Reads every remaining page; false when a page failed or the page was retired meanwhile. A call
   * while a run is going shares that run.
   */
  const loadAllPages = (): Promise<boolean> => {
    if (nextPage === null) {
      return Promise.resolve(!blocked && !retired);
    }
    allLoad ??= (async () => {
      loadingAll = true;
      pageFailed = false;
      try {
        while (nextPage !== null && !pageFailed && !blocked && !retired) {
          await loadNextPage();
        }
        return nextPage === null && !pageFailed && !blocked && !retired;
      } finally {
        loadingAll = false;
        allLoad = undefined;
      }
    })();
    return allLoad;
  };
  // "Find a person" searches everyone, so a search reads the remaining pages.
  $effect(() => {
    if (search.trim() && nextPage !== null && !pageFailed && !blocked) {
      untrack(() => void loadAllPages());
    }
  });
  const readNextPage = async (page: number) => {
    const request = new AbortController();
    pageRequest = request;
    pageFailed = false;
    try {
      const result = await getAllPeople({ withHidden: true, page }, { signal: request.signal });
      if (request.signal.aborted || retired) {
        return;
      }
      const existing = new Set(people.map(({ id }) => id));
      const added = result.people.filter(({ id }) => {
        if (existing.has(id)) {
          return false;
        }
        existing.add(id);
        return true;
      });
      people = people.concat(added);
      nextPage = result.hasNextPage ? page + 1 : null;
    } catch (error) {
      if (!request.signal.aborted && !retired) {
        pageFailed = true;
        handleError(error, $t('errors.failed_to_load_people'));
      }
    } finally {
      if (pageRequest === request) {
        pageRequest = undefined;
      }
    }
  };
</script>

<UserPageLayout>
  <Theme {theme}>
    <section class="pm-page" aria-label={$t('show_and_hide_people')}>
      <header class="pm-header">
        <div class="pm-title">
          <FrameleafButton label={$t('frameleaf_people_back')} onclick={leave} disabled={saving}>
            <Icon icon={mdiArrowLeft} size="18" />
          </FrameleafButton>
          <div>
            <h1>{$t('show_and_hide_people')}</h1>
            <p>{$t('frameleaf_people_manage_description')}</p>
          </div>
        </div>
        {#if !blocked}
          <div class="pm-toolbar">
            <input
              type="search"
              aria-label={$t('frameleaf_people_find_a_person')}
              placeholder={$t('frameleaf_people_find_a_person')}
              bind:value={search}
            />
            <div class="pm-batches" role="group" aria-label={$t('frameleaf_people_visibility_shortcuts')}>
              <FrameleafButton disabled={busy} onclick={() => void batch('hide')}
                ><Icon icon={mdiEyeOffOutline} size="18" />{$t('frameleaf_people_hide_all')}</FrameleafButton
              >
              <FrameleafButton disabled={busy} onclick={() => void batch('unnamed')}
                ><Icon icon={mdiAccountOffOutline} size="18" />{$t('frameleaf_people_hide_unnamed')}</FrameleafButton
              >
              <FrameleafButton disabled={busy} onclick={() => void batch('show')}
                ><Icon icon={mdiEyeOutline} size="18" />{$t('frameleaf_people_show_all')}</FrameleafButton
              >
              <FrameleafButton disabled={busy || !pending} label={$t('reset_people_visibility')} onclick={reset}
                ><Icon icon={mdiRestore} size="18" />{$t('reset')}</FrameleafButton
              >
            </div>
          </div>
        {/if}
      </header>
      {#if blocked}
        <p role="status">{$t('frameleaf_people_access_changed')}</p>
        <FrameleafButton onclick={() => location.reload()}>{$t('reload')}</FrameleafButton>
      {:else}
        <p class="pm-summary">
          {$t('frameleaf_people_manage_summary', {
            values: { shown: totalCount - hiddenCount, hidden: hiddenCount },
          })}
        </p>
        <div class="pm-grid">
          <PeopleInfiniteScroll
            people={rows}
            hasNextPage={nextPage !== null && !search.trim() && !pageFailed}
            {loadNextPage}
            managed
          >
            {#snippet children({ person })}
              {@const hidden = overrides.get(person.id) ?? person.isHidden}
              {@const changed = hidden !== person.isHidden}
              <ManagePersonCard {person} {hidden} {changed} disabled={busy} onToggle={() => toggle(person, hidden)} />
            {/snippet}
          </PeopleInfiniteScroll>
        </div>
        {#if rows.length === 0}<p class="pm-empty" role="status">
            {$t(search.trim() ? 'frameleaf_people_no_match' : 'frameleaf_people_none_to_manage')}
          </p>{/if}
        {#if pageFailed}
          <div role="alert">
            <p>{$t('errors.failed_to_load_people')}</p>
            <FrameleafButton onclick={loadNextPage}>{$t('retry')}</FrameleafButton>
          </div>
        {/if}
        <footer class="pm-footer">
          <div>
            {#if failedCount}<p role="alert">
                {$t('errors.unable_to_change_visibility', { values: { count: failedCount } })}
              </p>{/if}
            <span class="pm-pending" role="status" aria-live="polite"
              >{(loadingAll && $t('frameleaf_people_loading_everyone')) ||
                status ||
                $t(pending ? 'frameleaf_people_pending_changes' : 'frameleaf_people_no_pending_changes', {
                  values: { count: pending },
                })}</span
            >
          </div>
          <div class="pm-footer-actions">
            <FrameleafButton disabled={saving} onclick={leave}>{$t('cancel')}</FrameleafButton>
            <FrameleafButton variant="primary" disabled={busy || !pending} onclick={handleSaveVisibility}>
              <Icon icon={mdiCheck} size="18" />
              {$t(
                saving
                  ? 'frameleaf_settings_draft_saving'
                  : failedCount
                    ? 'retry'
                    : pending
                      ? 'frameleaf_people_save_changes_count'
                      : 'frameleaf_settings_draft_save',
                { values: { count: pending } },
              )}
            </FrameleafButton>
          </div>
        </footer>
      {/if}
    </section>
    <Dialog title={$t('frameleaf_people_discard_title')} closeLabel={$t('close')} bind:open={confirmLeave}>
      <p class="pm-dialog-hint">{$t('frameleaf_people_discard_description', { values: { count: pending } })}</p>
      <div class="pm-footer-actions">
        <FrameleafButton onclick={() => (confirmLeave = false)}
          >{$t('frameleaf_settings_draft_keep_editing')}</FrameleafButton
        >
        <FrameleafButton
          variant="primary"
          onclick={() => {
            confirmLeave = false;
            void goto('/people');
          }}>{$t('frameleaf_settings_draft_discard')}</FrameleafButton
        >
      </div>
    </Dialog>
  </Theme>
</UserPageLayout>

<style>
  /* ManagePeople.jsx and people.css; existing services retain server authorization. */
  .pm-page {
    display: flex;
    flex-direction: column;
    min-height: 100%;
    padding: 32px 32px 0;
  }
  .pm-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 20px;
    flex-wrap: wrap;
    padding-bottom: 28px;
    border-bottom: 1px solid var(--fl-border);
  }
  .pm-title {
    display: flex;
    align-items: flex-start;
    gap: 14px;
  }
  h1 {
    margin: 0;
    font-size: 24px;
    font-weight: 600;
  }
  .pm-title p {
    margin: 8px 0 0;
    color: var(--fl-muted);
  }
  .pm-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
  }
  .pm-toolbar input {
    min-width: 0;
    min-height: 34px;
    padding: 8px 12px;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .pm-batches {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .pm-summary {
    margin: 18px 0 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .pm-empty,
  .pm-dialog-hint {
    color: var(--fl-muted);
  }
  .pm-grid {
    padding: 18px 0 110px;
  }
  .pm-footer {
    position: sticky;
    bottom: -8px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin: auto -32px 0;
    padding: 14px 32px;
    background: color-mix(in srgb, var(--fl-canvas), transparent 8%);
    backdrop-filter: blur(12px);
    border-top: 1px solid var(--fl-border);
    z-index: 5;
  }
  .pm-pending {
    color: var(--fl-muted);
  }
  .pm-footer-actions {
    display: flex;
    gap: 8px;
  }
  @media (max-width: 700px) {
    .pm-page {
      padding: 22px 16px 0;
    }
    .pm-header {
      gap: 18px;
      padding-bottom: 18px;
    }
    .pm-title {
      gap: 10px;
    }
    .pm-toolbar {
      width: 100%;
    }
    .pm-toolbar input {
      flex: 1 1 100%;
    }
    .pm-batches {
      width: 100%;
    }
    .pm-batches :global(button) {
      flex: 1 1 calc(50% - 4px);
      min-height: 44px;
    }
    .pm-grid {
      padding-bottom: 120px;
    }
    .pm-footer {
      flex-direction: column;
      align-items: stretch;
      margin-inline: -16px;
      padding: 12px 16px;
    }
    .pm-footer-actions :global(button) {
      flex: 1;
      min-height: 44px;
    }
  }
</style>
