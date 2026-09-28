<script lang="ts">
  /**
   * The corner mark a library tile shows while a durable bulk job works on its item (FL-32, owner
   * decision September 22, 2026): a small loader until the job has answered for the item, then a
   * failure mark if it did not work. A finished item needs no mark — it has either left the view
   * or simply looks as it should.
   *
   * Decoration only: the tile's own button carries the same state in its accessible name, so a
   * screen reader hears it once, with the item it belongs to.
   */
  import type { DurableTileState } from '$lib/frameleaf/durable-bulk-tracker.svelte';
  import { Icon } from '@immich/ui';
  import { mdiAlertCircleOutline } from '@mdi/js';

  type Props = {
    job: DurableTileState;
    /** Already translated: "Processing" or the failure reason. Shown as the hover title. */
    label: string;
  };

  let { job, label }: Props = $props();
</script>

{#if job.state === 'pending'}
  <span class="fl-tile-job" title={label} aria-hidden="true" data-testid="frameleaf-tile-job-pending">
    <span class="fl-tile-job-spinner"></span>
  </span>
{:else}
  <span class="fl-tile-job is-failed" title={label} aria-hidden="true" data-testid="frameleaf-tile-job-failed">
    <Icon icon={mdiAlertCircleOutline} size="14" />
  </span>
{/if}

<style>
  .fl-tile-job {
    display: inline-grid;
    place-items: center;
    width: 22px;
    height: 22px;
    border-radius: 999px;
    /* The same scrim the tile's other badges sit on, so it reads over any photo. */
    background: rgb(0 0 0 / 55%);
    color: #fff;
  }
  .fl-tile-job.is-failed {
    background: var(--fl-danger);
    color: var(--fl-danger-text);
  }
  .fl-tile-job-spinner {
    width: 12px;
    height: 12px;
    border: 2px solid rgb(255 255 255 / 35%);
    border-top-color: var(--fl-accent);
    border-radius: 50%;
    animation: fl-tile-job-spin 900ms linear infinite;
  }
  @keyframes fl-tile-job-spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    /* Still, not gone: the ring with its accent arc says "working" without moving. */
    .fl-tile-job-spinner {
      animation: none;
    }
  }
</style>
