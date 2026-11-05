import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, posix } from 'node:path';
import mysqlFixture from 'src/library-import/fixtures/pigallery2/3.5.2-mysql84.json' with { type: 'json' };
import fixture from 'src/library-import/fixtures/pigallery2/3.5.2-sqlite.json' with { type: 'json' };
import { type ImportedPassword, type ImportedPasswordContext } from 'src/library-import/passwords.js';
import { resolvePigallery2File } from 'src/library-import/pigallery2-files.js';
import { readPigallery2MysqlRestore } from 'src/library-import/pigallery2-mysql-source.js';
import { pigallery2Projections } from 'src/library-import/pigallery2-projections.js';
import { pigallery2SidecarCandidates } from 'src/library-import/pigallery2-sidecars.js';
import {
  type Pigallery2Row,
  type Pigallery2Table,
  openPigallery2Snapshot,
  readPigallery2Manifest,
} from 'src/library-import/pigallery2.js';
import { mysqlSourceConfig } from 'src/library-import/preparation/photoprism.js';
import { qualifiedSource } from 'src/library-import/preparation/sqlite.js';
import { type PreparationAdapter, type SourceLogin } from 'src/library-import/preparation/types.js';
import { encodeSourceArchiveRecord } from 'src/library-import/source-archive-codec.js';

const inventory = (revision: string) => ({
  complete: true as const,
  ownershipComplete: true as const,
  privacyComplete: true as const,
  writersStopped: true as const,
  revisionBefore: revision,
  revisionAfter: revision,
});

/** PiGallery2 roles: 1 limited guest, 2 guest, 3 user, 4 admin, 5 developer. */
const role = (user: Pigallery2Row) => (typeof user.role === 'bigint' ? user.role : 0n);
/** A per-user allow/block list narrows what the account can see. */
const overridden = (user: Pigallery2Row) =>
  !(user.overrideAllowBlockList === 0n || user.overrideAllowBlockList === null);

/** PiGallery2 accounts are local bcrypt accounts with no disable flag, second factor or external identity. */
export const pigallery2Login = (user: Pigallery2Row): SourceLogin => ({
  accountEnabled: true,
  passwordLoginEnabled: true,
  secondFactorRequired: false,
  externalIdentityRequired: false,
  ownedLibraryAccess: role(user) >= 3n && !overridden(user) ? 'full' : 'restricted',
  otherRestrictions: role(user) >= 1n && role(user) <= 5n ? 'none' : 'present',
});

type Loaded = {
  tested: boolean;
  rows: Map<Pigallery2Table, Pigallery2Row[]>;
  schemaFixture: { source: { version: string }; schemaSha256: string };
  password(context: ImportedPasswordContext): Promise<ImportedPassword | undefined>;
  close(): void;
};

const tables = Object.keys(pigallery2Projections) as Pigallery2Table[];

const loadSqlite = (path: string, version: string): Loaded => {
  const snapshot = openPigallery2Snapshot(path, version, { bestEffort: true });
  try {
    return {
      tested: snapshot.qualified,
      rows: new Map(tables.map((table) => [table, [...snapshot.rows(table)].flat()])),
      schemaFixture: fixture,
      password: (context) => snapshot.password(context),
      close: () => snapshot.close(),
    };
  } catch (error) {
    snapshot.close();
    throw error;
  }
};

const loadMysql = async (databaseUrl: string, version: string): Promise<Loaded> => {
  const config = mysqlSourceConfig(databaseUrl, version);
  let tested = false;
  const rows = new Map<Pigallery2Table, Pigallery2Row[]>(tables.map((table) => [table, []]));
  for await (const batch of readPigallery2MysqlRestore(config, undefined, {
    bestEffort: true,
    onQualified: (qualified) => (tested = qualified),
  }))
    rows.get(batch.table)!.push(...batch.rows);
  return {
    tested,
    rows,
    schemaFixture: mysqlFixture,
    // The restored database only answers verifier reads inside a re-admitted read session.
    async password(context) {
      let credential: ImportedPassword | undefined;
      const session = readPigallery2MysqlRestore(
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
 * PiGallery2 SQLite snapshot or restored MySQL. PiGallery2 has no per-account ownership (every account browses the one
 * images folder), so the whole library belongs to the primary administrator; the originals root is that images folder.
 */
export const adapter: PreparationAdapter = {
  kind: 'pigallery2',
  databases: ['sqlite', 'mysql'],
  async open(input) {
    const source = input.databaseUrl
      ? await loadMysql(input.databaseUrl, input.source.version)
      : loadSqlite(input.snapshotPath!, input.source.version);
    const rows = (table: Pigallery2Table) => source.rows.get(table) ?? [];
    const users = rows('user_entity').toSorted((a, b) => {
      const left = typeof a.id === 'bigint' ? a.id : 0n,
        right = typeof b.id === 'bigint' ? b.id : 0n;
      return left < right ? -1 : left > right ? 1 : 0;
    });
    const primary =
      users.find((user) => role(user) >= 4n && !overridden(user)) ??
      users.find((user) => role(user) >= 3n && !overridden(user)) ??
      users.find((user) => role(user) >= 4n) ??
      users[0];
    const primaryId = primary === undefined ? undefined : String(primary.id);
    const directories = new Map(rows('directory_entity').map((row) => [String(row.id), row]));
    const resolve = (table: 'media_entity' | 'file_entity', row: Pigallery2Row) =>
      resolvePigallery2File(table, row, directories.get(String(row.directoryId)));

    return {
      tested: source.tested,
      testedVersion: fixture.source.version,
      owners() {
        return Promise.resolve(
          users.map((user) => ({
            sourceId: String(user.id),
            name: typeof user.name === 'string' && user.name ? user.name : String(user.id),
            email: null,
            login: pigallery2Login(user),
            password: (context: ImportedPasswordContext) => source.password(context),
          })),
        );
      },
      files() {
        // Notes (`file_entity`) must be archived, so a missing one stops the import like a missing original.
        return Promise.resolve(
          [
            ...rows('media_entity').map((row) => resolve('media_entity', row)),
            ...rows('file_entity').map((row) => resolve('file_entity', row)),
          ].map(({ id, path, role }) => ({ id, path, role })),
        );
      },
      async manifest(files) {
        const originals = files.filter((file) => file.id.startsWith('media_entity:'));
        const originalPaths = new Set(originals.map((file) => file.path));
        // PiGallery2 matches sidecar names exactly, so presence is checked by name rather than by a (case-folding) stat.
        const listings = new Map<string, Set<string>>();
        const present = async (path: string) => {
          const folder = posix.dirname(path);
          let names = listings.get(folder);
          if (!names) {
            names = new Set(await readdir(join(input.originalsRoot, folder)).catch(() => [] as string[]));
            listings.set(folder, names);
          }
          return names.has(posix.basename(path));
        };
        const archivePaths = new Set(rows('file_entity').map((row) => resolve('file_entity', row).path));
        for (const file of originals)
          for (const candidate of pigallery2SidecarCandidates(file.path))
            if (!originalPaths.has(candidate) && (await present(candidate))) archivePaths.add(candidate);
        const archivedFiles = [];
        for (const path of [...archivePaths].toSorted()) {
          const content = new Uint8Array(await readFile(join(input.originalsRoot, path)));
          archivedFiles.push({
            path,
            bytes: String(content.byteLength),
            sha256: createHash('sha256').update(content).digest('hex'),
            content,
          });
        }
        const media = rows('media_entity').map((row) => String(row.id));
        const grants = Object.fromEntries(
          users.map((user) => [
            String(user.id),
            String(user.id) === primaryId || !overridden(user) ? media : ([] as string[]),
          ]),
        );
        // Saved searches need PiGallery2's query engine; their rows stay in the archive as a reported loss.
        const savedSearches = rows('album_base_entity');
        const result = readPigallery2Manifest(
          {
            version: fixture.source.version,
            schemaSha256: source.schemaFixture.schemaSha256,
            *rows(table) {
              if (table !== 'album_base_entity') yield rows(table);
            },
          },
          {
            source: qualifiedSource(input.source, source.schemaFixture),
            inventory: inventory(input.source.revision),
            owners: Object.fromEntries(media.map((id) => [id, primaryId ?? ''])),
            grants,
            materializedAlbums: {},
            files: originals,
            archivedFiles,
          },
        );
        for (const value of savedSearches) {
          const record = { table: 'album_base_entity', value };
          encodeSourceArchiveRecord(record);
          result.archive.push(record);
          result.manifest.losses.push({
            code: 'PIGALLERY2_SAVED_SEARCH_ARCHIVED',
            entityId: String(value.id),
            acknowledged: false,
          });
        }
        if (
          savedSearches.length > 0 &&
          result.manifest.losses.every((loss) => loss.code !== 'PIGALLERY2_SOURCE_METADATA_ARCHIVED')
        )
          result.manifest.losses.push({ code: 'PIGALLERY2_SOURCE_METADATA_ARCHIVED', acknowledged: false });
        return result;
      },
      close: () => source.close(),
    };
  },
};
