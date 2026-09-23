<script lang="ts">
  /**
   * The account detail's outer tab bar (FL-76): Overview / Features / Preferences /
   * Notifications / Libraries / Security / Activity, in the order and under the labels of the
   * `resource-tabs` nav in the design template's account detail panel
   * (`design/frameleaf/template/src/AccountsLibraries.jsx`, `accounts-libraries.css`). The
   * caller wraps this in the page's own `Theme` + `Pane`, the same way it already wraps the
   * components this composes.
   *
   * Features, Preferences and Notifications are one tab group owned by `AccountPreferencesEditor`
   * (FL-77); this bar drives which of its three sections is current and asks it not to draw its
   * own, now-redundant nav (`showTabs={false}`).
   *
   * Two honest differences from the prototype's simulated store:
   *
   * - The prototype's Libraries tab lists a synthetic "managed uploads" library per account
   *   alongside any external ones. Production libraries (`LibraryResponseDto`) are always
   *   import-path (external) libraries; an account's own uploaded photos are never a `Library`
   *   row, so only external libraries are listed here.
   * - The prototype's Activity tab is a per-account admin audit log the server does not keep.
   *   The account's real, already-authorized activity signal is its upload calendar
   *   (`getUserCalendarHeatmapAdmin`), which used to sit outside every tab; it moves here
   *   instead, fetched once the first time this tab is shown.
   */
  import AccountLifecyclePanel from '$lib/components/frameleaf/AccountLifecyclePanel.svelte';
  import AccountPreferencesEditor from '$lib/components/frameleaf/AccountPreferencesEditor.svelte';
  import AccountSecurityPanel from '$lib/components/frameleaf/AccountSecurityPanel.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import CalendarHeatmap from '$lib/components/CalendarHeatmap.svelte';
  import Skeleton from '$lib/elements/Skeleton.svelte';
  import { getHeatmapRange } from '$lib';
  import type { AccountPreferencesSection } from '$lib/frameleaf/account-preferences';
  import { Route } from '$lib/route';
  import { locale } from '$lib/stores/preferences.store';
  import { createDateFormatter, findLocale } from '$lib/utils';
  import {
    CalendarHeatmapType,
    getUserCalendarHeatmapAdmin,
    type AssetStatsResponseDto,
    type CalendarHeatmapResponseDto,
    type LibraryResponseDto,
    type SessionResponseDto,
    type UserAdminResponseDto,
    type UserPreferencesResponseDto,
    type UserPreferencesUpdateDto,
  } from '@immich/sdk';
  import { getByteUnitString } from '@immich/ui';
  import { goto } from '$app/navigation';
  import { t } from 'svelte-i18n';

  type Tab = 'overview' | 'features' | 'preferences' | 'notifications' | 'libraries' | 'security' | 'activity';
  const TABS: Tab[] = ['overview', 'features', 'preferences', 'notifications', 'libraries', 'security', 'activity'];
  const PREFERENCE_TABS = new Set<Tab>(['features', 'preferences', 'notifications']);

  type Props = {
    user: UserAdminResponseDto;
    preferences: UserPreferencesResponseDto;
    statistics: AssetStatsResponseDto;
    sessions: SessionResponseDto[];
    /** Every library in the system; filtered here to the ones this account owns. */
    libraries: LibraryResponseDto[];
    /** False for a deleted account: the server only updates preferences of live accounts. */
    preferencesEditable: boolean;
    savePreferences: (update: UserPreferencesUpdateDto) => Promise<UserPreferencesResponseDto>;
    loadPreferences: () => Promise<UserPreferencesResponseDto>;
    onPreferencesSaved?: (preferences: UserPreferencesResponseDto) => void;
    /** Only offered on the administrator's own account. */
    onOpenPrivacy?: () => void;
  };

  let {
    user,
    preferences,
    statistics,
    sessions,
    libraries,
    preferencesEditable,
    savePreferences,
    loadPreferences,
    onPreferencesSaved,
    onOpenPrivacy,
  }: Props = $props();

  let tab = $state<Tab>('overview');
  let preferenceSection = $state<AccountPreferencesSection>('features');

  // The Activity tab's upload calendar is fetched once, the first time it is shown.
  let heatmapPromise = $state<Promise<CalendarHeatmapResponseDto> | null>(null);

  const selectTab = (name: Tab) => {
    tab = name;
    if (PREFERENCE_TABS.has(name)) {
      preferenceSection = name as AccountPreferencesSection;
    }
    if (name === 'activity' && !heatmapPromise) {
      heatmapPromise = getUserCalendarHeatmapAdmin({
        ...getHeatmapRange(),
        id: user.id,
        $type: CalendarHeatmapType.Upload,
      });
    }
  };

  const tabLabel = $derived<Record<Tab, string>>({
    overview: $t('frameleaf_account_detail_tab_overview'),
    features: $t('frameleaf_account_prefs_tab_features'),
    preferences: $t('frameleaf_account_prefs_tab_preferences'),
    notifications: $t('frameleaf_account_prefs_tab_notifications'),
    libraries: $t('frameleaf_account_detail_tab_libraries'),
    security: $t('frameleaf_account_detail_tab_security'),
    activity: $t('frameleaf_account_detail_tab_activity'),
  });

  const usedBytes = $derived(user.quotaUsageInBytes ?? 0);
  const availableBytes = $derived(user.quotaSizeInBytes);
  const hasQuota = $derived(availableBytes !== null && availableBytes !== undefined && availableBytes >= 0);

  const editedLocale = $derived(findLocale($locale).code);
  const createdAt = $derived(createDateFormatter(editedLocale).formatDateTime(new Date(user.createdAt)));

  const ownedLibraries = $derived(libraries.filter((library) => library.ownerId === user.id));
</script>

<nav class="resource-tabs" aria-label={$t('frameleaf_account_detail_tabs_nav_label')}>
  {#each TABS as name (name)}
    <button type="button" aria-current={tab === name ? 'page' : undefined} onclick={() => selectTab(name)}>
      {tabLabel[name]}
    </button>
  {/each}
</nav>

{#if tab === 'overview'}
  <dl class="resource-stats">
    <div>
      <dt>{$t('photos')}</dt>
      <dd>{statistics.images.toLocaleString($locale)}</dd>
    </div>
    <div>
      <dt>{$t('videos')}</dt>
      <dd>{statistics.videos.toLocaleString($locale)}</dd>
    </div>
    <div>
      <dt>{$t('storage')}</dt>
      <dd>{getByteUnitString(usedBytes, $locale, 1)}</dd>
    </div>
  </dl>

  <div class="resource-two-column">
    <div>
      <h3>{$t('storage_quota')}</h3>
      {#if hasQuota}
        {@const total = Math.max(1, availableBytes ?? 0)}
        <div class="resource-quota">
          <span>
            {getByteUnitString(usedBytes, $locale, 1)}
            <small>/ {getByteUnitString(availableBytes ?? 0, $locale, 1)}</small>
          </span>
          <progress
            max={total}
            value={Math.min(usedBytes, total)}
            aria-label={$t('storage_usage', {
              values: { used: getByteUnitString(usedBytes, $locale, 1), available: getByteUnitString(availableBytes ?? 0, $locale, 1) },
            })}
          />
        </div>
      {:else}
        <p class="unlimited">{$t('unlimited')}</p>
      {/if}
      <p class="resource-footnote">{$t('frameleaf_account_detail_quota_footnote')}</p>
      <div class="resource-actions">
        <Button onclick={() => selectTab('features')}>{$t('frameleaf_account_detail_feature_settings')}</Button>
        <Button onclick={() => selectTab('security')}>{$t('frameleaf_account_detail_security_settings')}</Button>
      </div>
    </div>
    <dl class="resource-facts">
      <dt>{$t('role')}</dt>
      <dd>{user.isAdmin ? $t('frameleaf_users_role_admin') : $t('frameleaf_users_role_user')}</dd>
      <dt>{$t('storage_label')}</dt>
      <dd>{user.storageLabel || $t('frameleaf_users_storage_label_automatic')}</dd>
      <dt>{$t('created_at')}</dt>
      <dd>{createdAt}</dd>
      <dt>{$t('frameleaf_account_detail_account_id')}</dt>
      <dd><code>{user.id}</code></dd>
    </dl>
  </div>

  <AccountLifecyclePanel {user} />
{:else if PREFERENCE_TABS.has(tab)}
  <AccountPreferencesEditor
    {preferences}
    accountName={user.name}
    editable={preferencesEditable}
    bind:section={preferenceSection}
    save={savePreferences}
    load={loadPreferences}
    {onOpenPrivacy}
    onSaved={onPreferencesSaved}
    showTabs={false}
  />
{:else if tab === 'libraries'}
  <div class="resource-list">
    {#each ownedLibraries as library (library.id)}
      <div>
        <div>
          <strong>{library.name}</strong>
          <small>
            {$t('frameleaf_account_detail_library_folders', { values: { count: library.importPaths.length } })} ·
            {$t('frameleaf_account_detail_library_items', { values: { count: library.assetCount } })}
          </small>
        </div>
        <Button onclick={() => goto(Route.viewLibrary(library))}>
          {$t('frameleaf_account_detail_library_open')}
        </Button>
      </div>
    {:else}
      <p class="resource-empty">{$t('frameleaf_account_detail_libraries_empty')}</p>
    {/each}
  </div>
{:else if tab === 'security'}
  <AccountSecurityPanel {user} {sessions} />
{:else if tab === 'activity' && heatmapPromise}
  {#await heatmapPromise}
    <Skeleton height={80} class="mt-2 rounded-lg" />
  {:then data}
    <CalendarHeatmap
      {data}
      itemLabel={(item) => $t('upload_day_count', { values: item })}
      totalLabel={(count) => $t('uploads_count', { values: { count } })}
    />
  {/await}
{/if}

<style>
  .resource-tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 1.25rem;
    margin: 0 0 1.375rem;
    border-bottom: 1px solid var(--fl-border);
    overflow: auto;
  }
  .resource-tabs button {
    padding: 0.625rem 0;
    border: 0;
    border-bottom: 2px solid transparent;
    color: var(--fl-muted);
    background: none;
    font: inherit;
    font-size: 0.75rem;
    text-transform: capitalize;
    white-space: nowrap;
    cursor: pointer;
  }
  .resource-tabs button[aria-current] {
    border-bottom-color: var(--fl-accent);
    color: var(--fl-text);
  }
  .resource-stats {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 1rem;
    margin: 0 0 0.625rem;
  }
  .resource-stats div {
    padding-left: 1.125rem;
    border-left: 1px solid var(--fl-border);
  }
  .resource-stats div:first-child {
    padding-left: 0;
    border: 0;
  }
  .resource-stats dt {
    margin-bottom: 0.5rem;
    color: var(--fl-muted);
    font-size: 0.625rem;
  }
  .resource-stats dd {
    margin: 0;
    font-size: 1.375rem;
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.025em;
    white-space: nowrap;
  }
  .resource-two-column {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 2rem;
    margin: 1.75rem 0;
  }
  .resource-two-column h3 {
    margin: 0 0 0.75rem;
    font-size: var(--fl-font-small);
    font-weight: 580;
  }
  .resource-quota {
    display: grid;
    gap: 0.25rem;
    min-width: 8.75rem;
    font-size: 0.75rem;
  }
  .resource-quota small {
    color: var(--fl-muted);
    font-size: 0.625rem;
  }
  .resource-quota progress {
    display: block;
    width: 100%;
    max-width: 17.5rem;
    height: 0.25rem;
    overflow: hidden;
    background: var(--fl-border);
    border: 0;
    border-radius: 0.25rem;
    accent-color: var(--fl-accent);
  }
  .unlimited {
    margin: 0;
    color: var(--fl-text);
    font-size: 0.75rem;
  }
  .resource-footnote {
    margin: 0.75rem 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.7;
  }
  .resource-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .resource-facts {
    display: grid;
    grid-template-columns: auto 1fr;
    align-content: start;
    gap: 0.75rem 1.5rem;
    font-size: 0.75rem;
  }
  .resource-facts dt {
    color: var(--fl-muted);
  }
  .resource-facts dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .resource-list {
    display: grid;
  }
  .resource-list > div {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1.5rem;
    padding: 1rem 0;
    border-bottom: 1px solid var(--fl-border);
    font-size: 0.75rem;
  }
  .resource-list > div:last-child {
    border-bottom: 0;
  }
  .resource-list > div > div:first-child {
    flex: 1;
    min-width: 0;
  }
  .resource-list strong {
    font-weight: 550;
  }
  .resource-list small {
    display: block;
    margin-top: 0.25rem;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .resource-empty {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  @media (max-width: 640px) {
    .resource-stats {
      grid-template-columns: 1fr 1fr;
      row-gap: 1.5rem;
    }
    .resource-two-column {
      grid-template-columns: 1fr;
      gap: 0.75rem;
    }
  }
</style>
