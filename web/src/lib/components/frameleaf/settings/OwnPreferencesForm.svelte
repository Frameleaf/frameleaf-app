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
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import type { AccountPreferencesDraftStore } from '$lib/frameleaf/account-preferences-draft.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { toastManager } from '@immich/ui';
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

  <div class="actions">
    <Button disabled={!store.dirty} onclick={() => store.cancel()}>{$t('frameleaf_account_prefs_cancel')}</Button>
    <Button variant="primary" type="submit" disabled={!store.dirty || store.saving}>{$t('save')}</Button>
  </div>
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
    border-left: 2px solid var(--fl-accent);
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
    color: var(--fl-danger-text, var(--fl-danger));
    font-size: var(--fl-font-small);
    line-height: 1.6;
  }
  .notice {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.6;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 8px;
  }
</style>
