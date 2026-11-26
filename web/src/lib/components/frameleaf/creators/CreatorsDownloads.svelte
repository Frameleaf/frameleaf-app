<script lang="ts">
  import {
    AssetMediaSize,
    MediaImportItemState,
    type MediaImportItemResponse,
    type MediaImportResponseDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiChevronDown, mdiChevronRight, mdiDownloadOutline, mdiRefresh } from '@mdi/js';
  import { locale, t, type Translations } from 'svelte-i18n';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import { mediaImportActive, mediaImportRetryable } from '$lib/components/frameleaf/media/boards-media';
  import { creatorPlatform, platformName } from '$lib/frameleaf/creators';
  import {
    creatorsDownloads,
    DOWNLOAD_KINDS,
    downloadCounts,
    downloadItemKind,
    downloadPercent,
    downloadStatus,
    mediaImportNeedsOwner,
    type DownloadKind,
    type DownloadShow,
  } from '$lib/frameleaf/creators-downloads.svelte';
  import { getAssetMediaUrl } from '$lib/utils';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import PlatformMark from './PlatformMark.svelte';

  /**
   * Every download in one list (prototype `Downloads`): what is running, what waits its turn, what
   * needs the owner and what was saved. A download of several files opens to show them.
   */
  let { show, onShow }: { show: DownloadShow; onShow: (show: DownloadShow) => void } = $props();

  /** Files listed under an open download; the rest are counted. */
  const FILES_SHOWN = 20;
  const FILE_ORDER: (DownloadKind | undefined)[] = ['running', 'needs', 'waiting', 'saved', undefined];
  const KIND_NAMES: Record<DownloadKind, Translations> = {
    running: 'frameleaf_creators_downloads_running',
    waiting: 'frameleaf_creators_tray_waiting',
    needs: 'frameleaf_creators_downloads_needs',
    saved: 'frameleaf_creators_column_saved',
  };

  let opened = $state<string | null>(null);

  const counts = $derived(creatorsDownloads.counts);
  const total = $derived(creatorsDownloads.jobs.reduce((sum, { items }) => sum + items.length, 0));
  const rows = $derived(
    show === 'all' ? creatorsDownloads.jobs : creatorsDownloads.jobs.filter((job) => downloadCounts(job)[show] > 0),
  );
  const busy = $derived(creatorsDownloads.pending !== '');

  const nameOf = (job: MediaImportResponseDto) =>
    job.items.length > 1
      ? $t('frameleaf_creators_tray_items', { values: { count: job.items.length } })
      : job.items[0]?.title || job.creator || $t('frameleaf_creators_download');
  const sizeOf = (job: MediaImportResponseDto) => {
    const bytes = job.items.reduce((sum, item) => sum + item.bytes, 0);
    return bytes > 0 ? getByteUnitString(bytes, $locale ?? undefined) : '';
  };
  /** The files of an open download, the ones still moving first. */
  const filesOf = (job: MediaImportResponseDto) =>
    job.items
      .map((item) => ({ item, kind: downloadItemKind(job, item) }))
      .sort((a, b) => FILE_ORDER.indexOf(a.kind) - FILE_ORDER.indexOf(b.kind));
  const fileState = (item: MediaImportItemResponse, kind: DownloadKind | undefined) => {
    if (item.state === MediaImportItemState.Assembling) {
      return $t('frameleaf_creators_tray_assembling');
    }
    if (item.state === MediaImportItemState.Failed) {
      return $t('frameleaf_creators_tray_failed');
    }
    switch (kind) {
      case 'running': {
        return $t('frameleaf_creators_tray_downloading');
      }
      case 'waiting': {
        return $t('frameleaf_creators_tray_waiting');
      }
      case 'saved': {
        return $t('frameleaf_creators_column_saved');
      }
      case 'needs': {
        return $t('frameleaf_creators_tray_paused');
      }
      default: {
        return $t('frameleaf_creators_tray_stopped');
      }
    }
  };
</script>

<header class="cr-head">
  <h1>{$t('frameleaf_creators_downloads')}</h1>
  <p>{$t('frameleaf_creators_downloads_intro')}</p>
</header>
<div class="cr-scroll">
  <section aria-label={$t('frameleaf_creators_downloads')}>
    <div class="cr-section-head">
      <div class="cr-chips" role="group" aria-label={$t('frameleaf_creators_downloads_show')}>
        <button type="button" class="cr-chip" aria-pressed={show === 'all'} onclick={() => onShow('all')}>
          {$t('frameleaf_creators_all')} <small>{total.toLocaleString($locale ?? undefined)}</small>
        </button>
        {#each DOWNLOAD_KINDS as kind (kind)}
          <button type="button" class="cr-chip" aria-pressed={show === kind} onclick={() => onShow(kind)}>
            {$t(KIND_NAMES[kind])} <small>{counts[kind].toLocaleString($locale ?? undefined)}</small>
          </button>
        {/each}
      </div>
      {#if creatorsDownloads.retryable.length > 0}
        <div class="cr-dl-actions">
          <Button disabled={busy} onclick={() => void creatorsDownloads.retryAll()}>
            <Icon icon={mdiRefresh} size="18" aria-hidden={true} />{$t('frameleaf_creators_downloads_retry_all')}
          </Button>
        </div>
      {/if}
    </div>
    {#if creatorsDownloads.actionFailed}<InlineError compact message={$t('frameleaf_creators_action_error')} />{/if}
    {#if creatorsDownloads.failed && creatorsDownloads.jobs.length === 0}
      <InlineError compact message={$t('frameleaf_creators_tray_error')} onRetry={creatorsDownloads.load} />
    {:else if rows.length === 0}
      <p class="cr-empty">{$t('frameleaf_creators_tray_empty')}</p>
    {:else}
      <table class="cr-manage cr-dl">
        <thead>
          <tr>
            <th scope="col">{$t('frameleaf_creators_download')}</th>
            <th scope="col">{$t('frameleaf_creators_column_status')}</th>
            <th scope="col">{$t('size')}</th>
            <th scope="col"><span class="sr-only">{$t('frameleaf_creators_column_actions')}</span></th>
          </tr>
        </thead>
        <tbody>
          {#each rows as job (job.id)}
            {@const active = mediaImportActive(job.state)}
            {@const name = nameOf(job)}
            {@const saved = job.items.find(({ assetId }) => !!assetId)?.assetId}
            {@const platform = creatorPlatform(job.provider)}
            {@const status = downloadStatus(job, $locale)}
            {@const open = opened === job.id}
            <tr class:attention={mediaImportNeedsOwner(job.state)}>
              <th scope="row">
                <span class="cr-dl-name">
                  {#if job.items.length > 1}
                    <button
                      type="button"
                      class="cr-dl-toggle"
                      aria-expanded={open}
                      aria-label={$t('frameleaf_creators_downloads_files', { values: { name } })}
                      onclick={() => (opened = open ? null : job.id)}
                    >
                      <Icon icon={open ? mdiChevronDown : mdiChevronRight} size="18" aria-hidden={true} />
                    </button>
                  {:else}
                    <span class="cr-dl-toggle"></span>
                  {/if}
                  <span class="cr-tray-thumb">
                    {#if saved}
                      <img
                        src={getAssetMediaUrl({ id: saved, size: AssetMediaSize.Thumbnail })}
                        alt=""
                        loading="lazy"
                      />
                    {:else}
                      <Icon icon={mdiDownloadOutline} size="18" aria-hidden={true} />
                    {/if}
                  </span>
                  <span class="cr-dl-text">
                    <strong>{name}</strong>
                    <small>
                      <PlatformMark {platform} provider={job.provider} size={12} />
                      {job.creator ? `${job.creator} · ` : ''}{platformName(platform, job.provider) ||
                        $t('frameleaf_creators_platform_website')}
                    </small>
                  </span>
                </span>
              </th>
              <td>
                <span class="cr-dl-state">
                  {$t(status.key, { values: status.values })}
                  <!-- What the Library said stopped it, in its own words. -->
                  {#if job.error && !active}<small>{job.error}</small>{/if}
                  {#if active}
                    <span
                      class="cr-bar"
                      role="progressbar"
                      aria-label={name}
                      aria-valuenow={downloadPercent(job)}
                      aria-valuemin={0}
                      aria-valuemax={100}><span style:width="{downloadPercent(job)}%"></span></span
                    >
                  {/if}
                </span>
              </td>
              <td>{sizeOf(job)}</td>
              <td>
                {#if active}
                  <Button disabled={busy} onclick={() => void creatorsDownloads.change(job, false)}>
                    {$t('frameleaf_creators_tray_stop')}
                  </Button>
                {:else if !job.subscriptionId && mediaImportRetryable(job.state)}
                  <Button disabled={busy} onclick={() => void creatorsDownloads.change(job, true)}>
                    {$t('retry')}
                  </Button>
                {/if}
              </td>
            </tr>
            {#if open}
              {@const files = filesOf(job)}
              {#each files.slice(0, FILES_SHOWN) as { item, kind } (item.id)}
                <tr class="cr-dl-file" class:attention={kind === 'needs'}>
                  <th scope="row">
                    <span class="cr-dl-name">
                      <span class="cr-dl-toggle"></span>
                      <span class="cr-tray-thumb">
                        {#if item.assetId}
                          <img
                            src={getAssetMediaUrl({ id: item.assetId, size: AssetMediaSize.Thumbnail })}
                            alt=""
                            loading="lazy"
                          />
                        {:else}
                          <Icon icon={mdiDownloadOutline} size="16" aria-hidden={true} />
                        {/if}
                      </span>
                      <span class="cr-dl-text">{item.title || $t('frameleaf_creators_download')}</span>
                    </span>
                  </th>
                  <td>
                    <span class="cr-dl-state">
                      {fileState(item, kind)}
                      {#if item.error}<small>{item.error}</small>{/if}
                    </span>
                  </td>
                  <td>{item.bytes > 0 ? getByteUnitString(item.bytes, $locale ?? undefined) : ''}</td>
                  <td></td>
                </tr>
              {/each}
              {#if files.length > FILES_SHOWN}
                <tr class="cr-dl-file">
                  <th scope="row" colspan="4">
                    <span class="cr-dl-name">
                      <span class="cr-dl-toggle"></span>
                      <small>
                        {$t('frameleaf_creators_downloads_more', { values: { count: files.length - FILES_SHOWN } })}
                      </small>
                    </span>
                  </th>
                </tr>
              {/if}
            {/if}
          {/each}
        </tbody>
      </table>
    {/if}
  </section>
</div>
