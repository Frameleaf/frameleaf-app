import type { CloudBackupAssetDetails } from 'src/utils/cloud-backup.js';

/**
 * How a restore brings back an item's details (FL-164, cloud-backup.md "Rules for bringing details
 * back"): `keep` leaves them as they are (only the file comes back), `fill` puts backed-up values into
 * empty fields, `replace` puts back every field that differs. Albums are only ever added back, and faces
 * only onto an item that has none, so a restore never takes an item out of an album or undoes face work.
 */
export const RESTORE_DETAILS_MODES = ['keep', 'fill', 'replace'] as const;
export type RestoreDetailsMode = (typeof RESTORE_DETAILS_MODES)[number];

/** An item with no details at all: what a deleted item that is made again starts from. */
export const EMPTY_DETAILS: CloudBackupAssetDetails = Object.freeze({
  isFavorite: false,
  visibility: 'timeline',
  rating: null,
  description: '',
  dateTimeOriginal: null,
  timeZone: null,
  latitude: null,
  longitude: null,
  tags: [],
  albums: [],
  faces: [],
  stack: null,
  edits: [],
}) as CloudBackupAssetDetails;

/** What putting details back changes; an empty object when nothing does. */
export type DetailChanges = {
  isFavorite?: boolean;
  visibility?: CloudBackupAssetDetails['visibility'];
  exif?: {
    description?: string;
    rating?: number | null;
    dateTimeOriginal?: string | null;
    timeZone?: string | null;
    latitude?: number;
    longitude?: number;
  };
  clearLocation?: true;
  /** Tags to add (fill), or every tag the item should have (replace). */
  tags?: { values: string[]; exact: boolean };
  /** Albums to add the item to. */
  albums?: string[];
  faces?: CloudBackupAssetDetails['faces'];
  stack?: { id: string; isPrimary: boolean };
  edits?: CloudBackupAssetDetails['edits'];
};

const sameSet = (a: string[], b: string[]) => a.length === b.length && new Set([...a, ...b]).size === a.length;

const hasLocation = (details: CloudBackupAssetDetails) => details.latitude !== null && details.longitude !== null;

/** The changes that bring `backup`'s details to an item that has `current` now. */
export const detailChanges = (
  current: CloudBackupAssetDetails,
  backup: CloudBackupAssetDetails,
  mode: RestoreDetailsMode,
): DetailChanges => {
  if (mode === 'keep') {
    return {};
  }
  const replace = mode === 'replace';
  const changes: DetailChanges = {};
  const exif: NonNullable<DetailChanges['exif']> = {};

  if (replace ? current.isFavorite !== backup.isFavorite : backup.isFavorite && !current.isFavorite) {
    changes.isFavorite = backup.isFavorite;
  }
  // the hidden half of a Live Photo stays as it is either way
  if (
    replace &&
    current.visibility !== backup.visibility &&
    current.visibility !== 'hidden' &&
    backup.visibility !== 'hidden'
  ) {
    changes.visibility = backup.visibility;
  }
  if (replace ? current.description !== backup.description : !current.description && !!backup.description) {
    exif.description = backup.description;
  }
  if (replace ? current.rating !== backup.rating : current.rating === null && backup.rating !== null) {
    exif.rating = backup.rating;
  }
  const sameDate = current.dateTimeOriginal === backup.dateTimeOriginal && current.timeZone === backup.timeZone;
  if (replace ? !sameDate : current.dateTimeOriginal === null && backup.dateTimeOriginal !== null) {
    exif.dateTimeOriginal = backup.dateTimeOriginal;
    exif.timeZone = backup.timeZone;
  }
  const sameLocation = current.latitude === backup.latitude && current.longitude === backup.longitude;
  if (hasLocation(backup) && (replace ? !sameLocation : !hasLocation(current))) {
    exif.latitude = backup.latitude!;
    exif.longitude = backup.longitude!;
  } else if (replace && !hasLocation(backup) && hasLocation(current)) {
    changes.clearLocation = true;
  }
  if (Object.keys(exif).length > 0) {
    changes.exif = exif;
  }

  if (replace) {
    if (!sameSet(current.tags, backup.tags)) {
      changes.tags = { values: backup.tags, exact: true };
    }
  } else {
    const missing = backup.tags.filter((tag) => !current.tags.includes(tag));
    if (missing.length > 0) {
      changes.tags = { values: missing, exact: false };
    }
  }

  const inAlbums = new Set(current.albums.map(({ id }) => id));
  const albums = backup.albums.map(({ id }) => id).filter((id) => !inAlbums.has(id));
  if (albums.length > 0) {
    changes.albums = albums;
  }

  if (current.faces.length === 0 && backup.faces.length > 0) {
    changes.faces = backup.faces;
  }

  if (backup.stack && (replace ? current.stack?.id !== backup.stack.id : !current.stack)) {
    changes.stack = backup.stack;
  }

  const sameEdits = JSON.stringify(current.edits) === JSON.stringify(backup.edits);
  if (replace ? !sameEdits : current.edits.length === 0 && backup.edits.length > 0) {
    changes.edits = backup.edits;
  }
  return changes;
};
