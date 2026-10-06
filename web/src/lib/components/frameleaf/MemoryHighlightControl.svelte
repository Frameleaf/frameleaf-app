<script lang="ts">
  /**
   * A highlight video made directly from a memory (FL-194, `REC-105`), next to "Make a movie in
   * Studio" in the memory player.
   *
   * The owner asks for it (length, resolution, sound, where it renders), and the server renders it
   * as a Studio export through the qualified render workers; nothing is created or contacted before
   * that. The run is the memory's private `highlight` export: this control follows it as the
   * server reports it (never inventing progress), offers to cancel it while it renders, and once it
   * is ready to download it or save it to the library. A failed or cancelled render can be tried
   * again with the same settings. A run already under way for the memory — started before a reload
   * or in another tab — is picked up instead of offering a second one.
   */
  import {
    MemoryExportFormat,
    MemoryExportStatus,
    cancelMemoryExport,
    createMemoryExport,
    downloadMemoryExport,
    getMemoryExport,
    getMemoryExports,
    saveMemoryExportToLibrary,
    type MemoryExportResponseDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiDownload,
    mdiImagePlusOutline,
    mdiMovieOpenCheckOutline,
    mdiMovieOpenPlayOutline,
    mdiRefresh,
    mdiStopCircleOutline,
  } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import IconButton from '$lib/components/frameleaf/IconButton.svelte';
  import MemoryHighlightDialog, {
    defaultHighlightChoice,
    type MemoryHighlightChoice,
  } from '$lib/components/frameleaf/MemoryHighlightDialog.svelte';
  import { exportProgress, isExportActive, latestExport } from '$lib/frameleaf/memory-stories';
  import { probeStudioHost } from '$lib/frameleaf/studio/capabilities';
  import type { StudioRenderEvidence } from '$lib/frameleaf/studio/host-contract';
  import { Route } from '$lib/route';
  import { downloadBlob } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';

  let {
    memoryId,
    memoryTitle,
    pollMs = 2000,
    onStatus,
  }: {
    memoryId: string;
    memoryTitle: string;
    /** How often a render in progress is asked for its state. */
    pollMs?: number;
    /** A short message for the player's live region. */
    onStatus?: (message: string) => void;
  } = $props();

  let run = $state<MemoryExportResponseDto | undefined>();
  let busy = $state(false);
  let dialogOpen = $state(false);
  let initial = $state<MemoryHighlightChoice>(defaultHighlightChoice);
  let renderEvidence = $state<StudioRenderEvidence[]>([]);
  let timer: ReturnType<typeof setTimeout> | undefined;

  const active = $derived(!!run && isExportActive(run.status));
  const percent = $derived(run ? Math.round(exportProgress(run) * 100) : 0);
  const savedAssetId = $derived(run?.highlight?.savedAssetId ?? null);
  const ended = $derived(run?.status === MemoryExportStatus.Failed || run?.status === MemoryExportStatus.Cancelled);

  const stopPolling = () => {
    clearTimeout(timer);
    timer = undefined;
  };

  const follow = () => {
    stopPolling();
    if (run && isExportActive(run.status)) {
      timer = setTimeout(() => void poll(), pollMs);
    }
  };

  const poll = async () => {
    if (!run) {
      return;
    }
    try {
      const next = await getMemoryExport({ id: run.id });
      if (next.status === MemoryExportStatus.Ready && run.status !== MemoryExportStatus.Ready) {
        onStatus?.($t('frameleaf_memories_highlight_ready'));
      }
      run = next;
    } catch (error) {
      // the run is gone with its memory, so there is nothing left to follow
      handleError(error, $t('frameleaf_memories_highlight_failed'));
      run = undefined;
    }
    follow();
  };

  $effect(() => {
    const id = memoryId;
    stopPolling();
    run = undefined;
    let stale = false;
    void (async () => {
      try {
        const runs = await getMemoryExports({ memoryId: id });
        if (!stale) {
          run = latestExport(runs, id, MemoryExportFormat.Highlight);
          follow();
        }
      } catch {
        // an unreachable export list must not take the player down with it
      }
    })();
    return () => {
      stale = true;
      stopPolling();
    };
  });

  const openDialog = async (choice: MemoryHighlightChoice = defaultHighlightChoice) => {
    initial = choice;
    dialogOpen = true;
    // What the render workers verified, from this server only, so the dialog can name a refusal.
    ({ renderEvidence } = await probeStudioHost());
  };

  const start = async (choice: MemoryHighlightChoice) => {
    if (busy) {
      return;
    }
    busy = true;
    try {
      run = await createMemoryExport({
        id: memoryId,
        memoryExportCreateDto: { format: MemoryExportFormat.Highlight, highlight: choice },
      });
      dialogOpen = false;
      onStatus?.($t('frameleaf_memories_highlight_started'));
      follow();
    } catch (error) {
      // the server's own reason: no qualified worker for this resolution, a source it may not render…
      handleError(error, $t('frameleaf_memories_highlight_failed'));
    } finally {
      busy = false;
    }
  };

  const retry = () => {
    const previous = run?.highlight;
    void openDialog(
      previous
        ? {
            lengthSeconds: previous.lengthSeconds,
            resolution: previous.resolution,
            audio: previous.audio,
            destination: previous.destination,
          }
        : defaultHighlightChoice,
    );
  };

  const cancel = async () => {
    if (!run || busy) {
      return;
    }
    busy = true;
    try {
      run = await cancelMemoryExport({ id: run.id });
      onStatus?.($t('frameleaf_memories_highlight_cancelled'));
      follow();
    } catch (error) {
      handleError(error, $t('frameleaf_memories_highlight_failed'));
    } finally {
      busy = false;
    }
  };

  const download = async () => {
    if (!run?.isDownloadable || busy) {
      return;
    }
    busy = true;
    try {
      const blob = await downloadMemoryExport({ id: run.id });
      downloadBlob(blob, `${run.title}.mp4`);
    } catch (error) {
      handleError(error, $t('frameleaf_memories_highlight_failed'));
    } finally {
      busy = false;
    }
  };

  const save = async () => {
    if (!run?.isDownloadable || busy) {
      return;
    }
    busy = true;
    try {
      run = await saveMemoryExportToLibrary({ id: run.id });
      onStatus?.($t('frameleaf_memories_highlight_saved'));
    } catch (error) {
      handleError(error, $t('frameleaf_memories_highlight_failed'));
    } finally {
      busy = false;
    }
  };
</script>

{#if active}
  <span
    class="fmh-progress"
    role="status"
    aria-live="polite"
    aria-label={$t('frameleaf_memories_highlight_progress', { values: { percent } })}
  >
    <span class="fmh-bar" aria-hidden="true"><span class="fmh-fill" style:inline-size={`${percent}%`}></span></span>
    <span class="fmh-text">
      {run?.status === MemoryExportStatus.Cancelling
        ? $t('frameleaf_memories_highlight_cancelling')
        : $t('frameleaf_memories_highlight_progress', { values: { percent } })}
    </span>
  </span>
  <IconButton label={$t('frameleaf_memories_highlight_cancel')} onclick={() => void cancel()}>
    <Icon icon={mdiStopCircleOutline} size="20" />
  </IconButton>
{:else if run?.status === MemoryExportStatus.Ready && run.isDownloadable}
  <IconButton label={$t('frameleaf_memories_highlight_download')} onclick={() => void download()}>
    <Icon icon={mdiDownload} size="20" />
  </IconButton>
  {#if savedAssetId}
    <IconButton label={$t('frameleaf_memories_highlight_open_saved')} href={Route.viewAsset({ id: savedAssetId })}>
      <Icon icon={mdiMovieOpenCheckOutline} size="20" />
    </IconButton>
  {:else}
    <IconButton label={$t('frameleaf_memories_highlight_save')} onclick={() => void save()}>
      <Icon icon={mdiImagePlusOutline} size="20" />
    </IconButton>
  {/if}
  <IconButton label={$t('frameleaf_memories_highlight')} onclick={() => void openDialog()}>
    <Icon icon={mdiMovieOpenPlayOutline} size="20" />
  </IconButton>
{:else if ended}
  <IconButton label={$t('frameleaf_memories_highlight_retry')} onclick={retry}>
    <Icon icon={mdiRefresh} size="20" />
  </IconButton>
{:else}
  <IconButton label={$t('frameleaf_memories_highlight')} onclick={() => void openDialog()}>
    <Icon icon={mdiMovieOpenPlayOutline} size="20" />
  </IconButton>
{/if}

{#if run?.status === MemoryExportStatus.Failed}
  <p class="fmh-error" role="alert">{run.error ?? $t('frameleaf_memories_highlight_failed')}</p>
{/if}

<MemoryHighlightDialog bind:open={dialogOpen} {memoryTitle} {initial} {busy} {renderEvidence} onStart={start} />

<style>
  /* The archive export's progress pill in MemoryPlayerPanel (.fmp-export), for the render. */
  .fmh-progress {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.25rem 0.625rem;
    border-radius: 999px;
    color: #fff;
    background: rgb(0 0 0 / 45%);
    font-size: var(--fl-font-small);
    white-space: nowrap;
  }
  .fmh-bar {
    display: block;
    inline-size: 5rem;
    block-size: 0.25rem;
    border-radius: 999px;
    background: rgb(255 255 255 / 30%);
    overflow: hidden;
  }
  .fmh-fill {
    display: block;
    block-size: 100%;
    background: #fff;
    transition: inline-size 200ms linear;
  }
  @media (prefers-reduced-motion: reduce) {
    .fmh-fill {
      transition: none;
    }
  }
  .fmh-error {
    flex-basis: 100%;
    margin: 0;
    color: #fff;
    font-size: var(--fl-font-small);
    text-shadow: 0 1px 2px rgb(0 0 0 / 60%);
  }
</style>
