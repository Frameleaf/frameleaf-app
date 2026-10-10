<script lang="ts">
  /**
   * The form around one group of the signed-in account's own preferences (FL-77): the fields
   * come from the caller, this adds the stale-save banner, the error line and Cancel / Save.
   *
   * Save sends only the group's changed values with the revision they were loaded at. If an
   * administrator (or another device) changed the account's preferences in the meantime the
   * server refuses the save, the draft stays on screen, and the banner offers to load the latest
   * values. When another group on this page saves, this group follows the new revision without
   * losing its own unsaved changes.
   *
   * Unsaved changes are held in the same sticky bar the server settings use (design review finding
   * 70), labelled as the account's own preferences and with a direct Save, since there is nothing
   * to review; the settings navigation marks the page with the pending dot. Leaving the page with
   * unsaved changes holds the navigation until they are kept or discarded: opening another
   * settings page used to drop them without a word. Closing or reloading the tab gets the
   * browser's own warning.
   */
  import { beforeNavigate, goto } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { ownPreferencesPending } from '$lib/components/frameleaf/settings/own-preferences-pending.svelte';
  import SaveBarFrame from '$lib/components/frameleaf/settings/SaveBarFrame.svelte';
  import { resolveSettingsArea, resolveSettingsSection } from '$lib/frameleaf/settings-areas';
  import type { AccountPreferencesDraftStore } from '$lib/frameleaf/account-preferences-draft.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { toastManager } from '@frameleaf/ui';
  import { untrack, type Snippet } from 'svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    store: AccountPreferencesDraftStore;
    children: Snippet;
  };

  let { store, children }: Props = $props();

  $effect(() => {
    const latest = authManager.preferences;
    untrack(() => store.follow(latest));
  });

  const errorText = $derived.by(() => {
    const error = store.error;
    if (!error) {
      return '';
    }
    switch (error.code) {
      case 'minimum_faces': {
        return $t('frameleaf_account_prefs_error_minimum_faces');
      }
      case 'memory_duration': {
        return $t('frameleaf_account_prefs_error_memory_duration');
      }
      case 'archive_size': {
        return $t('frameleaf_account_prefs_error_archive_size');
      }
      case 'load_failed': {
        return [$t('frameleaf_account_prefs_error_load'), error.detail].filter(Boolean).join(' ');
      }
      default: {
        return [$t('frameleaf_account_prefs_error_save'), error.detail].filter(Boolean).join(' ');
      }
    }
  });

  let pendingNavigation = $state<URL | null>(null);

  /** The settings page an address shows; a change of anything else keeps this form on screen. */
  const pageOf = (url: URL) => {
    const isOpen = url.searchParams.get('isOpen');
    const area = resolveSettingsArea({ area: url.searchParams.get('area'), isOpen });
    const section = resolveSettingsSection(area, { section: url.searchParams.get('section'), isOpen });
    return [url.pathname, area, section].join('|');
  };

  beforeNavigate(({ cancel, from, to, type }) => {
    if (type === 'leave' || !to || !untrack(() => store.dirty)) {
      return;
    }
    if (from && pageOf(from.url) === pageOf(to.url)) {
      return;
    }
    cancel();
    // The bar is pinned to the bottom of the page, so the question is in view wherever they are.
    pendingNavigation = to.url;
  });

  const discardAndContinue = async () => {
    const destination = pendingNavigation;
    pendingNavigation = null;
    // With the draft discarded the guard above lets this navigation through.
    store.cancel();
    if (destination) {
      await goto(destination);
    }
  };

  const warnBeforeUnload = (event: BeforeUnloadEvent) => {
    event.preventDefault();
  };

  $effect(() => {
    if (!store.dirty) {
      pendingNavigation = null;
      return;
    }
    const release = ownPreferencesPending.hold();
    addEventListener('beforeunload', warnBeforeUnload);
    return () => {
      release();
      removeEventListener('beforeunload', warnBeforeUnload);
    };
  });

  const onsubmit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (await store.save()) {
      toastManager.primary($t('saved_settings'));
    }
  };
</script>

<form class="own-preferences" autocomplete="off" {onsubmit}>
  {#if store.stale}
    <div class="conflict" role="status">
      <span>{$t('frameleaf_account_prefs_own_conflict')}</span>
      <Button disabled={store.loading} onclick={() => store.loadLatest()}>
        {$t('frameleaf_account_prefs_load_latest')}
      </Button>
    </div>
  {/if}

  <div class="fields">
    {@render children()}
  </div>

  {#if errorText}
    <p class="error" role="alert">{errorText}</p>
  {/if}
  {#if store.notice === 'latest_loaded'}
    <p class="notice" role="status">{$t('frameleaf_account_prefs_notice_latest')}</p>
  {/if}

  {#if store.dirty}
    <SaveBarFrame
      alert={!!pendingNavigation}
      label={$t('frameleaf_account_prefs_own_bar_label')}
      title={pendingNavigation
        ? $t('frameleaf_account_prefs_own_leave_notice')
        : $t('frameleaf_account_prefs_own_unsaved')}
      subtitle={pendingNavigation ? '' : $t('frameleaf_account_prefs_own_unsaved_help')}
    >
      {#if pendingNavigation}
        <Button onclick={() => (pendingNavigation = null)}>{$t('frameleaf_account_prefs_keep_editing')}</Button>
        <Button onclick={discardAndContinue}>{$t('frameleaf_account_prefs_discard_continue')}</Button>
      {:else}
        <Button disabled={store.saving} onclick={() => store.cancel()}>
          {$t('frameleaf_account_prefs_cancel')}
        </Button>
      {/if}
      <Button variant="primary" type="submit" disabled={store.saving}>{$t('save')}</Button>
    </SaveBarFrame>
  {/if}
</form>

<style>
  .own-preferences {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    margin: 1rem 0;
  }
  .fields {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .conflict {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    background: var(--fl-raised);
    border-inline-start: 2px solid var(--fl-accent);
    padding: 12px;
    line-height: 1.6;
    font-size: var(--fl-font-small);
    color: var(--fl-text);
  }
  .conflict span {
    flex: 1 1 250px;
  }
  .error {
    margin: 0;
    color: var(--fl-danger);
    font-size: var(--fl-font-small);
    line-height: 1.6;
  }
  .notice {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.6;
  }
</style>
