<script lang="ts">
  import {
    AssetMediaSize,
    cancelMediaImport,
    getMediaImports,
    MediaImportState,
    retryMediaImport,
    type MediaImportResponseDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiChevronDown, mdiChevronUp, mdiDownloadOutline, mdiProgressDownload } from '@mdi/js';
  import { onDestroy, untrack } from 'svelte';
  import { locale, t } from 'svelte-i18n';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import {
    mediaImportActive,
    mediaImportRetryable,
    mediaReceiptKey,
  } from '$lib/components/frameleaf/media/boards-media';
  import { creatorPlatform, platformName, relativeTime } from '$lib/frameleaf/creators';
  import { creatorsStore } from '$lib/frameleaf/creators-store.svelte';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { getAssetMediaUrl } from '$lib/utils';

  /**
   * The Downloads tray (prototype `Tray`): what the Library is saving and what it finished, with Stop
   * and Try again. The Library carries on whether or not this is open.
   */
  const SHOWN = 12;
  const retryKeys = new Map<string, string>();
  /** Saved files already announced to the rest of Boards. */
  const seen = new Set<string>();
  let first = true;
  let jobs = $state<MediaImportResponseDto[]>([]);
  let failed = $state(false);
  let actionFailed = $state(false);
  let pending = $state('');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  const controller = new AbortController();

  const open = $derived(creatorsStore.trayOpen);
  const running = $derived(jobs.filter(({ state }) => mediaImportActive(state)).length);
  const needs = $derived(
    jobs.filter(({ state }) => state === MediaImportState.Failed || state === MediaImportState.Partial).length,
  );

  const announce = (list: MediaImportResponseDto[]) => {
    let added = false;
    for (const job of list) {
      const fresh = job.items.flatMap(({ assetId }) => (assetId && !seen.has(assetId) ? [assetId] : []));
      for (const id of fresh) {
        seen.add(id);
      }
      if (!first && fresh.length > 0 && job.albumId) {
        added = true;
        eventManager.emit('AlbumAddAssets', { assetIds: fresh, albumIds: [job.albumId] });
      }
    }
    first = false;
    if (added) {
      void creatorsStore.refresh();
    }
  };

  const load = async () => {
    const version = ++generation;
    clearTimeout(timer);
    try {
      const { imports } = await getMediaImports({ signal: controller.signal });
      if (version !== generation) {
        return;
      }
      // An inspection has no collection yet; only real downloads are listed.
      const downloads = imports
        .filter(({ albumId }) => !!albumId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, SHOWN);
      announce(downloads);
      jobs = downloads;
      failed = false;
    } catch {
      if (version !== generation || controller.signal.aborted) {
        return;
      }
      failed = true;
    }
    if (failed || jobs.some(({ state }) => mediaImportActive(state))) {
      timer = setTimeout(() => void load(), failed ? 6000 : 2500);
    }
  };

  $effect(() => {
    void creatorsStore.downloads;
    untrack(() => void load());
  });
  onDestroy(() => {
    generation++;
    clearTimeout(timer);
    controller.abort();
  });

  const change = async (job: MediaImportResponseDto, retry: boolean) => {
    if (pending) {
      return;
    }
    pending = job.id;
    actionFailed = false;
    try {
      const { id, updatedAt } = job;
      const updated = retry
        ? await retryMediaImport({
            id,
            mediaRetryDto: { idempotencyKey: mediaReceiptKey(retryKeys, { id, updatedAt }) },
          })
        : await cancelMediaImport({ id });
      jobs = jobs.map((value) => (value.id === id ? updated : value));
      void load();
    } catch {
      actionFailed = true;
    } finally {
      pending = '';
    }
  };

  const done = (job: MediaImportResponseDto) => job.saved + job.skipped + job.failed;
  const percent = (job: MediaImportResponseDto) =>
    job.discovered > 0 ? Math.round((done(job) / job.discovered) * 100) : 0;
  const stateText = (job: MediaImportResponseDto) => {
    switch (job.state) {
      case MediaImportState.Assembling: {
        return $t('frameleaf_creators_tray_assembling');
      }
      case MediaImportState.Downloading:
      case MediaImportState.Importing: {
        return job.discovered > 1
          ? $t('frameleaf_creators_tray_downloading_of', { values: { done: done(job), total: job.discovered } })
          : $t('frameleaf_creators_tray_downloading');
      }
      case MediaImportState.Saved: {
        return $t('frameleaf_creators_tray_saved', { values: { when: relativeTime(job.updatedAt, $locale) } });
      }
      case MediaImportState.Partial: {
        return $t('frameleaf_creators_tray_partial', { values: { saved: job.saved, failed: job.failed } });
      }
      case MediaImportState.Failed: {
        return $t('frameleaf_creators_tray_failed');
      }
      case MediaImportState.Cancelled: {
        return $t('frameleaf_creators_tray_stopped');
      }
      case MediaImportState.Paused: {
        return $t('frameleaf_creators_tray_paused');
      }
      default: {
        return $t('frameleaf_creators_tray_waiting');
      }
    }
  };
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
      {$t('frameleaf_creators_tray_running', { values: { count: running } })}{needs > 0
        ? ` · ${$t('frameleaf_creators_tray_needs', { values: { count: needs } })}`
        : ''}
    </small>
    <Icon icon={open ? mdiChevronDown : mdiChevronUp} size="18" aria-hidden={true} />
  </button>
  {#if open}
    <div class="cr-tray-body">
      {#if failed && jobs.length === 0}
        <InlineError compact message={$t('frameleaf_creators_tray_error')} onRetry={load} />
      {:else if jobs.length === 0}
        <p>{$t('frameleaf_creators_tray_empty')}</p>
      {/if}
      {#if actionFailed}<InlineError compact message={$t('frameleaf_creators_action_error')} />{/if}
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
          <li class:attention={job.state === MediaImportState.Failed || job.state === MediaImportState.Partial}>
            <span class="cr-tray-thumb">
              {#if saved}
                <img src={getAssetMediaUrl({ id: saved, size: AssetMediaSize.Thumbnail })} alt="" loading="lazy" />
              {:else}
                <Icon icon={mdiDownloadOutline} size="18" aria-hidden={true} />
              {/if}
            </span>
            <span>
              <strong>{name}</strong>
              <small>{job.creator ? `${job.creator} · ` : ''}{site} · {stateText(job)}</small>
              {#if active}
                <span
                  class="cr-bar"
                  role="progressbar"
                  aria-label={name}
                  aria-valuenow={percent(job)}
                  aria-valuemin={0}
                  aria-valuemax={100}><span style:width="{percent(job)}%"></span></span
                >
              {/if}
            </span>
            {#if active}
              <Button disabled={pending !== ''} onclick={() => void change(job, false)}>
                {$t('frameleaf_creators_tray_stop')}
              </Button>
            {:else if !job.subscriptionId && mediaImportRetryable(job.state)}
              <Button disabled={pending !== ''} onclick={() => void change(job, true)}>{$t('retry')}</Button>
            {/if}
          </li>
        {/each}
      </ul>
    </div>
  {/if}
</section>
