<script lang="ts">
  import { activityIndicatorState, buildActivityList } from '$lib/frameleaf/activity';
  import { activitySession } from '$lib/frameleaf/activity-session.svelte';
  import { downloadManager } from '$lib/managers/download-manager.svelte';
  import { Route } from '$lib/route';
  import { uploadAssetsStore } from '$lib/stores/upload';
  import { DURATION } from '$lib/frameleaf/tokens';
  import { onDestroy, onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  /**
   * Top bar activity indicator (FL-30, completed by FL-104).
   *
   * It now counts the durable jobs the server is running as well as the transfers this tab is
   * running, and it is a link: the Activity page exists, so the shell offers the destination it
   * was always meant to. It stays hidden while nothing is happening.
   *
   * The count comes from the server, not from a local timer, which is why closing this tab and
   * opening another one shows the same number. As in the prototype (`Activity.jsx`
   * `ActivityIndicator`) the pill shows a ring and the count, and speaks of jobs.
   *
   * It is the only "work in progress" mark in the top bar, at every width (the bell is for
   * notifications). The ring is determinate when the work reports progress and closes into a tick
   * for a moment when the last job ends.
   */

  const pendingDownloads = $derived(
    [...downloadManager.assets.entries()].filter(([, download]) => download.status === 'preparing'),
  );

  const indicator = $derived(
    activityIndicatorState(
      buildActivityList({
        operations: activitySession.operations,
        uploads: $uploadAssetsStore,
        downloads: pendingDownloads,
      }),
    ),
  );

  // Watching keeps the count current; it polls only while work is in flight and stops with the bar.
  onMount(() => activitySession.watch());

  /** How long the tick stays after the last job ends. */
  const DONE_MS = 1200;
  /** The ring's circumference for r = 6 in a 16px box. */
  const RING = 2 * Math.PI * 6;

  // When the last job ends the ring closes into a tick for a moment, then the pill fades away.
  let done = $state(false);
  let wasRunning = false;
  let doneTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    const running = indicator.count > 0;
    if (running) {
      clearTimeout(doneTimer);
      done = false;
    } else if (wasRunning) {
      done = true;
      doneTimer = setTimeout(() => (done = false), DONE_MS + DURATION.fade);
    }
    wasRunning = running;
  });
  onDestroy(() => clearTimeout(doneTimer));

  const label = $derived(
    done
      ? $t('frameleaf_activity_indicator_done')
      : indicator.progress === null
        ? $t('frameleaf_activity_indicator', { values: { count: indicator.count } })
        : $t('frameleaf_activity_indicator_progress', {
            values: { count: indicator.count, progress: indicator.progress },
          }),
  );
</script>

{#if indicator.count > 0 || done}
  <a
    class="fl-activity"
    class:is-done={done}
    href={Route.activity()}
    title={$t('frameleaf_activity_open')}
    aria-label={label}
    data-testid="frameleaf-activity-indicator"
    style:--fl-activity-hold="{DONE_MS}ms"
  >
    <svg class="fl-activity-ring" viewBox="0 0 16 16" aria-hidden="true">
      <circle class="fl-activity-track" cx="8" cy="8" r="6" />
      <!-- Determinate when the work reports progress; otherwise a turning quarter arc. -->
      <circle
        class="fl-activity-arc"
        class:is-indeterminate={!done && indicator.progress === null}
        cx="8"
        cy="8"
        r="6"
        stroke-dasharray={RING}
        stroke-dashoffset={done ? 0 : RING * (1 - (indicator.progress ?? 25) / 100)}
      />
      {#if done}
        <path class="fl-activity-tick" d="M5 8.2 7.2 10.4 11 6" />
      {/if}
    </svg>
    {#if !done}
      <!-- Prototype `ActivityIndicator`: the ring and the number of running jobs; the label says the rest. -->
      <span class="fl-activity-count" aria-hidden="true">{indicator.count}</span>
    {/if}
  </a>
{/if}

<style>
  .fl-activity {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    gap: var(--fl-space-2);
    min-height: var(--fl-control-compact);
    padding: 0 var(--fl-space-3);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-pill);
    background: var(--fl-raised);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    white-space: nowrap;
    text-decoration: none;
  }
  .fl-activity:hover,
  .fl-activity:focus-visible {
    color: var(--fl-text);
    background: color-mix(in srgb, var(--fl-raised), var(--fl-text) 8%);
  }
  .fl-activity-count {
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }
  /* Finished: hold the tick, then fade the pill away. */
  .fl-activity.is-done {
    animation: fl-fade-out var(--fl-duration-fade) var(--fl-ease) both;
    animation-delay: var(--fl-activity-hold);
  }
  .fl-activity-ring {
    width: var(--fl-icon-md);
    height: var(--fl-icon-md);
    fill: none;
    stroke-width: 2;
    stroke-linecap: round;
  }
  .fl-activity-track {
    stroke: var(--fl-border);
  }
  .fl-activity-arc {
    stroke: var(--fl-accent);
    /* The arc starts at twelve o'clock; `rotate` leaves `transform` free for the turning animation. */
    rotate: -90deg;
    transform-origin: center;
    transition: stroke-dashoffset var(--fl-duration) linear;
  }
  .fl-activity-arc.is-indeterminate {
    animation: fl-spin var(--fl-duration-spin) linear infinite;
  }
  .fl-activity-tick {
    stroke: var(--fl-accent);
    stroke-linejoin: round;
    animation: fl-fade-in var(--fl-motion) var(--fl-ease) both;
  }
  /* Phones: the ring alone, so the bar keeps to its fixed grid. */
  @media (max-width: 47.99rem) {
    .fl-activity {
      justify-content: center;
      min-width: var(--fl-control-compact);
      padding: 0;
      border-color: transparent;
      background: transparent;
    }
    .fl-activity-count {
      display: none;
    }
  }
  /* Reduce Motion: the ring updates without easing and does not turn; the tick simply appears. */
  @media (prefers-reduced-motion: reduce) {
    .fl-activity-arc,
    .fl-activity-arc.is-indeterminate,
    .fl-activity-tick {
      transition: none;
      animation: none;
    }
  }
</style>
