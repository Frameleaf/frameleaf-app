<script lang="ts">
  /**
   * The enrolled render workers (FL-95), as the administrator sees them: identity, destination,
   * the operation kinds it may claim, its live health, its load against its own concurrency and
   * its ceilings. Rows never carry a secret or a session; the enrolment secret exists only in the
   * moment `RenderWorkerFormDialog` shows it. Every mutation goes through the page, which owns
   * the dialogs, so this component is presentation plus the filter/sort rules in
   * `$lib/frameleaf/render-workers`.
   */
  import Badge from '$lib/components/frameleaf/Badge.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Pane from '$lib/components/frameleaf/Pane.svelte';
  import {
    RENDER_WORKER_QUERY_MAX_LENGTH,
    bytesToGiB,
    destinationKey,
    filterWorkers,
    msToMinutes,
    operationKindKey,
    sortWorkers,
    workerHealth,
    workerHealthKey,
    workerHealthTone,
    type RenderWorkerFilter,
  } from '$lib/frameleaf/render-workers';
  import { locale } from '$lib/stores/preferences.store';
  import { MediaOperationDestination, RenderWorkerStatus, type RenderWorkerDto } from '@immich/sdk';
  import { DateTime } from 'luxon';
  import { t } from 'svelte-i18n';

  let {
    workers,
    now,
    onEnrol,
    onEdit,
    onRevoke,
  }: {
    workers: RenderWorkerDto[];
    /** Ticks from the page so health re-derives without the rows changing. */
    now: Date;
    onEnrol: () => void;
    onEdit: (worker: RenderWorkerDto) => void;
    onRevoke: (worker: RenderWorkerDto) => void;
  } = $props();

  let query = $state('');
  // Bound to <select>, so these stay plain strings and are narrowed where the rules are applied.
  let filter = $state('active');
  let destination = $state('all');

  const rows = $derived(
    sortWorkers(
      filterWorkers(workers, {
        query,
        filter: filter as RenderWorkerFilter,
        destination: destination as MediaOperationDestination | 'all',
      }),
    ),
  );

  const idPrefix = $props.id();
  const searchId = `${idPrefix}-search`;
  const filterId = `${idPrefix}-filter`;
  const destinationId = `${idPrefix}-destination`;

  const seenAt = (value: string | null) =>
    value
      ? DateTime.fromISO(value, { locale: $locale }).toLocaleString(DateTime.DATETIME_MED)
      : $t('frameleaf_render_workers_never_seen');

  const ceilings = (worker: RenderWorkerDto) => {
    const parts: string[] = [];
    const minutes = msToMinutes(worker.maxWallClockMs);
    if (minutes !== null) {
      parts.push($t('frameleaf_render_workers_ceiling_wall_clock', { values: { minutes } }));
    }
    const gib = bytesToGiB(worker.maxOutputBytes);
    if (gib !== null) {
      parts.push($t('frameleaf_render_workers_ceiling_output', { values: { gib } }));
    }
    return parts.length > 0 ? parts.join(' · ') : $t('frameleaf_render_workers_ceiling_none');
  };

  const gpu = (worker: RenderWorkerDto) => {
    const gib = bytesToGiB(worker.gpuMemoryBytes);
    return gib === null ? null : $t('frameleaf_render_workers_gpu_memory', { values: { gib } });
  };
</script>

<Pane label={$t('frameleaf_render_workers_title')}>
  <div class="head">
    <div>
      <!-- The page heading already names this section (a section named like its area does not repeat the name). -->
      <h2 class="sr-only">{$t('frameleaf_render_workers_title')}</h2>
      <p>{$t('frameleaf_render_workers_subtitle')}</p>
    </div>
    <Button variant="primary" onclick={onEnrol}>{$t('frameleaf_render_workers_enrol')}</Button>
  </div>

  <div class="toolbar">
    <label class="field" for={searchId}>
      <span>{$t('frameleaf_render_workers_search_label')}</span>
      <input
        id={searchId}
        type="search"
        maxlength={RENDER_WORKER_QUERY_MAX_LENGTH}
        placeholder={$t('frameleaf_render_workers_search_placeholder')}
        bind:value={query}
      />
    </label>
    <label class="field" for={filterId}>
      <span>{$t('frameleaf_render_workers_filter_label')}</span>
      <select id={filterId} bind:value={filter}>
        <option value="active">{$t('frameleaf_render_workers_filter_active')}</option>
        <option value="all">{$t('frameleaf_render_workers_filter_all')}</option>
        <option value="revoked">{$t('frameleaf_render_workers_filter_revoked')}</option>
      </select>
    </label>
    <label class="field" for={destinationId}>
      <span>{$t('frameleaf_render_workers_destination_filter_label')}</span>
      <select id={destinationId} bind:value={destination}>
        <option value="all">{$t('frameleaf_render_workers_destination_all')}</option>
        {#each Object.values(MediaOperationDestination) as value (value)}
          <option {value}>{$t(destinationKey[value])}</option>
        {/each}
      </select>
    </label>
    <p class="count" aria-live="polite">
      {$t('frameleaf_render_workers_count', { values: { count: rows.length } })}
    </p>
  </div>

  <!-- svelte-ignore a11y_no_noninteractive_tabindex (a scrollable region must be reachable by keyboard to scroll it) -->
  <div class="scroll" role="region" aria-label={$t('frameleaf_render_workers_table_label')} tabindex="0">
    <table>
      <thead>
        <tr>
          <th scope="col">{$t('frameleaf_render_workers_column_worker')}</th>
          <th scope="col">{$t('frameleaf_render_workers_column_scopes')}</th>
          <th scope="col">{$t('frameleaf_render_workers_column_health')}</th>
          <th scope="col">{$t('frameleaf_render_workers_column_load')}</th>
          <th scope="col">{$t('frameleaf_render_workers_column_ceilings')}</th>
          <th scope="col">{$t('frameleaf_render_workers_column_last_seen')}</th>
          <th scope="col"><span class="sr-only">{$t('frameleaf_render_workers_column_actions')}</span></th>
        </tr>
      </thead>
      <tbody>
        {#each rows as worker (worker.id)}
          {@const health = workerHealth(worker, now)}
          {@const revoked = worker.status === RenderWorkerStatus.Revoked}
          <tr class:revoked>
            <th scope="row">
              <strong>{worker.name}</strong>
              <small>
                {$t(destinationKey[worker.destination])}
                {#if gpu(worker)}
                  · {gpu(worker)}
                {/if}
              </small>
              <small class="mono">{worker.engineDigest ?? $t('frameleaf_render_workers_engine_any')}</small>
            </th>
            <td>
              <ul class="kinds">
                {#each worker.kinds as kind (kind)}
                  <li>{$t(operationKindKey[kind])}</li>
                {/each}
              </ul>
            </td>
            <td>
              <Badge
                value={$t(workerHealthKey[health])}
                label={$t(workerHealthKey[health])}
                tone={workerHealthTone[health]}
              />
            </td>
            <td>
              {$t('frameleaf_render_workers_load', {
                values: { active: worker.activeOperations, max: worker.maxConcurrentOperations },
              })}
            </td>
            <td>{ceilings(worker)}</td>
            <td>{seenAt(worker.lastSeenAt)}</td>
            <td class="actions">
              <Button variant="quiet" disabled={revoked} onclick={() => onEdit(worker)}>
                {$t('frameleaf_render_workers_edit')}
              </Button>
              <Button variant="quiet" disabled={revoked} onclick={() => onRevoke(worker)}>
                {$t('frameleaf_render_workers_revoke')}
              </Button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
    {#if rows.length === 0}
      <p class="empty">
        {workers.length === 0 ? $t('frameleaf_render_workers_empty_none') : $t('frameleaf_render_workers_empty')}
      </p>
    {/if}
  </div>
</Pane>

<style>
  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: start;
    justify-content: space-between;
    gap: 0.75rem 1rem;
    margin-bottom: 1rem;
  }
  .head h2 {
    font-size: var(--fl-font-size);
    margin: 0 0 0.25rem;
  }
  .head p {
    margin: 0;
    max-width: 60ch;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    gap: 0.75rem;
    margin-bottom: 1rem;
  }
  .field {
    display: grid;
    gap: 0.25rem;
    min-width: 0;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .field:first-child {
    flex: 1 1 14rem;
  }
  .field input,
  .field select {
    padding: 0.4375rem 0.6875rem;
    font: inherit;
    font-size: var(--fl-font-size);
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .count {
    margin: 0 0 0.4375rem;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .scroll {
    overflow-x: auto;
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--fl-font-size);
    color: var(--fl-text);
  }
  th,
  td {
    padding: 0.625rem 0.875rem;
    text-align: start;
    vertical-align: top;
  }
  thead th {
    font-size: var(--fl-font-small);
    font-weight: 600;
    color: var(--fl-muted);
    border-bottom: 1px solid var(--fl-border);
  }
  tbody tr + tr {
    border-top: 1px solid var(--fl-border);
  }
  tbody th {
    display: grid;
    gap: 0.125rem;
    font-weight: 400;
  }
  tbody th small {
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    overflow-wrap: anywhere;
  }
  .revoked th,
  .revoked td {
    color: var(--fl-muted);
  }
  .kinds {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .kinds li {
    padding: 0.0625rem 0.4375rem;
    font-size: var(--fl-font-small);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-pill);
  }
  .actions {
    white-space: nowrap;
  }
  .empty {
    margin: 0;
    padding: 1.5rem 0.875rem;
    color: var(--fl-muted);
  }
</style>
