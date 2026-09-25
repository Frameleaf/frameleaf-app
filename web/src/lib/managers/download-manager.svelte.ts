import { SvelteMap } from 'svelte/reactivity';

/**
 * Browser-local downloads (FL-45), ported from the prototype's download model in
 * `design/frameleaf/template/src/system-data.mjs:442-490` (`createDownload`, `advanceDownloads`,
 * `cancelDownload`, `downloadSummary`) onto real requests instead of a timer.
 *
 * - `preparing`: the request is running. `progress` counts the bytes received against the size the
 *   server announced (the archive plan from `/download/info` or the response `Content-Length`).
 * - `ready`: the file is held in this tab and waits for the person to press Save
 *   (`UploadPanel.jsx:494-507`); saving hands it to the browser and removes the row.
 * - `error`: the request failed. The row keeps its request so it can be retried.
 *
 * Every running request has its own `AbortController`: Cancel, Remove and `clearAll()` (which the
 * session lock calls, see `session-privacy.ts`) abort the transfer instead of only hiding its row.
 * Nothing here survives a reload: this is in-memory tab state, not a durable job.
 */

export type DownloadStatus = 'preparing' | 'ready' | 'error';

export interface DownloadProgress {
  /** Bytes received so far. */
  received: number;
  /** Bytes expected, when known. */
  total?: number;
}

export interface DownloadDetails {
  /** File name shown in the panel and used when the file is saved. */
  name: string;
  /** Number of photos and videos in the file. */
  count: number;
  /** Expected size in bytes (0 when not yet known). */
  total: number;
  assetIds: string[];
}

export interface DownloadContext {
  signal: AbortSignal;
  /** Reports bytes received; `total` replaces the expected size when the server announces one. */
  onProgress: (progress: DownloadProgress) => void;
  /** Updates what the row shows, e.g. once the archive plan is known. */
  describe: (details: Partial<DownloadDetails>) => void;
}

/** Produces the file. Called again on Retry, so it must be safe to re-run. */
export type DownloadTask = (context: DownloadContext) => Promise<Blob>;

export interface DownloadState extends DownloadDetails {
  status: DownloadStatus;
  /** 0–100 while preparing; 100 once ready. */
  progress: number;
  received: number;
  /** The failure, kept for the error row and for callers that need its status code. */
  error?: unknown;
  /** The file name without `.zip`, as the Activity page shows it. */
  archiveName: string;
}

/** No asset in the request could be downloaded (prototype `createDownload`, system-data.mjs:462). */
export class EmptyDownloadError extends Error {
  override name = 'EmptyDownloadError';
}

const nextKey = (() => {
  let counter = 0;
  return () => `download-${Date.now()}-${++counter}`;
})();

const clampPercent = (value: number) => Math.max(0, Math.min(100, value));

/**
 * Wraps `fetch` so the response body reports every chunk it delivers. Used as the SDK's `fetch`
 * option, which keeps the SDK's base URL, headers and HTTP error handling.
 */
export const progressFetch =
  (onProgress: DownloadContext['onProgress'], fetcher: typeof fetch = fetch): typeof fetch =>
  async (input, init) => {
    const response = await fetcher(input, init);
    if (!response.ok || !response.body) {
      return response;
    }

    const length = Number(response.headers.get('content-length'));
    const total = Number.isFinite(length) && length > 0 ? length : undefined;
    let received = 0;
    onProgress({ received, total });
    const counted = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          received += chunk.byteLength;
          onProgress({ received, total });
          controller.enqueue(chunk);
        },
      }),
    );

    return new Response(counted, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };

class DownloadManager {
  assets = new SvelteMap<string, DownloadState>();

  #tasks = new Map<string, DownloadTask>();
  #controllers = new Map<string, AbortController>();
  #files = new Map<string, Blob>();

  /** True while any row is shown, whatever its state. */
  isDownloading = $derived(this.assets.size > 0);

  summary = $derived.by(() => {
    let preparing = 0;
    let ready = 0;
    let errors = 0;
    for (const download of this.assets.values()) {
      if (download.status === 'preparing') {
        preparing++;
      } else if (download.status === 'ready') {
        ready++;
      } else {
        errors++;
      }
    }
    return { total: this.assets.size, preparing, ready, errors, active: preparing > 0 };
  });

  /**
   * Adds a row in the preparing state and starts `task`. Returns the row's key.
   * `details.name` is the file name the browser saves.
   */
  start(details: Partial<DownloadDetails> & { name: string }, task: DownloadTask): string {
    const key = nextKey();
    const assetIds = details.assetIds ?? [];
    this.assets.set(key, {
      name: details.name,
      count: details.count ?? assetIds.length,
      total: details.total ?? 0,
      assetIds,
      status: 'preparing',
      progress: 0,
      received: 0,
      archiveName: details.name.replace(/\.zip$/i, ''),
    });
    this.#tasks.set(key, task);
    void this.#run(key);
    return key;
  }

  /** Runs a failed row's request again. */
  retry(key: string) {
    const download = this.assets.get(key);
    if (!download || download.status !== 'error' || !this.#tasks.has(key)) {
      return;
    }
    this.assets.set(key, { ...download, status: 'preparing', progress: 0, received: 0, error: undefined });
    void this.#run(key);
  }

  /** Stops a running request (or discards a finished one) and removes its row. */
  cancel(key: string) {
    this.remove(key);
  }

  /** Aborts the request if it is still running, releases any held file and removes the row. */
  remove(key: string) {
    this.#controllers.get(key)?.abort();
    this.#controllers.delete(key);
    this.#tasks.delete(key);
    this.#files.delete(key);
    this.assets.delete(key);
  }

  /** Aborts everything and forgets every row, including the names of what was being downloaded. */
  clearAll() {
    for (const controller of this.#controllers.values()) {
      controller.abort();
    }
    this.#controllers.clear();
    this.#tasks.clear();
    this.#files.clear();
    this.assets.clear();
  }

  /** Removes the rows that are no longer running (the panel's Close while idle). */
  clearFinished() {
    for (const [key, download] of this.assets) {
      if (download.status !== 'preparing') {
        this.remove(key);
      }
    }
  }

  /** The prepared file, while its row is ready. */
  file(key: string) {
    return this.assets.get(key)?.status === 'ready' ? this.#files.get(key) : undefined;
  }

  /**
   * Hands a ready file to the browser and removes the row, as the prototype's Save does
   * (`UploadPanel.jsx:494-507`). Returns false when there was nothing to save.
   */
  save(key: string, saveFile: (file: Blob, name: string) => void) {
    const download = this.assets.get(key);
    const file = this.file(key);
    if (!download || !file) {
      return false;
    }
    saveFile(file, download.name);
    this.remove(key);
    return true;
  }

  async #run(key: string) {
    const task = this.#tasks.get(key);
    if (!task) {
      return;
    }
    const controller = new AbortController();
    this.#controllers.set(key, controller);
    const current = () => (this.#controllers.get(key) === controller ? this.assets.get(key) : undefined);

    const onProgress = ({ received, total }: DownloadProgress) => {
      const download = current();
      if (!download) {
        return;
      }
      const expected = total ?? download.total;
      // Never show 100% before the last byte: the announced size is an estimate for archives.
      const progress = expected > 0 ? clampPercent(Math.min(99, (received / expected) * 100)) : 0;
      // Update per whole percent, not per chunk, so a large file does not re-render thousands of times.
      if (Math.floor(progress) === Math.floor(download.progress) && expected === download.total) {
        return;
      }
      this.assets.set(key, { ...download, received, total: expected, progress: Math.floor(progress) });
    };

    const describe = (details: Partial<DownloadDetails>) => {
      const download = current();
      if (download) {
        const name = details.name ?? download.name;
        this.assets.set(key, { ...download, ...details, name, archiveName: name.replace(/\.zip$/i, '') });
      }
    };

    try {
      const file = await task({ signal: controller.signal, onProgress, describe });
      const download = current();
      if (!download || controller.signal.aborted) {
        return;
      }
      this.#files.set(key, file);
      this.assets.set(key, {
        ...download,
        status: 'ready',
        progress: 100,
        received: file.size,
        total: download.total || file.size,
      });
    } catch (error) {
      const download = current();
      if (!download || controller.signal.aborted) {
        return;
      }
      this.assets.set(key, { ...download, status: 'error', error });
    } finally {
      if (this.#controllers.get(key) === controller) {
        this.#controllers.delete(key);
      }
    }
  }
}

export const downloadManager = new DownloadManager();
