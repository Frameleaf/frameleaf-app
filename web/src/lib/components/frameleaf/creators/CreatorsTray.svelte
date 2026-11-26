<script lang="ts">
  import { AssetMediaSize } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiArrowRight, mdiChevronDown, mdiChevronUp, mdiDownloadOutline, mdiProgressDownload } from '@mdi/js';
  import { locale, t } from 'svelte-i18n';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import { mediaImportActive, mediaImportRetryable } from '$lib/components/frameleaf/media/boards-media';
  import { creatorPlatform, creatorsHref, platformName } from '$lib/frameleaf/creators';
  import {
    creatorsDownloads,
    downloadPercent,
    downloadStatus,
    mediaImportNeedsOwner,
  } from '$lib/frameleaf/creators-downloads.svelte';
  import { creatorsStore } from '$lib/frameleaf/creators-store.svelte';
  import { getAssetMediaUrl } from '$lib/utils';

  /**
   * The Downloads tray (prototype `Tray`): the latest of what the Library is saving and what it
   * finished, with Stop and Try again. The Downloads page lists them all. The Library carries on
   * whether or not this is open.
   */
  const SHOWN = 12;
  const open = $derived(creatorsStore.trayOpen);
  const jobs = $derived(creatorsDownloads.jobs.slice(0, SHOWN));
  const running = $derived(creatorsDownloads.jobs.filter(({ state }) => mediaImportActive(state)).length);
  const waiting = $derived(creatorsDownloads.counts.waiting);
  const needs = $derived(creatorsDownloads.needs);
  const busy = $derived(creatorsDownloads.pending !== '');
</script>

<section class="cr-tray" class:open aria-label={$t('frameleaf_creators_downloads')}>
  <button
    type="button"
    class="cr-tray-head"
    aria-expanded={open}
    onclick={() => (creatorsStore.trayOpen = !creatorsStore.trayOpen)}
  >
    <Icon icon={mdiProgressDownload} size="18" aria-hidden={true} />
    <strong>{$t('frameleaf_creators_downloads')}</strong>
    <small>
      {$t('frameleaf_creators_tray_running', { values: { count: running } })}{waiting > 0
        ? ` · ${$t('frameleaf_creators_tray_waiting_count', { values: { count: waiting } })}`
        : ''}{needs > 0 ? ` · ${$t('frameleaf_creators_tray_needs', { values: { count: needs } })}` : ''}
    </small>
    <Icon icon={open ? mdiChevronDown : mdiChevronUp} size="18" aria-hidden={true} />
  </button>
  {#if open}
    <div class="cr-tray-body">
      {#if creatorsDownloads.failed && jobs.length === 0}
        <InlineError compact message={$t('frameleaf_creators_tray_error')} onRetry={creatorsDownloads.load} />
      {:else if jobs.length === 0}
        <p>{$t('frameleaf_creators_tray_empty')}</p>
      {/if}
      {#if creatorsDownloads.actionFailed}<InlineError compact message={$t('frameleaf_creators_action_error')} />{/if}
      <ul>
        {#each jobs as job (job.id)}
          {@const active = mediaImportActive(job.state)}
          {@const saved = job.items.find(({ assetId }) => !!assetId)?.assetId}
          {@const name =
            job.items.length > 1
              ? $t('frameleaf_creators_tray_items', { values: { count: job.items.length } })
              : job.items[0]?.title || job.creator || $t('frameleaf_creators_download')}
          {@const site =
            platformName(creatorPlatform(job.provider), job.provider) || $t('frameleaf_creators_platform_website')}
          {@const status = downloadStatus(job, $locale)}
          <li class:attention={mediaImportNeedsOwner(job.state)}>
            <span class="cr-tray-thumb">
              {#if saved}
                <img src={getAssetMediaUrl({ id: saved, size: AssetMediaSize.Thumbnail })} alt="" loading="lazy" />
              {:else}
                <Icon icon={mdiDownloadOutline} size="18" aria-hidden={true} />
              {/if}
            </span>
            <span>
              <strong>{name}</strong>
              <small>{job.creator ? `${job.creator} · ` : ''}{site} · {$t(status.key, { values: status.values })}</small
              >
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
            {#if active}
              <Button disabled={busy} onclick={() => void creatorsDownloads.change(job, false)}>
                {$t('frameleaf_creators_tray_stop')}
              </Button>
            {:else if !job.subscriptionId && mediaImportRetryable(job.state)}
              <Button disabled={busy} onclick={() => void creatorsDownloads.change(job, true)}>{$t('retry')}</Button>
            {/if}
          </li>
        {/each}
      </ul>
    </div>
    <a class="cr-tray-all" href={creatorsHref({ view: 'downloads' })}>
      <span>{$t('frameleaf_creators_downloads_see_all')}</span>
      <Icon icon={mdiArrowRight} size="16" aria-hidden={true} />
    </a>
  {/if}
</section>
