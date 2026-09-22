<script lang="ts">
  import { downloadManager } from '$lib/managers/download-manager.svelte';
  import { uploadAssetsStore } from '$lib/stores/upload';
  import { t } from 'svelte-i18n';

  /**
   * Top bar activity indicator (FL-30).
   *
   * Reports the transfers the web client is actually running right now — uploads still
   * in flight and archives still being prepared. It is a live status, not a link: the
   * durable job feed and its Activity page arrive with FL-43/FL-104, and until then the
   * shell must not offer a destination that does not exist. The upload and download
   * panels already dock themselves while work is in progress.
   */

  const { remainingUploads } = uploadAssetsStore;

  const pendingDownloads = $derived(
    [...downloadManager.assets.values()].filter((download) => !download.downloaded).length,
  );
  const running = $derived($remainingUploads + pendingDownloads);
</script>

{#if running > 0}
  <div class="fl-activity" role="status" aria-live="polite" aria-atomic="true">
    <span class="fl-spinner" aria-hidden="true"></span>
    <span>{$t('frameleaf_activity_running', { values: { count: running } })}</span>
  </div>
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
