<script lang="ts" module>
  const CELEBRATED = 'frameleaf-setup-celebrated';
  const POLL_MS = 15_000;

  const readCelebrated = () => {
    try {
      return localStorage.getItem(CELEBRATED);
    } catch {
      return null;
    }
  };
</script>

<script lang="ts">
  /*
   * Setup bar (FL-1146, owner 2026-11-02; prototype SetupBar.jsx): an Immich import opens the library as soon as its
   * rows are in. Until the work behind it is done, administrators see this row above the top bar on every page:
   * the file check reads every original and compares it with Immich's checksum, thumbnails are made alongside it,
   * and smart search, faces and videos wait for the check. Quiet hours (FL-577) save those for the night, and the bar
   * says when they start. When everything has finished, the completion window opens once.
   */
  import { clickOutside } from '$lib/actions/click-outside';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { tonightLabel } from '$lib/frameleaf/background-work';
  import { Route } from '$lib/route';
  import { locale } from '$lib/stores/preferences.store';
  import { setupProgress } from '$lib/stores/setup-progress.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import {
    beginLibrarySetup,
    getLibrarySetupProgress,
    pauseLibrarySetup,
    Phase,
    type LibrarySetupProgressDto,
    LibrarySetupStageId,
    LibrarySetupStageStatus,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiAlertCircleOutline,
    mdiCheckCircle,
    mdiChevronDown,
    mdiChevronRight,
    mdiChevronUp,
    mdiClockOutline,
    mdiPause,
    mdiPauseCircleOutline,
    mdiPlay,
    mdiProgressClock,
  } from '@mdi/js';
  import { onDestroy } from 'svelte';
  import { t } from 'svelte-i18n';

  type Stage = LibrarySetupProgressDto['stages'][number];

  const progress = $derived(setupProgress.progress);
  let open = $state(false);
  let celebrating = $state(false);
  let busy = $state(false);
  let timer: ReturnType<typeof setInterval> | undefined;
  let loading = false;
  let requested = 0;
  let applied = 0;
  /** The kept answer is shared: an answer that lands after this bar has gone must not replace the next page's. */
  let disposed = false;

  // The kept answer belongs to an administrator; another account never sees it.
  const visible = $derived(!!authManager.user?.isAdmin && !!progress?.active && !progress.completedAt);
  const attention = $derived(progress?.phase === Phase.NeedsAttention);
  /** A stage with AI processing off still has work while videos are left in it. */
  const hasWork = (stage: Stage) => !stage.disabled || stage.done < stage.total;
  const current = $derived(
    progress?.stages.find(
      (stage) =>
        hasWork(stage) &&
        (stage.status === LibrarySetupStageStatus.Running || stage.status === LibrarySetupStageStatus.Paused),
    ) ?? progress?.stages.find((stage) => hasWork(stage) && stage.status === LibrarySetupStageStatus.Waiting),
  );
  const part = $derived(current && current.total > 0 ? Math.min(1, current.done / current.total) : 0);
  const percent = $derived(Math.floor(part * 100));
  const secondsLeft = $derived.by(() => {
    const since = setupProgress.since;
    if (!current || !since || since.id !== current.id || progress?.paused) {
      return null;
    }
    const elapsed = (Date.now() - since.at) / 1000;
    const rate = (current.done - since.done) / elapsed;
    return elapsed >= 60 && rate > 0 ? (current.total - current.done) / rate : null;
  });

  const stageTitle = (id: LibrarySetupStageId) => $t(`setup_bar_stage_${id}`);
  const tonight = (stage: Stage) => tonightLabel(stage.resumesAt ?? null, $t, $locale);
  // Work quiet hours saved for the night says when it starts, AI processing off or on.
  const stageDetail = (stage: Stage) =>
    stage.heldForNight
      ? tonight(stage)
      : stage.disabled
        ? $t(hasWork(stage) ? 'setup_bar_stage_videos_detail' : 'setup_bar_stage_search_disabled')
        : stage.id === LibrarySetupStageId.Search && stage.status === LibrarySetupStageStatus.Waiting
          ? $t('setup_bar_stage_search_waiting')
          : $t(`setup_bar_stage_${stage.id}_detail`);
  // The stage status has no failed value (native clients decode it strictly); a halted setup means the check stopped.
  const stopped = (stage: { id: LibrarySetupStageId; status: LibrarySetupStageStatus }) =>
    attention && stage.id === LibrarySetupStageId.Check && stage.status !== LibrarySetupStageStatus.Done;
  const statusIcon = {
    [LibrarySetupStageStatus.Done]: mdiCheckCircle,
    [LibrarySetupStageStatus.Running]: mdiProgressClock,
    [LibrarySetupStageStatus.Paused]: mdiPauseCircleOutline,
    [LibrarySetupStageStatus.Waiting]: mdiClockOutline,
  };
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

  const stopPolling = () => {
    clearInterval(timer);
    timer = undefined;
  };

  const show = (next: LibrarySetupProgressDto) => {
    const stage = next.stages.find((item) => item.status === LibrarySetupStageStatus.Running);
    if (!stage) {
      setupProgress.since = null;
    } else if (setupProgress.since?.id !== stage.id) {
      setupProgress.since = { id: stage.id, at: Date.now(), done: stage.done };
    }
    setupProgress.progress = next;
    if (next.completedAt && readCelebrated() !== next.completedAt) {
      celebrating = true;
    }
    // An inactive answer can come before Manager starts setup, so only a finished setup ends polling. Servers
    // not set up from an import answer at once without reading the database.
    if (next.completedAt) {
      stopPolling();
    }
  };

  /** Only the newest answer is shown: a slow poll must not undo a later one, or a pause. */
  const latest = async (request: Promise<LibrarySetupProgressDto>) => {
    const id = ++requested;
    const next = await request;
    if (!disposed && id > applied) {
      applied = id;
      show(next);
    }
  };

  const load = async () => {
    if (loading) {
      return;
    }
    loading = true;
    try {
      await latest(getLibrarySetupProgress());
    } catch {
      // A restart or a dropped connection: the next poll asks again.
    } finally {
      loading = false;
    }
  };

  const act = async (work: () => Promise<unknown>) => {
    if (!progress || busy) {
      return;
    }
    busy = true;
    try {
      await work();
    } catch (error) {
      handleError(error, $t('setup_bar_action_error'));
    } finally {
      busy = false;
    }
  };
  const togglePause = () =>
    act(() => latest(pauseLibrarySetup({ librarySetupPauseDto: { paused: !progress!.paused } })));
  // A failed or cancelled file check stops setup; starting it again is the only way on (Library Care says why).
  const retry = () =>
    act(async () => {
      await beginLibrarySetup();
      await latest(getLibrarySetupProgress());
    });

  const closeCelebration = () => {
    celebrating = false;
    try {
      localStorage.setItem(CELEBRATED, progress?.completedAt ?? '');
    } catch {
      // Without storage the window may open again on the next visit; nothing else depends on it.
    }
  };

  $effect(() => {
    if (!authManager.authenticated || !authManager.user?.isAdmin) {
      return;
    }
    void load();
    timer = setInterval(() => void load(), POLL_MS);
    return stopPolling;
  });

  // Pages size themselves from --fl-topbar-height, which adds this bar's height (app.css).
  $effect(() => {
    document.documentElement.style.setProperty('--fl-setup-bar-height', visible ? `${setupProgress.height}px` : '0px');
  });
  onDestroy(() => {
    disposed = true;
    document.documentElement.style.removeProperty('--fl-setup-bar-height');
  });
</script>

{#if visible && progress}
  <div
    class="fl-setup-bar"
    class:is-paused={progress.paused}
    class:is-attention={attention}
    bind:clientHeight={setupProgress.height}
    use:clickOutside={{ onOutclick: () => (open = false), onEscape: () => (open = false) }}
  >
    <Icon
      icon={attention ? mdiAlertCircleOutline : progress.paused ? mdiPauseCircleOutline : mdiProgressClock}
      size="18"
      class="fl-setup-bar-icon"
      aria-hidden={true}
    />
    <p class="fl-setup-bar-text" role="status">
      <strong>
        {attention
          ? $t('setup_bar_attention_title')
          : progress.paused
            ? $t('setup_bar_paused_title')
            : $t('setup_bar_title')}
      </strong>
      <span class="fl-setup-bar-detail">
        {#if attention}
          {$t(progress.stages.length > 0 ? 'setup_bar_attention_detail' : 'setup_bar_identity_attention_detail')}
        {:else if current && current.total > 0}
          {$t('setup_bar_progress', {
            values: {
              stage: stageTitle(current.id),
              done: current.done.toLocaleString($locale),
              total: current.total.toLocaleString($locale),
            },
          })}
        {:else if current}
          {stageTitle(current.id)}
        {/if}
        {#if attention}
          <!-- The attention line says it all. -->
        {:else if current?.heldForNight}
          · {tonight(current)}
        {:else if secondsLeft !== null}
          · {timeLeft(secondsLeft)}
        {/if}
      </span>
      {#if current}
        <span class="fl-setup-bar-percent">{percent}%</span>
      {/if}
    </p>
    {#if progress.flagged > 0}
      <a class="fl-setup-bar-flag" href={Route.libraryCare()}>
        <Icon icon={mdiAlertCircleOutline} size="16" aria-hidden={true} />
        {$t('setup_bar_flagged', { values: { count: progress.flagged } })}
      </a>
    {/if}
    {#if current}
      <div
        class="fl-setup-bar-progress"
        role="progressbar"
        aria-label={stageTitle(current.id)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <span style:width="{part * 100}%"></span>
      </div>
    {/if}
    <div class="fl-setup-bar-actions">
      {#if attention && progress.stages.length > 0}
        <button type="button" class="button primary" disabled={busy} onclick={retry}>
          {$t('retry')}
        </button>
      {:else if !attention}
        <button type="button" class="button fl-setup-bar-pause" disabled={busy} onclick={togglePause}>
          <Icon icon={progress.paused ? mdiPlay : mdiPause} size="18" aria-hidden={true} />
          {progress.paused ? $t('resume') : $t('pause')}
        </button>
      {/if}
      <button
        type="button"
        class="button"
        aria-expanded={open}
        aria-controls="fl-setup-bar-panel"
        onclick={() => (open = !open)}
      >
        {$t('details')}
        <Icon icon={open ? mdiChevronUp : mdiChevronDown} size="18" aria-hidden={true} />
      </button>
    </div>

    {#if open}
      <section class="fl-setup-bar-panel" id="fl-setup-bar-panel" aria-label={$t('setup_bar_title')}>
        {#if attention}
          <p>{$t(progress.stages.length > 0 ? 'setup_bar_attention_detail' : 'setup_bar_identity_attention_detail')}</p>
        {/if}
        {#if progress.stages.length > 0}
          <ol>
            <li class="is-done">
              <Icon icon={mdiCheckCircle} size="18" class="fl-setup-stage-icon" aria-hidden={true} />
              <div>
                <div class="fl-setup-stage-head">
                  <strong>{$t('setup_bar_stage_import')}</strong>
                  <span>{$t('setup_bar_status_done')}</span>
                </div>
                <p>
                  {$t('setup_bar_stage_import_detail', { values: { count: progress.items.toLocaleString($locale) } })}
                </p>
              </div>
            </li>
            {#each progress.stages as stage (stage.id)}
              {@const share = stage.total > 0 ? stage.done / stage.total : 0}
              {@const partial =
                hasWork(stage) && share > 0 && share < 1 && stage.status !== LibrarySetupStageStatus.Done}
              <li
                class:is-done={stage.status === LibrarySetupStageStatus.Done}
                class:is-running={stage.status === LibrarySetupStageStatus.Running && !stopped(stage)}
                class:is-waiting={stage.status === LibrarySetupStageStatus.Waiting}
              >
                <Icon
                  icon={!hasWork(stage)
                    ? mdiPauseCircleOutline
                    : stopped(stage)
                      ? mdiAlertCircleOutline
                      : statusIcon[stage.status]}
                  size="18"
                  class="fl-setup-stage-icon"
                  aria-hidden={true}
                />
                <div>
                  <div class="fl-setup-stage-head">
                    <strong>{stageTitle(stage.id)}</strong>
                    <span
                      >{stopped(stage)
                        ? $t('setup_bar_status_stopped')
                        : partial
                          ? `${Math.floor(share * 100)}%`
                          : !hasWork(stage)
                            ? $t('setup_bar_status_disabled')
                            : $t(`setup_bar_status_${stage.status}`)}</span
                    >
                  </div>
                  <p>{stageDetail(stage)}</p>
                  {#if stage.heldForNight && stage.disabled}
                    <!-- Only videos are saved for the night; AI processing stays off. -->
                    <p>{$t('setup_bar_stage_search_disabled')}</p>
                  {/if}
                  {#if partial}
                    <div class="fl-setup-bar-progress is-stage" aria-hidden="true">
                      <span style:width="{share * 100}%"></span>
                    </div>
                  {/if}
                </div>
              </li>
            {/each}
          </ol>
        {/if}
        <footer>
          <p>{progress.paused ? $t('setup_bar_footer_paused') : $t('setup_bar_footer')}</p>
          {#if !attention}
            <button type="button" class="button fl-setup-bar-panel-pause" disabled={busy} onclick={togglePause}>
              <Icon icon={progress.paused ? mdiPlay : mdiPause} size="18" aria-hidden={true} />
              {progress.paused ? $t('resume') : $t('pause')}
            </button>
          {/if}
          <a class="button" href={Route.libraryCare()}>
            {$t('setup_bar_library_care')}
            <Icon icon={mdiChevronRight} size="18" aria-hidden={true} />
          </a>
        </footer>
      </section>
    {/if}
  </div>
{/if}

{#if celebrating && progress}
  <!-- Loaded only when it opens: it shows once per library. -->
  {#await import('$lib/components/frameleaf/SetupComplete.svelte') then { default: SetupComplete }}
    <SetupComplete {progress} onClose={closeCelebration} />
  {/await}
{/if}

<style>
  /* One row above the top bar, on the bar's own gutters (TopBar.svelte .fl-topbar-grid). */
  .fl-setup-bar {
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
  .fl-setup-bar :global(.fl-setup-bar-icon) {
    flex-shrink: 0;
    color: var(--fl-accent);
  }
  .fl-setup-bar.is-paused :global(.fl-setup-bar-icon) {
    color: var(--fl-muted);
  }
  .fl-setup-bar.is-attention {
    background: color-mix(in srgb, var(--fl-warning), var(--fl-panel) 88%);
  }
  .fl-setup-bar.is-attention :global(.fl-setup-bar-icon) {
    color: var(--fl-warning);
  }
  .fl-setup-bar-text {
    display: flex;
    align-items: baseline;
    gap: 12px;
    min-width: 0;
    margin: 0;
  }
  .fl-setup-bar-text strong {
    font-weight: 600;
    white-space: nowrap;
  }
  .fl-setup-bar-detail {
    overflow: hidden;
    color: var(--fl-muted);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fl-setup-bar-percent {
    display: none;
    color: var(--fl-muted);
    font-variant-numeric: tabular-nums;
  }
  .fl-setup-bar-flag {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    gap: 6px;
    min-height: 34px;
    padding: 0 4px;
    color: var(--fl-warning);
    white-space: nowrap;
  }
  .fl-setup-bar-flag:hover {
    text-decoration: underline;
  }
  .fl-setup-bar-progress {
    flex: 1;
    min-width: 120px;
    height: 6px;
    overflow: hidden;
    border-radius: 999px;
    background: color-mix(in srgb, var(--fl-text), transparent 88%);
  }
  .fl-setup-bar-progress span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--fl-accent);
    transition: width 240ms cubic-bezier(0.2, 0.7, 0.2, 1);
  }
  .fl-setup-bar.is-paused .fl-setup-bar-progress span {
    background: var(--fl-muted);
  }
  .fl-setup-bar-actions {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: 8px;
    margin-inline-start: auto;
  }

  /* Details: a panel under the bar, aligned with its right gutter. */
  .fl-setup-bar-panel {
    position: absolute;
    top: calc(100% + 8px);
    inset-inline-end: 24px;
    width: min(440px, calc(100vw - 32px));
    padding: 20px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card, 10px);
    background: var(--fl-panel);
    box-shadow: var(--fl-shadow-2);
  }
  .fl-setup-bar-panel ol {
    display: grid;
    gap: 16px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .fl-setup-bar-panel li {
    display: grid;
    grid-template-columns: 18px 1fr;
    gap: 12px;
  }
  .fl-setup-bar-panel :global(.fl-setup-stage-icon) {
    margin-top: 1px;
    color: var(--fl-muted);
  }
  .fl-setup-bar-panel li.is-done :global(.fl-setup-stage-icon),
  .fl-setup-bar-panel li.is-running :global(.fl-setup-stage-icon) {
    color: var(--fl-accent);
  }
  .fl-setup-stage-head {
    display: flex;
    justify-content: space-between;
    gap: 12px;
  }
  .fl-setup-stage-head span {
    color: var(--fl-muted);
    font-variant-numeric: tabular-nums;
  }
  .fl-setup-bar-panel li p {
    margin: 4px 0 0;
    color: var(--fl-muted);
    font-size: 12px;
  }
  .fl-setup-bar-progress.is-stage {
    height: 4px;
    margin-top: 8px;
  }
  .fl-setup-bar-panel li.is-waiting strong {
    color: var(--fl-muted);
    font-weight: 500;
  }
  .fl-setup-bar-panel footer {
    display: flex;
    align-items: center;
    gap: 16px;
    margin-top: 20px;
    padding-top: 16px;
    border-top: 1px solid var(--fl-border);
  }
  .fl-setup-bar-panel footer p {
    flex: 1;
    margin: 0;
    color: var(--fl-muted);
    font-size: 12px;
  }
  .fl-setup-bar-panel .fl-setup-bar-panel-pause {
    display: none;
  }

  /* Narrow windows: the stage moves into Details; the percent and a thin line along the bottom stay. */
  @media (max-width: 1000px) {
    .fl-setup-bar-detail {
      display: none;
    }
    .fl-setup-bar-percent {
      display: inline;
    }
  }
  @media (max-width: 700px) {
    .fl-setup-bar {
      gap: 12px;
      padding: 8px max(1rem, var(--fl-safe-right)) 8px max(1rem, var(--fl-safe-left));
    }
    .fl-setup-bar-flag,
    .fl-setup-bar-actions .fl-setup-bar-pause {
      display: none;
    }
    .fl-setup-bar-progress:not(.is-stage) {
      position: absolute;
      inset-inline: 0;
      bottom: -1px;
      height: 3px;
      border-radius: 0;
    }
    .fl-setup-bar-panel {
      inset-inline-end: 16px;
    }
    .fl-setup-bar-panel footer {
      flex-wrap: wrap;
    }
    .fl-setup-bar-panel footer p {
      flex-basis: 100%;
    }
    .fl-setup-bar-panel .fl-setup-bar-panel-pause {
      display: inline-flex;
    }
  }
</style>
