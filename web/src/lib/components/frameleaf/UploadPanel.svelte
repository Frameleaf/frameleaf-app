<script lang="ts">
  import '$lib/frameleaf/tokens.css';
  import { cancelRemainingUploads, retryFailedUploads, uploadExecutionQueue } from '$lib/utils/file-uploader';
  import { locale } from '$lib/stores/preferences.store';
  import { uploadAssetsStore } from '$lib/stores/upload';
  import { UploadState, type UploadAsset } from '$lib/types';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import { acquireWakeLock, releaseWakeLock } from '$lib/utils/wakelock.svelte';
  import { Icon, Theme as AppTheme, themeManager } from '@frameleaf/ui';
  import {
    mdiAlertCircleOutline,
    mdiCheckCircle,
    mdiChevronDown,
    mdiClose,
    mdiCloudCheckOutline,
    mdiContentDuplicate,
    mdiImageOutline,
    mdiProgressUpload,
    mdiRefresh,
    mdiTrashCan,
    mdiVideoOutline,
  } from '@mdi/js';
  import { onDestroy } from 'svelte';
  import { t } from 'svelte-i18n';
  import { dock } from '$lib/frameleaf/motion';
  import { EXIT_DURATION } from '$lib/frameleaf/tokens';
  import { Route } from '$lib/route';
  import { mediaQueryManager } from '$lib/stores/media-query-manager.svelte';

  /**
   * Upload panel (FL-45), ported from the prototype's `UploadPanel` in
   * `design/frameleaf/template/src/UploadPanel.jsx` onto the real upload manager:
   * `uploadAssetsStore` carries per-file state and `uploadExecutionQueue` the concurrency,
   * exactly what the legacy `routes/UploadPanel.svelte` displayed. Nothing here is a timer
   * simulation: every row reflects a real `fileUploadHandler` request.
   *
   * The overall bar keeps its colour when a file fails: the failed share is a danger segment at
   * its end and the count is in the header, so one bad file in five hundred does not read as a
   * failed upload. The parallel-uploads tuning sits behind Options. On phones the panel starts as
   * its pill so it never opens over the photos uninvited.
   */

  const { stats, isUploading, remainingUploads } = uploadAssetsStore;

  let minimized = $state(false);
  let concurrency = $state(uploadExecutionQueue.concurrency);
  const appTheme = $derived(themeManager.value === AppTheme.Dark ? 'dark' : 'light');

  const active = $derived($remainingUploads > 0);
  /** Finished rows ("Clear finished" is offered while uploads continue, UploadPanel.jsx). */
  const finishedCount = $derived(
    $uploadAssetsStore.filter((item) => item.state === UploadState.DONE || item.state === UploadState.DUPLICATED)
      .length,
  );

  $effect(() => {
    if ($isUploading) {
      minimized = mediaQueryManager.maxMd;
    }
  });

  /**
   * Closing the panel (Close, Done, Show in Recently added): it leaves on the Dock exit with what
   * it was showing, and the list is cleared once it has gone, so the last frame is never an empty
   * panel. If more files were added in the meantime the panel simply comes back with them.
   */
  let leaving = $state(false);
  let leaveTimer: ReturnType<typeof setTimeout> | undefined;
  const afterLeave = () => {
    clearTimeout(leaveTimer);
    if (!leaving) {
      return;
    }
    leaving = false;
    if ($remainingUploads === 0) {
      uploadAssetsStore.reset();
    }
  };
  const dismiss = () => {
    if (leaving) {
      return;
    }
    leaving = true;
    // The exit normally reports its own end; this is for a browser that never does.
    leaveTimer = setTimeout(afterLeave, EXIT_DURATION.dock + 150);
  };
  onDestroy(() => clearTimeout(leaveTimer));

  $effect(() => {
    if (active) {
      void acquireWakeLock();
    } else {
      void releaseWakeLock();
    }
  });

  const totalBytes = $derived($uploadAssetsStore.reduce((sum, item) => sum + item.file.size, 0));
  const weightedBytes = $derived.by(() => {
    let sum = 0;
    for (const item of $uploadAssetsStore) {
      if (item.state === UploadState.STARTED) {
        sum += (item.file.size * (item.progress ?? 0)) / 100;
      } else if (item.state !== UploadState.PENDING) {
        // Done, duplicate and failed rows are finished, as in the prototype's `uploadSummary`.
        sum += item.file.size;
      }
    }
    return sum;
  });
  const percent = $derived(totalBytes > 0 ? Math.round((weightedBytes / totalBytes) * 100) : 0);
  /** The share of the batch, by size, that failed: drawn as the bar's danger segment. */
  const failedPercent = $derived.by(() => {
    if (totalBytes <= 0) {
      return 0;
    }
    let failed = 0;
    for (const item of $uploadAssetsStore) {
      if (item.state === UploadState.ERROR) {
        failed += item.file.size;
      }
    }
    // A failure is always visible, however small its file was.
    return failed > 0 ? Math.min(percent, Math.max(2, Math.round((failed / totalBytes) * 100))) : 0;
  });

  /** `uploadSummary` (system-data.mjs:422-423): "Uploading 3 of 10" counts the file in flight. */
  const processed = $derived(Math.min($stats.total, $stats.total - $remainingUploads + 1));
  const label = $derived(
    active
      ? $t('frameleaf_transfer_uploading_count', { values: { processed, total: $stats.total } })
      : $stats.errors > 0
        ? $t('frameleaf_transfer_upload_needs_attention', { values: { count: $stats.errors } })
        : $t('frameleaf_transfer_upload_complete'),
  );

  /** The header's second line, also read out by the minimised pill (`UploadPanel.jsx:296-302`). */
  const counts = $derived(
    [
      $t('frameleaf_transfer_count_uploaded', { values: { count: $stats.success } }),
      $stats.duplicates ? $t('frameleaf_transfer_count_duplicates', { values: { count: $stats.duplicates } }) : null,
      $stats.errors ? $t('frameleaf_transfer_count_failed', { values: { count: $stats.errors } }) : null,
    ]
      .filter(Boolean)
      .join(' · '),
  );

  /**
   * The prototype's row status names (`UploadPanel.jsx:257-268`) for `data-status`: `UploadState` is
   * a numeric enum, so a selector on the raw value would never match.
   */
  const STATUS_ATTRIBUTE: Record<UploadState, string> = {
    [UploadState.PENDING]: 'queued',
    [UploadState.STARTED]: 'uploading',
    [UploadState.DONE]: 'done',
    [UploadState.DUPLICATED]: 'duplicate',
    [UploadState.ERROR]: 'error',
  };

  /** `STATUS_TEXT` in `UploadPanel.jsx:262-268`. */
  const statusText = (item: UploadAsset) => {
    switch (item.state) {
      case UploadState.STARTED: {
        return `${$t('frameleaf_transfer_status_uploading')} ${Math.round(item.progress ?? 0)}%`;
      }
      case UploadState.DONE: {
        return $t('asset_uploaded');
      }
      case UploadState.DUPLICATED: {
        return $t(item.isTrashed ? 'asset_skipped_in_trash' : 'frameleaf_transfer_status_duplicate');
      }
      default: {
        return $t('frameleaf_transfer_status_pending');
      }
    }
  };

  const thumbnail = (node: HTMLImageElement, file: File) => {
    let url: string | undefined;
    if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function' && file.type.startsWith('image/')) {
      url = URL.createObjectURL(file);
      node.src = url;
    }
    return {
      destroy() {
        if (url) {
          URL.revokeObjectURL(url);
        }
      },
    };
  };
</script>

{#if $isUploading && !leaving}
  <div class="frameleaf fl-panel-wrap" data-theme={appTheme}>
    {#if minimized}
      <!-- UploadPanel.jsx:315-326: ring, label and overall percent. -->
      <button
        type="button"
        class="fl-pill"
        in:dock|global
        out:dock|global
        onoutroend={afterLeave}
        aria-label={`${$t('frameleaf_transfer_show_uploads')}. ${label}. ${counts}`}
        onclick={() => (minimized = false)}
      >
        <span class="fl-ring" style={`--pct: ${percent}`} aria-hidden="true"></span>
        <strong>{label}</strong>
        <span>{percent}%</span>
      </button>
    {:else}
      <section
        class="fl-panel"
        aria-label={$t('frameleaf_transfer_uploads')}
        in:dock|global
        out:dock|global
        onoutroend={afterLeave}
      >
        <header class="fl-panel-head">
          {#if active || $stats.errors > 0}
            <Icon icon={active ? mdiProgressUpload : mdiCloudCheckOutline} size="20" aria-hidden="true" />
          {:else}
            <!-- Finished with nothing to look at: the done mark unfurls once (a fade under Reduce Motion). -->
            <span class="fl-done-mark fl-unfurl" aria-hidden="true">
              <Icon icon={mdiCloudCheckOutline} size="20" />
            </span>
          {/if}
          <div class="fl-panel-head-text">
            <strong aria-live="polite">{label}</strong>
            <span>{counts} · {getByteUnitString(totalBytes, $locale)}</span>
          </div>
          <button
            type="button"
            class="fl-icon-button"
            aria-label={$t('frameleaf_transfer_minimize_uploads')}
            onclick={() => (minimized = true)}
          >
            <Icon icon={mdiChevronDown} size="18" aria-hidden="true" />
          </button>
          {#if !active}
            <button
              type="button"
              class="fl-icon-button"
              aria-label={$t('frameleaf_transfer_close_uploads')}
              onclick={dismiss}
            >
              <Icon icon={mdiClose} size="18" aria-hidden="true" />
            </button>
          {/if}
        </header>

        <div
          class="fl-progress"
          class:has-errors={$stats.errors > 0}
          role="progressbar"
          aria-label={$t('frameleaf_transfer_overall_progress')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <span style={`width: ${percent - failedPercent}%`}></span>
          {#if failedPercent > 0}
            <span class="fl-progress-failed" style={`width: ${failedPercent}%`}></span>
          {/if}
        </div>

        <ul class="fl-list">
          {#each $uploadAssetsStore as item (item.id)}
            <li class="fl-row" data-status={STATUS_ATTRIBUTE[item.state ?? UploadState.PENDING]}>
              <span class="fl-thumb">
                {#if item.file.type.startsWith('image/')}
                  <img use:thumbnail={item.file} alt="" />
                {:else}
                  <Icon
                    icon={item.file.type.startsWith('video/') ? mdiVideoOutline : mdiImageOutline}
                    size="18"
                    aria-hidden="true"
                  />
                {/if}
              </span>
              <span class="fl-name" title={item.file.name}>{item.file.name}</span>
              <span class="fl-state">
                {#if item.state === UploadState.PENDING || item.state === UploadState.STARTED}
                  <span
                    class="fl-ring"
                    style={`--pct: ${item.progress ?? 0}`}
                    role="progressbar"
                    aria-label={$t('frameleaf_transfer_progress', { values: { name: item.file.name } })}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(item.progress ?? 0)}
                  ></span>
                {:else if item.state === UploadState.DONE}
                  <Icon icon={mdiCheckCircle} size="18" class="fl-success" aria-hidden="true" />
                  <span class="fl-sr-only">{statusText(item)}</span>
                {:else if item.state === UploadState.DUPLICATED}
                  {#if item.isTrashed}
                    <Icon icon={mdiTrashCan} size="18" class="fl-muted-icon" aria-hidden="true" />
                  {:else}
                    <Icon icon={mdiContentDuplicate} size="18" class="fl-warning" aria-hidden="true" />
                  {/if}
                  <span class="fl-sr-only">{statusText(item)}</span>
                {:else if item.state === UploadState.ERROR}
                  <Icon icon={mdiAlertCircleOutline} size="18" class="fl-danger" aria-hidden="true" />
                  <span class="fl-sr-only">{$t('frameleaf_transfer_status_failed')}</span>
                {/if}
              </span>
              <span class="fl-meta">
                {#if item.state === UploadState.ERROR}
                  {typeof item.error === 'string' ? item.error : $t('frameleaf_transfer_status_failed')}
                {:else}
                  {getByteUnitString(item.file.size, $locale)} · {statusText(item)}
                {/if}
              </span>
              {#if item.state === UploadState.STARTED}
                <span class="fl-mini" aria-hidden="true">
                  <span style={`width: ${item.progress ?? 0}%`}></span>
                </span>
              {/if}
            </li>
          {/each}
        </ul>

        <footer class="fl-panel-foot">
          <!-- Tuning, not something an upload should ask about: it waits behind Options. -->
          <details class="fl-options">
            <summary>{$t('frameleaf_transfer_options')}</summary>
            <label class="fl-concurrency">
              {$t('frameleaf_transfer_parallel_uploads')}
              <input
                type="range"
                min="1"
                max="10"
                step="1"
                bind:value={concurrency}
                onchange={() => (uploadExecutionQueue.concurrency = concurrency)}
              />
              <output>{concurrency}</output>
            </label>
          </details>
          <div class="fl-panel-actions">
            {#if $stats.errors > 0}
              <button type="button" class="fl-button" onclick={() => void retryFailedUploads()}>
                <Icon icon={mdiRefresh} size="16" aria-hidden="true" />
                {$t('frameleaf_transfer_retry_failed')}
              </button>
            {/if}
            {#if $stats.errors > 0}
              <button type="button" class="fl-button" onclick={() => uploadAssetsStore.dismissErrors()}>
                {$t('frameleaf_transfer_dismiss_errors')}
              </button>
            {/if}
            {#if active && finishedCount > 0}
              <button type="button" class="fl-button" onclick={() => uploadAssetsStore.clearFinished()}>
                {$t('frameleaf_transfer_clear_finished')}
              </button>
            {/if}
            {#if active}
              <button type="button" class="fl-button" onclick={() => cancelRemainingUploads()}>
                {$t('frameleaf_transfer_cancel_remaining')}
              </button>
            {:else if $stats.success > 0}
              <!-- The photos that just arrived are one press away; Done only puts the panel away. -->
              <button type="button" class="fl-button" onclick={dismiss}>
                {$t('done')}
              </button>
              <a class="fl-button fl-button-primary" href={Route.recentlyAdded()} onclick={dismiss}>
                {$t('frameleaf_transfer_show_recent')}
              </a>
            {:else}
              <button type="button" class="fl-button fl-button-primary" onclick={dismiss}>
                {$t('done')}
              </button>
            {/if}
          </div>
        </footer>
      </section>
    {/if}
  </div>
{/if}

<style>
  /*
   * The panel and its pill share one cell, anchored to the dock's corner, so minimising, restoring
   * and Done are a handover in place: the one leaving sinks and fades (Dock exit, 200ms) under the
   * one arriving, and nothing in the dock jumps while both are there.
   */
  .fl-panel-wrap {
    display: grid;
    justify-items: end;
    align-items: end;
    pointer-events: auto;
  }
  .fl-panel-wrap > :global(*) {
    grid-area: 1 / 1;
  }
  .fl-done-mark {
    display: inline-flex;
    flex-shrink: 0;
    color: var(--fl-accent);
  }
  .fl-panel {
    display: flex;
    flex-direction: column;
    width: 22rem;
    max-width: calc(100vw - 2rem);
    max-height: 32rem;
    color: var(--fl-text);
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    box-shadow: var(--fl-shadow-2);
    overflow: hidden;
  }
  .fl-panel-head {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.75rem;
    border-bottom: 1px solid var(--fl-border);
  }
  .fl-panel-head-text {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    min-width: 0;
    flex: 1;
  }
  .fl-panel-head-text strong {
    font-size: 0.875rem;
  }
  .fl-panel-head-text span {
    color: var(--fl-muted);
    font-size: 0.75rem;
  }
  .fl-icon-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0.25rem;
    color: var(--fl-muted);
    background: transparent;
    border: 0;
    border-radius: var(--fl-radius-control);
  }
  .fl-icon-button:hover {
    background: var(--fl-raised);
    color: var(--fl-text);
  }
  .fl-progress {
    position: relative;
    display: flex;
    inline-size: 100%;
    block-size: 0.25rem;
    background: var(--fl-raised);
  }
  .fl-progress span {
    display: block;
    block-size: 100%;
    background: var(--fl-teal);
    transition: width var(--fl-motion) var(--fl-ease);
  }
  .fl-progress .fl-progress-failed {
    background: var(--fl-danger);
  }
  .fl-options {
    flex: 1 1 100%;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .fl-options summary {
    display: inline-flex;
    align-items: center;
    min-height: var(--fl-control-compact);
    cursor: pointer;
  }
  .fl-options summary:hover {
    color: var(--fl-text);
  }
  a.fl-button {
    text-decoration: none;
  }
  .fl-list {
    list-style: none;
    margin: 0;
    padding: 0.375rem;
    overflow-y: auto;
    display: grid;
    gap: 0.25rem;
  }
  .fl-row {
    display: grid;
    grid-template-columns: 1.75rem 1fr auto;
    grid-template-areas: 'thumb name state' 'thumb meta state' 'thumb mini state';
    align-items: center;
    column-gap: 0.5rem;
    row-gap: 0.125rem;
    padding: 0.375rem 0.5rem;
    border-radius: var(--fl-radius-control);
  }
  .fl-row:hover {
    background: var(--fl-raised);
  }
  .fl-thumb {
    grid-area: thumb;
    display: flex;
    align-items: center;
    justify-content: center;
    inline-size: 1.75rem;
    block-size: 1.75rem;
    border-radius: var(--fl-radius-control-compact);
    overflow: hidden;
    color: var(--fl-muted);
    background: var(--fl-raised);
  }
  .fl-thumb img {
    inline-size: 100%;
    block-size: 100%;
    object-fit: cover;
  }
  .fl-name {
    grid-area: name;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.8125rem;
  }
  .fl-state {
    grid-area: state;
    display: inline-flex;
    justify-self: end;
  }
  .fl-meta {
    grid-area: meta;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--fl-muted);
    font-size: 0.6875rem;
  }
  .fl-row[data-status='error'] .fl-meta {
    color: var(--fl-danger);
  }
  /* upload.css:263-275: the thin per-row bar under an upload in flight. */
  .fl-mini {
    grid-area: mini;
    display: block;
    block-size: 0.1875rem;
    overflow: hidden;
    border-radius: 0.125rem;
    background: var(--fl-border);
  }
  .fl-mini span {
    display: block;
    block-size: 100%;
    background: var(--fl-teal);
    transition: width var(--fl-motion) linear;
  }
  :global(.fl-success) {
    color: var(--fl-teal);
  }
  :global(.fl-warning) {
    color: var(--fl-warning);
  }
  :global(.fl-danger) {
    color: var(--fl-danger);
  }
  :global(.fl-muted-icon) {
    color: var(--fl-muted);
  }
  .fl-sr-only {
    position: absolute;
    inline-size: 1px;
    block-size: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
  /* upload.css:245-262: a donut, the teal arc over the border colour with a panel-coloured hole. */
  .fl-ring {
    --pct: 0;
    display: inline-grid;
    place-items: center;
    inline-size: 1.375rem;
    block-size: 1.375rem;
    border-radius: 50%;
    background: conic-gradient(var(--fl-teal) calc(var(--pct) * 1%), var(--fl-border) 0);
  }
  .fl-ring::after {
    content: '';
    inline-size: 0.875rem;
    block-size: 0.875rem;
    border-radius: 50%;
    background: var(--fl-panel);
  }
  .fl-panel-foot {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.625rem 0.75rem;
    border-top: 1px solid var(--fl-border);
  }
  .fl-concurrency {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--fl-muted);
    font-size: 0.75rem;
  }
  .fl-concurrency input {
    flex: 1;
  }
  .fl-panel-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }
  .fl-button {
    padding: 0.375rem 0.75rem;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    font-size: 0.8125rem;
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
  }
  .fl-button:hover {
    background: color-mix(in srgb, var(--fl-raised), var(--fl-text) 8%);
  }
  .fl-button-primary {
    color: var(--fl-accent-text);
    background: var(--fl-accent);
    border-color: var(--fl-accent);
  }
  /* upload.css:317-348: a capsule with the ring, the label and the overall percent. */
  .fl-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.625rem;
    min-block-size: 2.5rem;
    padding: 0.375rem 0.875rem 0.375rem 0.5rem;
    color: var(--fl-text);
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-pill);
    box-shadow: var(--fl-shadow-2);
  }
  .fl-pill:hover {
    background: var(--fl-raised);
  }
  .fl-pill .fl-ring {
    inline-size: 1.625rem;
    block-size: 1.625rem;
  }
  .fl-pill .fl-ring::after {
    inline-size: 1.125rem;
    block-size: 1.125rem;
  }
  .fl-pill strong {
    font-size: 0.8125rem;
    font-weight: 600;
  }
  .fl-pill span:last-child {
    color: var(--fl-muted);
    font-size: 0.6875rem;
    font-variant-numeric: tabular-nums;
  }
</style>
