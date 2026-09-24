<script lang="ts">
  import '$lib/frameleaf/tokens.css';
  import { type DownloadState, downloadManager } from '$lib/managers/download-manager.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import { downloadUrlPost } from '$lib/utils';
  import { Icon, Theme as AppTheme, themeManager } from '@immich/ui';
  import {
    mdiCheckCircle,
    mdiClose,
    mdiDownload,
    mdiDownloadOutline,
    mdiFileDownloadOutline,
    mdiReload,
  } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import { motionFly } from '$lib/frameleaf/motion';

  /**
   * Download panel (FL-45), ported from the prototype's `DownloadPanel` in
   * `design/frameleaf/template/src/UploadPanel.jsx` onto the real download manager. Single
   * archives already download themselves through `downloadArchive()`; this panel only shows
   * multi-part archives, which is exactly what the legacy `routes/DownloadPanel.svelte` did —
   * only the layout is new.
   */

  const appTheme = $derived(themeManager.value === AppTheme.Dark ? 'dark' : 'light');

  const save = (key: string, download: DownloadState) => {
    downloadUrlPost(download.url, download.assetIds, download.archiveName);
    downloadManager.markDownloaded(key);
  };

  const remove = (key: string) => downloadManager.remove(key);
</script>

{#if downloadManager.isDownloading}
  <div class="frameleaf fl-panel-wrap" data-theme={appTheme}>
    <section class="fl-panel" aria-label={$t('prepared_archives')} transition:motionFly={{ x: -100, duration: 350 }}>
      <header class="fl-panel-head">
        <Icon icon={mdiDownloadOutline} size="20" aria-hidden="true" />
        <div class="fl-panel-head-text">
          <strong aria-live="polite">{$t('prepared_archives')}</strong>
          <span>{$t('frameleaf_transfer_downloads_hint')}</span>
        </div>
        <button
          type="button"
          class="fl-icon-button"
          aria-label={$t('frameleaf_transfer_close_downloads')}
          onclick={() => downloadManager.clearAll()}
        >
          <Icon icon={mdiClose} size="18" aria-hidden="true" />
        </button>
      </header>

      <ul class="fl-list">
        {#each downloadManager.assets as [key, download] (key)}
          <li class="fl-row" data-downloaded={download.downloaded}>
            <Icon
              icon={download.downloaded ? mdiCheckCircle : mdiFileDownloadOutline}
              size="20"
              class={download.downloaded ? 'fl-success' : 'fl-muted-icon'}
              aria-hidden="true"
            />
            <span class="fl-name" title={key}>{key}</span>
            <span class="fl-meta">
              {#if download.total}
                {getByteUnitString(download.total, $locale)}
              {/if}
            </span>
            <span class="fl-actions">
              <button
                type="button"
                aria-label={$t(download.downloaded ? 'retry' : 'download')}
                onclick={() => save(key, download)}
              >
                <Icon icon={download.downloaded ? mdiReload : mdiDownload} size="18" aria-hidden="true" />
              </button>
              <button type="button" aria-label={$t('frameleaf_transfer_remove_download')} onclick={() => remove(key)}>
                <Icon icon={mdiClose} size="16" aria-hidden="true" />
              </button>
            </span>
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
  .fl-panel {
    display: flex;
    flex-direction: column;
    width: 22rem;
    max-width: calc(100vw - 2rem);
    max-height: 22rem;
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
    grid-template-columns: auto 1fr auto auto;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem;
    border-radius: var(--fl-radius-control);
  }
  .fl-row:hover {
    background: var(--fl-raised);
  }
  .fl-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.8125rem;
  }
  .fl-meta {
    color: var(--fl-muted);
    font-size: 0.6875rem;
    white-space: nowrap;
  }
  .fl-actions {
    display: inline-flex;
    gap: 0.25rem;
  }
  .fl-actions button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0.25rem;
    color: var(--fl-muted);
    border: 0;
    background: transparent;
    border-radius: var(--fl-radius);
  }
  .fl-actions button:hover {
    background: var(--fl-canvas);
    color: var(--fl-text);
  }
  :global(.fl-success) {
    color: var(--fl-accent);
  }
  :global(.fl-muted-icon) {
    color: var(--fl-muted);
  }
</style>
