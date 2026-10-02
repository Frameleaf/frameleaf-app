/* eslint-disable no-restricted-imports -- Offline recovery reads this format without application aliases. */
import { BUDDY_UUID } from './buddy-backup-crypto.ts';
import type { CloudBackupAlbum, CloudBackupManifest, CloudBackupPerson } from './cloud-backup.ts';

export type BuddyAlbum = CloudBackupAlbum & {
  parentId: string | null;
  kind: 'album' | 'collection' | 'space';
  icon: string | null;
  sortOrder: number | null;
};
export type BuddyMetadata = {
  version: 1;
  peopleByOwner: Record<string, Record<string, CloudBackupPerson>>;
  albums: Record<string, BuddyAlbum>;
};
export type BuddyAlbumPlan = {
  version: 1;
  albums: Record<string, { before: BuddyAlbum | null; after: BuddyAlbum }>;
};
type MetadataManifest = { library: CloudBackupManifest; metadata?: BuddyMetadata };

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid Buddy metadata');
  }
  return value as Record<string, unknown>;
};
const fields = (value: Record<string, unknown>, names: string[]) => {
  if (Object.keys(value).length !== names.length || names.some((name) => !Object.hasOwn(value, name))) {
    throw new Error('Invalid Buddy metadata fields');
  }
};
const uuid = (value: unknown) => typeof value === 'string' && BUDDY_UUID.test(value);
const text = (value: unknown, max = 65_536) => typeof value === 'string' && value.length <= max;
const date = (value: unknown) => {
  if (value === null) {
    return true;
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

/** A present section must validate fully; old snapshots with no section retain their legacy format. */
export const readBuddyMetadata = (value: unknown): BuddyMetadata | undefined => {
  if (value === undefined) {
    return;
  }
  const metadata = record(value);
  fields(metadata, ['version', 'peopleByOwner', 'albums']);
  if (metadata.version !== 1) {
    throw new Error('Unsupported Buddy metadata version');
  }
  for (const [ownerId, values] of Object.entries(record(metadata.peopleByOwner))) {
    if (!uuid(ownerId)) {
      throw new Error('Invalid Buddy person owner');
    }
    for (const [groupId, value] of Object.entries(record(values))) {
      const person = record(value);
      fields(person, ['ownerId', 'name', 'birthDate', 'isHidden', 'isFavorite']);
      if (
        !uuid(groupId) ||
        person.ownerId !== ownerId ||
        !text(person.name) ||
        typeof person.isHidden !== 'boolean' ||
        typeof person.isFavorite !== 'boolean' ||
        !date(person.birthDate)
      ) {
        throw new Error('Invalid Buddy person record');
      }
    }
  }
  const albums = record(metadata.albums);
  for (const [id, value] of Object.entries(albums)) {
    const album = record(value);
    fields(album, [
      'ownerId',
      'name',
      'description',
      'coverAssetId',
      'order',
      'sharedUsers',
      'parentId',
      'kind',
      'icon',
      'sortOrder',
    ]);
    if (
      !uuid(id) ||
      !uuid(album.ownerId) ||
      !text(album.name) ||
      !text(album.description) ||
      (album.coverAssetId !== null && !uuid(album.coverAssetId)) ||
      !['asc', 'desc'].includes(album.order as string) ||
      !Array.isArray(album.sharedUsers) ||
      album.sharedUsers.length > 0 ||
      !['album', 'collection', 'space'].includes(album.kind as string) ||
      (album.icon !== null && !text(album.icon, 80)) ||
      (album.sortOrder !== null && (typeof album.sortOrder !== 'number' || !Number.isFinite(album.sortOrder))) ||
      (album.parentId !== null && (!uuid(album.parentId) || album.parentId === id || album.kind !== 'album'))
    ) {
      throw new Error('Invalid Buddy album record');
    }
    if (
      album.parentId &&
      albums[album.parentId as string] &&
      record(albums[album.parentId as string]).kind !== 'collection'
    ) {
      throw new Error('Invalid Buddy album parent');
    }
  }
  return value as BuddyMetadata;
};

/** The same owner view feeds preview hashes, item checks and details publication. Never use another owner's name. */
export const buddyLibraryForOwner = (
  { library, metadata }: MetadataManifest,
  ownerId: string,
): CloudBackupManifest => ({
  ...library,
  people: metadata
    ? (metadata.peopleByOwner[ownerId] ?? {})
    : Object.fromEntries(Object.entries(library.people).filter(([, person]) => person.ownerId === ownerId)),
  // New metadata carries an explicitly empty sharing list; using the map directly avoids scanning every album per item.
  albums: metadata ? metadata.albums : library.albums,
});

/** Album IDs are selected independently from files. Parent dependencies can only recreate the same owner's albums. */
export const selectBuddyAlbumIds = (
  metadata: BuddyMetadata,
  request: { scope: string; albumId?: string; assetIds?: string[] },
  assets: CloudBackupManifest['assets'],
  ownerId: string,
  admin: boolean,
): string[] => {
  const selected = new Set<string>();
  if (request.scope === 'library') {
    for (const [id, album] of Object.entries(metadata.albums)) {
      if (admin || album.ownerId === ownerId) {
        selected.add(id);
      }
    }
  } else if (request.scope === 'album') {
    const album = metadata.albums[request.albumId ?? ''];
    if (!album || (!admin && album.ownerId !== ownerId)) {
      throw new Error('Buddy restore album unavailable');
    }
    selected.add(request.albumId!);
    if (album.kind === 'collection') {
      for (const [id, child] of Object.entries(metadata.albums)) {
        if (child.parentId === request.albumId && child.ownerId === album.ownerId) {
          selected.add(id);
        }
      }
    }
  }
  if (request.scope === 'asset' || request.scope === 'album') {
    for (const id of request.assetIds ?? []) {
      const asset = assets[id];
      if (!asset || (!admin && asset.owner !== ownerId)) {
        throw new Error('Buddy restore item unavailable');
      }
      for (const { id: albumId } of asset.details?.albums ?? []) {
        if (metadata.albums[albumId]?.ownerId === asset.owner) {
          selected.add(albumId);
        }
      }
    }
  }
  const pending = selected.values().toArray();
  for (let index = 0; index < pending.length; index++) {
    const id = pending[index];
    const album = metadata.albums[id];
    const parent = album.parentId && metadata.albums[album.parentId];
    if (parent && parent.ownerId === album.ownerId && !selected.has(album.parentId!)) {
      selected.add(album.parentId!);
      pending.push(album.parentId!);
    }
  }
  return [...selected].sort((left, right) => left.localeCompare(right));
};

/** Covers are resolved only after selected files are restored; a normal cover refresh is not an identity change. */
export const buddyAlbumState = (album: BuddyAlbum) =>
  JSON.stringify([
    album.ownerId,
    album.name,
    album.description,
    album.order,
    album.parentId,
    album.kind,
    album.icon,
    album.sortOrder,
  ]);

export const assertBuddyAlbumPlan = (
  metadata: BuddyMetadata,
  plan: BuddyAlbumPlan,
  ids: string[],
  mode: 'keep' | 'replace',
) => {
  const compare = (left: string, right: string) => left.localeCompare(right);
  if (
    plan.version !== 1 ||
    JSON.stringify(Object.keys(plan.albums).sort(compare)) !== JSON.stringify([...ids].sort(compare))
  ) {
    throw new Error('Buddy restore album selection changed');
  }
  for (const [id, { before, after }] of Object.entries(plan.albums)) {
    const backup = metadata.albums[id];
    if (
      !backup ||
      (before && (before.ownerId !== backup.ownerId || before.kind !== backup.kind)) ||
      buddyAlbumState(after) !== buddyAlbumState(mode === 'keep' && before ? before : backup)
    ) {
      throw new Error('Buddy restore album selection changed');
    }
  }
};
