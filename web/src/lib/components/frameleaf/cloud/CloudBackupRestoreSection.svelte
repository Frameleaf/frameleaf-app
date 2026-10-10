<script lang="ts">
  import { locale } from '$lib/stores/preferences.store';
  import { rovingFocus } from '$lib/frameleaf/roving-focus';
  /**
   * Settings › Frameleaf Cloud › Cloud backup › Restore (FL-164): the prototype's `BackupRestore`
   * (design/frameleaf/template/src/FrameleafCloud.jsx). The kept backups with the newest one, its paired
   * database backup and how far back deleted items can come from; the backup picker; Items (search a
   * backup by file name, see whether each item is still in the library, restore it), Albums (deleted
   * albums and albums missing items, restored or repaired with their items) and Whole library (every file
   * back in place and the database dump for the maintenance restore, after typing RESTORE).
   * Restores run on the server as `cloud_restore` jobs, shown here and in Activity; every file is checked
   * against its fingerprint before it touches the library.
   */
  import './frameleaf-cloud.css';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import CloudBackupRestoreDialog from '$lib/components/frameleaf/cloud/CloudBackupRestoreDialog.svelte';
  import CloudBanner from '$lib/components/frameleaf/cloud/CloudBanner.svelte';
  import CloudCard from '$lib/components/frameleaf/cloud/CloudCard.svelte';
  import CloudWorkControls from '$lib/components/frameleaf/cloud/CloudWorkControls.svelte';
  import { cloudWorkRows, LIBRARY_RESTORE_STEPS, WHOLE_LIBRARY_CONFIRMATION } from '$lib/frameleaf/cloud-backup';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import {
    CloudBackupAlbumState,
    CloudBackupItemFilter,
    CloudBackupItemState,
    CloudBackupKeyMode,
    CloudBackupRestoreScope,
    CloudBackupRestoreStatus,
    CloudBackupRunState,
    getCloudBackupManifests,
    listCloudBackupManifestAlbums,
    restoreCloudBackup,
    searchCloudBackupManifestItems,
    type CloudBackupManifestAlbumsResponseDto,
    type CloudBackupManifestDto,
    type CloudBackupManifestItemDto,
    type CloudBackupStatusResponseDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiBackupRestore, mdiRestore, mdiWrenchOutline } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';

  type Props = {
    status: CloudBackupStatusResponseDto;
    formatWhen: (value: string | null | undefined) => string;
    onStatus: (status: CloudBackupStatusResponseDto) => void;
  };

  let { status, formatWhen, onStatus }: Props = $props();

  type Mode = 'items' | 'albums' | 'library';
  const MODES: Array<[Mode, Translations]> = [
    ['items', 'frameleaf_cloud_restore_mode_items'],
    ['albums', 'frameleaf_cloud_restore_mode_albums'],
    ['library', 'frameleaf_cloud_restore_mode_library'],
  ];
  const FILTERS: Array<[CloudBackupItemFilter, Translations]> = [
    [CloudBackupItemFilter.All, 'frameleaf_cloud_restore_filter_all'],
    [CloudBackupItemFilter.Deleted, 'frameleaf_cloud_restore_filter_deleted'],
    [CloudBackupItemFilter.InLibrary, 'frameleaf_cloud_restore_filter_in_library'],
  ];
  const STATE_WORDS: Record<CloudBackupItemState, Translations> = {
    [CloudBackupItemState.Active]: 'frameleaf_cloud_restore_state_active',
    [CloudBackupItemState.Trashed]: 'frameleaf_cloud_restore_state_trashed',
    [CloudBackupItemState.Deleted]: 'frameleaf_cloud_restore_state_deleted',
  };
  /** How long typing waits before the backup is searched. */
  const SEARCH_DELAY_MS = 300;

  let manifests = $state<CloudBackupManifestDto[] | null>(null);
  let manifestKey = $state('');
  let mode = $state<Mode>('items');
  let query = $state('');
  let filter = $state<CloudBackupItemFilter>(CloudBackupItemFilter.All);
  let items = $state<CloudBackupManifestItemDto[]>([]);
  let total = $state(0);
  let searching = $state(false);
  let failure = $state('');
  let notice = $state('');
  let busy = $state(false);
  let confirm = $state('');
  let dialogItem = $state<CloudBackupManifestItemDto | null>(null);
  let albums = $state<CloudBackupManifestAlbumsResponseDto | null>(null);
  let dialogOpen = $state(false);

  const chosen = $derived(manifests?.find((manifest) => manifest.key === manifestKey) ?? manifests?.[0] ?? null);
  const newest = $derived(manifests?.[0] ?? null);
  const oldest = $derived(manifests?.at(-1) ?? null);
  const restoring = $derived(status.activeRestore);
  const busyBucket = $derived(!!restoring || !!status.activeRun);
  const needsKey = $derived(status.keyMode === CloudBackupKeyMode.OwnMemory && !status.keyLoaded);
  const day = (value: string | null | undefined) =>
    value ? new Intl.DateTimeFormat($locale, { dateStyle: 'medium' }).format(new Date(value)) : '—';

  onMount(() => {
    void (async () => {
      try {
        const answer = await getCloudBackupManifests();
        manifests = answer.manifests;
        manifestKey = answer.manifests[0]?.key ?? '';
      } catch (error) {
        manifests = [];
        failure = getServerErrorMessage(error) ?? $t('frameleaf_cloud_restore_load_failed');
      }
    })();
  });

  // The chosen backup is searched again when the query, the filter or the backup changes.
  $effect(() => {
    const key = manifestKey;
    const text = query.trim();
    const show = filter;
    if (!key || mode !== 'items' || needsKey) {
      return;
    }
    const timer = setTimeout(() => void search(key, text, show), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  });

  // The chosen backup's albums are read when the Albums view opens or the backup changes.
  $effect(() => {
    const key = manifestKey;
    if (!key || mode !== 'albums' || needsKey) {
      return;
    }
    void listAlbums(key);
  });

  const listAlbums = async (key: string) => {
    albums = null;
    failure = '';
    try {
      albums = await listCloudBackupManifestAlbums({ cloudBackupManifestAlbumsDto: { manifestKey: key } });
    } catch (error) {
      albums = { manifestKey: key, hasDetails: true, albums: [] };
      failure = getServerErrorMessage(error) ?? $t('frameleaf_cloud_restore_albums_failed');
    }
  };

  const search = async (key: string, text: string, show: CloudBackupItemFilter) => {
    searching = true;
    failure = '';
    try {
      const found = await searchCloudBackupManifestItems({
        cloudBackupManifestItemsDto: { manifestKey: key, query: text || undefined, filter: show },
      });
      items = found.items;
      total = found.total;
    } catch (error) {
      items = [];
      total = 0;
      failure = getServerErrorMessage(error) ?? $t('frameleaf_cloud_restore_search_failed');
    } finally {
      searching = false;
    }
  };

  const start = async (scope: CloudBackupRestoreScope, target: { assetIds?: string[]; albumId?: string } = {}) => {
    if (!chosen) {
      return;
    }
    busy = true;
    failure = '';
    try {
      onStatus(await restoreCloudBackup({ cloudBackupRestoreDto: { manifestKey: chosen.key, scope, ...target } }));
      notice = $t('frameleaf_cloud_restore_queued');
      confirm = '';
    } catch (error) {
      failure = getServerErrorMessage(error) ?? $t('frameleaf_cloud_action_failed');
    } finally {
      busy = false;
    }
  };

  const restoreItem = (item: CloudBackupManifestItemDto) => {
    // An item still in the library comes back in place, after the administrator chooses the backup and
    // how its details come back. A deleted one comes back as it was when the backup holds its details,
    // otherwise into the restore folder, where Library Care finds it.
    if (item.state === CloudBackupItemState.Deleted) {
      void start(item.hasDetails ? CloudBackupRestoreScope.Asset : CloudBackupRestoreScope.Files, {
        assetIds: [item.assetId],
      });
      return;
    }
    dialogItem = item.locked ? { ...item, name: $t('frameleaf_cloud_restore_locked_item') } : item;
    dialogOpen = true;
  };

  const restoreTitle = $derived(
    $t(
      cloudWorkRows(status).find((row) => row.id === 'cloud-restore-run')?.titleKey ??
        'frameleaf_cloud_work_restore_files',
    ),
  );
  const restoreProgress = $derived(restoring ? Math.round(restoring.progress) : null);
  const lastRestore = $derived(status.lastRestore);
</script>

<div id="fc-restore-title">
  <CloudCard
    icon={mdiBackupRestore}
    title={$t('frameleaf_cloud_restore_title')}
    description={$t('frameleaf_cloud_restore_description')}
    status={restoring
      ? restoring.state === CloudBackupRunState.Queued
        ? $t('frameleaf_cloud_restore_status_queued')
        : $t('frameleaf_cloud_restore_status_restoring')
      : undefined}
    tone="running"
  >
    {#if notice}
      <p class="fc-notice" role="status">{notice}</p>
    {/if}
    {#if manifests === null}
      <p class="fc-muted" role="status">{$t('frameleaf_cloud_loading')}</p>
    {:else if manifests.length === 0}
      <p class="fc-muted">{$t('frameleaf_cloud_restore_none')}</p>
    {:else}
      <dl class="fc-restore-stats">
        <div>
          <dt>{$t('frameleaf_cloud_restore_newest')}</dt>
          <dd>{day(newest?.createdAt)}</dd>
        </div>
        <div>
          <dt>{$t('frameleaf_cloud_restore_paired_database')}</dt>
          <dd>{newest?.databaseKey ? day(newest.createdAt) : '—'}</dd>
        </div>
        <div>
          <dt>{$t('frameleaf_cloud_restore_recoverable_since')}</dt>
          <dd>{day(oldest?.createdAt)}</dd>
        </div>
      </dl>

      <label class="fc-stack">
        {$t('frameleaf_cloud_restore_backup')}
        <select value={manifestKey} onchange={(event) => (manifestKey = event.currentTarget.value)}>
          {#each manifests as manifest (manifest.key)}
            <option value={manifest.key}>
              {$t('frameleaf_cloud_restore_backup_option', {
                values: {
                  when: formatWhen(manifest.createdAt),
                  files: manifest.files,
                  size: getByteUnitString(manifest.bytes),
                },
              })}
            </option>
          {/each}
        </select>
        {#if chosen}
          <small class="fc-muted">
            {chosen.databaseKey
              ? $t('frameleaf_cloud_restore_paired_help', { values: { when: formatWhen(chosen.createdAt) } })
              : $t('frameleaf_cloud_restore_unpaired_help')}
          </small>
        {/if}
      </label>

      <div
        class="fc-segmented fc-restore-modes"
        role="radiogroup"
        use:rovingFocus
        aria-label={$t('frameleaf_cloud_restore_what')}
      >
        {#each MODES as [id, labelKey] (id)}
          <button
            type="button"
            role="radio"
            aria-checked={mode === id}
            class:is-on={mode === id}
            onclick={() => (mode = id)}>{$t(labelKey)}</button
          >
        {/each}
      </div>

      {#if mode === 'items'}
        <div class="fc-actions fc-restore-search">
          <input
            type="search"
            aria-label={$t('frameleaf_cloud_restore_search_label')}
            placeholder={$t('frameleaf_cloud_restore_search_placeholder')}
            value={query}
            oninput={(event) => (query = event.currentTarget.value)}
          />
          <div class="fc-segmented" role="radiogroup" use:rovingFocus aria-label={$t('frameleaf_cloud_restore_show')}>
            {#each FILTERS as [id, labelKey] (id)}
              <button
                type="button"
                role="radio"
                aria-checked={filter === id}
                class:is-on={filter === id}
                onclick={() => (filter = id)}>{$t(labelKey)}</button
              >
            {/each}
          </div>
        </div>
        {#if needsKey}
          <p class="fc-muted">{$t('frameleaf_cloud_restore_needs_key')}</p>
        {:else if items.length > 0}
          <div class="fc-table-wrap">
            <table class="fc-table">
              <thead>
                <tr>
                  <th scope="col">{$t('frameleaf_cloud_restore_column_item')}</th>
                  <th scope="col">{$t('frameleaf_cloud_restore_column_owner')}</th>
                  <th scope="col">{$t('frameleaf_cloud_restore_column_library')}</th>
                  <th scope="col">
                    <span class="fc-visually-hidden">{$t('frameleaf_cloud_restore_column_action')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {#each items as item (item.assetId)}
                  {@const inLibrary = item.state === CloudBackupItemState.Active}
                  <tr>
                    <th scope="row">
                      {item.locked ? $t('frameleaf_cloud_restore_locked_item') : item.name}
                      <small>
                        {[item.modifiedAt ? formatWhen(item.modifiedAt) : null, getByteUnitString(item.bytes)]
                          .filter(Boolean)
                          .join(' · ')}
                      </small>
                    </th>
                    <td>{item.ownerName ?? '—'}</td>
                    <td>
                      <span class="fc-status" class:is-ok={inLibrary} class:is-warning={!inLibrary}>
                        {$t(STATE_WORDS[item.state])}
                      </span>
                    </td>
                    <td>
                      <Button disabled={busy || busyBucket} onclick={() => restoreItem(item)}>
                        <Icon icon={mdiBackupRestore} size="18" />
                        {item.state === CloudBackupItemState.Deleted
                          ? $t('frameleaf_cloud_restore')
                          : $t('frameleaf_cloud_restore_ellipsis')}
                      </Button>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          {#if total > items.length}
            <p class="fc-muted">{$t('frameleaf_cloud_restore_more', { values: { shown: items.length, total } })}</p>
          {/if}
        {:else if !searching}
          <p class="fc-muted">{$t('frameleaf_cloud_restore_no_match')}</p>
        {/if}
        <p class="fc-note">{$t('frameleaf_cloud_restore_items_note')}</p>
      {:else if mode === 'albums'}
        {#if needsKey}
          <p class="fc-muted">{$t('frameleaf_cloud_restore_needs_key')}</p>
        {:else if albums === null}
          <p class="fc-muted" role="status">{$t('frameleaf_cloud_loading')}</p>
        {:else if !albums.hasDetails}
          <p class="fc-muted">{$t('frameleaf_cloud_restore_albums_old_backup')}</p>
        {:else if albums.albums.length > 0}
          <div class="fc-table-wrap">
            <table class="fc-table">
              <thead>
                <tr>
                  <th scope="col">{$t('frameleaf_cloud_restore_column_album')}</th>
                  <th scope="col">{$t('frameleaf_cloud_restore_column_owner')}</th>
                  <th scope="col">{$t('frameleaf_cloud_restore_column_state')}</th>
                  <th scope="col">
                    <span class="fc-visually-hidden">{$t('frameleaf_cloud_restore_column_action')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {#each albums.albums as album (album.albumId)}
                  {@const deleted = album.state === CloudBackupAlbumState.Deleted}
                  <tr>
                    <th scope="row">
                      {album.name}
                      <small>{$t('frameleaf_cloud_restore_album_items', { values: { count: album.items } })}</small>
                    </th>
                    <td>{album.ownerName ?? '—'}</td>
                    <td>
                      <span class="fc-status is-warning">
                        {deleted
                          ? $t('frameleaf_cloud_restore_album_deleted')
                          : $t('frameleaf_cloud_restore_album_missing', { values: { count: album.missing } })}
                      </span>
                    </td>
                    <td>
                      <Button
                        disabled={busy || busyBucket}
                        onclick={() => void start(CloudBackupRestoreScope.Album, { albumId: album.albumId })}
                      >
                        <Icon icon={deleted ? mdiRestore : mdiWrenchOutline} size="18" />
                        {deleted
                          ? $t('frameleaf_cloud_restore_album_restore')
                          : $t('frameleaf_cloud_restore_album_repair')}
                      </Button>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {:else}
          <p class="fc-muted">{$t('frameleaf_cloud_restore_albums_none')}</p>
        {/if}
        <p class="fc-note">{$t('frameleaf_cloud_restore_albums_note')}</p>
      {:else}
        <CloudBanner tone="warning" title={$t('frameleaf_cloud_restore_library_banner_title')}>
          {$t('frameleaf_cloud_restore_library_banner_body', {
            values: { when: chosen ? formatWhen(chosen.createdAt) : '—' },
          })}
        </CloudBanner>
        <ol class="fc-steps fc-restore-steps" aria-label={$t('frameleaf_cloud_restore_steps')}>
          {#each LIBRARY_RESTORE_STEPS as step, index (step.titleKey)}
            <li title={$t(step.detailKey)}>
              <span>{index + 1}</span>
              {$t(step.titleKey)}
            </li>
          {/each}
        </ol>
        <label class="fc-stack">
          {$t('frameleaf_cloud_restore_type_confirm', { values: { word: WHOLE_LIBRARY_CONFIRMATION } })}
          <input
            autocomplete="off"
            value={confirm}
            oninput={(event) => (confirm = event.currentTarget.value.toUpperCase())}
          />
        </label>
        <div class="fc-actions">
          <Button
            variant="primary"
            disabled={confirm !== WHOLE_LIBRARY_CONFIRMATION || busy || busyBucket || needsKey || !chosen?.databaseKey}
            onclick={() => void start(CloudBackupRestoreScope.Library)}
          >
            <Icon icon={mdiBackupRestore} size="18" />
            {$t('frameleaf_cloud_restore_library_start')}
          </Button>
        </div>
      {/if}
    {/if}

    {#if restoring}
      <div class="fc-last-run">
        <h3>{$t('frameleaf_cloud_restore_in_progress')}</h3>
        <p class="fc-muted" role="status">
          {restoring.state === CloudBackupRunState.Queued
            ? $t('frameleaf_cloud_backup_progress_queued')
            : $t('frameleaf_cloud_restore_progress', {
                values: {
                  progress: restoreProgress,
                  files: restoring.files,
                  total: restoring.filesTotal,
                  size: getByteUnitString(restoring.bytes),
                },
              })}
        </p>
        {#if restoring.state !== CloudBackupRunState.Queued}
          <progress max={100} value={restoreProgress} aria-label={$t('frameleaf_cloud_restore_progress_label')}>
            {restoreProgress}%
          </progress>
        {/if}
        <CloudWorkControls
          operationId={restoring.operationId}
          runState={restoring.state}
          title={restoreTitle}
          restore
          {onStatus}
        />
      </div>
    {:else if lastRestore}
      <div class="fc-last-run">
        <h3>{$t('frameleaf_cloud_restore_last')}</h3>
        {#if lastRestore.status === CloudBackupRestoreStatus.Completed}
          <p>
            {$t('frameleaf_cloud_restore_finished', {
              values: { when: formatWhen(lastRestore.at), files: lastRestore.files },
            })}
          </p>
          {#if lastRestore.destination}
            <p class="fc-muted">
              {$t('frameleaf_cloud_restore_destination', { values: { folder: lastRestore.destination } })}
            </p>
          {/if}
          {#if lastRestore.recreated > 0}
            <p class="fc-muted">
              {$t('frameleaf_cloud_restore_recreated', { values: { count: lastRestore.recreated } })}
            </p>
          {/if}
          {#if lastRestore.detailsRestored > 0}
            <p class="fc-muted">
              {$t('frameleaf_cloud_restore_details_restored', { values: { count: lastRestore.detailsRestored } })}
            </p>
          {/if}
          {#if lastRestore.replaced > 0}
            <p class="fc-muted">
              {$t('frameleaf_cloud_restore_replaced', { values: { count: lastRestore.replaced } })}
            </p>
          {/if}
          {#if lastRestore.databaseFile}
            <p class="fc-muted">
              {$t('frameleaf_cloud_restore_database_ready', { values: { file: lastRestore.databaseFile } })}
            </p>
          {/if}
        {:else if lastRestore.status === CloudBackupRestoreStatus.Failed}
          <p class="fc-refusal" role="status">
            {$t('frameleaf_cloud_restore_failed', { values: { error: lastRestore.error ?? '' } })}
          </p>
        {:else}
          <p class="fc-muted">{$t('frameleaf_cloud_restore_cancelled')}</p>
        {/if}
      </div>
    {/if}

    {#if failure}
      <p class="fc-notice is-error" role="alert">{failure}</p>
    {/if}
  </CloudCard>
</div>

{#if dialogOpen && dialogItem && manifests}
  <CloudBackupRestoreDialog
    bind:open={dialogOpen}
    item={dialogItem}
    {manifests}
    manifestKey={chosen?.key ?? manifestKey}
    {needsKey}
    keyFingerprint={status.keyFingerprint}
    formatWhen={(value) => formatWhen(value)}
    onDone={(next) => {
      onStatus(next);
      notice = $t('frameleaf_cloud_restore_queued');
    }}
  />
{/if}

<style>
  .fc-restore-stats {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 1rem;
    margin: 4px 0 18px;
  }
  .fc-restore-stats div {
    padding-inline-start: 1.125rem;
    border-inline-start: 1px solid var(--fl-border);
  }
  .fc-restore-stats div:first-child {
    padding-inline-start: 0;
    border: 0;
  }
  .fc-restore-stats dt {
    margin-bottom: 0.5rem;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .fc-restore-stats dd {
    margin: 0;
    font-size: 1.125rem;
    font-variant-numeric: tabular-nums;
  }
  .fc-restore-modes {
    margin: 4px 0 16px;
  }
  .fc-restore-search {
    margin-top: 0;
    flex-wrap: wrap;
  }
  @media (max-width: 640px) {
    .fc-restore-stats {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
