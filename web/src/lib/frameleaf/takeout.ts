import {
  TakeoutPhase,
  TakeoutSourceKind,
  TakeoutState,
  type TakeoutItemResponseDto,
  type TakeoutOptionsDto,
  type TakeoutPairResponseDto,
  type TakeoutResponseDto,
  type TakeoutSourceResponseDto,
} from '@immich/sdk';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { Translations } from 'svelte-i18n';

/**
 * The Google Photos import wizard's rules (FL-65), kept apart from the page so they can be read and
 * tested on their own. The prototype's `Import Google Photos` workflow has three stages — Stage,
 * Scan, Reconcile — and this module decides which one an import is on, what the stage shows, and how
 * an archive upload resumes after the browser was closed.
 *
 * The server is the authority for every state: nothing here is persisted in the browser, and a
 * reload finds the import exactly where the server says it is.
 */

export const TAKEOUT_STAGES = ['stage', 'scan', 'reconcile'] as const;
export type TakeoutStage = (typeof TAKEOUT_STAGES)[number];

/** States in which a job is working on the import: nothing may change, and the page keeps watching. */
const BUSY: ReadonlySet<TakeoutState> = new Set([
  TakeoutState.Queued,
  TakeoutState.Scanning,
  TakeoutState.Importing,
  TakeoutState.Paused,
  TakeoutState.Cancelling,
]);
/** States the server moves out of by itself, so the page refreshes while it shows them. */
const MOVING: ReadonlySet<TakeoutState> = new Set([
  TakeoutState.Queued,
  TakeoutState.Scanning,
  TakeoutState.Importing,
  TakeoutState.Cancelling,
]);
/** States in which review decisions and import choices may change. */
const REVIEWABLE: ReadonlySet<TakeoutState> = new Set([
  TakeoutState.Review,
  TakeoutState.Completed,
  TakeoutState.Failed,
  TakeoutState.Cancelled,
]);
/** A job stopped without finishing. */
const STOPPED: ReadonlySet<TakeoutState> = new Set([TakeoutState.Failed, TakeoutState.Cancelled]);

export const isTakeoutBusy = (state: TakeoutState) => BUSY.has(state);
export const isTakeoutMoving = (state: TakeoutState) => MOVING.has(state);
export const isTakeoutStopped = (state: TakeoutState) => STOPPED.has(state);

/** The prototype stage an import is on. */
export const takeoutStage = (takeout?: Pick<TakeoutResponseDto, 'phase'>): TakeoutStage => {
  if (!takeout || takeout.phase === TakeoutPhase.Sources) {
    return 'stage';
  }
  return takeout.phase === TakeoutPhase.Scanning ? 'scan' : 'reconcile';
};

/** Decisions about items and pairs, and the import choices, can change. */
export const canReviewTakeout = (takeout: Pick<TakeoutResponseDto, 'phase' | 'state'>) =>
  takeout.phase !== TakeoutPhase.Sources && takeout.phase !== TakeoutPhase.Scanning && REVIEWABLE.has(takeout.state);

/** A scan that stopped can be run again; archives can be added before it. */
export const canRetryScan = (takeout: Pick<TakeoutResponseDto, 'phase' | 'state'>) =>
  takeout.phase === TakeoutPhase.Scanning && isTakeoutStopped(takeout.state);

/** Every source is fully on the server. */
export const takeoutSourcesStaged = (sources: readonly TakeoutSourceResponseDto[]) =>
  sources.length > 0 &&
  sources.every((source) => source.kind === TakeoutSourceKind.Directory || source.received === source.size);

/** Bytes still to upload across the archives. */
export const takeoutBytesRemaining = (sources: readonly TakeoutSourceResponseDto[]) =>
  sources.reduce(
    (total, source) => total + (source.kind === TakeoutSourceKind.Zip ? Math.max(0, source.size - source.received) : 0),
    0,
  );

/**
 * Progress of the job working on the import, from what the server counted. The total grows while a
 * scan reads the archives; null percent means nothing is counted yet, so no bar is shown as stalled.
 */
export const takeoutProgress = (takeout: Pick<TakeoutResponseDto, 'processed' | 'total'>) => {
  const total = takeout.total ?? 0;
  const done = Math.min(takeout.processed, Math.max(total, takeout.processed));
  return {
    done,
    total: takeout.total,
    percent: total > 0 ? Math.min(100, Math.round((done / total) * 100)) : null,
  };
};

/** Items the owner still has to decide about before importing with sidecar review on. */
export const takeoutNeedsReview = (takeout: Pick<TakeoutResponseDto, 'counts'>) =>
  takeout.counts.review + takeout.counts.suggestedPairs;

/** The import choices to send, from the import's current ones and the albums the owner picked. */
export const takeoutImportOptions = (
  options: TakeoutResponseDto['options'],
  albums: readonly { folder: string; selected: boolean }[],
): TakeoutOptionsDto => ({
  descriptions: options.descriptions,
  dates: options.dates,
  locations: options.locations,
  favorites: options.favorites,
  archive: options.archive,
  albums: options.albums,
  sidecarReview: options.sidecarReview,
  updateMatchedMetadata: options.updateMatchedMetadata,
  selectedAlbums: albums.filter((album) => album.selected).map((album) => album.folder),
});

export const takeoutStateKey = (state: TakeoutState): Translations => `frameleaf_takeout_state_${state}`;
export const takeoutItemStateKey = (state: TakeoutItemResponseDto['state']): Translations =>
  `frameleaf_takeout_item_${state}`;
export const takeoutPairStateKey = (state: TakeoutPairResponseDto['state']): Translations =>
  `frameleaf_takeout_pair_${state}`;
export const takeoutWarningKey = (warning: TakeoutItemResponseDto['warnings'][number]): Translations =>
  `frameleaf_takeout_warning_${warning}`;

/* ------------------------------------------------------------------ */
/* Resumable archive upload                                            */
/* ------------------------------------------------------------------ */

/** The server accepts at most 8 MiB per request. */
export const TAKEOUT_UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024;

export type TakeoutArchiveProgress = { phase: 'verifying' | 'uploading'; name: string; bytes: number; total: number };

type ArchiveApi = {
  verify: (range: { offset: number; size: number; sha256: string }) => Promise<void>;
  upload: (offset: number, bytes: Blob) => Promise<TakeoutSourceResponseDto>;
};

export class TakeoutUploadError extends Error {
  constructor(readonly key: Translations) {
    super(key);
  }
}

/**
 * Upload an archive from where the server has it. Name and size only suggest that the chosen file is
 * the archive being resumed; every byte already staged is compared (by SHA-256, one chunk at a
 * time) before anything is appended, so a different file with the same name is caught.
 */
export const resumeTakeoutArchive = async (
  file: Pick<File, 'name' | 'size' | 'slice'>,
  staged: TakeoutSourceResponseDto,
  api: ArchiveApi,
  signal: AbortSignal,
  onProgress: (progress: TakeoutArchiveProgress) => void,
): Promise<TakeoutSourceResponseDto> => {
  if (file.name !== staged.name || file.size !== staged.size) {
    throw new TakeoutUploadError('frameleaf_takeout_error_wrong_archive');
  }
  if (staged.received < 0 || staged.received > file.size) {
    throw new TakeoutUploadError('frameleaf_takeout_error_offset');
  }
  for (let offset = 0; offset < staged.received; offset += TAKEOUT_UPLOAD_CHUNK_SIZE) {
    signal.throwIfAborted();
    const end = Math.min(offset + TAKEOUT_UPLOAD_CHUNK_SIZE, staged.received);
    const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
    await api.verify({ offset, size: bytes.byteLength, sha256: bytesToHex(sha256(bytes)) });
    onProgress({ phase: 'verifying', name: file.name, bytes: end, total: staged.received });
  }
  let current = staged;
  while (current.received < file.size) {
    signal.throwIfAborted();
    const end = Math.min(current.received + TAKEOUT_UPLOAD_CHUNK_SIZE, file.size);
    const next = await api.upload(current.received, file.slice(current.received, end));
    if (next.id !== current.id || next.size !== file.size || next.received !== end) {
      throw new TakeoutUploadError('frameleaf_takeout_error_acknowledgement');
    }
    current = next;
    onProgress({ phase: 'uploading', name: file.name, bytes: current.received, total: file.size });
  }
  return current;
};

/** The staged archive a chosen file resumes, when one with the same name and size exists. */
export const findStagedArchive = (sources: readonly TakeoutSourceResponseDto[], file: Pick<File, 'name' | 'size'>) =>
  sources.find(
    (source) => source.kind === TakeoutSourceKind.Zip && source.name === file.name && source.size === file.size,
  );

/* ------------------------------------------------------------------ */
/* Reconciliation report                                               */
/* ------------------------------------------------------------------ */

const csvCell = (value: string | number | null | undefined) => {
  const text = value === null || value === undefined ? '' : String(value);
  // Quote everything that could break a row, and neutralise spreadsheet formulas.
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};

/** The reconciliation report as CSV: one row per item, what happened to it and why. */
export const takeoutReportCsv = (items: readonly TakeoutItemResponseDto[]) => {
  const header = ['path', 'source', 'kind', 'state', 'assetId', 'albums', 'warnings', 'error'];
  const rows = items.map((item) =>
    [
      item.path,
      item.source,
      item.kind,
      item.state,
      item.assetId,
      item.albums.join('; '),
      item.warnings.join('; '),
      item.error,
    ]
      .map((cell) => csvCell(cell))
      .join(','),
  );
  return [header.join(','), ...rows].join('\n') + '\n';
};

/** The reconciliation report as JSON: the import, every item and every Live Photo decision. */
export const takeoutReportJson = (
  takeout: TakeoutResponseDto,
  items: readonly TakeoutItemResponseDto[],
  pairs: readonly TakeoutPairResponseDto[],
  hiddenLocked: number,
) =>
  JSON.stringify(
    {
      import: {
        id: takeout.id,
        name: takeout.name,
        state: takeout.state,
        counts: takeout.counts,
        sources: takeout.sources.map(({ name, kind, size, rejected }) => ({ name, kind, size, rejected })),
        options: takeout.options,
      },
      // Locked items are only in a report made from an unlocked session.
      lockedItemsOmitted: hiddenLocked,
      items,
      livePhotos: pairs,
    },
    null,
    2,
  );

export const takeoutReportFileName = (takeout: Pick<TakeoutResponseDto, 'createdAt'>, extension: 'json' | 'csv') =>
  `google-photos-import-${takeout.createdAt.slice(0, 10)}-report.${extension}`;

/** Every page of a paginated listing, in order. */
export const collectPages = async <T>(
  load: (offset: number, limit: number) => Promise<{ entries: T[]; total: number }>,
  limit = 200,
): Promise<T[]> => {
  const entries: T[] = [];
  for (let offset = 0; ; offset += limit) {
    const page = await load(offset, limit);
    entries.push(...page.entries);
    if (page.entries.length === 0 || entries.length >= page.total) {
      return entries;
    }
  }
};
