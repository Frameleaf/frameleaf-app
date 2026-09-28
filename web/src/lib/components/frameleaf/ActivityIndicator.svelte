<script lang="ts">
  import { activityIndicatorState, buildActivityList } from '$lib/frameleaf/activity';
  import { activitySession } from '$lib/frameleaf/activity-session.svelte';
  import { downloadManager } from '$lib/managers/download-manager.svelte';
  import { Route } from '$lib/route';
  import { uploadAssetsStore } from '$lib/stores/upload';
  import { onMount } from 'svelte';
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
   * `ActivityIndicator`) the pill shows the spinner and the count, and speaks of jobs.
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
</script>

{#if indicator.count > 0}
  <a
    class="fl-activity"
    href={Route.activity()}
    title={$t('frameleaf_activity_open')}
    aria-label={indicator.progress === null
      ? $t('frameleaf_activity_indicator', { values: { count: indicator.count } })
      : $t('frameleaf_activity_indicator_progress', {
          values: { count: indicator.count, progress: indicator.progress },
        })}
  >
    <span class="fl-spinner" aria-hidden="true"></span>
    <!-- Prototype `ActivityIndicator`: the spinner and the number of running jobs; the label says the rest. -->
    <span class="fl-activity-count" aria-hidden="true">{indicator.count}</span>
  </a>
{/if}

<style>
  .fl-activity {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.25rem 0.625rem;
    border: 1px solid var(--fl-border);
    border-radius: 999px;
    background: var(--fl-raised);
    color: var(--fl-muted);
    font-size: 0.75rem;
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
  .fl-spinner {
    width: 0.75rem;
    height: 0.75rem;
    border: 2px solid var(--fl-border);
    border-top-color: var(--fl-accent);
    border-radius: 50%;
    animation: fl-spin 900ms linear infinite;
  }
  @keyframes fl-spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .fl-spinner {
      animation: none;
    }
  }
</style>
