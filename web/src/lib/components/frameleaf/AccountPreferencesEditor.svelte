<script lang="ts">
  /**
   * The administrator's editor for one account's preferences (FL-77), ported from the design
   * template's `AccountPreferences.jsx` and the Features / Preferences / Notifications tabs of the
   * account detail in `AccountsLibraries.jsx`.
   *
   * One draft is kept across the three tabs. Save sends only the changed values with the
   * revision they were loaded at; the server refuses a save made against preferences that changed
   * since (409), and the draft is then kept until the administrator discards it and loads the
   * latest values. Feature switches are account preferences for tools and navigation, never an
   * access control. The one administrator-enforced value is "Allow casting". The account's Locked
   * people and tags are never shown or sent here.
   */
  import { beforeNavigate, goto } from '$app/navigation';
  import {
    ACCOUNT_FEATURES,
    ACCOUNT_PREFERENCES_SECTIONS,
    archiveSizeToGib,
    gibToArchiveSize,
    reminderDateFromInput,
    reminderDateInput,
    type AccountFeatureId,
    type AccountPreferenceKey,
    type AccountPreferencesSection,
  } from '$lib/frameleaf/account-preferences';
  import { AccountPreferencesDraftStore } from '$lib/frameleaf/account-preferences-draft.svelte';
  import { AssetOrder, type UserPreferencesResponseDto, type UserPreferencesUpdateDto } from '@immich/sdk';
  import { untrack } from 'svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    /** The account's preferences as loaded; newer values passed later never replace an unsaved draft. */
    preferences: UserPreferencesResponseDto;
    accountName: string;
    /** False for a deleted account: the server only updates preferences of live accounts. */
    editable?: boolean;
    section?: AccountPreferencesSection;
    save: (update: UserPreferencesUpdateDto) => Promise<UserPreferencesResponseDto>;
    load: () => Promise<UserPreferencesResponseDto>;
    onSaved?: (preferences: UserPreferencesResponseDto) => void;
    onUpdated?: (preferences: UserPreferencesResponseDto) => void;
    /** Only offered on the administrator's own account. */
    onOpenPrivacy?: () => void;
    /**
     * False when the account detail's own outer tab bar (FL-76) already switches between
     * Features / Preferences / Notifications, so this editor's internal one would only repeat
     * it. `section` still drives which fieldset shows; the caller owns the tab the visible nav
     * reads as current.
     */
    showTabs?: boolean;
  };

  let {
    preferences,
    accountName,
    editable = true,
    section = $bindable('features'),
    save,
    load,
    onSaved,
    onUpdated,
    onOpenPrivacy,
    showTabs = true,
  }: Props = $props();

  const store = untrack(
    () =>
      new AccountPreferencesDraftStore(preferences, {
        role: 'admin',
        save: (update) => save(update),
        load: () => load(),
        onUpdated: (next) => onUpdated?.(next),
      }),
  );

  // Newer preferences for this account (for example after the account is edited elsewhere on the
  // page). An unsaved draft is never replaced; it is marked stale instead.
  $effect(() => {
    const latest = preferences;
    untrack(() => store.follow(latest));
  });

  const draft = $derived(store.draft);
  const dirty = $derived(store.dirty);

  // The size field shows GiB while the draft holds exact bytes. It keeps what was typed, so a
  // value that rounds to a whole number of bytes is never rewritten mid-entry; it only follows
  // the draft when the draft changes some other way (cancel, reset, save, load latest).
  let archiveGib = $state<number | null>(untrack(() => archiveSizeToGib(store.draft['download.archiveSize'])));
  $effect(() => {
    const bytes = store.draft['download.archiveSize'];
    untrack(() => {
      if (gibToArchiveSize(archiveGib) !== bytes) {
        archiveGib = archiveSizeToGib(bytes);
      }
    });
  });

  const featureCopy = $derived<Record<AccountFeatureId, { label: string; description: string }>>({
    folders: {
      label: $t('frameleaf_account_prefs_feature_folders'),
      description: $t('frameleaf_account_prefs_feature_folders_description'),
    },
    memories: {
      label: $t('frameleaf_account_prefs_feature_memories'),
      description: $t('frameleaf_account_prefs_feature_memories_description'),
    },
    people: {
      label: $t('frameleaf_account_prefs_feature_people'),
      description: $t('frameleaf_account_prefs_feature_people_description'),
    },
    sharedLinks: {
      label: $t('frameleaf_account_prefs_feature_shared_links'),
      description: $t('frameleaf_account_prefs_feature_shared_links_description'),
    },
    tags: {
      label: $t('frameleaf_account_prefs_feature_tags'),
      description: $t('frameleaf_account_prefs_feature_tags_description'),
    },
    ratings: {
      label: $t('frameleaf_account_prefs_feature_ratings'),
      description: $t('frameleaf_account_prefs_feature_ratings_description'),
    },
    cast: {
      label: $t('frameleaf_account_prefs_feature_cast'),
      description: $t('frameleaf_account_prefs_feature_cast_description'),
    },
  });

  const sectionLabel = $derived<Record<AccountPreferencesSection, string>>({
    features: $t('frameleaf_account_prefs_tab_features'),
    preferences: $t('frameleaf_account_prefs_tab_preferences'),
    notifications: $t('frameleaf_account_prefs_tab_notifications'),
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

  const noticeText = $derived(
    store.notice === 'saved'
      ? $t('frameleaf_account_prefs_notice_saved')
      : store.notice === 'defaults_restored'
        ? $t('frameleaf_account_prefs_notice_defaults')
        : store.notice === 'latest_loaded'
          ? $t('frameleaf_account_prefs_notice_latest')
          : '',
  );

  const change = <K extends AccountPreferenceKey>(key: K, value: (typeof draft)[K]) => store.set(key, value);
  const checked = (event: Event) => (event.currentTarget as HTMLInputElement).checked;
  const wholeNumber = (event: Event) => {
    const value = (event.currentTarget as HTMLInputElement).value;
    return value === '' ? null : Number(value);
  };

  const onsubmit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!editable || !dirty) {
      return;
    }
    const saved = await store.save();
    if (saved) {
      onSaved?.(saved);
    }
  };

  const loadLatest = () => store.loadLatest();
  const cancel = () => store.cancel();
  const resetPage = () => store.resetSection(section);

  // Leaving with unsaved changes: the template holds navigation until the draft is saved or
  // discarded. Closing or reloading the tab gets the browser's own warning.
  let pendingNavigation = $state<URL | null>(null);

  beforeNavigate(({ cancel: cancelNavigation, to, type }) => {
    if (type === 'leave' || !untrack(() => store.dirty) || !to) {
      return;
    }
    cancelNavigation();
    pendingNavigation = to.url;
  });

  const keepEditing = () => {
    pendingNavigation = null;
  };

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
    if (!dirty) {
      return;
    }
    addEventListener('beforeunload', warnBeforeUnload);
    return () => removeEventListener('beforeunload', warnBeforeUnload);
  });
</script>

{#snippet toggle(
  label: string,
  description: string | undefined,
  value: boolean,
  onchange: (value: boolean) => void,
  disabled = false,
)}
  <label class="ap-toggle">
    <input
      type="checkbox"
      aria-label={label}
      checked={value}
      {disabled}
      onchange={(event) => onchange(checked(event))}
    />
    <span>
      <strong>{label}</strong>
      {#if description}
        <small>{description}</small>
      {/if}
    </span>
  </label>
{/snippet}

<div class="account-preferences-host">
  {#if pendingNavigation}
    <div class="ap-leave" role="alert">
      <span>{$t('frameleaf_account_prefs_leave_notice', { values: { name: accountName } })}</span>
      <button type="button" onclick={keepEditing}>{$t('frameleaf_account_prefs_keep_editing')}</button>
      <button type="button" onclick={discardAndContinue}>{$t('frameleaf_account_prefs_discard_continue')}</button>
    </div>
  {/if}

  {#if showTabs}
    <nav class="ap-tabs" aria-label={$t('frameleaf_account_prefs_tabs_label')}>
      {#each ACCOUNT_PREFERENCES_SECTIONS as name (name)}
        <button type="button" aria-current={section === name ? 'page' : undefined} onclick={() => (section = name)}>
          {sectionLabel[name]}
        </button>
      {/each}
    </nav>
  {/if}

  <form
    class="account-preferences"
    aria-label={$t('frameleaf_account_prefs_form_label', {
      values: { name: accountName, section: sectionLabel[section] },
    })}
    {onsubmit}
  >
    {#if store.stale}
      <div class="ap-conflict" role="status">
        <span>{$t('frameleaf_account_prefs_conflict')}</span>
        <button type="button" disabled={store.loading} onclick={loadLatest}>
          {$t('frameleaf_account_prefs_load_latest')}
        </button>
      </div>
    {/if}

    <fieldset class="ap-controls" disabled={!editable}>
      {#if section === 'features'}
        <p class="ap-context">{$t('frameleaf_account_prefs_features_context')}</p>
        <div class="ap-feature-head" aria-hidden="true">
          <span>{$t('frameleaf_account_prefs_column_feature')}</span>
          <span>{$t('frameleaf_account_prefs_column_use_tool')}</span>
          <span>{$t('frameleaf_account_prefs_column_navigation')}</span>
        </div>
        <div class="ap-feature-list">
          {#each ACCOUNT_FEATURES as feature (feature.id)}
            {@const copy = featureCopy[feature.id]}
            {@const enabled = draft[feature.enabledKey] as boolean}
            {@const castLocked = feature.id === 'cast' && draft['cast.adminDisabled']}
            <div class="ap-feature">
              <div class="ap-feature-name">
                <strong>{copy.label}</strong>
                <small>{copy.description}</small>
              </div>
              <label class="ap-feature-check">
                <input
                  type="checkbox"
                  aria-label={copy.label}
                  checked={enabled}
                  disabled={castLocked}
                  onchange={(event) => change(feature.enabledKey, checked(event))}
                />
                <span>{$t('frameleaf_account_prefs_column_use_tool')}</span>
              </label>
              {#if feature.sidebarKey}
                {@const sidebarKey = feature.sidebarKey}
                <label class="ap-feature-check">
                  <input
                    type="checkbox"
                    aria-label={$t('frameleaf_account_prefs_show_in_navigation', {
                      values: { feature: copy.label.toLowerCase() },
                    })}
                    checked={draft[sidebarKey] as boolean}
                    disabled={!enabled}
                    onchange={(event) => change(sidebarKey, checked(event))}
                  />
                  <span>{$t('frameleaf_account_prefs_column_navigation')}</span>
                </label>
              {:else}
                <span class="ap-not-applicable" aria-label={$t('frameleaf_account_prefs_no_navigation')}>—</span>
              {/if}
              {#if feature.id === 'people' && enabled}
                <div class="ap-feature-detail">
                  <label class="ap-field">
                    <span>{$t('frameleaf_account_prefs_minimum_faces')}</span>
                    <input
                      type="number"
                      min="1"
                      step="1"
                      required
                      aria-describedby="ap-minimum-faces-help"
                      value={draft['people.minimumFaces'] ?? ''}
                      oninput={(event) => change('people.minimumFaces', wholeNumber(event))}
                    />
                    <small id="ap-minimum-faces-help">{$t('frameleaf_account_prefs_minimum_faces_help')}</small>
                  </label>
                </div>
              {/if}
              {#if feature.id === 'memories'}
                <div class="ap-feature-detail">
                  <label class="ap-field">
                    <span>{$t('frameleaf_account_prefs_memory_duration')}</span>
                    <input
                      type="number"
                      min="1"
                      step="1"
                      required
                      aria-describedby="ap-memory-duration-help"
                      value={draft['memories.duration'] ?? ''}
                      oninput={(event) => change('memories.duration', wholeNumber(event))}
                    />
                    <small id="ap-memory-duration-help">{$t('frameleaf_account_prefs_memory_duration_help')}</small>
                  </label>
                </div>
              {/if}
              {#if feature.id === 'cast'}
                <!-- FL-77: the administrator's casting decision, enforced by the server. -->
                <div class="ap-feature-detail">
                  {@render toggle(
                    $t('frameleaf_users_cast_allow'),
                    $t('frameleaf_users_cast_allow_description'),
                    !draft['cast.adminDisabled'],
                    (value) => change('cast.adminDisabled', !value),
                  )}
                </div>
              {/if}
            </div>
          {/each}
        </div>
        <div class="ap-standalone">
          {@render toggle(
            $t('frameleaf_account_prefs_recently_added_navigation'),
            undefined,
            draft['recentlyAdded.sidebarWeb'],
            (value) => change('recentlyAdded.sidebarWeb', value),
          )}
        </div>
      {:else if section === 'preferences'}
        <div class="ap-fields">
          <label class="ap-field">
            <span>{$t('frameleaf_account_prefs_album_order')}</span>
            <select
              value={draft['albums.defaultAssetOrder']}
              onchange={(event) =>
                change('albums.defaultAssetOrder', (event.currentTarget as HTMLSelectElement).value as AssetOrder)}
            >
              <option value={AssetOrder.Desc}>{$t('newest_first')}</option>
              <option value={AssetOrder.Asc}>{$t('oldest_first')}</option>
            </select>
          </label>
          <label class="ap-field">
            <span>{$t('frameleaf_account_prefs_archive_size')}</span>
            <input
              type="number"
              min={1 / 1024 ** 3}
              step="any"
              required
              aria-describedby="ap-archive-size-help"
              bind:value={archiveGib}
              oninput={(event) => {
                const value = (event.currentTarget as HTMLInputElement).value;
                change('download.archiveSize', value === '' ? null : gibToArchiveSize(Number(value)));
              }}
            />
            <small id="ap-archive-size-help">{$t('frameleaf_account_prefs_archive_size_help')}</small>
          </label>
        </div>
        {@render toggle(
          $t('frameleaf_account_prefs_motion_videos'),
          $t('frameleaf_account_prefs_motion_videos_description'),
          draft['download.includeEmbeddedVideos'],
          (value) => change('download.includeEmbeddedVideos', value),
        )}
        <div class="ap-group">
          <h3>{$t('frameleaf_account_prefs_supporter_title')}</h3>
          {@render toggle(
            $t('frameleaf_account_prefs_supporter_badge'),
            $t('frameleaf_account_prefs_supporter_badge_description'),
            draft['purchase.showSupportBadge'],
            (value) => change('purchase.showSupportBadge', value),
          )}
          <label class="ap-field">
            <span>{$t('frameleaf_account_prefs_reminder_date')}</span>
            <input
              type="date"
              aria-describedby="ap-reminder-date-help"
              value={reminderDateInput(draft['purchase.hideBuyButtonUntil'])}
              onchange={(event) =>
                change(
                  'purchase.hideBuyButtonUntil',
                  reminderDateFromInput((event.currentTarget as HTMLInputElement).value),
                )}
            />
            <small id="ap-reminder-date-help">{$t('frameleaf_account_prefs_reminder_date_help')}</small>
          </label>
        </div>
      {:else}
        <div class="ap-notifications">
          {@render toggle(
            $t('frameleaf_account_prefs_email'),
            $t('frameleaf_account_prefs_email_description'),
            draft['emailNotifications.enabled'],
            (value) => store.setEmailNotifications(value),
          )}
          <div class="ap-notification-children">
            {@render toggle(
              $t('frameleaf_account_prefs_album_invites'),
              $t('frameleaf_account_prefs_album_invites_description'),
              draft['emailNotifications.albumInvite'],
              (value) => change('emailNotifications.albumInvite', value),
              !draft['emailNotifications.enabled'],
            )}
            {@render toggle(
              $t('frameleaf_account_prefs_album_updates'),
              $t('frameleaf_account_prefs_album_updates_description'),
              draft['emailNotifications.albumUpdate'],
              (value) => change('emailNotifications.albumUpdate', value),
              !draft['emailNotifications.enabled'],
            )}
          </div>
        </div>
      {/if}
    </fieldset>

    {#if section === 'preferences'}
      <div class="ap-private">
        <div>
          <h3>{$t('frameleaf_account_prefs_locked_title')}</h3>
          <p>{$t('frameleaf_account_prefs_locked_description')}</p>
        </div>
        {#if onOpenPrivacy}
          <button type="button" onclick={onOpenPrivacy}>{$t('frameleaf_account_prefs_open_locked')}</button>
        {/if}
      </div>
    {/if}

    {#if errorText}
      <p class="ap-error" role="alert">{errorText}</p>
    {/if}
    {#if noticeText}
      <p class="ap-notice" role="status">{noticeText}</p>
    {/if}

    <footer class="ap-save-bar">
      <span>
        {#if !editable}
          {$t('frameleaf_account_prefs_status_restore')}
        {:else if dirty}
          {$t('frameleaf_account_prefs_status_dirty')}
        {:else}
          {$t('frameleaf_account_prefs_status_clean')}
        {/if}
      </span>
      <div>
        <button type="button" disabled={!editable} onclick={resetPage}>
          {$t('frameleaf_account_prefs_reset_page')}
        </button>
        <button type="button" disabled={!dirty} onclick={cancel}>{$t('frameleaf_account_prefs_cancel')}</button>
        <button class="ap-primary" type="submit" disabled={!dirty || !editable || store.saving}>
          {$t('frameleaf_account_prefs_save')}
        </button>
      </div>
    </footer>
  </form>
</div>

<style>
  .account-preferences-host {
    min-width: 0;
    container-type: inline-size;
  }
  .ap-tabs {
    display: flex;
    gap: 20px;
    border-bottom: 1px solid var(--fl-border);
    margin: 0 0 22px;
    overflow: auto;
  }
  .ap-tabs button {
    border: 0;
    border-bottom: 2px solid transparent;
    color: var(--fl-muted);
    background: none;
    padding: 10px 0;
    font: inherit;
    font-size: 12px;
    text-transform: capitalize;
    cursor: pointer;
    white-space: nowrap;
  }
  .ap-tabs button[aria-current] {
    border-bottom-color: var(--fl-accent);
    color: var(--fl-text);
  }
  .ap-leave {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    background: var(--fl-raised);
    border-left: 2px solid var(--fl-muted);
    padding: 12px 14px;
    margin-bottom: 18px;
    font-size: 12px;
    line-height: 1.6;
    color: var(--fl-muted);
  }
  .ap-leave span {
    flex: 1 1 250px;
  }
  .ap-leave button,
  .account-preferences button {
    font: inherit;
    font-size: 12px;
    line-height: 1.4;
    min-height: 34px;
    padding: 7px 12px;
    background: var(--fl-raised);
    color: var(--fl-text);
    border: 1px solid var(--fl-border);
    border-radius: 5px;
    cursor: pointer;
  }
  .ap-leave button:hover,
  .account-preferences button:hover {
    border-color: var(--fl-muted);
  }
  .account-preferences {
    color: var(--fl-text);
    min-width: 0;
    font-size: 12px;
  }
  .ap-controls {
    margin: 0;
    padding: 0;
    border: 0;
    min-width: 0;
  }
  .ap-context {
    margin: 0 0 18px;
    color: var(--fl-muted);
    line-height: 1.6;
    max-width: 70ch;
  }
  .ap-feature-head,
  .ap-feature {
    display: grid;
    grid-template-columns: minmax(160px, 1fr) 88px 160px;
    gap: 10px 16px;
    align-items: center;
  }
  .ap-feature-head {
    color: var(--fl-muted);
    font-size: 10px;
    padding: 0 0 10px;
  }
  .ap-feature-head > :not(:first-child) {
    text-align: center;
  }
  .ap-feature {
    padding: 15px 0;
    border-top: 1px solid var(--fl-border);
  }
  .ap-feature-name strong {
    display: block;
    font-weight: 580;
    font-size: 13px;
  }
  .account-preferences small {
    display: block;
    color: var(--fl-muted);
    font-size: 11px;
    line-height: 1.6;
    margin-top: 4px;
  }
  .ap-feature-check {
    display: flex;
    flex-direction: row;
    justify-content: center;
    align-items: center;
    min-height: 30px;
    gap: 8px;
    cursor: pointer;
  }
  .account-preferences input[type='checkbox'] {
    width: 16px;
    height: 16px;
    margin: 0;
    flex: 0 0 auto;
    accent-color: var(--fl-accent);
  }
  .ap-feature-check > span {
    display: none;
  }
  .ap-not-applicable {
    text-align: center;
    color: var(--fl-muted);
  }
  .ap-feature-detail {
    grid-column: 1 / -1;
    padding-top: 3px;
  }
  .ap-feature-detail .ap-field {
    grid-template-columns: minmax(150px, 1fr) 90px;
    align-items: center;
    max-width: 520px;
  }
  .ap-feature-detail .ap-field small {
    grid-column: 1 / -1;
    margin: 0;
  }
  .ap-standalone {
    border-top: 1px solid var(--fl-border);
    padding-top: 18px;
  }
  .ap-fields {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 24px;
    margin-bottom: 24px;
  }
  .ap-field {
    display: grid;
    gap: 7px;
    min-width: 0;
  }
  .ap-field > span {
    font-weight: 550;
  }
  .ap-field input,
  .ap-field select {
    min-width: 0;
    width: 100%;
    box-sizing: border-box;
    min-height: 36px;
    font: inherit;
    background: var(--fl-canvas);
    color: var(--fl-text);
    border: 1px solid var(--fl-border);
    border-radius: 5px;
    padding: 7px 10px;
  }
  .ap-toggle {
    display: flex;
    flex-direction: row;
    gap: 12px;
    align-items: start;
    padding: 10px 0;
    cursor: pointer;
  }
  .ap-toggle input {
    margin-top: 2px;
  }
  .ap-toggle strong {
    font-weight: 550;
  }
  .ap-group {
    margin-top: 20px;
    border-top: 1px solid var(--fl-border);
    padding-top: 18px;
  }
  .account-preferences h3 {
    margin: 0 0 10px;
    font-size: 12px;
    font-weight: 600;
  }
  .ap-group .ap-field {
    max-width: 350px;
    margin-top: 12px;
  }
  .ap-notification-children {
    margin: 10px 0 0 7px;
    border-left: 1px solid var(--fl-border);
    padding: 0 0 0 20px;
  }
  .ap-private {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 20px;
    border-top: 1px solid var(--fl-border);
    padding-top: 20px;
    margin-top: 24px;
  }
  .ap-private p {
    margin: 0;
    color: var(--fl-muted);
    line-height: 1.6;
  }
  .ap-private h3 {
    margin-bottom: 4px;
  }
  .ap-save-bar {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 12px;
    align-items: center;
    border-top: 1px solid var(--fl-border);
    margin-top: 24px;
    padding-top: 16px;
  }
  .ap-save-bar > span {
    color: var(--fl-muted);
    font-size: 11px;
  }
  .ap-save-bar > div {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .account-preferences button.ap-primary {
    background: var(--fl-accent);
    color: var(--fl-canvas);
    border-color: transparent;
    font-weight: 600;
  }
  .account-preferences :disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .account-preferences fieldset:disabled {
    opacity: 0.7;
  }
  .account-preferences :focus-visible,
  .ap-tabs button:focus-visible,
  .ap-leave button:focus-visible {
    outline: 2px solid var(--fl-accent);
    outline-offset: 3px;
  }
  .ap-error {
    color: var(--fl-danger, #d95d53);
    line-height: 1.6;
  }
  .ap-notice {
    color: var(--fl-muted);
    line-height: 1.6;
  }
  .ap-conflict {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    background: var(--fl-raised);
    border-left: 2px solid var(--fl-accent);
    padding: 12px;
    margin-bottom: 18px;
    line-height: 1.6;
  }
  .ap-conflict span {
    flex: 1 1 250px;
  }
  @container (max-width: 560px) {
    .ap-feature-head {
      display: none;
    }
    .ap-feature {
      grid-template-columns: 1fr 1fr;
      gap: 8px 12px;
    }
    .ap-feature-name {
      grid-column: 1 / -1;
    }
    .ap-feature-check {
      justify-content: start;
      min-height: 40px;
      font-size: 11px;
    }
    .ap-feature-check > span {
      display: inline;
    }
    .ap-not-applicable {
      display: none;
    }
    .ap-fields {
      grid-template-columns: 1fr;
      gap: 18px;
    }
    .ap-private {
      align-items: start;
      flex-direction: column;
      gap: 12px;
    }
    .ap-feature-detail .ap-field {
      grid-template-columns: minmax(0, 1fr) 80px;
    }
    .ap-save-bar > div {
      flex: 1 1 100%;
    }
    .account-preferences button,
    .ap-field input,
    .ap-field select {
      min-height: 40px;
    }
  }
</style>
