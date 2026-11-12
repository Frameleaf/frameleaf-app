<script lang="ts">
  /*
   * FL-1409 (M5; prototype SetupBar.jsx): the "Setting up your library" row, during any large import. An
   * external-library scan or a large upload gets the same row above the top bar: how many photos are ready and about
   * how long is left. When that work is paused, held for the night or waiting for a drive, the row says so in the
   * words of the run's Recent work card and offers the card's Resume or Release. `import-progress.ts` says what the
   * server can report. The first-run import keeps its own bar (SetupBar.svelte); this one stays away while that shows.
   */
  import { tonightLabel } from '$lib/frameleaf/background-work';
  import { importProgress } from '$lib/frameleaf/import-progress';
  import { runningJobsSession } from '$lib/frameleaf/running-jobs-session.svelte';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { Route } from '$lib/route';
  import { handleResumeQueue } from '$lib/services/queue.service';
  import { locale } from '$lib/stores/preferences.store';
  import { setupProgress } from '$lib/stores/setup-progress.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import { releaseJobRun } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiChevronRight, mdiHarddisk, mdiPauseCircleOutline, mdiPlay, mdiProgressClock } from '@mdi/js';
  import { onDestroy, onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  const progress = $derived(importProgress(runningJobsSession.summary));
  /** The first-run import's bar is showing: one bar at a time. */
  const settingUp = $derived(!!setupProgress.progress?.active && !setupProgress.progress.completedAt);
  const visible = $derived(!!progress && !settingUp);
  const stopped = $derived(progress?.stopped);
  const part = $derived(progress?.ready ? Math.min(1, progress.ready.done / progress.ready.total) : 0);
  const percent = $derived(Math.floor(part * 100));
  let busy = $state(false);
  let height = $state(0);

  const number = (value: number) => value.toLocaleString($locale);
  const title = $derived(
    progress?.scan
      ? progress.scan.name
        ? $t('frameleaf_import_bar_title_scan', { values: { name: progress.scan.name } })
        : $t('frameleaf_import_bar_title_scan_unnamed')
      : progress?.upload?.name
        ? $t('frameleaf_import_bar_title_upload', { values: { name: progress.upload.name } })
        : $t('frameleaf_import_bar_title'),
  );
  /** The first-run bar's words for a time left. */
  const timeLeft = (seconds: number) => {
    const minutes = Math.max(1, Math.round(seconds / 60));
    if (minutes < 90) {
      return $t('setup_bar_left_minutes', { values: { count: minutes } });
    }
    const hours = Math.round(minutes / 60);
    return hours < 48
      ? $t('setup_bar_left_hours', { values: { count: hours } })
      : $t('setup_bar_left_days', { values: { count: Math.round(hours / 24) } });
  };

  /** Resume or Release, as the run's Recent work card does it. */
  const act = async () => {
    if (!stopped || busy) {
      return;
    }
    busy = true;
    try {
      if (stopped.action === 'release' && stopped.run) {
        await releaseJobRun({ id: stopped.run.id });
      } else {
        for (const name of stopped.queues) {
          await handleResumeQueue({ name });
        }
      }
    } catch (error) {
      handleError(
        error,
        $t(stopped.action === 'release' ? 'frameleaf_job_runs_release_failed' : 'frameleaf_job_runs_resume_failed'),
      );
    } finally {
      busy = false;
      await runningJobsSession.refresh();
    }
  };

  onMount(() => runningJobsSession.watch());
  // Pages size themselves from --fl-topbar-height, which adds this bar's height (app.css).
  $effect(() => {
    document.documentElement.style.setProperty('--fl-import-bar-height', visible ? `${height}px` : '0px');
  });
  onDestroy(() => document.documentElement.style.removeProperty('--fl-import-bar-height'));
</script>

{#if visible && progress}
  <div class="fl-import-bar" class:is-stopped={!!stopped} bind:clientHeight={height}>
    <Icon
      icon={stopped?.status === 'frameleaf_job_runs_status_waiting_drive'
        ? mdiHarddisk
        : stopped
          ? mdiPauseCircleOutline
          : mdiProgressClock}
      size="18"
      class="fl-import-bar-icon"
      aria-hidden={true}
    />
    <p class="fl-import-bar-text" role="status">
      <strong>{title}</strong>
      <span class="fl-import-bar-detail">
        {#if progress.ready}
          {$t('frameleaf_import_bar_ready', {
            values: { done: number(progress.ready.done), total: number(progress.ready.total) },
          })}
        {:else if progress.found !== undefined}
          {$t('frameleaf_import_bar_found', { values: { count: progress.found } })}
        {/if}
        {#if stopped}
          · {$t(stopped.status)}{#if stopped.why}: {$t(stopped.why, { values: stopped.values })}{/if}
        {:else if progress.tonight}
          · {tonightLabel(progress.tonight.startsAt, $t, $locale)}
        {:else if progress.etaSeconds !== null}
          · {timeLeft(progress.etaSeconds)}
        {/if}
      </span>
      {#if stopped}
        <!-- Narrow windows keep the state when the sentence has no room. -->
        <span class="fl-import-bar-short">{$t(stopped.status)}</span>
      {:else if progress.ready}
        <span class="fl-import-bar-short">{percent}%</span>
      {/if}
    </p>
    {#if progress.ready}
      <div
        class="fl-import-bar-progress"
        role="progressbar"
        aria-label={title}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <span style:width="{part * 100}%"></span>
      </div>
    {/if}
    <div class="fl-import-bar-actions">
      {#if stopped?.action === 'tasks'}
        <a class="button" href={commandCenterUrl('processing', 'queues')}>{$t('frameleaf_job_runs_see_paused')}</a>
      {:else if stopped?.action}
        <button type="button" class="button" disabled={busy} onclick={() => void act()}>
          {#if stopped.action === 'resume'}
            <Icon icon={mdiPlay} size="18" aria-hidden={true} />{$t('resume')}
          {:else}
            {$t('frameleaf_job_runs_release')}
          {/if}
        </button>
      {/if}
      <a class="button fl-import-bar-open" href={Route.activity()}>
        {$t('frameleaf_activity_title')}
        <Icon icon={mdiChevronRight} size="18" aria-hidden={true} />
      </a>
    </div>
  </div>
{/if}

<style>
  /* SetupBar.svelte's row: above the top bar, on the bar's own gutters (TopBar.svelte .fl-topbar-grid). */
  .fl-import-bar {
    position: relative;
    z-index: 30;
    display: flex;
    align-items: center;
    gap: 16px;
    min-height: 52px;
    padding: 8px max(1.5rem, var(--fl-safe-right)) 8px max(1.125rem, var(--fl-safe-left));
    border-bottom: 1px solid var(--fl-border);
    background: color-mix(in srgb, var(--fl-accent), var(--fl-panel) 92%);
    color: var(--fl-text);
  }
  .fl-import-bar :global(.fl-import-bar-icon) {
    flex-shrink: 0;
    color: var(--fl-accent);
  }
  .fl-import-bar.is-stopped :global(.fl-import-bar-icon) {
    color: var(--fl-muted);
  }
  .fl-import-bar-text {
    display: flex;
    align-items: baseline;
    gap: 12px;
    min-width: 0;
    margin: 0;
  }
  .fl-import-bar-text strong {
    overflow: hidden;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fl-import-bar-detail {
    overflow: hidden;
    color: var(--fl-muted);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fl-import-bar-short {
    display: none;
    flex-shrink: 0;
    color: var(--fl-muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .fl-import-bar-progress {
    flex: 1;
    min-width: 120px;
    height: 6px;
    overflow: hidden;
    border-radius: 999px;
    background: color-mix(in srgb, var(--fl-text), transparent 88%);
  }
  .fl-import-bar-progress span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--fl-accent);
    transition: width 240ms cubic-bezier(0.2, 0.7, 0.2, 1);
  }
  .fl-import-bar.is-stopped .fl-import-bar-progress span {
    background: var(--fl-muted);
  }
  .fl-import-bar-actions {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: 8px;
    margin-inline-start: auto;
  }

  /* Narrow windows: the sentence gives way to the percent, or to the state when the work is not moving. */
  @media (max-width: 1000px) {
    .fl-import-bar-detail {
      display: none;
    }
    .fl-import-bar-short {
      display: inline;
    }
  }
  @media (max-width: 700px) {
    .fl-import-bar {
      gap: 12px;
      padding: 8px max(1rem, var(--fl-safe-right)) 8px max(1rem, var(--fl-safe-left));
    }
    .fl-import-bar-open {
      display: none;
    }
    .fl-import-bar-progress {
      position: absolute;
      inset-inline: 0;
      bottom: -1px;
      min-width: 0;
      height: 3px;
      border-radius: 0;
    }
  }
</style>
