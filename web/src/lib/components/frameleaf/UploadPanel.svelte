<script lang="ts">
  import '$lib/frameleaf/tokens.css';
  import { cancelRemainingUploads, fileUploadHandler, uploadExecutionQueue } from '$lib/utils/file-uploader';
  import { Route } from '$lib/route';
  import { locale } from '$lib/stores/preferences.store';
  import { uploadAssetsStore } from '$lib/stores/upload';
  import { UploadState, type UploadAsset } from '$lib/types';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import { acquireWakeLock, releaseWakeLock } from '$lib/utils/wakelock.svelte';
  import { Icon, Theme as AppTheme, themeManager } from '@immich/ui';
  import {
    mdiAlertCircleOutline,
    mdiCheckCircle,
    mdiChevronDown,
    mdiCircleOutline,
    mdiClose,
    mdiCloudCheckOutline,
    mdiContentDuplicate,
    mdiImageOutline,
    mdiOpenInNew,
    mdiProgressUpload,
    mdiRefresh,
    mdiTrashCan,
    mdiVideoOutline,
  } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import { quartInOut } from 'svelte/easing';
  import { scale } from 'svelte/transition';

  /**
   * Upload panel (FL-45), ported from the prototype's `UploadPanel` in
   * `design/frameleaf/template/src/UploadPanel.jsx` onto the real upload manager:
   * `uploadAssetsStore` carries per-file state and `uploadExecutionQueue` the concurrency,
   * exactly what the legacy `routes/UploadPanel.svelte` displayed. Nothing here is a timer
   * simulation — every row reflects a real `fileUploadHandler` request.
   */

  const { stats, isDismissible, isUploading, remainingUploads } = uploadAssetsStore;

  let minimized = $state(false);
  let concurrency = $state(uploadExecutionQueue.concurrency);
  const appTheme = $derived(themeManager.value === AppTheme.Dark ? 'dark' : 'light');

  const active = $derived($remainingUploads > 0);

  $effect(() => {
    if ($isUploading) {
      minimized = false;
    }
  });

  $effect(() => {
    if (active) {
      void acquireWakeLock();
    } else {
      void releaseWakeLock();
    }
  });

  const totalBytes = $derived($uploadAssetsStore.reduce((sum, item) => sum + item.file.size, 0));
  const weightedBytes = $derived(
    $uploadAssetsStore.reduce((sum, item) => {
      if (item.state === UploadState.DONE || item.state === UploadState.DUPLICATED) {
        return sum + item.file.size;
      }
      if (item.state === UploadState.STARTED) {
        return sum + (item.file.size * (item.progress ?? 0)) / 100;
      }
      return sum;
    }, 0),
  );
  const percent = $derived(totalBytes > 0 ? Math.round((weightedBytes / totalBytes) * 100) : 0);

  const label = $derived(
    active
      ? $t('frameleaf_transfer_uploading_count', {
          values: { processed: $stats.total - $remainingUploads, total: $stats.total },
        })
      : $stats.errors > 0
        ? $t('frameleaf_transfer_upload_needs_attention', { values: { count: $stats.errors } })
        : $t('frameleaf_transfer_upload_complete'),
  );

  const retryItem = async (item: UploadAsset) => {
    uploadAssetsStore.removeItem(item.id);
    await fileUploadHandler({ files: [item.file], albumId: item.albumId });
  };

  const retryAllFailed = async () => {
    const failed = $uploadAssetsStore.filter((item) => item.state === UploadState.ERROR);
    for (const item of failed) {
      await retryItem(item);
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

{#if $isUploading}
  <div class="frameleaf fl-panel-wrap" data-theme={appTheme}>
    {#if minimized}
      <button
        type="button"
        class="fl-pill"
        in:scale={{ duration: 250, easing: quartInOut }}
        aria-label={`${$t('frameleaf_transfer_show_uploads')}. ${label}`}
        onclick={() => (minimized = false)}
      >
        <span class="fl-ring" style={`--pct: ${percent}`} aria-hidden="true"></span>
        <strong>{$remainingUploads > 0 ? $remainingUploads.toLocaleString($locale) : $stats.errors}</strong>
      </button>
    {:else}
      <section class="fl-panel" role="region" aria-label={$t('upload')} in:scale={{ duration: 250, easing: quartInOut }}>
        <header class="fl-panel-head">
          <Icon icon={active ? mdiProgressUpload : mdiCloudCheckOutline} size={20} aria-hidden="true" />
          <div class="fl-panel-head-text">
            <strong aria-live="polite">{label}</strong>
            <span>
              {$t('frameleaf_transfer_count_uploaded', { values: { count: $stats.success } })}
              {#if $stats.duplicates}
                · {$t('frameleaf_transfer_count_duplicates', { values: { count: $stats.duplicates } })}
              {/if}
              {#if $stats.errors}
                · {$t('frameleaf_transfer_count_failed', { values: { count: $stats.errors } })}
              {/if}
              · {getByteUnitString(totalBytes, $locale)}
            </span>
          </div>
          <button
            type="button"
            class="fl-icon-button"
            aria-label={$t('frameleaf_transfer_minimize_uploads')}
            onclick={() => (minimized = true)}
          >
            <Icon icon={mdiChevronDown} size={18} aria-hidden="true" />
          </button>
          {#if !active}
            <button
              type="button"
              class="fl-icon-button"
              aria-label={$t('frameleaf_transfer_close_uploads')}
              onclick={() => uploadAssetsStore.reset()}
            >
              <Icon icon={mdiClose} size={18} aria-hidden="true" />
            </button>
          {/if}
        </header>

        <div
          class="fl-progress"
          class:has-errors={$stats.errors > 0}
          role="progressbar"
          aria-label={$t('frameleaf_transfer_uploading_count', {
            values: { processed: $stats.total - $remainingUploads, total: $stats.total },
          })}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <span style={`width: ${percent}%`}></span>
        </div>

        <ul class="fl-list">
          {#each $uploadAssetsStore as item (item.id)}
            <li class="fl-row" data-state={item.state}>
              <span class="fl-thumb">
                {#if item.file.type.startsWith('image/')}
                  <img use:thumbnail={item.file} alt="" />
                {:else}
                  <Icon
                    icon={item.file.type.startsWith('video/') ? mdiVideoOutline : mdiImageOutline}
                    size={18}
                    aria-hidden="true"
                  />
                {/if}
              </span>
              <span class="fl-name" title={item.file.name}>{item.file.name}</span>
              <span class="fl-state">
                {#if item.state === UploadState.PENDING}
                  <Icon icon={mdiCircleOutline} size={18} aria-hidden="true" />
                  <span class="fl-sr-only">{$t('frameleaf_transfer_status_pending')}</span>
                {:else if item.state === UploadState.STARTED}
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
                  <Icon icon={mdiCheckCircle} size={18} class="fl-success" aria-hidden="true" />
                  <span class="fl-sr-only">{$t('asset_uploaded')}</span>
                {:else if item.state === UploadState.DUPLICATED}
                  {#if item.isTrashed}
                    <Icon icon={mdiTrashCan} size={18} class="fl-muted-icon" aria-hidden="true" />
                  {:else}
                    <Icon icon={mdiContentDuplicate} size={18} class="fl-warning" aria-hidden="true" />
                  {/if}
                  <span class="fl-sr-only">{$t(item.isTrashed ? 'asset_skipped_in_trash' : 'asset_skipped')}</span>
                {:else if item.state === UploadState.ERROR}
                  <Icon icon={mdiAlertCircleOutline} size={18} class="fl-danger" aria-hidden="true" />
                  <span class="fl-sr-only">{$t('error')}</span>
                {/if}
              </span>
              <span class="fl-meta">
                {#if item.state === UploadState.ERROR}
                  {typeof item.error === 'string' ? item.error : $t('error')}
                {:else if item.state === UploadState.STARTED}
                  {item.message ?? $t('asset_uploading')} {Math.round(item.progress ?? 0)}%
                {:else}
                  {getByteUnitString(item.file.size, $locale)}
                {/if}
              </span>
              {#if item.state === UploadState.DUPLICATED}
                <span class="fl-actions">
                  {#if item.assetId}
                    <a
                      href={item.isTrashed ? Route.viewTrashedAsset({ id: item.assetId }) : Route.viewAsset({ id: item.assetId })}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={$t('view')}
                    >
                      <Icon icon={mdiOpenInNew} size={16} aria-hidden="true" />
                    </a>
                  {/if}
                  <button type="button" aria-label={$t('dismiss')} onclick={() => uploadAssetsStore.removeItem(item.id)}>
                    <Icon icon={mdiClose} size={16} aria-hidden="true" />
                  </button>
                </span>
              {:else if item.state === UploadState.ERROR}
                <span class="fl-actions">
                  <button type="button" aria-label={$t('retry_upload')} onclick={() => retryItem(item)}>
                    <Icon icon={mdiRefresh} size={16} aria-hidden="true" />
                  </button>
                  <button type="button" aria-label={$t('dismiss')} onclick={() => uploadAssetsStore.removeItem(item.id)}>
                    <Icon icon={mdiClose} size={16} aria-hidden="true" />
                  </button>
                </span>
              {/if}
            </li>
          {/each}
        </ul>

        <footer class="fl-panel-foot">
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
          <div class="fl-panel-actions">
            {#if $stats.errors > 0}
              <button type="button" class="fl-button" onclick={() => void retryAllFailed()}>
                <Icon icon={mdiRefresh} size={16} aria-hidden="true" />
                {$t('frameleaf_transfer_retry_failed')}
              </button>
            {/if}
            {#if $isDismissible}
              <button type="button" class="fl-button" onclick={() => uploadAssetsStore.dismissErrors()}>
                {$t('frameleaf_transfer_dismiss_errors')}
              </button>
            {/if}
            {#if active}
              <button type="button" class="fl-button" onclick={() => cancelRemainingUploads()}>
                {$t('frameleaf_transfer_cancel_remaining')}
              </button>
            {:else}
              <button type="button" class="fl-button fl-button-primary" onclick={() => uploadAssetsStore.reset()}>
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
  .fl-panel-wrap {
    pointer-events: auto;
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
    inline-size: 100%;
    block-size: 0.25rem;
    background: var(--fl-raised);
  }
  .fl-progress span {
    display: block;
    block-size: 100%;
    background: var(--fl-accent);
    transition: width var(--fl-motion) var(--fl-ease);
  }
  .fl-progress.has-errors span {
    background: var(--fl-danger);
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
    grid-template-areas: 'thumb name state' 'thumb meta actions';
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
    border-radius: var(--fl-radius);
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
  .fl-actions {
    grid-area: actions;
    display: inline-flex;
    gap: 0.25rem;
    justify-self: end;
  }
  .fl-actions button,
  .fl-actions a {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0.125rem;
    color: var(--fl-muted);
    border: 0;
    background: transparent;
    border-radius: var(--fl-radius);
  }
  .fl-actions button:hover,
  .fl-actions a:hover {
    background: var(--fl-canvas);
    color: var(--fl-text);
  }
  :global(.fl-success) {
    color: var(--fl-accent);
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
  .fl-ring {
    --pct: 0;
    display: inline-block;
    inline-size: 1.125rem;
    block-size: 1.125rem;
    border-radius: 50%;
    background: conic-gradient(var(--fl-accent) calc(var(--pct) * 1%), var(--fl-border) 0);
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
  .fl-pill {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.375rem;
    inline-size: 3.5rem;
    block-size: 3.5rem;
    color: var(--fl-text);
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: 50%;
    box-shadow: var(--fl-shadow-2);
  }
  .fl-pill strong {
    font-size: 0.875rem;
  }
</style>
