import { type RowDataPacket, createConnection } from 'mysql2/promise';
import { Readable } from 'node:stream';
import fixture from 'src/library-import/fixtures/piwigo/16.4.0-mariadb.json' with { type: 'json' };
import { type ImportedPassword, type ImportedPasswordContext } from 'src/library-import/passwords.js';
import { resolvePiwigoOriginals } from 'src/library-import/piwigo-files.js';
import {
  type PiwigoRow,
  type PiwigoTable,
  readPiwigoManifest,
  readPiwigoRestore,
} from 'src/library-import/piwigo-source.js';
import { qualifiedSource } from 'src/library-import/preparation/sqlite.js';
import {
  type PreparationAdapter,
  type PreparationFile,
  type SourceLogin,
  unrestrictedLogin,
} from 'src/library-import/preparation/types.js';

type Batch = { table: PiwigoTable; rows: PiwigoRow[] };
type RestoreConfig = Parameters<typeof readPiwigoRestore>[0];

const refuse = (code: string): never => {
  throw new Error(`Piwigo source refused: ${code}`);
};
const prefixPattern = /^(?!\d)[a-zA-Z0-9_$]{0,20}$/u;
const statusRank: Record<string, number> = { webmaster: 0, admin: 1, normal: 2, generic: 3 };

/** `mysql://user:password@127.0.0.1:3306/database[?prefix=piwigo_]`: the isolated restore is loopback-only, no TLS. */
export const parsePiwigoDatabaseUrl = (databaseUrl: string | undefined) => {
  let url: URL;
  try {
    url = new URL(databaseUrl ?? '');
  } catch {
    return refuse('PIWIGO_DATABASE_URL_INVALID');
  }
  const host = url.hostname.replace(/^\[(.*)\]$/u, '$1');
  if (!['mysql:', 'mariadb:'].includes(url.protocol) || !url.pathname.slice(1))
    return refuse('PIWIGO_DATABASE_URL_INVALID');
  if (!['127.0.0.1', '::1'].includes(host)) return refuse('PIWIGO_DATABASE_URL_NOT_LOOPBACK');
  const prefix = url.searchParams.get('prefix');
  if (prefix !== null && !prefixPattern.test(prefix)) return refuse('PIWIGO_DATABASE_URL_INVALID');
  return {
    host,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)),
    prefix: prefix ?? undefined,
  };
};

/** Piwigo's `$prefixeTable` is chosen at install time; an explicit prefix or exactly one table family must carry it. */
const detectPrefix = async (config: Omit<RestoreConfig, 'prefix' | 'version'>, explicit: string | undefined) => {
  const connection = await createConnection({ ...config, connectTimeout: 5000, multipleStatements: false }).catch(() =>
    refuse('PIWIGO_SOURCE_UNAVAILABLE'),
  );
  try {
    const [rows] = await connection
      .query<RowDataPacket[]>({
        sql: 'SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()',
        timeout: 5000,
      })
      .catch(() => refuse('PIWIGO_SOURCE_UNAVAILABLE'));
    const names = new Set(rows.map((row) => String(row.name)));
    const candidates = [...names]
      .filter((name) => name.endsWith('user_infos'))
      .map((name) => name.slice(0, -'user_infos'.length))
      .filter(
        (prefix) => prefixPattern.test(prefix) && names.has(prefix + 'images') && names.has(prefix + 'categories'),
      );
    if (explicit !== undefined) return candidates.includes(explicit) ? explicit : refuse('PIWIGO_TABLE_PREFIX_UNKNOWN');
    return candidates.length === 1 ? candidates[0] : refuse('PIWIGO_TABLE_PREFIX_AMBIGUOUS');
  } finally {
    connection.destroy();
  }
};

const level = (value: unknown) => (typeof value === 'bigint' ? value : -1n);

/**
 * Piwigo has no per-photo or per-album owner the manifest can take as-is: photos go to their uploader (`added_by`),
 * falling back to the highest-ranked account that may see them; albums go to the highest-ranked account allowed to
 * see the album. Rules mirror readPiwigoManifest's access checks so the reviewed owners are always admissible.
 */
export const derivePiwigoReview = (tables: Map<PiwigoTable, PiwigoRow[]>) => {
  const rows = (table: PiwigoTable) => tables.get(table) ?? [];
  const infos = new Map(rows('user_infos').map((row) => [String(row.user_id), row]));
  const accounts = rows('users')
    .map((user) => ({ id: String(user.id), info: infos.get(String(user.id)) }))
    .filter((user) => user.info && user.info.status !== 'guest')
    .sort(
      (a, b) =>
        (statusRank[String(a.info!.status)] ?? 9) - (statusRank[String(b.info!.status)] ?? 9) ||
        (BigInt(a.id) < BigInt(b.id) ? -1 : 1),
    )
    .map((user) => user.id);
  const categories = new Map(rows('categories').map((row) => [String(row.id), row]));
  const groupsOf = Map.groupBy(rows('user_group'), (row) => String(row.user_id));
  const groupGrants = Map.groupBy(rows('group_access'), (row) => String(row.group_id));
  const directGrants = Map.groupBy(rows('user_access'), (row) => String(row.user_id));
  const grants = new Map(
    accounts.map((user) => [
      user,
      new Set([
        ...(directGrants.get(user) ?? []).map((row) => String(row.cat_id)),
        ...(groupsOf.get(user) ?? []).flatMap((group) =>
          (groupGrants.get(String(group.group_id)) ?? []).map((row) => String(row.cat_id)),
        ),
      ]),
    ]),
  );
  const allowed = (user: string, categoryId: string) => {
    const info = infos.get(user),
      category = categories.get(categoryId);
    if (!info || !category || !grants.has(user) || info.enabled_high !== 'true') return false;
    if (category.visible === 'false' && !['admin', 'webmaster'].includes(String(info.status))) return false;
    return category.status === 'public' || grants.get(user)!.has(categoryId);
  };
  const images = new Map(rows('images').map((row) => [String(row.id), row]));
  const memberships = Map.groupBy(rows('image_category'), (row) => String(row.image_id));
  const photoOwners: Record<string, string> = {};
  for (const [imageId, image] of images) {
    const uploader = String(image.added_by);
    const candidates = [...new Set([...(grants.has(uploader) ? [uploader] : []), ...accounts])];
    photoOwners[imageId] =
      candidates.find(
        (user) =>
          level(infos.get(user)?.level) >= level(image.level) &&
          (memberships.get(imageId) ?? []).some((row) => allowed(user, String(row.category_id))),
      ) ??
      // No admissible owner: the manifest refuses with PIWIGO_OWNER_REVIEW_REQUIRED.
      candidates[0] ??
      '';
  }
  const albumOwners: Record<string, string> = {};
  for (const categoryId of categories.keys())
    albumOwners[categoryId] = accounts.find((user) => allowed(user, categoryId)) ?? accounts[0] ?? '';
  // Relationships to deleted photos are archived and reported (PIWIGO_MISSING_IMAGE_RELATIONSHIPS_ARCHIVED).
  const missing = new Set<string>();
  for (const table of ['image_category', 'favorites', 'image_tag', 'image_format'] as const)
    for (const row of rows(table)) if (!images.has(String(row.image_id))) missing.add(String(row.image_id));
  for (const row of rows('rate')) if (!images.has(String(row.element_id))) missing.add(String(row.element_id));
  for (const category of categories.values())
    if (category.representative_picture_id !== null && !images.has(String(category.representative_picture_id)))
      missing.add(String(category.representative_picture_id));
  return {
    photoOwners,
    albumOwners,
    // ponytail: Piwigo stores capture times as naive wall-clock values and keeps no zone; UTC until the Manager asks.
    reviewedCaptureOffsets: Object.fromEntries(images.keys().map((imageId) => [imageId, 0])),
    reviewedMissingImageIds: [...missing],
  };
};

export const piwigoFiles = (tables: Map<PiwigoTable, PiwigoRow[]>): PreparationFile[] => {
  const formats = Map.groupBy(tables.get('image_format') ?? [], (row) => String(row.image_id));
  return (tables.get('images') ?? []).flatMap((image) =>
    resolvePiwigoOriginals(image, formats.get(String(image.id)) ?? []).map((file) => ({
      id: `image:${file.imageId}:${file.formatId === null ? 'original' : `format:${file.formatId}`}`,
      path: file.path,
      role: file.role,
    })),
  );
};

/** Piwigo has no account disable or core second factor; generic accounts are shared logins, never personal ones. */
const piwigoLogin = (info: PiwigoRow): SourceLogin => ({
  ...unrestrictedLogin,
  ownedLibraryAccess: info.enabled_high === 'true' ? 'full' : 'restricted',
  otherRestrictions: info.status === 'generic' ? 'present' : 'none',
});

/** Piwigo MariaDB/MySQL restore; the originals mount is the Piwigo web root (`upload/`, `galleries/`). */
export const adapter: PreparationAdapter = {
  kind: 'piwigo',
  databases: ['mysql'],
  async open(input) {
    const { prefix, ...connection } = parsePiwigoDatabaseUrl(input.databaseUrl);
    const config: RestoreConfig = {
      ...connection,
      prefix: await detectPrefix(connection, prefix),
      version: fixture.source.version,
    };
    // ponytail: readPiwigoRestore is one pass while preparation needs files and owners before the manifest, so every
    // projected row is buffered (roughly 1-2 KB per photo with its relationships, ~1-2 GB per million photos, doubled
    // while readPiwigoManifest builds its archive). Re-read the restore per phase if libraries outgrow that.
    const drain = async (bestEffort: boolean) => {
      const batches: Batch[] = [];
      for await (const batch of readPiwigoRestore(config, undefined, { bestEffort })) batches.push(batch);
      return batches;
    };
    let tested = true;
    let batches: Batch[];
    try {
      batches = await drain(false);
    } catch {
      // Best effort keeps every integrity check, so a genuine failure is reported again by the second read.
      tested = false;
      batches = await drain(true);
    }
    const tables = new Map<PiwigoTable, PiwigoRow[]>();
    for (const batch of batches) {
      const rows = tables.get(batch.table) ?? [];
      rows.push(...batch.rows);
      tables.set(batch.table, rows);
    }
    const infos = new Map((tables.get('user_infos') ?? []).map((row) => [String(row.user_id), row]));
    // Verifiers are only readable inside the reader's locked callback, so each claim re-opens the restore.
    const password = async (context: ImportedPasswordContext) => {
      let credential: ImportedPassword | undefined;
      const stream = readPiwigoRestore(
        config,
        async (read) => {
          credential = await read(context);
        },
        { bestEffort: !tested },
      );
      try {
        await stream.next();
      } finally {
        await stream.return(undefined);
      }
      return credential;
    };
    return {
      tested,
      testedVersion: fixture.source.version,
      owners() {
        const owners = (tables.get('users') ?? []).flatMap((user) => {
          const info = infos.get(String(user.id));
          if (!info || info.status === 'guest') return [];
          return [
            {
              sourceId: String(user.id),
              name: String(user.username ?? user.id),
              email: typeof user.mail_address === 'string' && user.mail_address ? user.mail_address : null,
              login: piwigoLogin(info),
              password,
            },
          ];
        });
        return Promise.resolve(owners);
      },
      files() {
        return Promise.resolve(piwigoFiles(tables));
      },
      async manifest(files) {
        return readPiwigoManifest(Readable.from(batches) as AsyncIterable<Batch>, {
          source: qualifiedSource(input.source, fixture),
          inventory: {
            complete: true,
            ownershipComplete: true,
            privacyComplete: true,
            writersStopped: true,
            revisionBefore: input.source.revision,
            revisionAfter: input.source.revision,
          },
          ...derivePiwigoReview(tables),
          files,
        });
      },
      close() {
        batches = [];
        tables.clear();
      },
    };
  },
};
