<script lang="ts">
  import '$lib/frameleaf/tokens.css';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { motionFly } from '$lib/frameleaf/motion';
  import { type DownloadState, downloadManager, EmptyDownloadError } from '$lib/managers/download-manager.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { downloadBlob } from '$lib/utils';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import { isHttpError } from '@immich/sdk';
  import { Icon, Theme as AppTheme, themeManager } from '@immich/ui';
  import {
    mdiAlertCircleOutline,
    mdiCheckCircle,
    mdiClose,
    mdiDownload,
    mdiDownloadOutline,
    mdiFileDownloadOutline,
    mdiProgressDownload,
    mdiRefresh,
  } from '@mdi/js';
  import { t } from 'svelte-i18n';

  /**
   * Download panel (FL-45), ported from the prototype's `DownloadPanel` in
   * `design/frameleaf/template/src/UploadPanel.jsx:441-569` onto the real download manager. Every
   * download — a single photo, a selection, an album and each part of a split archive — shows here:
   * it is prepared with progress and Cancel, then waits for Save; a failure stays as a row with
   * Retry (the upload panel's "Retry failed", `UploadPanel.jsx:414-418`) and Dismiss. Rows of a
   * public share page are shown by its inline strip instead (`PublicDownloadStrip`).
   */

  const appTheme = $derived(themeManager.value === AppTheme.Dark ? 'dark' : 'light');
  const summary = $derived(downloadManager.summary);

  /** `UploadPanel.jsx:509-513`. */
  const title = $derived(
    summary.preparing
      ? $t('frameleaf_transfer_preparing_downloads', { values: { count: summary.preparing } })
      : summary.ready
        ? $t('frameleaf_transfer_downloads_ready', { values: { count: summary.ready } })
        : $t('frameleaf_transfer_downloads'),
  );

  const errorText = (error: unknown) => {
    if (error instanceof EmptyDownloadError) {
      return $t('frameleaf_transfer_download_error_empty');
    }
    if (isHttpError(error) && [400, 401, 403, 404].includes(error.status)) {
      return $t('frameleaf_transfer_download_error_unavailable');
    }
    return $t('frameleaf_transfer_download_error_failed');
  };

  /** `UploadPanel.jsx:547-553`: "N items · size · 42%" while preparing, "· Ready" once saved. */
  const meta = (download: DownloadState) =>
    [
      download.count > 0 ? $t('items_count', { values: { count: download.count } }) : null,
      download.total > 0 ? getByteUnitString(download.total, $locale) : null,
      download.status === 'preparing' ? `${download.progress}%` : $t('frameleaf_transfer_download_ready'),
    ]
      .filter(Boolean)
      .join(' · ');

  const save = (key: string) => downloadManager.save(key, downloadBlob);

  /** A ready file held in the tab is lost if the tab closes before Save, so the browser asks first. */
  const onBeforeUnload = (event: BeforeUnloadEvent) => {
    if (!downloadManager.hasUnsavedFiles) {
      return;
    }
    event.preventDefault();
    // Older Safari and Chromium ask only when returnValue is set; newer ones ignore it.
    // eslint-disable-next-line tscompat/tscompat -- Set for the browsers that need it; harmless elsewhere.
    event.returnValue = '';
  };
</script>

<svelte:window onbeforeunload={onBeforeUnload} />

{#if downloadManager.isDownloading}
  <div class="frameleaf fl-panel-wrap" data-theme={appTheme}>
    <section class="fl-panel" aria-label={$t('frameleaf_transfer_downloads')} in:motionFly={{ y: 12, duration: 280 }}>
      <header class="fl-panel-head">
        <Icon icon={summary.active ? mdiProgressDownload : mdiDownloadOutline} size="20" aria-hidden="true" />
        <div class="fl-panel-head-text">
          <strong aria-live="polite">{title}</strong>
          <span>{$t('frameleaf_transfer_downloads_hint')}</span>
        </div>
        {#if !summary.active}
          <button
            type="button"
            class="fl-icon-button"
            aria-label={$t('frameleaf_transfer_close_downloads')}
            onclick={() => downloadManager.clearAll()}
          >
            <Icon icon={mdiClose} size="18" aria-hidden="true" />
          </button>
        {/if}
      </header>

      <ul class="fl-list">
        {#each downloadManager.panelRows as [key, download] (key)}
          <li class="fl-row" data-status={download.status}>
            <span class="fl-row-icon">
              <Icon
                icon={download.status === 'ready'
                  ? mdiCheckCircle
                  : download.status === 'error'
                    ? mdiAlertCircleOutline
                    : mdiFileDownloadOutline}
                size="20"
                aria-hidden="true"
              />
            </span>
            <span class="fl-name" title={download.name}>{download.name}</span>
            <span class="fl-actions">
              {#if download.status === 'preparing'}
                <Button onclick={() => downloadManager.cancel(key)}>{$t('cancel')}</Button>
              {:else if download.status === 'ready'}
                <Button variant="primary" onclick={() => save(key)}>
                  <Icon icon={mdiDownload} size="16" aria-hidden="true" />
                  {$t('save')}
                </Button>
              {:else}
                <Button onclick={() => downloadManager.retry(key)}>
                  <Icon icon={mdiRefresh} size="16" aria-hidden="true" />
                  {$t('retry')}
                </Button>
                <Button onclick={() => downloadManager.remove(key)}>{$t('dismiss')}</Button>
              {/if}
            </span>
            <span class="fl-meta">
              {download.status === 'error' ? errorText(download.error) : meta(download)}
            </span>
            {#if download.status === 'preparing'}
              <span
                class="fl-progress"
                role="progressbar"
                aria-label={$t('frameleaf_transfer_progress', { values: { name: download.name } })}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={download.progress}
              >
                <span style={`width: ${download.progress}%`}></span>
              </span>
            {/if}
          </li>
        {/each}
      </ul>
    </section>
  </div>
{/if}

<style>
  .fl-panel-wrap {
    pointer-events: auto;
  }
  /* upload.css:108-128 — the same card as the upload panel. */
  .fl-panel {
    display: flex;
    flex-direction: column;
    width: 22rem;
    max-width: calc(100vw - 2rem);
    max-height: min(32rem, calc(100dvh - 6rem));
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
    padding: 0.625rem 0.5rem 0.625rem 0.875rem;
  }
  .fl-panel-head > :global(svg) {
    color: var(--fl-muted);
    flex-shrink: 0;
  }
  .fl-panel-head-text {
    display: flex;
    flex-direction: column;
    gap: 0.0625rem;
    min-width: 0;
    flex: 1;
  }
  .fl-panel-head-text strong {
    font-size: 0.875rem;
    font-weight: 600;
  }
  .fl-panel-head-text span {
    color: var(--fl-muted);
    font-size: 0.75rem;
  }
  .fl-icon-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    inline-size: 2rem;
    block-size: 2rem;
    color: var(--fl-muted);
    background: transparent;
    border: 0;
    border-radius: var(--fl-radius-control);
  }
  .fl-icon-button:hover {
    background: var(--fl-raised);
    color: var(--fl-text);
  }
  .fl-list {
    list-style: none;
    margin: 0;
    padding: 0.25rem 0.375rem 0.375rem;
    overflow-y: auto;
    display: grid;
    gap: 0.125rem;
  }
  /* upload.css:349-395 */
  .fl-row {
    display: grid;
    grid-template-columns: 2.125rem 1fr auto;
    column-gap: 0.625rem;
    row-gap: 0.125rem;
    align-items: center;
    padding: 0.375rem 0.5rem;
    border-radius: var(--fl-radius-control);
  }
  .fl-row-icon {
    grid-row: 1 / 3;
    display: inline-flex;
    justify-self: center;
    color: var(--fl-muted);
  }
  .fl-row[data-status='ready'] .fl-row-icon {
    color: var(--fl-teal);
  }
  .fl-row[data-status='error'] .fl-row-icon {
    color: var(--fl-danger);
  }
  .fl-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.8125rem;
    font-weight: 500;
  }
  .fl-meta {
    grid-column: 2;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--fl-muted);
    font-size: 0.6875rem;
  }
  .fl-actions {
    grid-column: 3;
    grid-row: 1 / 3;
    display: inline-flex;
    gap: 0.25rem;
  }
  .fl-actions :global(button) {
    gap: 0.25rem;
    min-block-size: 1.875rem;
    padding: 0.25rem 0.625rem;
    font-size: 0.8125rem;
  }
  .fl-progress {
    grid-column: 2;
    display: block;
    block-size: 0.1875rem;
    margin-block-start: 0.125rem;
    overflow: hidden;
    border-radius: 0.125rem;
    background: var(--fl-border);
  }
  .fl-progress span {
    display: block;
    block-size: 100%;
    background: var(--fl-teal);
    transition: width var(--fl-motion) linear;
  }
  @media (max-width: 43.75rem) {
    .fl-panel {
      width: auto;
      max-height: 50dvh;
    }
  }
</style>
