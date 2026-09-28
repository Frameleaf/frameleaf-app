<script lang="ts">
  /**
   * One library's detail panel (FL-78), the libraries half of the design template's
   * `resource-detail` in `design/frameleaf/template/src/AccountsLibraries.jsx`: Overview (snapshot,
   * facts, the library scan and the removal zone), Folders and Activity.
   *
   * The scan block reads the library's latest durable scan: its real progress, why it failed or
   * stopped, and Cancel while it runs. Pause and resume live in the notifications panel with every
   * other running job. Managed uploads have no scan and no removal: they belong to their account.
   */
  import '$lib/frameleaf/libraries.css';
  import { describeAdminEvent, formatHistoryDate } from '$lib/frameleaf/account-history';
  import { canScanLibrary, isScanActive, scanMessage, type LibraryRow } from '$lib/frameleaf/libraries';
  import { locale } from '$lib/stores/preferences.store';
  import { getUserHistoryAdmin, type UserAdminHistoryEventResponseDto } from '@immich/sdk';
  import { getByteUnitString } from '@immich/ui';
  import { t } from 'svelte-i18n';

  type Tab = 'overview' | 'folders' | 'activity';
  const TABS: Tab[] = ['overview', 'folders', 'activity'];

  type Props = {
    row: LibraryRow;
    /** When the statistics on this page were read, for the snapshot footnote. */
    snapshotAt: Date;
    busy?: boolean;
    onEdit: () => void;
    onRemove: () => void;
    onScan: () => void;
    onCancelScan: () => void;
    onAnalytics: () => void;
    onClose: () => void;
  };

  let { row, snapshotAt, busy = false, onEdit, onRemove, onScan, onCancelScan, onAnalytics, onClose }: Props = $props();

  let tab = $state<Tab>('overview');
  let history = $state<UserAdminHistoryEventResponseDto[]>([]);
  let historyStatus = $state<'idle' | 'loading' | 'loaded' | 'error'>('idle');

  const external = $derived(row.kind === 'external');
  const active = $derived(row.lifecycle === 'active');
  const scanning = $derived(isScanActive(row.scan));
  const message = $derived(scanMessage(row.scan));

  const bytes = (value: number) => getByteUnitString(value, $locale, 1);
  const when = (value: string | Date | null) =>
    value ? formatHistoryDate(new Date(value).toISOString(), $locale) : $t('frameleaf_libraries_not_yet');

  const loadHistory = async () => {
    historyStatus = 'loading';
    try {
      const page = await getUserHistoryAdmin({ id: row.ownerId, take: 100 });
      // an external library's own entries; for managed uploads, the account's entries
      history = page.events.filter((event) => (external ? event.libraryId === row.id : !event.libraryId));
      historyStatus = 'loaded';
    } catch {
      historyStatus = 'error';
    }
  };

  const selectTab = (next: Tab) => {
    tab = next;
    if (next === 'activity') {
      void loadHistory();
    }
  };

  const tabLabel: Record<Tab, string> = $derived({
    overview: $t('frameleaf_libraries_tab_overview'),
    folders: $t('frameleaf_libraries_tab_folders'),
    activity: $t('frameleaf_libraries_tab_activity'),
  });
</script>

<section class="resource-detail" aria-label={$t('frameleaf_libraries_detail_label', { values: { name: row.name } })}>
  <header>
    <div class="resource-profile">
      <div>
        <h2>{row.name}</h2>
        <p>
          {row.ownerName} · {external ? $t('frameleaf_libraries_kind_external') : $t('frameleaf_libraries_kind_upload')}
        </p>
      </div>
    </div>
    <div class="resource-actions">
      <button type="button" class="resource-button" onclick={onAnalytics}>
        {$t('frameleaf_libraries_view_analytics')}
      </button>
      {#if active && external}
        <button type="button" class="resource-button" onclick={onEdit}>{$t('frameleaf_libraries_edit')}</button>
      {/if}
      <button
        type="button"
        class="resource-button"
        aria-label={$t('frameleaf_libraries_close_details')}
        onclick={onClose}
      >
        ×
      </button>
    </div>
  </header>

  <nav class="resource-tabs" aria-label={$t('frameleaf_libraries_tabs_label')}>
    {#each TABS as name (name)}
      <button type="button" aria-current={tab === name ? 'page' : undefined} onclick={() => selectTab(name)}>
        {tabLabel[name]}
      </button>
    {/each}
  </nav>

  {#if tab === 'overview'}
    <dl class="resource-stats">
      <div>
        <dt>{$t('frameleaf_libraries_stat_photos')}</dt>
        <dd>{(row.stats?.photos ?? 0).toLocaleString($locale)}</dd>
      </div>
      <div>
        <dt>{$t('frameleaf_libraries_stat_videos')}</dt>
        <dd>{(row.stats?.videos ?? 0).toLocaleString($locale)}</dd>
      </div>
      <div>
        <dt>{$t('frameleaf_libraries_stat_logical')}</dt>
        <dd>{bytes(row.stats?.logical ?? 0)}</dd>
      </div>
      <div>
        <dt>{$t('frameleaf_libraries_stat_physical')}</dt>
        <dd>{bytes(row.stats?.physical ?? 0)}</dd>
      </div>
    </dl>
    <p class="resource-footnote">
      {$t('frameleaf_libraries_snapshot_footnote', { values: { date: when(snapshotAt) } })}
    </p>

    <dl class="resource-facts">
      <dt>{$t('frameleaf_libraries_fact_owner')}</dt>
      <dd>{$t('frameleaf_libraries_fact_owner_fixed', { values: { name: row.ownerName } })}</dd>
      <dt>{$t('frameleaf_libraries_fact_source')}</dt>
      <dd>{external ? $t('frameleaf_libraries_source_external') : $t('frameleaf_libraries_source_upload')}</dd>
      <dt>{$t('frameleaf_libraries_fact_last_scan')}</dt>
      <dd>{when(row.refreshedAt)}</dd>
    </dl>

    {#if external && active}
      <div class="resource-scan">
        <div>
          <h3>{$t('frameleaf_libraries_scan_title')}</h3>
          <p role="status" data-testid="library-scan-message">{$t(message.key, { values: message.values })}</p>
        </div>
        {#if scanning && row.scan}
          <progress max={100} value={row.scan.progress} aria-label={$t('frameleaf_libraries_scan_progress')}></progress>
          <button type="button" class="resource-button" disabled={busy} onclick={onCancelScan}>
            {$t('frameleaf_libraries_scan_cancel')}
          </button>
        {:else}
          <button type="button" class="resource-button" disabled={busy || !canScanLibrary(row)} onclick={onScan}>
            {$t('frameleaf_libraries_scan_start')}
          </button>
        {/if}
      </div>
    {/if}

    <div class="resource-danger-zone">
      {#if external && active}
        <p>{$t('frameleaf_libraries_danger_external')}</p>
        <button type="button" class="resource-button danger" onclick={onRemove}>
          {$t('frameleaf_libraries_remove')}
        </button>
      {:else if external}
        <p>{$t('frameleaf_libraries_danger_removing')}</p>
      {:else}
        <p>{$t('frameleaf_libraries_danger_upload')}</p>
      {/if}
    </div>
  {:else if tab === 'folders'}
    {#if !external}
      <p>{$t('frameleaf_libraries_folders_upload')}</p>
    {:else}
      <div class="resource-two-column">
        <div>
          <h3>{$t('frameleaf_libraries_folders_import')}</h3>
          {#each row.importPaths as path (path)}
            <p class="resource-path"><code>{path}</code></p>
          {:else}
            <p>{$t('frameleaf_libraries_folders_none')}</p>
          {/each}
        </div>
        <div>
          <h3>{$t('frameleaf_libraries_folders_exclusions')}</h3>
          {#each row.exclusionPatterns as pattern (pattern)}
            <p class="resource-path"><code>{pattern}</code></p>
          {:else}
            <p>{$t('frameleaf_libraries_exclusions_none')}</p>
          {/each}
        </div>
      </div>
    {/if}
  {:else if tab === 'activity'}
    {#if historyStatus === 'loading'}
      <p class="resource-empty" role="status">{$t('loading')}</p>
    {:else if historyStatus === 'error'}
      <p class="resource-error" role="alert">{$t('frameleaf_account_history_error')}</p>
    {:else if history.length > 0}
      <ol class="resource-history">
        {#each history as event (event.id)}
          <li>
            <strong>{describeAdminEvent(event, $t, bytes)}</strong>
            <span>{event.subject} · {formatHistoryDate(event.createdAt, $locale)}</span>
          </li>
        {/each}
      </ol>
    {:else}
      <p class="resource-empty">{$t('frameleaf_libraries_activity_empty')}</p>
    {/if}
  {/if}
</section>
