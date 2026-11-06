import { stat } from 'node:fs/promises';
import { join, posix } from 'node:path';
import fixture from 'src/library-import/fixtures/photoview/2.4.0-sqlite.json' with { type: 'json' };
import { type ImportedPasswordContext } from 'src/library-import/passwords.js';
import { type PhotoviewRow, openPhotoviewSnapshot, readPhotoviewManifest } from 'src/library-import/photoview.js';
import { openSnapshotBestEffort } from 'src/library-import/preparation/sqlite.js';
import { type PreparationAdapter, unrestrictedLogin } from 'src/library-import/preparation/types.js';

const inventory = (revision: string) => ({
  complete: true as const,
  ownershipComplete: true as const,
  privacyComplete: true as const,
  writersStopped: true as const,
  revisionBefore: revision,
  revisionAfter: revision,
});

const isWithin = (path: string, root: string) => root === '/' || path === root || path.startsWith(root + '/');

/** Deepest directory holding every Photoview root path (a user's scanned media path), then each ancestor up to `/`. */
const sourceRootCandidates = (albums: PhotoviewRow[]) => {
  const roots = albums
    .filter((album) => album.parent_album_id === null && typeof album.path === 'string')
    .map((album) => posix.normalize(String(album.path)).split('/').filter(Boolean));
  const common = roots.length === 0 ? [] : [...roots[0]];
  for (const segments of roots.slice(1)) {
    let index = 0;
    while (index < common.length && common[index] === segments[index]) index++;
    common.length = index;
  }
  const candidates: string[] = [];
  for (let length = common.length; length >= 0; length--) candidates.push('/' + common.slice(0, length).join('/'));
  return candidates;
};

const exists = async (path: string) => {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
};

/**
 * Owner of each directory: among its source readers, the one whose top-most granted directory on the way to the root
 * is deepest (a user's own scanned path beats an administrator scanning the whole library); ties go to the lowest id.
 * Directories nobody can read stay unmapped and the reader refuses them.
 */
const directoryOwners = (albums: PhotoviewRow[], grants: PhotoviewRow[]) => {
  const parents = new Map(albums.map((album) => [String(album.id), album.parent_album_id]));
  const granted = Map.groupBy(grants, (grant) => String(grant.album_id));
  const owners: Record<string, string> = {};
  for (const album of albums) {
    const chain: string[] = [];
    const seen = new Set<string>();
    let current: string | undefined = String(album.id);
    while (current !== undefined && parents.has(current) && !seen.has(current)) {
      seen.add(current);
      chain.push(current);
      const parent = parents.get(current);
      current = parent === null || parent === undefined ? undefined : String(parent);
    }
    // depth from the root: chain[chain.length - 1] is the root directory (depth 0).
    const top = new Map<string, number>();
    for (const [index, id] of chain.entries()) {
      const depth = chain.length - 1 - index;
      for (const grant of granted.get(id) ?? []) top.set(String(grant.user_id), depth);
    }
    const [owner] = [...top].toSorted(([leftUser, leftDepth], [rightUser, rightDepth]) =>
      leftDepth === rightDepth ? Number(BigInt(leftUser) - BigInt(rightUser)) : rightDepth - leftDepth,
    );
    if (owner) owners[String(album.id)] = owner[0];
  }
  return owners;
};

/** Photoview SQLite: originals are mounted at the directory that holds every user's scanned media path. */
export const adapter: PreparationAdapter = {
  kind: 'photoview',
  databases: ['sqlite'],
  async open(input) {
    // The strict reader also accepts the known native constraint permutations, so it is always tried first.
    const { snapshot, tested } = openSnapshotBestEffort(
      (bestEffort) => openPhotoviewSnapshot(input.snapshotPath!, fixture.source.version, { bestEffort }),
      true,
    );
    try {
      const rows = (table: Parameters<typeof snapshot.rows>[0]) => [...snapshot.rows(table)].flat();
      const albums = rows('albums');
      const media = rows('media');
      const candidates = sourceRootCandidates(albums);
      // The Manager mounts Photoview's media volume; find which source directory that mount is.
      let sourceRoot = candidates[0];
      const probe = media.find((item) => typeof item.path === 'string' && isWithin(item.path, sourceRoot));
      if (probe)
        for (const candidate of candidates) {
          if (await exists(join(input.originalsRoot, posix.relative(candidate, String(probe.path))))) {
            sourceRoot = candidate;
            break;
          }
        }
      const relative = (path: unknown) =>
        typeof path === 'string' && isWithin(path, sourceRoot) ? posix.relative(sourceRoot, path) : undefined;
      const albumOwners = directoryOwners(albums, rows('user_albums'));
      const photoOwners: Record<string, string> = {};
      for (const item of media) {
        const owner = albumOwners[String(item.album_id)];
        if (owner !== undefined) photoOwners[String(item.id)] = owner;
      }
      return {
        tested,
        testedVersion: fixture.source.version,
        owners() {
          const owners = rows('users').map((user) => ({
            sourceId: String(user.id),
            name: String(user.username),
            // Photoview accounts have no email, second factor, external identity or disabled state.
            email: null,
            login: unrestrictedLogin,
            password: (context: ImportedPasswordContext) => snapshot.password(context),
          }));
          return Promise.resolve(owners);
        },
        files() {
          const files = media.flatMap((item) => {
            const files = [];
            const original = relative(item.path);
            if (original !== undefined)
              files.push({ id: `media:${item.id}`, path: original, role: 'original' as const });
            const sidecar = item.side_car_path === null ? undefined : relative(item.side_car_path);
            if (sidecar !== undefined)
              files.push({ id: `sidecar:${item.id}`, path: sidecar, role: 'sidecar' as const });
            return files;
          });
          return Promise.resolve(files);
        },
        manifest(files) {
          const result = readPhotoviewManifest(snapshot, {
            // The reader compares against the snapshot it opened; preparation restores the real identity afterwards.
            source: { ...input.source, version: fixture.source.version, schemaSha256: snapshot.schemaSha256 },
            inventory: inventory(input.source.revision),
            sourceRoot,
            photoOwners,
            albumOwners,
            files,
          });
          return Promise.resolve(result);
        },
        close: () => snapshot.close(),
      };
    } catch (error) {
      snapshot.close();
      throw error;
    }
  },
};
