<script lang="ts">
  /**
   * The Frameleaf admin Libraries area (FL-78), ported from the libraries view of the design
   * template's `AccountsLibraries` (`design/frameleaf/template/src/AccountsLibraries.jsx`,
   * `accounts-libraries.css`): the heading with "Scan N libraries" and "Add external library", one
   * toolbar, a table of every owner's managed uploads and external libraries with their scan
   * status and progress, and the selected library's detail below it.
   *
   * Rows come from the page's loader; nothing here is kept in the browser. While any scan is
   * moving the list is read again every couple of seconds, so progress, failures and the end of a
   * scan show as the server records them, and a reload shows exactly the same thing.
   */
  import '$lib/frameleaf/libraries.css';
  import LibraryDetail from '$lib/components/frameleaf/LibraryDetail.svelte';
  import LibraryFormDialog from '$lib/components/frameleaf/LibraryFormDialog.svelte';
  import LibraryRemoveDialog from '$lib/components/frameleaf/LibraryRemoveDialog.svelte';
  import SettingsOverline from '$lib/components/frameleaf/settings/SettingsOverline.svelte';
  import {
    LIBRARY_QUERY_MAX_LENGTH,
    LIBRARY_SCAN_POLL_MS,
    filterLibraryRows,
    isScanActive,
    isScanMoving,
    libraryKey,
    scanNeedsAttention,
    scanStatusKey,
    scannableLibraries,
    sortLibraryRows,
    type LibraryFilter,
    type LibraryRow,
    type LibrarySort,
  } from '$lib/frameleaf/libraries';
  import { locale } from '$lib/stores/preferences.store';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import { cancelLibraryScan, scanLibrary, type LibraryResponseDto, type UserAdminResponseDto } from '@immich/sdk';
  import { getByteUnitString } from '@immich/ui';
  import { t } from 'svelte-i18n';

  type Props = {
    rows: LibraryRow[];
    /** Accounts that may own a new library. */
    owners: UserAdminResponseDto[];
    /** The external libraries as the server returned them, for the edit form. */
    libraries: LibraryResponseDto[];
    selectedKey: string | null;
    /** Open the edit dialog for the selected library on arrival (the edit address). */
    editOnOpen?: boolean;
    /** Open the add dialog on arrival (the add address). */
    createOnOpen?: boolean;
    snapshotAt: Date;
    onSelect: (key: string | null) => void;
    onAnalytics: () => void;
    refresh: () => Promise<void>;
  };

  let {
    rows,
    owners,
    libraries,
    selectedKey,
    editOnOpen = false,
    createOnOpen = false,
    snapshotAt,
    onSelect,
    onAnalytics,
    refresh,
  }: Props = $props();

  let query = $state('');
  // Bound to <select>, so these stay plain strings and are narrowed where the rules are applied.
  let filter = $state('active');
  let sort = $state('name');
  let notice = $state('');
  let error = $state('');
  let busy = $state(false);
  let modal = $state<{ type: 'create' } | { type: 'edit'; id: string } | { type: 'remove'; id: string } | null>(
    createOnOpen ? { type: 'create' } : null,
  );

  let editOnOpenHandled = false;

  const visible = $derived(
    sortLibraryRows(filterLibraryRows(rows, { query, filter: filter as LibraryFilter }), sort as LibrarySort),
  );
  const selected = $derived(rows.find((row) => row.key === selectedKey) ?? null);
  const scannable = $derived(scannableLibraries(visible));
  const moving = $derived(rows.some((row) => isScanMoving(row.scan)));
  const editing = $derived(libraries.find((library) => modal?.type === 'edit' && library.id === modal.id));

  $effect(() => {
    if (editOnOpenHandled || !editOnOpen || selected?.kind !== 'external' || selected.lifecycle !== 'active') {
      return;
    }

    editOnOpenHandled = true;
    modal = { type: 'edit', id: selected.id };
  });

  // Read the list again while a scan moves; stop as soon as none does.
  $effect(() => {
    if (!moving) {
      return;
    }
    const timer = setInterval(() => void refresh(), LIBRARY_SCAN_POLL_MS);
    return () => clearInterval(timer);
  });

  const run = async (action: () => Promise<unknown>, success: string, failure: string) => {
    busy = true;
    error = '';
    try {
      await action();
      notice = success;
    } catch (error_) {
      error = `${failure} ${getServerErrorMessage(error_) ?? ''}`.trim();
    } finally {
      busy = false;
      await refresh();
    }
  };

  const scanOne = (row: LibraryRow) =>
    run(
      () => scanLibrary({ id: row.id }),
      $t('frameleaf_libraries_notice_scan_queued'),
      $t('frameleaf_libraries_error_scan'),
    );

  const scanAll = () => {
    const targets = [...scannable];
    return run(
      () => Promise.all(targets.map((row) => scanLibrary({ id: row.id }))),
      $t('frameleaf_libraries_notice_scans_queued', { values: { count: targets.length } }),
      $t('frameleaf_libraries_error_scan'),
    );
  };

  const cancelScan = (row: LibraryRow) =>
    run(
      () => cancelLibraryScan({ id: row.id }),
      $t('frameleaf_libraries_notice_scan_cancelled'),
      $t('frameleaf_libraries_error_cancel'),
    );

  const statusLabel = (row: LibraryRow) => {
    if (row.lifecycle !== 'active') {
      return $t('frameleaf_libraries_status_removing');
    }
    return row.scan
      ? $t(`frameleaf_libraries_status_${scanStatusKey(row.scan)}`)
      : $t('frameleaf_libraries_status_active');
  };

  const statusWarning = (row: LibraryRow) => row.lifecycle !== 'active' || (!!row.scan && scanNeedsAttention(row.scan));
</script>

<section class="fl-libraries" aria-label={$t('frameleaf_libraries_title')}>
  <header class="resource-heading">
    <div>
      <SettingsOverline>{$t('frameleaf_libraries_eyebrow')}</SettingsOverline>
      <h1>{$t('frameleaf_libraries_title')}</h1>
      <p>{$t('frameleaf_libraries_subtitle')}</p>
    </div>
    <div class="resource-actions">
      <button type="button" class="resource-button" disabled={scannable.length === 0 || busy} onclick={scanAll}>
        {$t('frameleaf_libraries_scan_all', { values: { count: scannable.length } })}
      </button>
      <button type="button" class="resource-button primary" onclick={() => (modal = { type: 'create' })}
        >{$t('frameleaf_libraries_add')}</button
      >
    </div>
  </header>

  <div class="resource-toolbar">
    <input
      type="search"
      aria-label={$t('frameleaf_libraries_search_label')}
      placeholder={$t('frameleaf_libraries_search_placeholder')}
      maxlength={LIBRARY_QUERY_MAX_LENGTH}
      bind:value={query}
    />
    <select aria-label={$t('frameleaf_libraries_filter_label')} bind:value={filter}>
      <option value="active">{$t('frameleaf_libraries_filter_active')}</option>
      <option value="all">{$t('frameleaf_libraries_filter_all')}</option>
      <option value="deleted">{$t('frameleaf_libraries_filter_deleted')}</option>
      <option value="upload">{$t('frameleaf_libraries_filter_upload')}</option>
      <option value="external">{$t('frameleaf_libraries_filter_external')}</option>
    </select>
    <select aria-label={$t('frameleaf_libraries_sort_label')} bind:value={sort}>
      <option value="name">{$t('frameleaf_libraries_sort_name')}</option>
      <option value="storage">{$t('frameleaf_libraries_sort_storage')}</option>
      <option value="created">{$t('frameleaf_libraries_sort_created')}</option>
    </select>
    <span>{$t('frameleaf_libraries_count', { values: { count: visible.length } })}</span>
  </div>

  {#if !modal && error}
    <p class="resource-error" role="alert">{error}</p>
  {/if}
  <p class="resource-live" role="status">{notice}</p>

  <!-- the template makes the scrolling table reachable by keyboard -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div class="resource-table-scroll" role="region" aria-label={$t('frameleaf_libraries_table_label')} tabindex="0">
    <table class="resource-table">
      <thead>
        <tr>
          <th scope="col">{$t('frameleaf_libraries_column_library')}</th>
          <th scope="col">{$t('frameleaf_libraries_column_owner')}</th>
          <th scope="col">{$t('frameleaf_libraries_column_items')}</th>
          <th scope="col">{$t('frameleaf_libraries_column_logical')}</th>
          <th scope="col">{$t('frameleaf_libraries_column_status')}</th>
        </tr>
      </thead>
      <tbody>
        {#each visible as row (row.key)}
          <tr data-selected={selectedKey === row.key}>
            <th scope="row">
              <button type="button" class="resource-row-name" onclick={() => onSelect(row.key)}>
                <span>
                  <strong>{row.name}</strong>
                  <small>
                    {row.kind === 'upload'
                      ? $t('frameleaf_libraries_row_uploads')
                      : $t('frameleaf_libraries_row_folders', { values: { count: row.importPaths.length } })}
                  </small>
                </span>
              </button>
            </th>
            <td>{row.ownerName}</td>
            <td>
              {(row.stats?.items ?? 0).toLocaleString($locale)}
              <small>{$t('frameleaf_libraries_row_videos', { values: { count: row.stats?.videos ?? 0 } })}</small>
            </td>
            <td>{getByteUnitString(row.stats?.logical ?? 0, $locale, 1)}</td>
            <td>
              <span class="resource-status" class:warning={statusWarning(row)}>{statusLabel(row)}</span>
              {#if row.scan && isScanActive(row.scan)}
                <progress
                  value={row.scan.progress}
                  max={100}
                  aria-label={$t('frameleaf_libraries_scan_progress_label', { values: { name: row.name } })}
                ></progress>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
    {#if visible.length === 0}
      <p class="resource-empty">{$t('frameleaf_libraries_empty')}</p>
    {/if}
  </div>

  {#if selected}
    {#key selected.key}
      <LibraryDetail
        row={selected}
        {snapshotAt}
        {busy}
        onEdit={() => (modal = { type: 'edit', id: selected.id })}
        onRemove={() => (modal = { type: 'remove', id: selected.id })}
        onScan={() => scanOne(selected)}
        onCancelScan={() => cancelScan(selected)}
        {onAnalytics}
        onClose={() => onSelect(null)}
      />
    {/key}
  {/if}

  {#if modal?.type === 'create'}
    <LibraryFormDialog
      {owners}
      ownerId={selected?.ownerId}
      onSaved={(library) => {
        notice = $t('frameleaf_libraries_notice_created');
        onSelect(libraryKey(library.id));
        void refresh();
      }}
      onClose={() => (modal = null)}
    />
  {:else if modal?.type === 'edit' && editing}
    <LibraryFormDialog
      library={editing}
      {owners}
      onSaved={() => {
        notice = $t('frameleaf_libraries_notice_updated');
        void refresh();
      }}
      onClose={() => (modal = null)}
    />
  {:else if modal?.type === 'remove'}
    <LibraryRemoveDialog
      libraryId={modal.id}
      onRemoved={() => {
        notice = $t('frameleaf_libraries_notice_removed');
        onSelect(null);
        void refresh();
      }}
      onClose={() => (modal = null)}
    />
  {/if}
</section>
