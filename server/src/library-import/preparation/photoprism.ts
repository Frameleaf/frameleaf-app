import mariadbFixture from 'src/library-import/fixtures/photoprism/261029-mariadb114.json' with { type: 'json' };
import fixture from 'src/library-import/fixtures/photoprism/261029-sqlite.json' with { type: 'json' };
import { type ImportManifest } from 'src/library-import/manifest.js';
import { type ImportedPassword, type ImportedPasswordContext } from 'src/library-import/passwords.js';
import { type PhotoprismInventoryRecord, readPhotoprismInventory } from 'src/library-import/photoprism-inventory.js';
import { assemblePhotoprismManifest } from 'src/library-import/photoprism-manifest.js';
import { readPhotoprismMariadbInventory } from 'src/library-import/photoprism-mariadb-source.js';
import { type PhotoprismRow, openPhotoprismSnapshot } from 'src/library-import/photoprism.js';
import { qualifiedSource } from 'src/library-import/preparation/sqlite.js';
import {
  type PreparationAdapter,
  type PreparationOwner,
  type SourceLogin,
} from 'src/library-import/preparation/types.js';
import { LibraryImportRefused } from 'src/library-import/state.js';

/** Restored MySQL/MariaDB copy on the preparation's loopback: `mysql://user:password@127.0.0.1:port/database`. */
export const mysqlSourceConfig = (databaseUrl: string, version: string) => {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new LibraryImportRefused('IMPORT_PREPARATION_INPUT_INVALID');
  }
  const database = decodeURIComponent(url.pathname.slice(1));
  if (url.protocol !== 'mysql:' || url.search || url.hash || !database || database.includes('/'))
    throw new LibraryImportRefused('IMPORT_PREPARATION_INPUT_INVALID');
  return {
    host: url.hostname.replace(/^\[(.*)\]$/u, '$1'),
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    version,
  };
};

const inventory = (revision: string) => ({
  complete: true as const,
  ownershipComplete: true as const,
  privacyComplete: true as const,
  writersStopped: true as const,
  revisionBefore: revision,
  revisionAfter: revision,
});

/** Password providers the qualified login cases accept; OIDC accounts also keep a working local password. */
const passwordProviders = new Set(['local', '', 'default']);

/** Source login facts from the qualified login cases; anything unrecognised is reported as a restriction. */
export const photoprismLogin = (user: PhotoprismRow): SourceLogin => {
  const provider = typeof user.auth_provider === 'string' ? user.auth_provider : 'unknown';
  const local = passwordProviders.has(provider);
  return {
    // A super admin signs in even with can_login off; `none` disables the account.
    accountEnabled:
      user.deleted_at === null && provider !== 'none' && (user.super_admin === 1n || user.can_login === 1n),
    passwordLoginEnabled: local || provider === 'oidc',
    secondFactorRequired: user.auth_method !== '',
    externalIdentityRequired: !local,
    ownedLibraryAccess:
      user.user_role === 'admin' && user.user_scope === '*' && user.base_path === '' ? 'full' : 'restricted',
    // Expiry is enforced at sign-in time, so any expiry and any account attribute are reported.
    otherRestrictions: user.expires_at === null && user.user_attr === '' ? 'none' : 'present',
  };
};

/** The only verifier the native qualification proved portable: the original local super administrator. */
const portableVerifier = (user: PhotoprismRow | undefined) =>
  user !== undefined &&
  user.id === 1n &&
  user.auth_provider === 'local' &&
  user.auth_method === '' &&
  user.super_admin === 1n &&
  user.can_login === 1n &&
  user.user_role === 'admin' &&
  user.user_scope === '*' &&
  user.user_attr === '' &&
  user.base_path === '' &&
  user.expires_at === null &&
  user.deleted_at === null;

/**
 * PhotoPrism generates exactly this filter for a folder album (form.Serialize quotes a value only when it holds
 * a space or one of :'()[]-+`); any other dynamic album stays archived.
 */
const folderFilter = (path: string) => `path:${/[\s:'()[\]\-+`]/u.test(path) ? `"${path}"` : path} public:true`;

type Loaded = {
  tested: boolean;
  records: PhotoprismInventoryRecord[];
  schemaFixture: { source: { version: string }; schemaSha256: string };
  password(context: ImportedPasswordContext): Promise<ImportedPassword | undefined>;
  close(): void;
};

const loadSqlite = (path: string, version: string): Loaded => {
  const snapshot = openPhotoprismSnapshot(path, version, { bestEffort: true });
  try {
    return {
      tested: snapshot.qualified,
      records: [...readPhotoprismInventory(path, version, { bestEffort: true })],
      schemaFixture: fixture,
      password: (context) => snapshot.password(context),
      close: () => snapshot.close(),
    };
  } catch (error) {
    snapshot.close();
    throw error;
  }
};

const loadMariadb = async (databaseUrl: string, version: string): Promise<Loaded> => {
  const config = mysqlSourceConfig(databaseUrl, version);
  let tested = false;
  const records: PhotoprismInventoryRecord[] = [];
  for await (const record of readPhotoprismMariadbInventory(config, undefined, {
    bestEffort: true,
    onQualified: (qualified) => (tested = qualified),
  }))
    records.push(record);
  return {
    tested,
    records,
    schemaFixture: mariadbFixture,
    // The restored database only answers verifier reads inside a re-admitted read session.
    async password(context) {
      let credential: ImportedPassword | undefined;
      const session = readPhotoprismMariadbInventory(
        config,
        async (read) => {
          credential = await read(context);
        },
        { bestEffort: true },
      );
      try {
        await session.next();
      } finally {
        await session.return(undefined);
      }
      return credential;
    },
    close: () => {},
  };
};

/**
 * PhotoPrism SQLite snapshot or restored MariaDB. Owners come from the source accounts: a photo or album belongs to the
 * account that created it, otherwise to the primary administrator (PhotoPrism libraries are shared, not per account).
 */
export const adapter: PreparationAdapter = {
  kind: 'photoprism',
  databases: ['sqlite', 'mysql'],
  async open(input) {
    const source = input.databaseUrl
      ? await loadMariadb(input.databaseUrl, input.source.version)
      : loadSqlite(input.snapshotPath!, input.source.version);
    const { records } = source;
    const archived = (table: string) =>
      records.flatMap((record) => (record.type === 'archive' && record.table === table ? [record.value] : []));
    const users = new Map(archived('users').map((row) => [row.user_uid, row]));
    const principals = records.flatMap((record) =>
      record.type === 'principal' && !record.value.system ? [record.value] : [],
    );
    const accountId = (id: string) => users.get(id)?.id;
    const ranked = principals.toSorted((a, b) => {
      const left = accountId(a.id),
        right = accountId(b.id);
      if (typeof left === 'bigint' && typeof right === 'bigint' && left !== right) return left < right ? -1 : 1;
      if (typeof left === 'bigint' && typeof right !== 'bigint') return -1;
      if (typeof right === 'bigint' && typeof left !== 'bigint') return 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    const active = (id: string) => users.get(id)?.deleted_at === null;
    const primary = (
      ranked.find((user) => active(user.id) && users.get(user.id)?.super_admin === 1n) ??
      ranked.find((user) => active(user.id) && user.role === 'admin') ??
      ranked.find((user) => active(user.id)) ??
      ranked[0]
    )?.id;
    const accounts = new Set(principals.map((user) => user.id));
    const ownerOf = (createdBy: string | undefined) =>
      createdBy !== undefined && accounts.has(createdBy) ? createdBy : primary;

    const photos = records.flatMap((record) => (record.type === 'photo' ? [record.value] : []));
    const albums = records.flatMap((record) => (record.type === 'album' ? [record.value] : []));
    const photoOwners: Record<string, string> = {};
    for (const photo of photos) {
      const owner = ownerOf(photo.createdBy);
      if (owner !== undefined) photoOwners[photo.id] = owner;
    }
    const albumOwners: Record<string, string> = {};
    for (const album of albums) {
      const owner = ownerOf(album.createdBy);
      if (owner !== undefined) albumOwners[album.id] = owner;
    }

    return {
      tested: source.tested,
      testedVersion: fixture.source.version,
      owners() {
        const owners = principals.map((principal): PreparationOwner => {
          const user = users.get(principal.id);
          const email = user?.user_email;
          return {
            sourceId: principal.id,
            name: principal.name,
            email: typeof email === 'string' && email ? email : null,
            login: user ? photoprismLogin(user) : { ...photoprismLogin({}), otherRestrictions: 'present' },
            // A verifier outside the qualified policy becomes a secure emailed claim, never a refusal.
            password: (context) => (portableVerifier(user) ? source.password(context) : Promise.resolve(undefined)),
          };
        });
        return Promise.resolve(owners);
      },
      files() {
        return Promise.resolve(
          records.flatMap((record) =>
            record.type === 'file' && record.value.role !== undefined
              ? [{ id: record.value.id, path: record.value.path, role: record.value.role }]
              : [],
          ),
        );
      },
      manifest(files) {
        const losses: ImportManifest['losses'] = [];
        const loss = (code: string, entityId: string) => {
          if (losses.every((entry) => entry.code !== code || entry.entityId !== entityId))
            losses.push({ code, entityId, acknowledged: false });
        };
        const rawPhotos = new Map(archived('photos').map((row) => [row.photo_uid, row]));
        const rawAlbums = new Map(archived('albums').map((row) => [row.album_uid, row]));
        const materializedAlbums: Record<string, string[]> = {};
        const dropped = new Set<string>();
        for (const album of albums) {
          // Deleted albums are archived by the mapper whatever their kind.
          if (album.review.length === 0 || album.deletedAt) continue;
          const raw = rawAlbums.get(album.id);
          const path = raw?.album_path;
          if (raw?.album_type !== 'folder' || typeof path !== 'string' || raw.album_filter !== folderFilter(path)) {
            // Moments, months, states and custom filters need PhotoPrism's search; the rows stay archived.
            dropped.add(album.id);
            loss('PHOTOPRISM_DYNAMIC_ALBUM_ARCHIVED', album.id);
            continue;
          }
          // Folder search: photos in this folder that are public, not archived and not hidden.
          const members = photos.filter((photo) => {
            const row = rawPhotos.get(photo.id);
            return (
              row?.photo_path === path &&
              row.photo_private === 0n &&
              row.deleted_at === null &&
              typeof row.photo_quality === 'bigint' &&
              row.photo_quality >= 0n
            );
          });
          if (members.some((photo) => photoOwners[photo.id] !== albumOwners[album.id]))
            loss('PHOTOPRISM_CROSS_OWNER_MEMBERSHIP_ARCHIVED', album.id);
          materializedAlbums[album.id] = members
            .filter((photo) => photoOwners[photo.id] === albumOwners[album.id])
            .map((photo) => photo.id);
        }
        // Destination albums hold only their owner's assets; other owners' memberships stay in the archive.
        const mapped = records.filter((record) => {
          if (record.type === 'album') return !dropped.has(record.value.id);
          if (record.type !== 'membership' || record.value.hidden || record.value.missing) return true;
          const { albumId, photoId } = record.value;
          if (photoOwners[photoId] === albumOwners[albumId]) return true;
          loss('PHOTOPRISM_CROSS_OWNER_MEMBERSHIP_ARCHIVED', albumId);
          return false;
        });
        const result = assemblePhotoprismManifest(mapped, {
          source: qualifiedSource(input.source, source.schemaFixture),
          inventory: inventory(input.source.revision),
          photoOwners,
          albumOwners: Object.fromEntries(Object.entries(albumOwners).filter(([id]) => !dropped.has(id))),
          files,
          materializedAlbums,
        });
        result.manifest.losses.push(...losses);
        return Promise.resolve(result);
      },
      close: () => source.close(),
    };
  },
};
