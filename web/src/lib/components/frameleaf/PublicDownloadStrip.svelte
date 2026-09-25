<script lang="ts">
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { downloadManager, EmptyDownloadError, type DownloadState } from '$lib/managers/download-manager.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { downloadBlob } from '$lib/utils';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import { isHttpError } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiAlertCircleOutline, mdiCheckCircleOutline, mdiDownloadOutline, mdiProgressDownload } from '@mdi/js';
  import { t } from 'svelte-i18n';

  /**
   * The public share page's download strip (FL-45), ported from the prototype's job strip in
   * `PublicViewer.jsx:402-426` and `sharing.css:856-897`: "Preparing archive · n of m" with Cancel,
   * then "Archive ready · n files · size" with Save archive. It shows the download rows the share
   * page started (group `share`), which the Downloads panel leaves out. A part split off by the
   * archive size limit can be saved as soon as it is ready, while later parts are still being
   * prepared. A failure keeps Retry and Dismiss, as the Downloads panel does (a recorded deviation:
   * the prototype's strip cannot fail).
   */

  const rows = $derived(downloadManager.rows('share'));
  const preparing = $derived(rows.filter(([, download]) => download.status === 'preparing'));
  const ready = $derived(rows.find(([, download]) => download.status === 'ready'));
  const failed = $derived(rows.find(([, download]) => download.status === 'error'));

  /** Files counted done: a ready part in full, a preparing part by its received share. */
  const done = (download: DownloadState) =>
    download.status === 'ready' ? download.count : Math.floor((download.progress / 100) * download.count);
  const counted = $derived(rows.filter(([, download]) => download.status !== 'error'));
  const total = $derived(counted.reduce((sum, [, download]) => sum + download.count, 0));
  const doneCount = $derived(counted.reduce((sum, [, download]) => sum + done(download), 0));

  // A ready part leads: its Save is what the person can do now, even while later parts prepare.
  const phase = $derived(ready ? 'ready' : preparing.length > 0 ? 'preparing' : failed ? 'error' : null);

  const errorText = (error: unknown) => {
    if (error instanceof EmptyDownloadError) {
      return $t('frameleaf_transfer_download_error_empty');
    }
    if (isHttpError(error) && [400, 401, 403, 404].includes(error.status)) {
      return $t('frameleaf_transfer_download_error_unavailable');
    }
    return $t('frameleaf_transfer_download_error_failed');
  };

  const cancel = () => {
    for (const [key] of preparing) {
      downloadManager.cancel(key);
    }
  };
</script>

{#if phase}
  <div class="pv-job" data-state={phase} role="status" aria-live="polite">
    <Icon
      icon={phase === 'ready' ? mdiCheckCircleOutline : phase === 'error' ? mdiAlertCircleOutline : mdiProgressDownload}
      size="22"
      aria-hidden={true}
    />
    <div class="pv-job-copy">
      <strong>
        {#if phase === 'preparing'}
          {total > 0
            ? $t('frameleaf_public_archive_preparing', { values: { done: doneCount, total } })
            : $t('frameleaf_public_archive_planning')}
        {:else if ready}
          {$t('frameleaf_public_archive_ready', { values: { count: ready[1].count } })}{ready[1].total > 0
            ? ` · ${getByteUnitString(ready[1].total, $locale)}`
            : ''}
        {:else if failed}
          {errorText(failed[1].error)}
        {/if}
      </strong>
      {#if phase === 'preparing'}
        <span class="pv-progress" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={doneCount}>
          <span style={`transform: scaleX(${total ? doneCount / total : 0})`}></span>
        </span>
      {/if}
    </div>
    {#if ready}
      <!-- A ready part is offered at once, even while later parts are still being prepared. -->
      <Button variant="primary" onclick={() => downloadManager.save(ready[0], downloadBlob)}>
        <Icon icon={mdiDownloadOutline} size="18" aria-hidden={true} />
        {$t('frameleaf_public_save_archive')}
      </Button>
    {/if}
    {#if preparing.length > 0}
      <Button onclick={cancel}>{$t('cancel')}</Button>
    {/if}
    {#if failed}
      <!-- A failed part keeps its Retry beside a ready part. -->
      <Button onclick={() => downloadManager.retry(failed[0])}>{$t('retry')}</Button>
      <Button onclick={() => downloadManager.remove(failed[0])}>{$t('dismiss')}</Button>
    {/if}
  </div>
{/if}

<style>
  .pv-job {
    display: flex;
    align-items: center;
    gap: 0.875rem;
    padding: 0.75rem 0.875rem;
    margin-block-end: 0.875rem;
    color: var(--fl-text);
    background: var(--fl-panel);
    border-radius: var(--fl-radius-card);
  }
  /* sharing.css:865-867: only the light theme draws the border. */
  :global(.frameleaf[data-theme='light']) .pv-job {
    border: 1px solid var(--fl-border);
  }
  .pv-job > :global(svg) {
    flex-shrink: 0;
    color: var(--fl-teal);
  }
  .pv-job[data-state='error'] > :global(svg) {
    color: var(--fl-danger);
  }
  .pv-job-copy {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 0.5rem;
    min-width: 0;
  }
  .pv-job-copy strong {
    font-size: 0.8125rem;
    font-weight: 560;
  }
  .pv-progress {
    display: block;
    block-size: 0.25rem;
    overflow: hidden;
    border-radius: 999px;
    background: var(--fl-raised);
  }
  .pv-progress > span {
    display: block;
    block-size: 100%;
    inline-size: 100%;
    transform-origin: left;
    background: var(--fl-teal);
    transition: transform var(--fl-motion-slow) var(--fl-ease);
  }
</style>
