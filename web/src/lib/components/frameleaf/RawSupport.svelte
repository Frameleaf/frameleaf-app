<script lang="ts">
  /**
   * Universal RAW (FL-420, prototype RawLibraryCare.jsx): how the household's camera originals are
   * doing, which camera formats this server can show and develop, and a repair that makes missing
   * previews again. Everything is real: the status comes from `GET /media-health/raw`, repair is the
   * ordinary regenerate-thumbnail job, and the originals are never touched.
   */
  import { onDestroy, onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { Icon } from '@frameleaf/ui';
  import {
    AssetJobName,
    AssetMediaSize,
    Colorspace,
    RawSupportSource,
    RawSupportStatus,
    getRawSupport,
    runAssetJobs,
    type RawSupportItemDto,
    type RawSupportResponseDto,
  } from '@frameleaf/sdk';
  import {
    mdiArrowLeft,
    mdiCameraIris,
    mdiCameraOutline,
    mdiCheckCircleOutline,
    mdiChevronRight,
    mdiClose,
    mdiHarddisk,
    mdiInformationOutline,
    mdiMagnifyPlusOutline,
    mdiProgressClock,
    mdiRefresh,
    mdiShieldCheckOutline,
  } from '@mdi/js';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import PhotographyThumb from '$lib/components/frameleaf/PhotographyThumb.svelte';
  import Skeleton from '$lib/components/frameleaf/Skeleton.svelte';
  import {
    RAW_STATUS_COPY,
    REPAIR_POLL_MS,
    REPAIRABLE,
    WARNING,
    advanceRepair,
    cameraName,
    formatRows,
    readRepair,
    repairableIds,
    saveRepair,
    startRepair,
    type RawRepair,
  } from '$lib/frameleaf/raw-support';
  import { Route } from '$lib/route';
  import { getAssetMediaUrl } from '$lib/utils';

  let summary = $state<RawSupportResponseDto | null>(null);
  let loadError = $state(false);
  let actionError = $state('');
  let tab = $state<'health' | 'formats'>('health');
  let selectedId = $state<string | null>(null);
  /** Which dialog is mounted; `dialogOpen` drives its sheet so the exit plays before it unmounts. */
  let dialog = $state<'repair' | 'zoom' | 'details' | null>(null);
  let dialogOpen = $state(false);
  const show = (kind: 'repair' | 'zoom' | 'details') => {
    dialog = kind;
    dialogOpen = true;
  };
  const hide = () => (dialogOpen = false);
  let repair = $state<RawRepair | null>(readRepair());
  let storageFailed = $state(false);
  let starting = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const items = $derived(summary?.items ?? []);
  const selected = $derived(items.find((item) => item.assetId === selectedId) ?? items[0]);
  const copy = $derived(selected ? RAW_STATUS_COPY[selected.status] : undefined);
  const repairIds = $derived(repairableIds(items));
  const repairing = $derived(repair?.status === 'running');
  const rows = $derived(summary ? formatRows(summary.formats) : []);

  const thumbnail = (item: RawSupportItemDto) => getAssetMediaUrl({ id: item.assetId, size: AssetMediaSize.Thumbnail });
  const preview = (item: RawSupportItemDto, size = AssetMediaSize.Preview) =>
    item.source === RawSupportSource.None
      ? null
      : getAssetMediaUrl({ id: item.assetId, size, cacheKey: item.renderedAt });

  async function load() {
    try {
      const next = await getRawSupport({ limit: 200 });
      if (disposed) {
        return;
      }
      summary = next;
      loadError = false;
      if (repair) {
        setRepair(advanceRepair(repair, next));
      }
    } catch {
      if (!disposed) {
        loadError = summary === null;
      }
    }
    schedule();
  }

  function schedule() {
    clearTimeout(timer);
    if (!disposed && repair?.status === 'running') {
      timer = setTimeout(() => void load(), REPAIR_POLL_MS);
    }
  }

  function setRepair(next: RawRepair | null) {
    repair = next;
    storageFailed = !saveRepair(next);
  }

  async function repairFiles(ids: string[]) {
    if (ids.length === 0 || repairing || starting) {
      return;
    }
    starting = true;
    actionError = '';
    try {
      await runAssetJobs({ assetJobsDto: { assetIds: ids, name: AssetJobName.RegenerateThumbnail } });
      setRepair(startRepair(ids));
      hide();
      schedule();
    } catch {
      actionError = $t('frameleaf_raw_support_repair_failed');
    } finally {
      starting = false;
    }
  }

  function action(item: RawSupportItemDto) {
    if (REPAIRABLE.has(item.status)) {
      void repairFiles([item.assetId]);
    } else {
      show('details');
    }
  }

  onMount(() => void load());
  onDestroy(() => {
    disposed = true;
    clearTimeout(timer);
  });
</script>

<div class="raw-care">
  <header class="raw-care-header">
    <div>
      <p class="raw-eyebrow">{$t('frameleaf_raw_support_eyebrow')}</p>
      <h1>{$t('frameleaf_raw_support_title')}</h1>
      <p class="raw-muted">{$t('frameleaf_raw_support_lead')}</p>
    </div>
    <span class="raw-grow"></span>
    <span class="raw-core-badge"
      ><Icon icon={mdiCheckCircleOutline} size="1rem" aria-hidden={true} />{$t('frameleaf_raw_support_included')}</span
    >
    <a class="raw-back fl-control" href={Route.photos()}
      ><Icon icon={mdiArrowLeft} size="1rem" aria-hidden={true} />{$t('frameleaf_raw_support_library')}</a
    >
  </header>

  <div class="raw-core-note">
    <Icon icon={mdiCameraOutline} size="1.5rem" aria-hidden={true} />
    <div>
      <strong>{$t('frameleaf_raw_support_core_title')}</strong>
      <p>{$t('frameleaf_raw_support_core_body')}</p>
    </div>
    <span class="raw-grow"></span>
    <span class="raw-core-where">{$t('frameleaf_raw_support_on_this_server')}</span>
  </div>

  <nav class="raw-tabs" aria-label={$t('frameleaf_raw_support_title')}>
    <button type="button" aria-current={tab === 'health' ? 'page' : undefined} onclick={() => (tab = 'health')}
      >{$t('frameleaf_raw_support_tab_health')}{#if summary}<span>{summary.total}</span>{/if}</button
    >
    <button type="button" aria-current={tab === 'formats' ? 'page' : undefined} onclick={() => (tab = 'formats')}
      >{$t('frameleaf_raw_support_tab_formats')}</button
    >
    <span class="raw-grow"></span>
    <Button disabled={repairIds.length === 0 || repairing} onclick={() => show('repair')}
      ><Icon icon={mdiRefresh} size="1rem" aria-hidden={true} />{$t('frameleaf_raw_support_reprocess')}</Button
    >
  </nav>

  {#if storageFailed}<p class="raw-alert" role="alert">{$t('frameleaf_raw_support_storage_failed')}</p>{/if}
  {#if actionError}<InlineError compact message={actionError} />{/if}

  {#if repair && !repair.hidden}
    <section class="raw-job" aria-label={$t('frameleaf_raw_support_repair_progress')}>
      <Icon
        icon={repair.status === 'complete' ? mdiCheckCircleOutline : mdiProgressClock}
        size="1.5rem"
        aria-hidden={true}
      />
      <div>
        <strong
          >{repair.status === 'complete'
            ? $t('frameleaf_raw_support_repair_complete')
            : repair.status === 'stalled'
              ? $t('frameleaf_raw_support_repair_stalled')
              : $t('frameleaf_raw_support_repair_running')}</strong
        >
        <p>
          {$t('frameleaf_raw_support_repair_count', {
            values: { done: repair.done.length, total: repair.ids.length },
          })}
        </p>
        <progress max={repair.ids.length || 1} value={repair.done.length}></progress>
      </div>
      <span class="raw-grow"></span>
      <Button
        label={$t('frameleaf_raw_support_repair_hide')}
        onclick={() => setRepair(repair!.status === 'running' ? { ...repair!, hidden: true } : null)}
        ><Icon icon={mdiClose} size="1rem" aria-hidden={true} /></Button
      >
    </section>
  {/if}

  {#if loadError}
    <InlineError message={$t('frameleaf_raw_support_load_failed')} onRetry={() => void load()} />
  {:else if !summary}
    <div class="raw-health-body" role="status" aria-label={$t('frameleaf_raw_support_loading')}>
      <div class="raw-list">
        {#each [0, 1, 2] as placeholder (placeholder)}<Skeleton variant="tile" />{/each}
      </div>
      <Skeleton variant="tile" />
    </div>
  {:else if tab === 'formats'}
    <section class="raw-formats">
      <h2>{$t('frameleaf_raw_support_formats_title')}</h2>
      <p class="raw-muted">{$t('frameleaf_raw_support_formats_lead')}</p>
      <div class="raw-table-wrap">
        <table>
          <thead>
            <tr>
              <th>{$t('frameleaf_raw_support_col_format')}</th>
              <th>{$t('frameleaf_raw_support_col_viewing')}</th>
              <th>{$t('frameleaf_raw_support_col_development')}</th>
              <th>{$t('frameleaf_raw_support_col_qualification')}</th>
            </tr>
          </thead>
          <tbody>
            {#each rows as row (row.label)}
              <tr>
                <td>
                  <strong>{row.label}</strong>
                  <small
                    >{[
                      row.maker,
                      row.count > 0 ? $t('frameleaf_raw_support_in_library', { values: { count: row.count } }) : '',
                      row.attention > 0
                        ? $t('frameleaf_raw_support_needs_attention', { values: { count: row.attention } })
                        : '',
                    ]
                      .filter(Boolean)
                      .join(' · ')}</small
                  >
                </td>
                <td>
                  {summary.decoder.available
                    ? $t('frameleaf_raw_support_viewing_ready')
                    : $t('frameleaf_raw_support_viewing_missing')}
                </td>
                <td>
                  {summary.developer.available
                    ? $t('frameleaf_raw_support_development_ready')
                    : $t('frameleaf_raw_support_development_missing')}
                </td>
                <td>
                  <span class="raw-status" class:raw-status-ready={row.tested.length > 0}
                    >{row.tested.length > 0
                      ? $t('frameleaf_raw_support_tested_with', { values: { cameras: row.tested.join(', ') } })
                      : $t('frameleaf_raw_support_not_tested')}</span
                  >
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <p class="raw-matrix-note">
        <Icon icon={mdiInformationOutline} size="1.25rem" aria-hidden={true} />
        {$t('frameleaf_raw_support_matrix_note')}
      </p>
    </section>
  {:else if items.length === 0}
    <div class="raw-empty">
      <Icon icon={mdiCameraOutline} size="2rem" aria-hidden={true} />
      <h2>{$t('frameleaf_raw_support_empty_title')}</h2>
      <p>{$t('frameleaf_raw_support_empty_body')}</p>
    </div>
  {:else if selected && copy}
    <div class="raw-health-body">
      <section class="raw-list" aria-label={$t('frameleaf_raw_support_files')}>
        {#each items as item (item.assetId)}
          <button
            type="button"
            class:selected={item.assetId === selected.assetId}
            aria-pressed={item.assetId === selected.assetId}
            onclick={() => (selectedId = item.assetId)}
          >
            <span class="raw-list-thumb"><PhotographyThumb src={thumbnail(item)} /></span>
            <div>
              <strong>{item.fileName}</strong>
              <small>{cameraName(item) || item.extension.toUpperCase()}</small>
              <span
                class="raw-status"
                class:raw-status-ready={item.status === RawSupportStatus.Ready}
                class:raw-status-warning={WARNING.has(item.status)}>{$t(RAW_STATUS_COPY[item.status].label)}</span
              >
            </div>
            <Icon icon={mdiChevronRight} size="1.1rem" aria-hidden={true} />
          </button>
        {/each}
        {#if summary.total > items.length}<p class="raw-muted raw-list-more">
            {$t('frameleaf_raw_support_list_more', { values: { shown: items.length, total: summary.total } })}
          </p>{/if}
      </section>
      <section class="raw-detail" aria-label={$t('frameleaf_raw_support_file_details')}>
        <div class="raw-preview">
          {#key selected.assetId}<PhotographyThumb
              src={preview(selected)}
              alt={$t('frameleaf_raw_support_preview_of', { values: { name: selected.fileName } })}
              loading="eager"
            />{/key}
          <span class="raw-source"
            >{selected.source === RawSupportSource.Sensor
              ? $t('frameleaf_raw_support_source_sensor')
              : selected.source === RawSupportSource.Embedded
                ? $t('frameleaf_raw_support_source_embedded')
                : $t('frameleaf_raw_support_source_none')}</span
          >
          <button
            type="button"
            class="raw-zoom-button fl-control"
            disabled={selected.source === RawSupportSource.None}
            onclick={() => show('zoom')}
            ><Icon icon={mdiMagnifyPlusOutline} size="1rem" aria-hidden={true} />{$t(
              'frameleaf_raw_support_full_view',
            )}</button
          >
        </div>
        <div class="raw-provenance">
          <div>
            <h2>{selected.fileName}</h2>
            <p>
              {[cameraName(selected), selected.width && selected.height ? `${selected.width} × ${selected.height}` : '']
                .filter(Boolean)
                .join(' · ')}
            </p>
          </div>
          <span
            class="raw-status"
            class:raw-status-ready={selected.status === RawSupportStatus.Ready}
            class:raw-status-warning={WARNING.has(selected.status)}>{$t(copy.label)}</span
          >
        </div>
        <p>
          {selected.status === RawSupportStatus.Ready && !selected.hasFullsize
            ? $t('frameleaf_raw_support_detail_ready_preview_size')
            : $t(copy.detail)}
        </p>
        <dl>
          <div>
            <dt>{$t('frameleaf_raw_support_dt_source')}</dt>
            <dd>{$t('frameleaf_raw_support_file_type', { values: { type: selected.extension.toUpperCase() } })}</dd>
          </div>
          <div>
            <dt>{$t('frameleaf_raw_support_dt_profile')}</dt>
            <dd>
              {selected.source === RawSupportSource.Sensor
                ? summary.colorspace === Colorspace.Srgb
                  ? $t('frameleaf_raw_support_profile_srgb')
                  : $t('frameleaf_raw_support_profile_p3')
                : selected.source === RawSupportSource.Embedded
                  ? $t('frameleaf_raw_support_profile_embedded')
                  : $t('frameleaf_raw_support_profile_none')}
            </dd>
          </div>
          <div>
            <dt>{$t('frameleaf_raw_support_dt_original')}</dt>
            <dd>
              <Icon icon={mdiShieldCheckOutline} size="0.95rem" aria-hidden={true} />{$t(
                'frameleaf_raw_support_original_preserved',
              )}
            </dd>
          </div>
          {#if selected.pairedFileName}<div>
              <dt>{$t('frameleaf_raw_support_dt_stack')}</dt>
              <dd>{selected.pairedFileName}</dd>
            </div>{/if}
        </dl>
        <div class="raw-detail-actions">
          {#if copy.action}<Button
              variant="primary"
              disabled={REPAIRABLE.has(selected.status) && (repairing || starting)}
              onclick={() => action(selected)}>{$t(copy.action)}</Button
            >{/if}
          <a class="fl-control" href={Route.photography()}
            ><Icon icon={mdiCameraIris} size="1rem" aria-hidden={true} />{$t(
              'frameleaf_raw_support_open_photography',
            )}</a
          >
        </div>
      </section>
    </div>
  {/if}
</div>

{#if dialog === 'repair'}
  <Dialog
    title={$t('frameleaf_raw_support_reprocess')}
    closeLabel={$t('close')}
    bind:open={dialogOpen}
    onClosed={() => (dialog = null)}
  >
    <p>{$t('frameleaf_raw_support_repair_body', { values: { count: repairIds.length } })}</p>
    <p>{$t('frameleaf_raw_support_repair_keep')}</p>
    <div class="raw-repair-note">
      <Icon icon={mdiHarddisk} size="1.25rem" aria-hidden={true} />{$t('frameleaf_raw_support_repair_note')}
    </div>
    {#snippet actions()}
      <Button onclick={hide}>{$t('cancel')}</Button>
      <Button variant="primary" disabled={starting} onclick={() => void repairFiles(repairIds)}
        ><Icon icon={mdiRefresh} size="1rem" aria-hidden={true} />{$t('frameleaf_raw_support_repair_start')}</Button
      >
    {/snippet}
  </Dialog>
{:else if dialog === 'zoom' && selected}
  <Dialog
    title={selected.fileName}
    closeLabel={$t('close')}
    size="wide"
    bind:open={dialogOpen}
    onClosed={() => (dialog = null)}
  >
    <img
      class="raw-zoom"
      src={preview(selected, selected.hasFullsize ? AssetMediaSize.Fullsize : AssetMediaSize.Preview)}
      alt={$t('frameleaf_raw_support_preview_of', { values: { name: selected.fileName } })}
    />
    <p class="raw-muted">
      {selected.hasFullsize ? $t('frameleaf_raw_support_zoom_full') : $t('frameleaf_raw_support_zoom_preview')}
    </p>
  </Dialog>
{:else if dialog === 'details' && selected && copy}
  <Dialog title={$t(copy.label)} closeLabel={$t('close')} bind:open={dialogOpen} onClosed={() => (dialog = null)}>
    <p>{$t(copy.detail)}</p>
    <p>{[cameraName(selected), selected.extension.toUpperCase()].filter(Boolean).join(' · ')}</p>
    <p class="raw-muted">
      {summary?.decoder.version
        ? $t('frameleaf_raw_support_decoder_version', { values: { version: summary.decoder.version } })
        : summary?.decoder.available
          ? $t('frameleaf_raw_support_viewing_ready')
          : $t('frameleaf_raw_support_viewing_missing')}
    </p>
    {#snippet actions()}
      <Button
        onclick={() => {
          tab = 'formats';
          hide();
        }}>{$t('frameleaf_raw_support_tab_formats')}</Button
      >
      <Button variant="primary" onclick={hide}>{$t('done')}</Button>
    {/snippet}
  </Dialog>
{/if}

<style>
  .raw-care {
    min-width: 0;
    padding: var(--fl-space-5) var(--fl-space-6) var(--fl-space-4);
    color: var(--fl-text);
  }
  .raw-care-header {
    display: flex;
    align-items: center;
    gap: var(--fl-space-3);
    margin-bottom: 22px;
  }
  .raw-care-header p {
    margin: 0;
  }
  .raw-care-header .raw-muted {
    font-size: 15px;
  }
  .raw-eyebrow {
    font: var(--fl-type-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--fl-muted);
  }
  .raw-care h1 {
    font-size: 28px;
    font-weight: 700;
    margin: 5px 0 6px;
    letter-spacing: -0.8px;
  }
  .raw-muted {
    color: var(--fl-muted);
  }
  .raw-grow {
    flex: 1;
  }
  .raw-core-badge {
    color: var(--fl-accent);
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: var(--fl-font-small);
    white-space: nowrap;
  }
  .raw-back,
  .raw-detail-actions a {
    display: inline-flex;
    align-items: center;
    gap: var(--fl-space-2);
    padding: 0.4375rem 0.75rem;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    white-space: nowrap;
  }
  .raw-core-note {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 17px 20px;
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  .raw-core-note > :global(svg:first-child) {
    color: var(--fl-accent);
    flex-shrink: 0;
  }
  .raw-core-note strong {
    font-size: 15px;
  }
  .raw-core-note p {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    margin: 5px 0 0;
    max-width: 640px;
    line-height: 1.6;
  }
  .raw-core-where {
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
    white-space: nowrap;
  }
  .raw-tabs {
    display: flex;
    gap: 22px;
    align-items: center;
    margin: var(--fl-space-6) 0 20px;
    border-bottom: 1px solid var(--fl-border);
    padding-bottom: var(--fl-space-3);
  }
  .raw-tabs > button:not(.fl-control) {
    border: 0;
    background: transparent;
    color: var(--fl-muted);
    font: inherit;
    font-size: var(--fl-font-callout);
    cursor: pointer;
    padding: 0;
  }
  .raw-tabs > button[aria-current] {
    color: var(--fl-text);
    font-weight: 600;
  }
  .raw-tabs button span {
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
    font-weight: 400;
    padding-left: var(--fl-space-2);
  }
  .raw-alert {
    font-size: var(--fl-font-small);
    color: var(--fl-warning);
  }
  .raw-health-body {
    display: grid;
    grid-template-columns: 310px minmax(0, 1fr);
    gap: var(--fl-space-6);
    max-width: 1220px;
  }
  .raw-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  .raw-list > button {
    display: flex;
    gap: var(--fl-space-3);
    align-items: center;
    text-align: left;
    border: 1px solid transparent;
    border-radius: var(--fl-radius-card);
    background: transparent;
    color: var(--fl-text);
    padding: 10px;
    cursor: pointer;
    font: inherit;
  }
  .raw-list > button:hover {
    background: var(--fl-raised);
  }
  .raw-list > button.selected {
    background: var(--fl-panel);
    border-color: var(--fl-border);
  }
  .raw-list-thumb {
    display: block;
    width: 62px;
    height: 72px;
    flex-shrink: 0;
    overflow: hidden;
    border-radius: var(--fl-radius-sm);
  }
  .raw-list-thumb :global(img) {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .raw-list > button > div {
    flex: 1;
    min-width: 0;
  }
  .raw-list strong,
  .raw-list small {
    display: block;
    font-size: var(--fl-font-small);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .raw-list small {
    color: var(--fl-muted);
    margin: 5px 0 var(--fl-space-2);
    font-size: var(--fl-font-micro);
  }
  .raw-list-more {
    font-size: var(--fl-font-micro);
    padding: var(--fl-space-2) 10px;
  }
  .raw-status {
    display: inline-flex;
    align-items: center;
    border-radius: var(--fl-radius-sm);
    padding: 4px 7px;
    font-size: 10px;
    color: var(--fl-muted);
    background: var(--fl-raised);
  }
  .raw-status-ready {
    color: var(--fl-accent);
    background: color-mix(in srgb, var(--fl-accent) 10%, transparent);
  }
  .raw-status-warning {
    color: var(--fl-warning);
  }
  .raw-detail {
    min-width: 0;
  }
  .raw-preview {
    position: relative;
    height: 360px;
    background: var(--fl-panel);
    border-radius: var(--fl-radius-card);
    overflow: hidden;
  }
  .raw-preview :global(img) {
    width: 100%;
    height: 100%;
    object-fit: contain;
    display: block;
  }
  .raw-source {
    position: absolute;
    bottom: 14px;
    left: 14px;
    border-radius: var(--fl-radius-sm);
    background: #111b;
    color: #fff;
    padding: 6px 9px;
    font-size: 10px;
  }
  .raw-zoom-button {
    position: absolute;
    bottom: 14px;
    right: 14px;
    display: inline-flex;
    align-items: center;
    gap: var(--fl-space-2);
    padding: 0.4375rem 0.75rem;
    border-radius: var(--fl-radius-control);
    background: #101416cc;
    color: #fff;
    border: 1px solid #ffffff36;
    cursor: pointer;
  }
  .raw-zoom-button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .raw-provenance {
    display: flex;
    align-items: center;
    gap: var(--fl-space-3);
    margin-top: 20px;
    justify-content: space-between;
  }
  .raw-provenance h2 {
    margin: 0;
    font-size: 17px;
    font-weight: 600;
    letter-spacing: -0.2px;
    overflow-wrap: anywhere;
  }
  .raw-provenance p {
    margin: 5px 0 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
  }
  .raw-detail > p {
    font-size: var(--fl-font-small);
    line-height: 1.6;
    color: var(--fl-muted);
    margin: 14px 0;
  }
  .raw-detail dl {
    display: flex;
    flex-direction: column;
    gap: 10px;
    font-size: var(--fl-font-micro);
    padding: 0 0 17px;
    margin: 0;
  }
  .raw-detail dl > div {
    display: flex;
    gap: var(--fl-space-4);
  }
  .raw-detail dt {
    width: 104px;
    color: var(--fl-muted);
    flex-shrink: 0;
  }
  .raw-detail dd {
    margin: 0;
    display: flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .raw-detail-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-2);
  }
  .raw-job {
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 14px 18px;
    margin-bottom: 20px;
    background: var(--fl-panel);
  }
  .raw-job strong {
    font-size: var(--fl-font-small);
  }
  .raw-job p {
    margin: 5px 0 var(--fl-space-2);
    font-size: var(--fl-font-micro);
    color: var(--fl-muted);
  }
  .raw-job progress {
    display: block;
    height: 5px;
    width: 250px;
    max-width: 100%;
    accent-color: var(--fl-accent);
  }
  .raw-formats {
    max-width: 1160px;
  }
  .raw-formats h2 {
    font-size: var(--fl-font-headline);
    font-weight: 600;
    margin: 0 0 var(--fl-space-2);
  }
  .raw-formats > p {
    font-size: var(--fl-font-small);
    line-height: 1.6;
    margin: 0;
  }
  .raw-table-wrap {
    overflow: auto;
  }
  .raw-formats table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--fl-font-small);
    margin: 22px 0;
    text-align: left;
  }
  .raw-formats td,
  .raw-formats th {
    padding: 15px;
    border-bottom: 1px solid var(--fl-border);
  }
  .raw-formats th {
    color: var(--fl-muted);
    font-size: 10px;
    font-weight: 500;
  }
  .raw-formats td small {
    display: block;
    font-size: 10px;
    color: var(--fl-muted);
    margin-top: 5px;
  }
  .raw-matrix-note,
  .raw-repair-note {
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--fl-muted);
  }
  .raw-matrix-note {
    font-size: var(--fl-font-small);
  }
  .raw-repair-note {
    font-size: var(--fl-font-micro);
    padding: 14px;
    margin-top: var(--fl-space-4);
    background: var(--fl-raised);
    border-radius: var(--fl-radius-sm);
  }
  .raw-zoom {
    width: 100%;
    max-height: 70vh;
    object-fit: contain;
  }
  .raw-empty {
    display: grid;
    justify-items: center;
    gap: var(--fl-space-2);
    padding: 64px var(--fl-space-4);
    color: var(--fl-muted);
    text-align: center;
  }
  .raw-empty h2 {
    color: var(--fl-text);
    font-size: var(--fl-font-headline);
    font-weight: 600;
    margin: 0;
  }
  .raw-empty p {
    margin: 0;
  }
  @media (max-width: 1100px) {
    .raw-care {
      padding: var(--fl-space-4) var(--fl-space-3);
    }
    .raw-health-body {
      grid-template-columns: 245px minmax(0, 1fr);
      gap: var(--fl-space-4);
    }
    .raw-core-where {
      display: none;
    }
    .raw-core-badge {
      max-width: 100px;
      white-space: normal;
    }
  }
  @media (max-width: 700px) {
    .raw-care {
      padding: var(--fl-space-3) var(--fl-space-2);
    }
    .raw-care-header {
      flex-wrap: wrap;
    }
    .raw-care-header > .raw-grow {
      display: none;
    }
    .raw-core-badge {
      max-width: none;
    }
    .raw-core-note {
      padding: 14px;
    }
    .raw-tabs {
      flex-wrap: wrap;
      gap: var(--fl-space-4);
    }
    .raw-tabs > .raw-grow {
      display: none;
    }
    .raw-health-body {
      grid-template-columns: 1fr;
    }
    .raw-list {
      flex-direction: row;
      overflow: auto;
      padding-bottom: 4px;
    }
    .raw-list > button {
      flex: 0 0 210px;
    }
    .raw-preview {
      height: 280px;
    }
    .raw-job {
      flex-wrap: wrap;
    }
    .raw-job > .raw-grow {
      display: none;
    }
  }
</style>
