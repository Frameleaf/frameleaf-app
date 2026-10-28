<script lang="ts">
  import { onMount } from "svelte";
  import {
    sendRequest,
    watchConnection,
    type QueueItem,
    type QueueProgress,
  } from "./platform";
  const empty: QueueProgress = { items: [], unfinished: 0, hasMore: false };
  let queue = $state<QueueProgress>(empty);
  let error = $state("");
  let action = $state<string | null>(null);
  let epoch = 0;
  let disposed = false;
  let reading = false;
  let refreshAgain = false;
  async function refresh() {
    if (disposed) return;
    if (reading) {
      refreshAgain = true;
      return;
    }
    reading = true;
    refreshAgain = false;
    const version = ++epoch;
    try {
      const reply = await sendRequest({ type: "queue" });
      if (disposed || version !== epoch) return;
      if (!reply.ok) {
        queue = empty;
        error = reply.error;
        return;
      }
      queue =
        reply.connection?.status === "connected"
          ? (reply.queue ?? empty)
          : empty;
      error = queue.error ?? "";
    } catch {
      if (!disposed && version === epoch) {
        queue = empty;
        error = "Could not read your queue. Reopen the extension to try again.";
      }
    } finally {
      reading = false;
      if (refreshAgain && !disposed) {
        refreshAgain = false;
        void refresh();
      }
    }
  }
  onMount(() => {
    disposed = false;
    void refresh();
    const timer = setInterval(() => void refresh(), 1000);
    const stop = watchConnection(() => {
      epoch++;
      queue = empty;
      void refresh();
    });
    return () => {
      disposed = true;
      epoch++;
      clearInterval(timer);
      stop();
    };
  });
  async function change(type: "retry-capture" | "cancel-capture", id: string) {
    epoch++;
    action = id;
    error = "";
    try {
      const reply = await sendRequest({ type, id });
      if (!reply.ok) error = reply.error;
      else await refresh();
    } catch {
      error =
        "Could not change this capture. Its saved queue entry is retained.";
    } finally {
      action = null;
    }
  }
  function status(item: QueueItem): string {
    if (item.retryAt && item.retryAt > Date.now()) return "Retry scheduled";
    return {
      queued: "Queued",
      uploading: "Uploading",
      committing: "Finishing",
      saved: "Saved",
      duplicate: "Already in your library",
      failed: "Could not save",
      "needs-attention": "Needs attention",
      cancelled: "Cancelled",
    }[item.state];
  }
</script>

<section aria-label="Capture queue" class="capture-queue">
  <h2>Queue</h2>
  <div aria-live="polite">
    {#if !queue.items.length && !error}<p class="muted">
        No captures queued.
      </p>{/if}
    {#if queue.unfinished}<p>
        {queue.unfinished} unfinished {queue.unfinished === 1
          ? "capture"
          : "captures"}
      </p>{/if}
    <ul class="queue-list">
      {#each queue.items as item (item.id)}
        <li>
          <strong class="address">{item.label}</strong><span class="queue-state"
            >{status(item)}</span
          >
          {#if item.state === "uploading" && item.total}<progress
              max={item.total}
              value={item.offset}
              aria-label={`Upload progress for ${item.label}`}
            ></progress>{/if}
          {#if item.error}<p class="error">{item.error}</p>{/if}
          <div class="queue-actions">
            {#if item.canRetry}<button
                type="button"
                disabled={!!action}
                onclick={() => void change("retry-capture", item.id)}
                >Retry</button
              >{/if}
            {#if item.canCancel}<button
                type="button"
                disabled={!!action}
                onclick={() => void change("cancel-capture", item.id)}
                >Cancel</button
              >{/if}
          </div>
        </li>
      {/each}
    </ul>
    {#if queue.hasMore}<p class="hint">
        Showing the first 100 unfinished captures. More appear as these finish.
      </p>{/if}
  </div>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</section>
