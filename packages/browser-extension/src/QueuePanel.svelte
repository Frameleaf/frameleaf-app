<script lang="ts">
  import { onMount } from "svelte";
  import Icon from "./Icon.svelte";
  import { collectionPath, type CollectionChoice } from "./collections";
  import {
    sendRequest,
    watchConnection,
    type QueueItem,
    type QueueProgress,
  } from "./platform";
  let {
    collections = [],
    unfinished = $bindable(0),
  }: { collections?: CollectionChoice[]; unfinished?: number } = $props();
  const empty: QueueProgress = { items: [], unfinished: 0, hasMore: false };
  const uuid =
    /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
  let queue = $state<QueueProgress>(empty);
  let origin = $state("");
  let error = $state("");
  let action = $state<string | null>(null);
  let now = $state(Date.now());
  let epoch = 0;
  let disposed = false;
  let reading = false;
  let refreshAgain = false;
  $effect(() => {
    unfinished = queue.unfinished;
  });
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
      now = Date.now();
      if (!reply.ok) {
        queue = empty;
        error = reply.error;
        return;
      }
      // A paused connection still lists its waiting items, read-only.
      queue = reply.connection ? (reply.queue ?? empty) : empty;
      origin = reply.connection?.binding.origin ?? "";
      error = queue.error ?? "";
    } catch {
      if (!disposed && version === epoch) {
        queue = empty;
        error =
          "Could not read the saving list. Reopen the extension to try again.";
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
      error = "Could not change this item. It stays in your saving list.";
    } finally {
      action = null;
    }
  }
  const collectionName = (id: string) =>
    collectionPath(collections, id).at(-1) ?? "your collection";
  const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  function ago(time: number) {
    const minutes = Math.round((time - now) / 60_000);
    if (Math.abs(minutes) < 1) return "just now";
    if (Math.abs(minutes) < 60) return relative.format(minutes, "minute");
    const hours = Math.round(minutes / 60);
    if (Math.abs(hours) < 24) return relative.format(hours, "hour");
    return relative.format(Math.round(hours / 24), "day");
  }
  const percent = (item: QueueItem) =>
    item.total ? Math.min(100, Math.round((item.offset / item.total) * 100)) : 0;
  const scheduled = (item: QueueItem) =>
    item.state === "queued" && !!item.retryAt && item.retryAt > now;
  function tone(item: QueueItem) {
    if (item.state === "needs-attention" || item.state === "failed")
      return "attention";
    return item.state;
  }
  function openUrl(item: QueueItem): string | null {
    if (!origin || !item.itemId || !uuid.test(item.itemId)) return null;
    if (item.itemKind === "asset") return `${origin}/pro/photos/${item.itemId}`;
    return uuid.test(item.albumId) ? `${origin}/albums/${item.albumId}` : null;
  }
</script>

<section aria-label="Saving and saved" class="capture-queue">
  <div aria-live="polite">
    {#if !queue.items.length && !error}<p class="hint">
        Nothing is saving right now.
      </p>{/if}
    <ul class="queue-list">
      {#each queue.items as item (item.id)}
        {@const link = openUrl(item)}
        <li class={tone(item)}>
          <span class="queue-thumb" aria-hidden="true"
            ><Icon
              name={item.kind === "link" ? "linkVariant" : "imageOutline"}
              size={18}
            /></span
          >
          <span class="queue-text">
            <strong class="queue-name">{item.label}</strong>
            <small class="queue-state">
              {#if item.cancelling}
                Cancelling… waiting for your server to confirm.
              {:else if item.state === "uploading"}
                Saving · {percent(item)}%
              {:else if item.state === "committing"}
                Saving · finishing
              {:else if scheduled(item)}
                Retry scheduled · trying again {ago(item.retryAt!)}{#if item.error}.
                  {item.error}{/if}
              {:else if item.state === "queued"}
                Waiting for your server
              {:else if item.state === "needs-attention"}
                Needs attention · {item.error ?? "Check this item."}
              {:else if item.state === "failed"}
                Couldn’t save · {item.error ?? "Your server refused it."}
              {:else if item.state === "saved"}
                Saved to {collectionName(item.albumId)} · {ago(item.updatedAt)}
              {:else if item.state === "duplicate"}
                Already in your library · added to {collectionName(
                  item.albumId,
                )}
              {:else}
                Cancelled · nothing was saved
              {/if}
            </small>
            {#if item.state === "uploading" && item.total}<progress
                max="100"
                value={percent(item)}
                aria-label={`Saving ${item.label}`}
              ></progress>{/if}
          </span>
          <span class="queue-actions">
            {#if link}<a
                class="button small icon-only"
                href={link}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Open ${item.label} in Frameleaf`}
                title="Open in Frameleaf"><Icon name="openInNew" /></a
              >{/if}
            {#if item.canRetry}<button
                type="button"
                class="small"
                disabled={!!action}
                onclick={() => void change("retry-capture", item.id)}
                >Retry now</button
              >{/if}
            {#if item.canCancel}<button
                type="button"
                class="small"
                disabled={!!action}
                aria-label={`Cancel ${item.label}`}
                onclick={() => void change("cancel-capture", item.id)}
                >Cancel</button
              >{/if}
          </span>
        </li>
      {/each}
    </ul>
    {#if queue.hasMore}<p class="hint">
        Showing the first 100 waiting items. More appear as these finish.
      </p>{/if}
  </div>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  <p class="hint">
    Saving keeps going if you close this window or the browser. Finished items
    are listed for a while, then tidied away.
  </p>
</section>
