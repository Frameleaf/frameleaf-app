import { createHash } from 'node:crypto';
import path from 'node:path';
import { AssetType, ChecksumAlgorithm } from 'src/enum.js';
import { normalizeImportPath } from 'src/utils/library-paths.js';

/**
 * The shape of an external library scan job (FL-78).
 *
 * A scan is a `media_operation` of kind `library_scan`. Its snapshot names the library and what
 * asked for it; everything about the library itself — folders, exclusions, owner — is read afresh
 * on every claim, so a scan never runs against settings that no longer exist. Its result is the
 * one mutable record of what the scan has done, written after every batch.
 */
export type LibraryScanTrigger = 'manual' | 'automatic';

export type LibraryScanSnapshot = {
  libraryId: string;
  trigger: LibraryScanTrigger;
};

/**
 * - `crawl`: walking the import folders and importing files the library does not have yet.
 * - `check`: checking every indexed item against its folder, from `cursor`.
 * - `done`: finished; only a completed scan says so.
 */
export type LibraryScanPhase = 'crawl' | 'check' | 'done';

/** Why a scan stopped short of the end on the server's own initiative, for the library page. */
export type LibraryScanStopReason = 'paths_changed' | 'library_removed' | 'owner_deleted';

export type LibraryScanResult = {
  phase: LibraryScanPhase;
  /** The library's folders and exclusions when this scan started; a different value stops it. */
  fingerprint: string | null;
  /** Files found in the folders by the current crawl. */
  crawled: number;
  /** Items indexed at the start of the crawl, which the check will visit. */
  expected: number;
  /** Items the check phase visits, counted when it starts. */
  total: number;
  added: number;
  checked: number;
  updated: number;
  offlined: number;
  onlined: number;
  /** The last item id the check finished. */
  cursor: string | null;
  stopReason: LibraryScanStopReason | null;
};

const PHASES: ReadonlySet<string> = new Set(['crawl', 'check', 'done']);
const STOP_REASONS: ReadonlySet<string> = new Set(['paths_changed', 'library_removed', 'owner_deleted']);

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const asCount = (value: unknown): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;

export const parseLibraryScanSnapshot = (value: unknown): LibraryScanSnapshot => {
  const snapshot = asObject(value);
  if (typeof snapshot.libraryId !== 'string' || snapshot.libraryId.length === 0) {
    throw new Error('Library scan snapshot has no library');
  }
  return {
    libraryId: snapshot.libraryId,
    trigger: snapshot.trigger === 'automatic' ? 'automatic' : 'manual',
  };
};

export const emptyLibraryScanResult = (): LibraryScanResult => ({
  phase: 'crawl',
  fingerprint: null,
  crawled: 0,
  expected: 0,
  total: 0,
  added: 0,
  checked: 0,
  updated: 0,
  offlined: 0,
  onlined: 0,
  cursor: null,
  stopReason: null,
});

export const parseLibraryScanResult = (value: unknown): LibraryScanResult => {
  const result = asObject(value);
  const empty = emptyLibraryScanResult();
  return {
    phase: typeof result.phase === 'string' && PHASES.has(result.phase) ? (result.phase as LibraryScanPhase) : 'crawl',
    fingerprint: typeof result.fingerprint === 'string' ? result.fingerprint : empty.fingerprint,
    crawled: asCount(result.crawled),
    expected: asCount(result.expected),
    total: asCount(result.total),
    added: asCount(result.added),
    checked: asCount(result.checked),
    updated: asCount(result.updated),
    offlined: asCount(result.offlined),
    onlined: asCount(result.onlined),
    cursor: typeof result.cursor === 'string' ? result.cursor : null,
    stopReason:
      typeof result.stopReason === 'string' && STOP_REASONS.has(result.stopReason)
        ? (result.stopReason as LibraryScanStopReason)
        : null,
  };
};

/** Folders and exclusions, order-insensitive, as one short digest. */
export const libraryPathsFingerprint = (library: { importPaths: string[]; exclusionPatterns: string[] }): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        importPaths: [...new Set(library.importPaths.map((importPath) => normalizeImportPath(importPath)))].sort(),
        exclusionPatterns: [...new Set(library.exclusionPatterns)].sort(),
      }),
    )
    .digest('hex')
    .slice(0, 32);

/**
 * Work done and work known, for the progress bar. The total grows as the crawl finds files, which
 * is what a crawl honestly knows; the check phase knows its total when it starts.
 */
export const libraryScanUnits = (result: LibraryScanResult): { processed: number; total: number } => {
  const processed = result.crawled + result.checked;
  const toCheck = result.phase === 'crawl' ? result.expected : Math.max(result.total, result.checked);
  return { processed, total: Math.max(processed, result.crawled + toCheck) };
};

/** 0–99 while running: 100 belongs to a scan that has actually finished. */
export const libraryScanProgress = (result: LibraryScanResult): number => {
  const { processed, total } = libraryScanUnits(result);
  if (total === 0) {
    return 0;
  }
  return Math.min(99, Math.floor((100 * processed) / total));
};

/** The row a newly found file becomes (FL-78): a read-only original the library only references. */
export const libraryAssetFromFile = (
  file: { path: string; mtime: Date },
  owner: { ownerId: string; libraryId: string },
  hashPath: (value: string) => Buffer,
  isVideo: boolean,
) => ({
  ownerId: owner.ownerId,
  libraryId: owner.libraryId,
  checksum: hashPath(`path:${file.path}`),
  checksumAlgorithm: ChecksumAlgorithm.sha1Path,
  originalPath: file.path,
  fileCreatedAt: file.mtime,
  fileModifiedAt: file.mtime,
  localDateTime: file.mtime,
  type: isVideo ? AssetType.Video : AssetType.Image,
  originalFileName: path.parse(file.path).base,
  isExternal: true,
  livePhotoVideoId: null,
});
