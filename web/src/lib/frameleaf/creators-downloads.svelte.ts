import {
  cancelMediaImport,
  getMediaImports,
  MediaImportItemState,
  MediaImportState,
  retryMediaImport,
  type MediaImportItemResponse,
  type MediaImportResponseDto,
} from '@frameleaf/sdk';
import { mediaImportActive, mediaImportRetryable, mediaReceiptKey } from '$lib/components/frameleaf/media/boards-media';
import { relativeTime } from '$lib/frameleaf/creators';
import { creatorsStore } from '$lib/frameleaf/creators-store.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';

export const DOWNLOAD_KINDS = ['running', 'waiting', 'needs', 'saved'] as const;
export type DownloadKind = (typeof DOWNLOAD_KINDS)[number];
export type DownloadShow = DownloadKind | 'all';

export const downloadShow = (value: string | null): DownloadShow =>
  DOWNLOAD_KINDS.includes(value as DownloadKind) ? (value as DownloadKind) : 'all';

/**
 * Where one file of a download stands. A file not yet saved counts as waiting only while its download
 * is still going; once the download has stopped short (failed, partly saved, paused) it needs the owner.
 * A file of a download the owner stopped, and one skipped, is in neither list.
 */
export const downloadItemKind = (
  job: Pick<MediaImportResponseDto, 'state'>,
  item: Pick<MediaImportItemResponse, 'state'>,
): DownloadKind | undefined => {
  if (item.state === MediaImportItemState.Saved) {
    return 'saved';
  }
  if (item.state === MediaImportItemState.Skipped || job.state === MediaImportState.Cancelled) {
    return;
  }
  if (mediaImportActive(job.state)) {
    if (item.state === MediaImportItemState.Failed) {
      return 'needs';
    }
    return item.state === MediaImportItemState.Discovered ? 'waiting' : 'running';
  }
  return 'needs';
};

/** How many files of a download are in each list. */
export const downloadCounts = (job: MediaImportResponseDto) => {
  const counts: Record<DownloadKind, number> = { running: 0, waiting: 0, needs: 0, saved: 0 };
  for (const item of job.items) {
    const kind = downloadItemKind(job, item);
    if (kind) {
      counts[kind]++;
    }
  }
  return counts;
};

const settled = (job: MediaImportResponseDto) => job.saved + job.skipped + job.failed;
export const downloadPercent = (job: MediaImportResponseDto) =>
  job.discovered > 0 ? Math.round((settled(job) / job.discovered) * 100) : 0;

/** How a download is going, as a message and its values. */
export const downloadStatus = (
  job: MediaImportResponseDto,
  locale: string | null | undefined,
): { key: string; values?: Record<string, string | number> } => {
  switch (job.state) {
    case MediaImportState.Assembling: {
      return { key: 'frameleaf_creators_tray_assembling' };
    }
    case MediaImportState.Downloading:
    case MediaImportState.Importing: {
      return job.discovered > 1
        ? { key: 'frameleaf_creators_tray_downloading_of', values: { done: settled(job), total: job.discovered } }
        : { key: 'frameleaf_creators_tray_downloading' };
    }
    case MediaImportState.Saved: {
      return { key: 'frameleaf_creators_tray_saved', values: { when: relativeTime(job.updatedAt, locale) } };
    }
    case MediaImportState.Partial: {
      return { key: 'frameleaf_creators_tray_partial', values: { saved: job.saved, failed: job.failed } };
    }
    case MediaImportState.Failed: {
      return { key: 'frameleaf_creators_tray_failed' };
    }
    case MediaImportState.Cancelled: {
      return { key: 'frameleaf_creators_tray_stopped' };
    }
    case MediaImportState.Paused: {
      return { key: 'frameleaf_creators_tray_paused' };
    }
    default: {
      return { key: 'frameleaf_creators_tray_waiting' };
    }
  }
};

export const mediaImportNeedsOwner = (state: MediaImportState) =>
  [MediaImportState.Failed, MediaImportState.Partial, MediaImportState.Paused].includes(state);

/**
 * The downloads the Library knows of, read again while any is going. The Creators workspace starts and
 * stops it; the tray and the Downloads page both show it.
 */
class CreatorsDownloads {
  jobs = $state<MediaImportResponseDto[]>([]);
  failed = $state(false);
  actionFailed = $state(false);
  /** The download being changed, or `all`. */
  pending = $state('');

  private retryKeys = new Map<string, string>();
  /** Saved files already announced to the rest of Boards. */
  private seen = new Set<string>();
  private first = true;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  /** Bumped by `stop`: an action still waiting on the Library then leaves the cleared list alone. */
  private life = 0;
  private controller = new AbortController();

  /** Files in each list, over every download. */
  get counts() {
    const total: Record<DownloadKind, number> = { running: 0, waiting: 0, needs: 0, saved: 0 };
    for (const job of this.jobs) {
      const counts = downloadCounts(job);
      for (const kind of DOWNLOAD_KINDS) {
        total[kind] += counts[kind];
      }
    }
    return total;
  }

  /** Downloads that stopped short and wait for the owner. */
  get needs() {
    return this.jobs.filter(({ state }) => mediaImportNeedsOwner(state)).length;
  }

  get retryable() {
    return this.jobs.filter(({ state, subscriptionId }) => !subscriptionId && mediaImportNeedsOwner(state));
  }

  private announce(list: MediaImportResponseDto[]) {
    let added = false;
    for (const job of list) {
      const fresh = job.items.flatMap(({ assetId }) => (assetId && !this.seen.has(assetId) ? [assetId] : []));
      for (const id of fresh) {
        this.seen.add(id);
      }
      if (!this.first && fresh.length > 0 && job.albumId) {
        added = true;
        eventManager.emit('AlbumAddAssets', { assetIds: fresh, albumIds: [job.albumId] });
      }
    }
    this.first = false;
    if (added) {
      void creatorsStore.refresh();
    }
  }

  load = async () => {
    const version = ++this.generation;
    const { signal } = this.controller;
    clearTimeout(this.timer);
    try {
      const { imports } = await getMediaImports({ signal });
      if (version !== this.generation) {
        return;
      }
      // An inspection has no collection yet; only real downloads are listed.
      const downloads = imports
        .filter(({ albumId }) => !!albumId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      this.announce(downloads);
      this.jobs = downloads;
      this.failed = false;
    } catch {
      if (version !== this.generation || signal.aborted) {
        return;
      }
      this.failed = true;
    }
    if (this.failed || this.jobs.some(({ state }) => mediaImportActive(state))) {
      this.timer = setTimeout(() => void this.load(), this.failed ? 6000 : 2500);
    }
  };

  stop() {
    this.life++;
    this.generation++;
    clearTimeout(this.timer);
    this.controller.abort();
    this.controller = new AbortController();
    this.jobs = [];
    this.failed = false;
    this.actionFailed = false;
    this.pending = '';
    this.seen.clear();
    this.first = true;
  }

  private async send(job: MediaImportResponseDto, retry: boolean) {
    const { id, updatedAt } = job;
    const updated = retry
      ? await retryMediaImport({
          id,
          mediaRetryDto: { idempotencyKey: mediaReceiptKey(this.retryKeys, { id, updatedAt }) },
        })
      : await cancelMediaImport({ id });
    return updated;
  }
  private replace(updated: MediaImportResponseDto) {
    this.jobs = this.jobs.map((value) => (value.id === updated.id ? updated : value));
  }

  /** Stop a download that is going, or try one again. */
  async change(job: MediaImportResponseDto, retry: boolean) {
    if (this.pending || (retry && !mediaImportRetryable(job.state))) {
      return;
    }
    const { life } = this;
    this.pending = job.id;
    this.actionFailed = false;
    let failed = false;
    let updated: MediaImportResponseDto | undefined;
    try {
      updated = await this.send(job, retry);
    } catch {
      failed = true;
    }
    if (life !== this.life) {
      return;
    }
    if (updated) {
      this.replace(updated);
    }
    this.actionFailed = failed;
    this.pending = '';
    void this.load();
  }

  /** Try again every download that stopped short. Each is its own request: one refusal stops none of the others. */
  async retryAll() {
    if (this.pending) {
      return;
    }
    const { life } = this;
    this.pending = 'all';
    this.actionFailed = false;
    const results = await Promise.allSettled(this.retryable.map((job) => this.send(job, true)));
    if (life !== this.life) {
      return;
    }
    for (const result of results) {
      if (result.status === 'fulfilled') {
        this.replace(result.value);
      }
    }
    this.actionFailed = results.some(({ status }) => status === 'rejected');
    this.pending = '';
    void this.load();
  }
}

export const creatorsDownloads = new CreatorsDownloads();
