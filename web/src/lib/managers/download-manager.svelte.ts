import { SvelteMap } from 'svelte/reactivity';
import { eventManager } from '$lib/managers/event-manager.svelte';

/**
 * Browser-local downloads (FL-45), ported from the prototype's download model in
 * `design/frameleaf/template/src/system-data.mjs:442-490` (`createDownload`, `advanceDownloads`,
 * `cancelDownload`, `downloadSummary`) onto real requests instead of a timer.
 *
 * - `preparing`: the request is running. `progress` counts the bytes received against the size the
 *   server announced (the archive plan from `/download/info` or the response `Content-Length`).
 * - `ready`: the file waits for the person to press Save (`UploadPanel.jsx:494-507`); saving hands
 *   it to the browser and removes the row.
 * - `error`: the request failed. The row keeps its request so it can be retried.
 *
 * Only files up to `bufferLimit()` are fetched into this tab (buffered). A larger file is not
 * fetched at all: its task returns a `StreamedDownload`, the row is ready at once, and Save starts
 * the browser's own streamed download. Save is a click, so browsers allow one after another.
 *
 * Every running request has its own `AbortController`: Cancel, Remove and `clearAll()` (which the
 * session lock and logout call) abort the transfer instead of only hiding its row. Nothing here
 * survives a reload: this is in-memory tab state, not a durable job.
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
  /**
   * Which surface shows the row: none for the Downloads panel, `share` for the public share page's
   * inline strip (`PublicViewer.jsx:402-426`).
   */
  group?: DownloadGroup;
}

export type DownloadGroup = 'share';

export interface DownloadContext {
  /** The row's key. */
  key: string;
  signal: AbortSignal;
  /** Reports bytes received; `total` replaces the expected size when the server announces one. */
  onProgress: (progress: DownloadProgress) => void;
  /** Updates what the row shows, e.g. once the archive plan is known. */
  describe: (details: Partial<DownloadDetails>) => void;
}

/** A file too large to hold in the tab: Save hands the request to the browser instead. */
export class StreamedDownload {
  constructor(readonly start: (name: string) => void) {}
}

/** Produces the file, or the streamed download for it. Called again on Retry, so it must be safe to re-run. */
export type DownloadTask = (context: DownloadContext) => Promise<Blob | StreamedDownload>;

export interface DownloadState extends DownloadDetails {
  status: DownloadStatus;
  /** 0–100 while preparing; 100 once ready. */
  progress: number;
  received: number;
  /** The failure, kept for the error row and for callers that need its status code. */
  error?: unknown;
  /** The file name without `.zip`, as the Activity page shows it. */
  archiveName: string;
  /** True while a ready row holds its file in this tab (lost if the tab closes before Save). */
  buffered: boolean;
}

const MiB = 1024 * 1024;

const isAppleWebKit = () => {
  if (typeof navigator === 'undefined') {
    return false;
  }
  const agent = navigator.userAgent;
  const iPadOS = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  return /iPad|iPhone|iPod/.test(agent) || iPadOS || /^((?!chrome|chromium|android).)*safari/i.test(agent);
};

/**
 * The largest file fetched into the tab: 512 MiB, or 128 MiB on iOS and Safari, whose tabs are
 * killed well before desktop Chromium or Firefox run out of blob storage.
 */
export const bufferLimit = () => (isAppleWebKit() ? 128 : 512) * MiB;

/** The request was stopped because the file is too large to hold in the tab; it is streamed instead. */
export class TooLargeToHold extends Error {
  override name = 'TooLargeToHold';
}

export interface HoldLimit {
  /** Stream rather than hold a response that does not announce its size. */
  requireLength: boolean;
  /** Reserves room for `bytes` in the tab, or answers false when they do not fit. */
  fits: (bytes: number) => boolean;
  /** Set when the response was stopped for its size. */
  tooLarge: boolean;
}

/** Row counts for one surface, as the prototype's `downloadSummary` (system-data.mjs:483-488). */
export const summarizeDownloads = (rows: Iterable<DownloadState>) => {
  let total = 0;
  let preparing = 0;
  let ready = 0;
  let errors = 0;
  for (const download of rows) {
    total++;
    if (download.status === 'preparing') {
      preparing++;
    } else if (download.status === 'ready') {
      ready++;
    } else {
      errors++;
    }
  }
  return { total, preparing, ready, errors, active: preparing > 0 };
};

const abortError = () => new DOMException('The download was cancelled', 'AbortError');

type Waiter = { resolve: () => void; reject: (error: unknown) => void };

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
  (onProgress: DownloadContext['onProgress'], fetcher: typeof fetch = fetch, limit?: HoldLimit): typeof fetch =>
  async (input, init) => {
    const response = await fetcher(input, init);
    if (!response.ok || !response.body) {
      return response;
    }

    const length = Number(response.headers.get('content-length'));
    const total = Number.isFinite(length) && length > 0 ? length : undefined;
    // Decide from the headers, before the body is read, whether the file may be held (review B1).
    if (limit && (total === undefined ? limit.requireLength : !limit.fits(total))) {
      limit.tooLarge = true;
      await response.body.cancel();
      throw new TooLargeToHold();
    }
    let received = 0;
    let admitted = total ?? 0;
    onProgress({ received, total });
    const counted = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          received += chunk.byteLength;
          // A body larger than announced or planned (an edited file, an archive estimate) stops too.
          if (limit && received > admitted) {
            if (!limit.fits(received)) {
              limit.tooLarge = true;
              controller.error(new TooLargeToHold());
              return;
            }
            admitted = received;
          }
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
  #files = new Map<string, Blob | StreamedDownload>();
  #waiters = new Map<string, Waiter[]>();
  /** Bytes promised to files still being fetched into the tab, by row. */
  #reserved = new Map<string, number>();

  /** The rows of the Downloads panel (rows without a group). */
  panelRows = $derived([...this.assets.entries()].filter(([, download]) => !download.group));

  /** True while the Downloads panel has a row, whatever its state. */
  isDownloading = $derived(this.panelRows.length > 0);

  /** Counts for the Downloads panel. */
  summary = $derived(summarizeDownloads(this.panelRows.map(([, download]) => download)));

  /** A ready file held in this tab would be lost if the tab closed now. */
  hasUnsavedFiles = $derived(this.#anyBuffered());

  constructor() {
    // B2: logging out aborts every request and forgets every row and file name, as uploads do.
    eventManager.on({ AuthLogout: () => this.clearAll() });
  }

  /** Bytes of prepared files held in this tab. */
  heldBytes() {
    let held = 0;
    for (const download of this.assets.values()) {
      if (download.buffered) {
        held += download.received;
      }
    }
    return held;
  }

  /** Bytes reserved for files being fetched, leaving out one row's own reservation. */
  reservedBytes(except?: string) {
    let reserved = 0;
    for (const [key, bytes] of this.#reserved) {
      if (key !== except) {
        reserved += bytes;
      }
    }
    return reserved;
  }

  /**
   * Reserves room for `bytes` of the row's file when the held files, the other reservations and
   * these bytes stay within `bufferLimit()`; answers false and reserves nothing otherwise. A row's
   * reservation only grows, and ends when its file is ready (then held), fails, streams or is removed.
   */
  reserve(key: string, bytes: number) {
    // A removed row's request may still be finishing; it must not take room back.
    if (!this.assets.has(key) || bytes > bufferLimit() - this.heldBytes() - this.reservedBytes(key)) {
      return false;
    }
    this.#reserved.set(key, Math.max(this.#reserved.get(key) ?? 0, bytes));
    return true;
  }

  release(key: string) {
    this.#reserved.delete(key);
  }

  /** The rows of one surface. */
  rows(group?: DownloadGroup) {
    return [...this.assets.entries()].filter(([, download]) => download.group === group);
  }

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
      group: details.group,
      status: 'preparing',
      progress: 0,
      received: 0,
      archiveName: details.name.replace(/\.zip$/i, ''),
      buffered: false,
    });
    this.#tasks.set(key, task);
    void this.#run(key);
    return key;
  }

  /**
   * Resolves when the row is ready to save, rejects with its error when it fails, and with an
   * `AbortError` when it is cancelled or cleared first.
   */
  settled(key: string): Promise<void> {
    const download = this.assets.get(key);
    if (!download) {
      return Promise.reject(abortError());
    }
    if (download.status === 'ready') {
      return Promise.resolve();
    }
    if (download.status === 'error') {
      return Promise.reject(download.error);
    }
    return new Promise((resolve, reject) => {
      this.#waiters.set(key, [...(this.#waiters.get(key) ?? []), { resolve, reject }]);
    });
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
    this.#reserved.delete(key);
    this.assets.delete(key);
    this.#settle(key, abortError());
  }

  /** Aborts everything and forgets every row, including the names of what was being downloaded. */
  clearAll() {
    // Deleting the current entry while iterating a Map is safe.
    for (const key of this.assets.keys()) {
      this.remove(key);
    }
    for (const controller of this.#controllers.values()) {
      controller.abort();
    }
    this.#controllers.clear();
    this.#tasks.clear();
    this.#files.clear();
  }

  /** Removes the rows of one surface that are no longer running (the panel's Close while idle). */
  clearFinished(group?: DownloadGroup) {
    for (const [key, download] of this.rows(group)) {
      if (download.status !== 'preparing') {
        this.remove(key);
      }
    }
  }

  /** The prepared file, while its row is ready and buffered. */
  file(key: string) {
    const file = this.assets.get(key)?.status === 'ready' ? this.#files.get(key) : undefined;
    return file instanceof Blob ? file : undefined;
  }

  /**
   * Hands a ready file to the browser and removes the row, as the prototype's Save does
   * (`UploadPanel.jsx:494-507`): a buffered file through `saveFile`, a large one as the browser's
   * own streamed download. Returns false when there was nothing to save.
   */
  save(key: string, saveFile: (file: Blob, name: string) => void) {
    const download = this.assets.get(key);
    const file = download?.status === 'ready' ? this.#files.get(key) : undefined;
    if (!download || !file) {
      return false;
    }
    if (file instanceof StreamedDownload) {
      file.start(download.name);
    } else {
      saveFile(file, download.name);
    }
    this.remove(key);
    return true;
  }

  #anyBuffered() {
    for (const download of this.assets.values()) {
      if (download.buffered) {
        return true;
      }
    }
    return false;
  }

  #settle(key: string, error?: unknown) {
    const waiters = this.#waiters.get(key);
    this.#waiters.delete(key);
    for (const waiter of waiters ?? []) {
      if (error === undefined) {
        waiter.resolve();
      } else {
        waiter.reject(error);
      }
    }
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
      const file = await task({ key, signal: controller.signal, onProgress, describe });
      const download = current();
      if (!download || controller.signal.aborted) {
        return;
      }
      this.#files.set(key, file);
      const buffered = file instanceof Blob;
      this.assets.set(key, {
        ...download,
        status: 'ready',
        progress: 100,
        received: buffered ? file.size : 0,
        total: download.total || (buffered ? file.size : 0),
        buffered,
      });
      this.#settle(key);
    } catch (error) {
      const download = current();
      if (!download || controller.signal.aborted) {
        return;
      }
      this.assets.set(key, { ...download, status: 'error', error });
      this.#settle(key, error ?? new Error('Download failed'));
    } finally {
      if (this.#controllers.get(key) === controller) {
        this.#controllers.delete(key);
        // A ready file now counts as held; a failed or streamed one holds nothing.
        this.#reserved.delete(key);
      }
    }
  }
}

export const downloadManager = new DownloadManager();

/**
 * Fetches a file into the tab, or hands back `stream` when it is too large to hold (review B1). The
 * prepared files the tab holds and the bytes reserved for files still being fetched never exceed
 * `bufferLimit()` together, whether the files are parts of one archive or separate downloads.
 * The file's bytes are reserved when this starts (a known size), when its `Content-Length` arrives,
 * and as a body outgrows what was reserved; a body that would go over streams instead.
 *
 * - `size` is the size the server planned or recorded. Leave it out when it is unknown or cannot be
 *   trusted (an edited file): the response must then announce a `Content-Length` within the limit,
 *   checked before the body is read.
 * - `request` runs the SDK call with the given `fetch`.
 */
export const holdOrStream = async (
  { key, signal, onProgress }: DownloadContext,
  {
    size,
    request,
    stream,
  }: {
    size?: number;
    request: (fetch: typeof globalThis.fetch) => Promise<Blob | undefined>;
    stream: StreamedDownload;
  },
): Promise<Blob | StreamedDownload> => {
  // Reserved at once, so a download started in the same moment sees these bytes as taken.
  if (size !== undefined && !downloadManager.reserve(key, size)) {
    return stream;
  }
  const limit: HoldLimit = {
    requireLength: size === undefined,
    fits: (bytes) => downloadManager.reserve(key, bytes),
    tooLarge: false,
  };
  const streamInstead = () => {
    downloadManager.release(key);
    return stream;
  };
  try {
    const file = await request(progressFetch(onProgress, fetch, limit));
    if (limit.tooLarge) {
      return streamInstead();
    }
    // The SDK swallows a body that failed part-way and answers with no data.
    if (!(file instanceof Blob)) {
      throw signal.aborted ? abortError() : new Error('The download was interrupted');
    }
    return file;
  } catch (error) {
    if (limit.tooLarge || error instanceof TooLargeToHold) {
      return streamInstead();
    }
    downloadManager.release(key);
    throw error;
  }
};
