import { createHash } from 'node:crypto';
import path from 'node:path';
import { MediaOperationStatus } from 'src/enum.js';

/**
 * Google Photos import rules (FL-65, `IMP-001`), kept free of the database and the filesystem so
 * they can be read and tested on their own: how an export's paths are read, how a JSON sidecar is
 * matched to its photo, what an item's metadata becomes, and what state an import is in.
 */

/** Where an import has got to. The work of each step runs as a `takeout_import` media operation. */
export type TakeoutPhase = 'sources' | 'scanning' | 'review' | 'importing' | 'completed';
export type TakeoutSourceKind = 'zip' | 'directory';
export type TakeoutFileKind = 'image' | 'video' | 'sidecar';
export type TakeoutItemState = 'ready' | 'review' | 'importing' | 'imported' | 'matched' | 'skipped' | 'failed';
export type TakeoutPairState = 'suggested' | 'approved' | 'skipped' | 'linked' | 'failed';
export type TakeoutResultKind = 'created' | 'matched';
export type TakeoutAction = 'scan' | 'import';

/** What the API reports: the phase, refined by the job that is working on it. */
export type TakeoutState =
  | 'sources'
  | 'queued'
  | 'scanning'
  | 'review'
  | 'importing'
  | 'paused'
  | 'cancelling'
  | 'cancelled'
  | 'failed'
  | 'completed';

export const TAKEOUT_ITEM_STATES: readonly TakeoutItemState[] = [
  'ready',
  'review',
  'importing',
  'imported',
  'matched',
  'skipped',
  'failed',
];

export const TAKEOUT_PAIR_STATES: readonly TakeoutPairState[] = [
  'suggested',
  'approved',
  'skipped',
  'linked',
  'failed',
];

/** The metadata Google Photos exported for one photo or video. */
export type TakeoutMetadata = {
  title: string;
  description?: string;
  takenAt?: string;
  createdAt?: string;
  latitude?: number;
  longitude?: number;
  favorite?: boolean;
  archived?: boolean;
  /** The photo was in Google's Locked Folder. It is imported into Locked. */
  locked?: boolean;
  /** The photo was in the Google Photos trash when it was exported. It is not imported. */
  trashed?: boolean;
};

export type TakeoutSidecar = { id: string; name: string; metadata: TakeoutMetadata };
export type TakeoutSidecarCandidate = { id: string; path: string; metadata: TakeoutMetadata };
export type TakeoutBoundary = { relativePath: string; folder: string; name: string };

/**
 * Warnings an item can carry, as stable codes the web client translates
 * (`frameleaf_takeout_warning_<code>`).
 */
export type TakeoutWarning = 'ambiguous_sidecar' | 'no_sidecar' | 'invalid_sidecar' | 'trashed' | 'locked';

/**
 * The owner's choices for an import. `albums` and `sidecarReview` are the two switches the settings
 * section names ("Recreate album memberships", "Review ambiguous sidecars").
 */
export type TakeoutOptions = {
  descriptions: boolean;
  dates: boolean;
  locations: boolean;
  favorites: boolean;
  archive: boolean;
  albums: boolean;
  /** Hold items whose sidecars disagree for a decision; off imports them without a sidecar. */
  sidecarReview: boolean;
  /** Fill metadata the library is missing on photos it already had. Never overwrites a value. */
  updateMatchedMetadata: boolean;
  /** Album folders to recreate; absent means every folder that is not a year folder. */
  selectedAlbums?: string[];
};

export const TAKEOUT_DEFAULT_OPTIONS: Readonly<TakeoutOptions> = Object.freeze({
  descriptions: true,
  dates: true,
  locations: true,
  favorites: true,
  archive: true,
  albums: true,
  sidecarReview: true,
  updateMatchedMetadata: false,
});

/** Stored options, read leniently: anything missing or malformed falls back to the default. */
export const parseTakeoutOptions = (value: unknown): TakeoutOptions => {
  const stored = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const flag = (key: keyof Omit<TakeoutOptions, 'selectedAlbums'>) =>
    typeof stored[key] === 'boolean' ? (stored[key] as boolean) : TAKEOUT_DEFAULT_OPTIONS[key];
  const selected = Array.isArray(stored.selectedAlbums)
    ? stored.selectedAlbums.filter((folder): folder is string => typeof folder === 'string')
    : undefined;

  return {
    descriptions: flag('descriptions'),
    dates: flag('dates'),
    locations: flag('locations'),
    favorites: flag('favorites'),
    archive: flag('archive'),
    albums: flag('albums'),
    sidecarReview: flag('sidecarReview'),
    updateMatchedMetadata: flag('updateMatchedMetadata'),
    ...(selected && { selectedAlbums: selected }),
  };
};

/**
 * The Google Photos folder inside a Takeout export, in the languages Google names it in. An archive
 * holding other Google products is read only below this folder.
 */
const photoRoots =
  /^google[\s_-]*(photos|fotos|foto|フォト|사진|相册|相簿|照片|фото|фотографии|รูปภาพ|φωτογραφίες|صور|תמונות|фотографії)$/iu;
const editedSuffix = /-(edited|modifié|bearbeitet|modificato|editado|modificado|bewerkt|編集済み|편집됨)(?=\.[^.]+$)/iu;
const lockedFolders =
  /^(locked folder|gesperrter ordner|dossier verrouillé|carpeta bloqueada|cartella bloccata|pasta trancada|vergrendelde map|ロックされたフォルダ|잠금 폴더)$/iu;

/** Why an archive entry was refused instead of staged. Its name is never used as a path either way. */
export class TakeoutEntryRejected extends Error {}

/**
 * Where an archive entry sits inside the export, or undefined when it is outside Google Photos or is
 * a folder. Throws `TakeoutEntryRejected` for a name that could escape a directory: absolute, with a
 * drive letter, a backslash, a NUL or a `..` segment. Extracted content is always stored under an
 * opaque generated name; archive paths are never used as filesystem destinations.
 */
export function takeoutEntryPath(entryName: string): TakeoutBoundary | undefined {
  if (
    !entryName ||
    entryName.includes('\0') ||
    entryName.includes('\\') ||
    entryName.startsWith('/') ||
    /^[a-z]:/iu.test(entryName)
  ) {
    throw new TakeoutEntryRejected('Unsafe archive entry path');
  }
  const segments = entryName.split('/').filter((part) => part !== '' && part !== '.');
  if (segments.includes('..')) {
    throw new TakeoutEntryRejected('Archive entries cannot traverse parent directories');
  }
  if (entryName.endsWith('/') || segments.length === 0) {
    return;
  }
  const takeout = segments.findIndex((part) => part.toLowerCase() === 'takeout');
  let relative = segments;
  if (takeout !== -1) {
    if (!photoRoots.test(segments[takeout + 1] ?? '')) {
      return;
    }
    relative = segments.slice(takeout + 2);
  } else if (photoRoots.test(segments[0])) {
    relative = segments.slice(1);
  }
  if (relative.length === 0) {
    return;
  }
  const name = relative.at(-1)!;
  const folder = relative.slice(0, -1).join('/');
  return { relativePath: relative.join('/'), folder, name };
}

/** "Photos from 2019" and its translations: Google's automatic year folders, not albums. */
export function isTakeoutYearFolder(folder: string) {
  return /^(?:(?:photos from|fotos (?:von|de)|photos de|foto del|bilder von|写真|사진)\s*)?(?:19|20)\d{2}(?:年|년)?$/iu.test(
    path.posix.basename(folder),
  );
}

/** Google's Locked Folder, as the export names it. */
export const isTakeoutLockedFolder = (folder: string) => !!folder && lockedFolders.test(path.posix.basename(folder));

/** A folder the import recreates as an album. */
export const isTakeoutAlbumSelected = (folder: string, options: Pick<TakeoutOptions, 'albums' | 'selectedAlbums'>) => {
  if (!options.albums || !folder || isTakeoutLockedFolder(folder)) {
    return false;
  }
  return options.selectedAlbums ? options.selectedAlbums.includes(folder) : !isTakeoutYearFolder(folder);
};

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const timestamp = (value: unknown): string | undefined => {
  const raw = object(value)?.timestamp;
  if (typeof raw !== 'number' && (typeof raw !== 'string' || !/^-?\d+(?:\.\d+)?$/u.test(raw))) {
    return;
  }
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || Math.abs(seconds) > 8_640_000_000_000) {
    return;
  }
  return new Date(seconds * 1000).toISOString();
};

/**
 * A photo sidecar's metadata, or undefined for JSON that is not one (album metadata, other Google
 * products, comments). Only what Google exported is read; nothing is guessed.
 *
 * Google's export has no documented Locked Folder flag; the boolean `inLockedFolder` is honoured
 * when present, alongside the folder name (`isTakeoutLockedFolder`).
 */
export function parseTakeoutSidecar(value: unknown): TakeoutMetadata | undefined {
  const data = object(value);
  if (!data || typeof data.title !== 'string' || (!object(data.photoTakenTime) && !object(data.creationTime))) {
    return;
  }
  const takenAt = timestamp(data.photoTakenTime);
  const createdAt = timestamp(data.creationTime);
  const geo = [object(data.geoDataExif), object(data.geoData)].find(
    (candidate) =>
      candidate &&
      typeof candidate.latitude === 'number' &&
      typeof candidate.longitude === 'number' &&
      Number.isFinite(candidate.latitude) &&
      Number.isFinite(candidate.longitude) &&
      Math.abs(candidate.latitude) <= 90 &&
      Math.abs(candidate.longitude) <= 180 &&
      (candidate.latitude !== 0 || candidate.longitude !== 0),
  );
  return {
    title: data.title.slice(0, 4096),
    ...(typeof data.description === 'string' &&
      data.description !== '' && { description: data.description.slice(0, 100_000) }),
    ...(takenAt && { takenAt }),
    ...(createdAt && { createdAt }),
    ...(geo && { latitude: geo.latitude as number, longitude: geo.longitude as number }),
    ...(typeof data.favorited === 'boolean' && { favorite: data.favorited }),
    ...(typeof data.archived === 'boolean' && { archived: data.archived }),
    ...(data.inLockedFolder === true && { locked: true }),
    ...(data.trashed === true && { trashed: true }),
  };
}

function normalizedName(name: string) {
  return name
    .normalize('NFC')
    .toLowerCase()
    .replace(/(\.[^.()]+)(\(\d+\))$/u, '$2$1');
}

/**
 * The media name a sidecar describes: `IMG_1.jpg.json`, `IMG_1.jpg.supplemental-metadata.json` and
 * Google's truncated variants (`IMG_1.jpg.supplemental-metad.json`, `IMG_1.jpg.suppl(1).json`).
 */
function sidecarMediaName(name: string) {
  const base = name.replace(/\.json$/iu, '');
  const supplemental = base.match(/^(.*?)\.supp?l?(?:emental)?(?:[-\w]*?)(\(\d+\))?$/iu);
  return normalizedName(supplemental ? supplemental[1] + (supplemental[2] ?? '') : base);
}

/**
 * Folder-local sidecar matching, indexed so a scan stays linear in the number of files. Returns the
 * distinct candidates for a media file: exactly one is a match, several need the owner's decision,
 * none means the file's own metadata is used.
 */
export function createTakeoutSidecarIndex(sidecars: TakeoutSidecar[]) {
  const exact = new Map<string, Set<TakeoutSidecar>>();
  const byTitle = new Map<string, Set<TakeoutSidecar>>();
  const extensionless = new Map<string, Set<TakeoutSidecar>>();
  const add = (index: Map<string, Set<TakeoutSidecar>>, key: string, sidecar: TakeoutSidecar) => {
    const values = index.get(key) ?? new Set<TakeoutSidecar>();
    values.add(sidecar);
    index.set(key, values);
  };
  for (const sidecar of sidecars) {
    const name = sidecarMediaName(sidecar.name);
    add(exact, name, sidecar);
    add(byTitle, normalizedName(sidecar.metadata.title), sidecar);
    if (!path.posix.extname(name)) {
      add(extensionless, name, sidecar);
    }
  }
  return (mediaName: string): TakeoutSidecar[] => {
    const name = normalizedName(mediaName);
    let matches = exact.get(name) ?? byTitle.get(name) ?? extensionless.get(path.posix.parse(name).name);
    if (!matches && editedSuffix.test(mediaName)) {
      // Reusing an original's sidecar for an edited copy requires its Google title to confirm that
      // original name; suffix similarity alone is not enough.
      matches = byTitle.get(normalizedName(mediaName.replace(editedSuffix, '')));
    }
    const distinct = new Map<string, TakeoutSidecar>();
    for (const candidate of matches ?? []) {
      distinct.set(JSON.stringify(candidate.metadata), candidate);
    }
    return distinct.values().toArray();
  };
}

/** The key a photo and a video must share to be offered as one Live Photo. */
export function takeoutLivePhotoKey(name: string) {
  return normalizedName(path.posix.parse(name).name.replace(/\.MP$/iu, ''));
}

/** A version 4 shaped uuid derived from `namespace`, so the same entry always gets the same id. */
export function takeoutStableId(namespace: string) {
  const bytes = createHash('sha256').update(namespace).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

/**
 * What a scanned item starts as. One candidate is used as it is; several wait for a decision; a
 * trashed photo is skipped. `locked` is true when any candidate or the folder says Locked Folder, so
 * a disputed item stays private whichever sidecar is chosen.
 */
export const takeoutScannedItem = (input: {
  name: string;
  folder: string;
  candidates: TakeoutSidecarCandidate[];
  invalidSidecar: boolean;
}): {
  state: TakeoutItemState;
  metadata: TakeoutMetadata;
  sidecarId: string | null;
  warnings: TakeoutWarning[];
  locked: boolean;
} => {
  const { candidates } = input;
  const single = candidates.length === 1 ? candidates[0] : undefined;
  const metadata = single?.metadata ?? { title: input.name };
  const locked = isTakeoutLockedFolder(input.folder) || candidates.some((candidate) => candidate.metadata.locked);
  const warnings: TakeoutWarning[] = [];
  if (candidates.length > 1) {
    warnings.push('ambiguous_sidecar');
  } else if (candidates.length === 0) {
    warnings.push('no_sidecar');
  }
  if (input.invalidSidecar) {
    warnings.push('invalid_sidecar');
  }
  if (locked) {
    warnings.push('locked');
  }
  const trashed = candidates.length > 0 && candidates.every((candidate) => candidate.metadata.trashed);
  if (trashed) {
    warnings.push('trashed');
  }

  return {
    state: trashed ? 'skipped' : candidates.length > 1 ? 'review' : 'ready',
    metadata,
    sidecarId: single?.id ?? null,
    warnings,
    locked,
  };
};

/** The asset fields an import writes. Absent fields are left as they are. */
export type TakeoutAssetPatch = {
  description?: string;
  dateTimeOriginal?: string;
  latitude?: number;
  longitude?: number;
  isFavorite?: boolean;
  archive?: boolean;
};

/** What the library already holds for a photo the import matched. */
export type TakeoutExistingAsset = {
  description: string | null;
  latitude: number | null;
  longitude: number | null;
  isFavorite: boolean;
  archived: boolean;
};

/**
 * The fields to write on an asset the import created: everything the owner chose to bring over.
 */
export const takeoutCreatedPatch = (metadata: TakeoutMetadata, options: TakeoutOptions): TakeoutAssetPatch => {
  const patch: TakeoutAssetPatch = {};
  if (options.descriptions && metadata.description) {
    patch.description = metadata.description;
  }
  if (options.dates && metadata.takenAt) {
    patch.dateTimeOriginal = metadata.takenAt;
  }
  if (options.locations && metadata.latitude !== undefined && metadata.longitude !== undefined) {
    patch.latitude = metadata.latitude;
    patch.longitude = metadata.longitude;
  }
  if (options.favorites && metadata.favorite) {
    patch.isFavorite = true;
  }
  if (options.archive && metadata.archived) {
    patch.archive = true;
  }
  return patch;
};

/**
 * The fields to write on a photo the library already had. Nothing unless the owner asked for it, and
 * then only what is missing: a description or place the library does not have, a favorite or archive
 * Google recorded. Dates are never changed, and no value the library holds is overwritten, so a
 * repeated import cannot undo a manual edit.
 */
export const takeoutMatchedPatch = (
  metadata: TakeoutMetadata,
  existing: TakeoutExistingAsset,
  options: TakeoutOptions,
): TakeoutAssetPatch => {
  if (!options.updateMatchedMetadata) {
    return {};
  }
  const patch: TakeoutAssetPatch = {};
  if (options.descriptions && metadata.description && !existing.description) {
    patch.description = metadata.description;
  }
  if (
    options.locations &&
    metadata.latitude !== undefined &&
    metadata.longitude !== undefined &&
    (existing.latitude === null || existing.longitude === null)
  ) {
    patch.latitude = metadata.latitude;
    patch.longitude = metadata.longitude;
  }
  if (options.favorites && metadata.favorite && !existing.isFavorite) {
    patch.isFavorite = true;
  }
  if (options.archive && metadata.archived && !existing.archived) {
    patch.archive = true;
  }
  return patch;
};

/** Operation statuses that mean the job is waiting for a worker. */
const WAITING: ReadonlySet<MediaOperationStatus> = new Set([
  MediaOperationStatus.Queued,
  MediaOperationStatus.Preparing,
]);
const WORKING: ReadonlySet<MediaOperationStatus> = new Set([
  MediaOperationStatus.Rendering,
  MediaOperationStatus.Validating,
]);

/**
 * The state an import is in, from its phase and the latest job that worked on it. A scan or import
 * reads as its job does: waiting, working, paused, stopping, stopped or failed. A job that completed
 * advanced the phase before it did, so a completed job only ever sits behind the next phase.
 */
export const takeoutState = (
  phase: TakeoutPhase,
  operation?: { status: MediaOperationStatus } | null,
): TakeoutState => {
  if (phase !== 'scanning' && phase !== 'importing') {
    return phase;
  }
  if (!operation) {
    return 'failed';
  }
  const status = operation.status;
  if (WAITING.has(status)) {
    return 'queued';
  }
  if (WORKING.has(status)) {
    return phase;
  }
  switch (status) {
    case MediaOperationStatus.Paused: {
      return 'paused';
    }
    case MediaOperationStatus.Cancelling: {
      return 'cancelling';
    }
    case MediaOperationStatus.Cancelled: {
      return 'cancelled';
    }
    case MediaOperationStatus.Completed: {
      return phase === 'scanning' ? 'review' : 'completed';
    }
    default: {
      return 'failed';
    }
  }
};

/** States in which a job is working on the import and nothing about it may change. */
export const TAKEOUT_BUSY_STATES: readonly TakeoutState[] = ['queued', 'scanning', 'importing', 'paused', 'cancelling'];

/** States in which the owner may change review decisions and import choices. */
export const TAKEOUT_REVIEWABLE_STATES: readonly TakeoutState[] = ['review', 'completed', 'failed', 'cancelled'];
