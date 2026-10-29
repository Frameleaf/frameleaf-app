import { createMigrationProvider, schemaDiff, schemaFromDatabase } from '@frameleaf/sql-tools';
import { Injectable } from '@nestjs/common';
import AsyncLock from 'async-lock';
import { Kysely, type RawBuilder, type Transaction, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { InjectKysely } from 'nestjs-kysely';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as semver from 'semver';
import z from 'zod';
import type { DB } from 'src/schema/index.js';
import {
  CLIP_MODEL_INFO,
  EXTENSION_NAMES,
  POSTGRES_VERSION_RANGE,
  VECTOR_INDEX_TABLES,
  VECTOR_VERSION_RANGE,
} from 'src/constants.js';
import { GenerateSql } from 'src/decorators.js';
import { DatabaseExtension, DatabaseLock, VectorIndex } from 'src/enum.js';
import { resetQueueAfterRestore } from 'src/queue/store.js';
import { publicationDatabase } from 'src/queue/transaction.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { getFrameleafSchema } from 'src/schema/frameleaf-schema.js';
import { ExtensionVersion, VectorExtension } from 'src/types.js';
import { vectorIndexQuery } from 'src/utils/database.js';
import { withDatabaseCleanup } from 'src/utils/execution-database.js';
import { resetMediaOperationsAfterRestore } from 'src/utils/media-operation-restore.js';

const CLIP_TABLES = [
  'smart_search',
  'smart_search_description',
  'asset_video_duplicate_frame',
  'video_moment_frame_embedding',
] as const;

export const getVectorExtension = (_runner?: Kysely<DB>): Promise<VectorExtension> =>
  Promise.resolve(DatabaseExtension.Vector);

/** A session advisory lock held on its own reserved connection. */
export type HeldLock = { backendPid: number; verify: () => Promise<boolean>; release: () => Promise<void> };

/**
 * Every column that stores an absolute media path, so a media-location move rebases them all. A path left on the old
 * prefix is not counted as a reference after the move, and its file can be reported as untracked and deleted.
 * Relative or external paths (library import paths, takeout entry names) are not listed.
 */
const MEDIA_PATH_COLUMNS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['asset', ['originalPath', 'libraryPath']],
  ['asset_file', ['path']],
  ['person', ['thumbnailPath']],
  ['user', ['profileImagePath']],
  ['physical_file', ['path']],
  ['physical_file_trash', ['path']],
  ['move_history', ['oldPath', 'newPath']],
  ['asset_video_duplicate_frame', ['path']],
  ['video_moment_frame', ['path']],
  ['video_edit_version', ['masterPath', 'proxyPath', 'sourcePath']],
  ['asset_develop_revision', ['masterPath', 'previewPath', 'hdrMasterPath', 'hdrPreviewPath']],
  ['asset_develop_artifact', ['path']],
  ['asset_restoration', ['previewBeforePath', 'previewAfterPath', 'resultPath', 'resultPreviewPath']],
  ['asset_health', ['originalPath']],
  ['asset_health_candidate', ['candidatePath']],
  ['asset_integrity_verification', ['originalPath']],
  ['asset_upload_resource', ['finalPath']],
  ['asset_upload_part', ['path']],
  ['identical_file_change', ['ownPath']],
  ['integrity_report', ['path']],
  ['preservation_package', ['path']],
  ['memory_export', ['path']],
  ['buddy_backup_reference', ['path']],
  ['cloud_backup_manifest_entry', ['path']],
  ['icloud_resource', ['path', 'stagingPath', 'promotedPath']],
  ['takeout_source', ['path']],
  ['takeout_file', ['path']],
  ['takeout_item', ['createPath']],
  ['media_operation_checkpoint', ['outputPath', 'subtitlePath']],
  ['studio_export_version', ['outputPath', 'subtitlePath']],
  ['studio_preview_frame', ['framePath']],
  ['studio_project_import', ['path']],
  ['studio_import_publication', ['stagedPath', 'targetPath']],
  ['studio_bundle_upload', ['path']],
  ['studio_generated_resource', ['path']],
  ['studio_hdr_intermediate', ['path']],
];
const MEDIA_PATH_ARRAY_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['asset_checksum', 'verifiedPaths'],
  ['cloud_backup_selection', 'folders'],
];
const MEDIA_PATH_JSON_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['video_edit_version', 'files'],
  ['photography_workflow', 'value'],
];

/**
 * Locks whose waiters must not give up after the pool's lock_timeout: the migration lock is held for as long as a
 * worker migrates, which on a fresh or slow database is far longer than 5 s, and every other worker must wait for it.
 */
const UNBOUNDED_WAIT_LOCKS: ReadonlySet<DatabaseLock> = new Set([DatabaseLock.Migrations]);

@Injectable()
export class DatabaseRepository {
  private readonly asyncLock = new AsyncLock();

  constructor(
    @InjectKysely() private db: Kysely<DB>,
    private logger: LoggingRepository,
    private configRepository: ConfigRepository,
  ) {
    this.db = publicationDatabase(this.db);
    this.logger.setContext(DatabaseRepository.name);
  }

  async shutdown() {
    await this.db.destroy();
  }

  getVectorExtension(): Promise<VectorExtension> {
    return getVectorExtension(this.db);
  }

  @GenerateSql({ params: [[DatabaseExtension.Vector]] })
  async getExtensionVersions(extensions: readonly DatabaseExtension[]): Promise<ExtensionVersion[]> {
    const { rows } = await sql<ExtensionVersion>`
      SELECT name, default_version as "availableVersion", installed_version as "installedVersion"
      FROM pg_available_extensions
      WHERE name in (${sql.join(extensions)})
    `.execute(this.db);
    return rows;
  }

  getExtensionVersionRange(_extension: VectorExtension): string {
    return VECTOR_VERSION_RANGE;
  }

  @GenerateSql()
  async getPostgresVersion(): Promise<string> {
    const { rows } = await sql<{ server_version: string }>`SHOW server_version`.execute(this.db);
    return rows[0].server_version;
  }

  getPostgresVersionRange(): string {
    return POSTGRES_VERSION_RANGE;
  }

  async createExtension(extension: DatabaseExtension): Promise<void> {
    await sql`CREATE EXTENSION IF NOT EXISTS ${sql.id(extension)} CASCADE`.execute(this.db);
  }

  async dropExtension(extension: DatabaseExtension): Promise<void> {
    this.logger.log(`Dropping ${EXTENSION_NAMES[extension]} extension`);
    await sql`DROP EXTENSION IF EXISTS ${sql.raw(extension)}`.execute(this.db);
  }

  async updateVectorExtension(extension: VectorExtension, targetVersion?: string): Promise<void> {
    const [{ availableVersion, installedVersion }] = await this.getExtensionVersions([extension]);
    if (!installedVersion) {
      throw new Error(`${EXTENSION_NAMES[extension]} extension is not installed`);
    }

    if (!availableVersion) {
      throw new Error(`No available version for ${EXTENSION_NAMES[extension]} extension`);
    }
    targetVersion ??= availableVersion;

    if (!semver.diff(installedVersion, targetVersion)) {
      return;
    }

    await Promise.all([
      this.db.schema.dropIndex(VectorIndex.Clip).ifExists().execute(),
      this.db.schema.dropIndex(VectorIndex.Face).ifExists().execute(),
    ]);

    await sql`ALTER EXTENSION ${sql.raw(extension)} UPDATE TO ${sql.lit(targetVersion)}`.execute(this.db);
    await Promise.all([this.reindexVectors(VectorIndex.Clip), this.reindexVectors(VectorIndex.Face)]);
  }

  async prewarm(_index: VectorIndex): Promise<void> {
    // HNSW pages are populated on demand by PostgreSQL's shared buffer cache.
  }

  async reindexVectorsIfNeeded(names: VectorIndex[]): Promise<void> {
    const { rows } = await sql<{ indexdef: string; indexname: string }>`
      SELECT indexdef, indexname FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = ANY(${names}::text[])
    `.execute(this.db);
    for (const name of names) {
      if (rows.every((row) => row.indexname !== name || !row.indexdef.toLowerCase().includes('using hnsw'))) {
        await this.reindexVectors(name);
      }
    }
  }

  private async reindexVectors(indexName: VectorIndex): Promise<void> {
    const table = VECTOR_INDEX_TABLES[indexName];
    const exists = await sql<{
      present: boolean;
    }>`SELECT to_regclass(${'public.' + table}) IS NOT NULL AS present`.execute(this.db);
    if (!exists.rows[0]?.present) return;
    await this.db.transaction().execute(async (tx) => {
      await sql`DROP INDEX IF EXISTS ${sql.id(indexName)}`.execute(tx);
      await sql.raw(vectorIndexQuery({ vectorExtension: DatabaseExtension.Vector, table, indexName })).execute(tx);
    });
  }

  getMigrations() {
    return sql<{
      name: string;
      timestamp: string;
    }>`SELECT name, timestamp FROM public.frameleaf_migrations ORDER BY name`
      .execute(this.db)
      .then(({ rows }) => rows);
  }

  async getSchemaDrift() {
    const source = getFrameleafSchema();
    const { database } = this.configRepository.getEnv();
    const target = await schemaFromDatabase({
      connection: database.config,
      overrides: false,
      excludeMigrationTables: true,
    });
    if (target.warnings.length > 0) throw new Error(`Canonical schema reader warnings: ${target.warnings.join('; ')}`);

    // Configuration resizes these stores together; only their supported vector width is runtime managed.
    const embeddings = CLIP_TABLES.map((name) =>
      target.tables.find((table) => table.name === name)?.columns.find((column) => column.name === 'embedding'),
    );
    const dimension = embeddings[0]?.length;
    if (
      dimension !== undefined &&
      Object.values(CLIP_MODEL_INFO).some(({ dimSize }) => dimSize === dimension) &&
      embeddings.every((column) => column?.type === 'vector' && column.length === dimension)
    ) {
      for (const name of CLIP_TABLES) {
        const column = source.tables
          .find((table) => table.name === name)
          ?.columns.find(({ name }) => name === 'embedding');
        if (column) column.length = dimension;
      }
    }

    const drift = schemaDiff(source, target, {
      tables: { ignoreExtra: false },
      constraints: { ignoreExtra: false },
      indexes: { ignoreExtra: false },
      triggers: { ignoreExtra: false },
      columns: { ignoreExtra: false },
      functions: { ignoreExtra: false },
      parameters: { ignoreExtra: true },
      extensions: { ignoreExtra: true },
    });

    return drift;
  }

  async getDimensionSize(table: string, column = 'embedding'): Promise<number> {
    const { rows } = await sql<{ dimsize: number }>`
      SELECT atttypmod as dimsize
      FROM pg_attribute f
        JOIN pg_class c ON c.oid = f.attrelid
      WHERE c.relkind = 'r'::char
        AND f.attnum > 0
        AND c.relname = ${table}::text
        AND f.attname = ${column}::text
    `.execute(this.db);

    const dimSize = rows[0]?.dimsize;
    if (
      !z
        .int()
        .min(1)
        .max(2 ** 16)
        .safeParse(dimSize).success
    ) {
      this.logger.warn(`Could not retrieve dimension size of column '${column}' in table '${table}', assuming 512`);
      return 512;
    }
    return dimSize;
  }

  async setDimensionSize(dimSize: number): Promise<void> {
    if (
      !z
        .int()
        .min(1)
        .max(2 ** 16)
        .safeParse(dimSize).success
    ) {
      throw new Error(`Invalid CLIP dimension size: ${dimSize}`);
    }

    const { rows: clipTables } = await sql<{ tableName: string }>`
      SELECT table_name as "tableName"
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY(${CLIP_TABLES})
    `.execute(this.db);
    const tables = clipTables.map(({ tableName }) => tableName);

    // this is done in two transactions to handle concurrent writes
    await this.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx) => {
        await this.assertLegacyClipIndex(trx);
        for (const table of tables) {
          const constraint = `${table}_dim_size_constraint`;
          await sql`delete from ${sql.table(table)}`.execute(trx);
          await sql`alter table ${sql.table(table)} drop constraint if exists ${sql.raw(constraint)}`.execute(trx);
          await sql`alter table ${sql.table(table)} add constraint ${sql.raw(constraint)} check (array_length(embedding::real[], 1) = ${sql.lit(dimSize)})`.execute(
            trx,
          );
        }
      });

    const vectorExtension = await this.getVectorExtension();
    await this.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx) => {
        await this.assertLegacyClipIndex(trx);
        if (tables.includes('smart_search')) {
          await sql`drop index if exists clip_index`.execute(trx);
        }
        if (tables.includes('smart_search_description')) {
          await sql`drop index if exists clip_description_index`.execute(trx);
        }
        for (const table of tables) {
          const constraint = `${table}_dim_size_constraint`;
          await trx.schema
            .alterTable(table)
            .alterColumn('embedding', (col) => col.setDataType(sql.raw(`vector(${dimSize})`)))
            .execute();
          await sql`alter table ${sql.table(table)} drop constraint if exists ${sql.raw(constraint)}`.execute(trx);
        }
        if (tables.includes('smart_search')) {
          await sql
            .raw(vectorIndexQuery({ vectorExtension, table: 'smart_search', indexName: VectorIndex.Clip }))
            .execute(trx);
        }
        if (tables.includes('smart_search_description')) {
          await sql
            .raw(
              vectorIndexQuery({
                vectorExtension,
                table: 'smart_search_description',
                indexName: 'clip_description_index',
              }),
            )
            .execute(trx);
        }
      });

    for (const table of tables) {
      await sql`vacuum analyze ${sql.table(table)}`.execute(this.db);
    }
  }

  async deleteAllSearchEmbeddings(): Promise<void> {
    await this.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx) => {
        await this.assertLegacyClipIndex(trx);
        await sql`truncate ${sql.table('smart_search')}, ${sql.table('smart_search_description')}, ${sql.table('asset_video_duplicate_frame')}, ${sql.table('video_moment_frame_embedding')}`.execute(
          trx,
        );
      });
  }

  private async assertLegacyClipIndex(tx: Transaction<DB>): Promise<void> {
    // Serialize destructive legacy resets with desktop index admission.
    await sql`SELECT pg_advisory_xact_lock(912741, 1)`.execute(tx);
    if (await tx.selectFrom('desktop_clip_index').select('scope').where('scope', '=', 'clip').executeTakeFirst())
      throw new Error('desktop_clip_index_admitted');
  }

  async vacuum({ analyze = false, table }: { analyze?: boolean; table?: keyof DB } = {}): Promise<void> {
    try {
      await sql`VACUUM ${sql.raw(analyze ? 'ANALYZE' : '')} ${sql.raw(table ?? '')}`.execute(this.db);
    } catch (error) {
      this.logger.warn(`Failed to vacuum ${table || 'database'}: ${error}`);
      this.logger.warn('If using Docker, consider increasing shm_size for the database.');
    }
  }

  reindex(table: keyof DB, { concurrently = false } = {}): Promise<unknown> {
    return sql`REINDEX TABLE ${sql.raw(concurrently ? 'CONCURRENTLY' : '')} ${sql.raw(table)}`.execute(this.db);
  }

  /** Reject source databases before performing any DDL. Import uses a distinct read-only connection. */
  async assertFrameleafDatabase(): Promise<void> {
    const result = await sql<{ ownLedger: boolean; foreignTables: boolean }>`
      SELECT to_regclass('public.frameleaf_migrations') IS NOT NULL AS "ownLedger",
        EXISTS (
          SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
            AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')
        ) AS "foreignTables"
    `.execute(this.db);
    if (result.rows[0]?.foreignTables && !result.rows[0]?.ownLedger) {
      throw new Error(
        'Frameleaf requires an empty PostgreSQL 19 database. Use import-immich with a separate read-only source; existing Immich or legacy Frameleaf databases cannot be adopted.',
      );
    }
  }

  async assertImportActivated(): Promise<void> {
    const { rows } = await sql<{ status: string }>`SELECT status FROM public.frameleaf_immich_import`.execute(this.db);
    if (rows[0] && rows[0].status !== 'activated') {
      throw new Error('DESTINATION_IMPORT_NOT_ACTIVATED: finish import-immich verify before starting Frameleaf.');
    }
  }

  async resetTransientExecutionState(): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      await resetQueueAfterRestore(tx);
      await resetMediaOperationsAfterRestore(tx);
      await sql`TRUNCATE public.frameleaf_rate_limit, public.frameleaf_upload_lease, public.socket_io_attachments, public.frameleaf_websocket_worker`.execute(
        tx,
      );
    });
  }

  async runMigrations(): Promise<void> {
    await this.assertFrameleafDatabase();
    const migrator = new Migrator({
      db: this.db,
      migrationTableName: 'frameleaf_migrations',
      migrationLockTableName: 'frameleaf_migrations_lock',
      provider: createMigrationProvider(fileURLToPath(new URL('../schema/migrations/', import.meta.url)), {
        import: (path) => import(pathToFileURL(path).href),
      }),
    });
    const { error, results } = await migrator.migrateToLatest();
    if (error) throw error;
    for (const result of results ?? [])
      this.logger.log(`Frameleaf migration ${result.migrationName}: ${result.status}`);
  }

  async migrateFilePaths(sourceFolder: string, targetFolder: string): Promise<void> {
    const isWindows = (value: string) => /^[a-z]:/i.test(value) || value.startsWith('\\\\');
    const windowsSource = isWindows(sourceFolder);
    if (sourceFolder.endsWith('/') || (windowsSource && sourceFolder.endsWith('\\'))) {
      sourceFolder = sourceFolder.slice(0, -1);
    }
    if (targetFolder.endsWith('/') || (isWindows(targetFolder) && targetFolder.endsWith('\\'))) {
      targetFolder = targetFolder.slice(0, -1);
    }

    const replacement = (value: RawBuilder<unknown>) =>
      sql<string>`${targetFolder} || substring(${value} from char_length(${sourceFolder}) + 1)`;
    const separators = ['/', ...(windowsSource ? ['\\'] : [])];
    const matches = (value: RawBuilder<unknown>) => {
      if (!sourceFolder) {
        return sql<boolean>`starts_with(${value}, ${'/'})`;
      }
      return sql<boolean>`(${value} = ${sourceFolder} OR ${sql.join(
        separators.map((separator) => sql<boolean>`starts_with(${value}, ${sourceFolder + separator})`),
        sql` OR `,
      )})`;
    };
    // JSON documents hold paths as string values: rewrite each string that starts with the old folder.
    // ponytail: a text-level rewrite, so an escaped quote right before such a path inside a longer string is rewritten too.
    const jsonString = (folder: string, separator: string) => JSON.stringify(folder + separator).slice(0, -1);

    await this.db.transaction().execute(async (tx) => {
      for (const [table, columns] of MEDIA_PATH_COLUMNS) {
        for (const column of columns) {
          const value = sql.ref(column);
          await sql`UPDATE ${sql.table(table)} SET ${value} = ${replacement(value)} WHERE ${matches(value)}`.execute(
            tx,
          );
        }
      }

      for (const [table, column] of MEDIA_PATH_ARRAY_COLUMNS) {
        const value = sql.ref(column);
        const element = sql.ref('element');
        await sql`UPDATE ${sql.table(table)}
          SET ${value} = ARRAY(
            SELECT CASE WHEN ${matches(element)} THEN ${replacement(element)} ELSE element END
            FROM unnest(${value}) WITH ORDINALITY AS item(element, position) ORDER BY position
          )
          WHERE EXISTS (SELECT 1 FROM unnest(${value}) AS item(element) WHERE ${matches(element)})`.execute(tx);
      }

      for (const [table, column] of MEDIA_PATH_JSON_COLUMNS) {
        for (const separator of separators) {
          const value = sql.ref(column);
          const prefix = jsonString(sourceFolder, separator);
          await sql`UPDATE ${sql.table(table)}
            SET ${value} = replace(${value}::text, ${prefix}, ${jsonString(targetFolder, separator)})::jsonb
            WHERE strpos(${value}::text, ${prefix}) > 0`.execute(tx);
        }
      }
    });
  }

  /** Takes `lock`, waiting without the pool's lock_timeout for the locks in `UNBOUNDED_WAIT_LOCKS`. */
  async withLock<R>(lock: DatabaseLock, callback: () => Promise<R>): Promise<R> {
    return this.asyncLock.acquire(DatabaseLock[lock], () =>
      this.db.connection().execute(async (connection) => {
        try {
          await this.acquireLock(lock, connection);
          return await callback();
        } finally {
          await this.releaseLock(lock, connection);
        }
      }),
    );
  }

  /**
   * Whether the canonical Frameleaf schema has been installed. A worker that does not migrate (the edge worker) asks this
   * while holding `DatabaseLock.Migrations`, so a boot that is still migrating is waited for.
   */
  async isSchemaReady(): Promise<boolean> {
    const { rows } = await sql<{ ready: boolean }>`
      SELECT to_regclass('public.system_metadata') IS NOT NULL
        AND to_regclass('public.frameleaf_migrations') IS NOT NULL AS ready
    `.execute(this.db);
    return !!rows[0]?.ready;
  }

  tryLock(lock: DatabaseLock): Promise<boolean> {
    return this.db.connection().execute(async (connection) => this.acquireTryLock(lock, connection));
  }

  /**
   * FL-165: take a session advisory lock on a connection reserved for as long as it is held, so the
   * pool can never hand that session to other work or close it unnoticed. Resolves null when another
   * session holds the lock. `verify` asks, on the same connection, whether this session still holds
   * it (false when the connection was lost); `release` unlocks and returns the connection.
   */
  async holdLock(lock: DatabaseLock): Promise<HeldLock | null> {
    let settle!: (held: HeldLock | null) => void;
    const result = new Promise<HeldLock | null>((resolve) => (settle = resolve));
    let finish!: () => void;
    const done = new Promise<void>((resolve) => (finish = resolve));
    const reserved = this.db
      .connection()
      .execute(async (connection) => {
        try {
          if (!(await this.acquireTryLock(lock, connection))) {
            settle(null);
            return;
          }
          let lost = false;
          const { rows } = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(connection);
          settle({
            backendPid: rows[0].pid,
            verify: async () => {
              if (lost) {
                return false;
              }
              try {
                const { rows } = await sql<{ held: boolean }>`
                  SELECT EXISTS (
                    SELECT 1 FROM pg_locks
                    WHERE locktype = 'advisory' AND objid = ${lock} AND pid = pg_backend_pid() AND granted
                  ) AS held`.execute(connection);
                lost = !rows[0]?.held;
              } catch {
                lost = true;
              }
              if (lost) {
                finish();
              }
              return !lost;
            },
            release: async () => {
              finish();
              await reserved;
            },
          });
          await done;
        } finally {
          // Never return a still-locked session to the pool, including failed initial PID lookup.
          await this.releaseLock(lock, connection).catch(() => {});
        }
      })
      .catch((error: unknown) => {
        this.logger.warn(`A held database lock ended: ${error}`);
        settle(null);
      });
    return result;
  }

  isBusy(lock: DatabaseLock): boolean {
    return this.asyncLock.isBusy(DatabaseLock[lock]);
  }

  async wait(lock: DatabaseLock): Promise<void> {
    await this.asyncLock.acquire(DatabaseLock[lock], () => {});
  }

  /**
   * Per-asset advisory lock. Serializes concurrent read-modify-write of
   * `asset_metadata` blobs so two jobs (e.g. background NSFW detection and a
   * user review action) can't clobber each other. Uses a single dedicated lock
   * class (the negative number namespace) and the lower 32 bits of the UUID's
   * hashtext for the key, so it doesn't collide with the integer DatabaseLock
   * enum values above.
   *
   * The lock is acquired via `pg_advisory_xact_lock` inside a transaction so
   * it auto-releases on commit/rollback. The transaction object is passed to
   * the callback — callers must do their lock-protected reads/writes through
   * it (otherwise those queries run on different pooled connections and
   * can deadlock once N parallel callers exhaust the pool with held locks).
   * Side effects that don't need to be atomic with the metadata RMW (tag
   * application, job queueing, ML inference) should be performed outside the
   * callback to keep the lock window — and therefore the held connection —
   * as short as possible.
   */
  async withAssetMetadataLock<R>(assetId: string, callback: (kysely: Kysely<DB>) => Promise<R>): Promise<R> {
    return this.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(-1, hashtext(${assetId})::int)`.execute(trx);
      return callback(trx);
    });
  }

  /**
   * FL-34: `withAssetMetadataLock` for several assets, such as every member of a stack or live photo
   * that one review writes. The per-asset locks are taken one at a time in id order, so two such
   * callers cannot deadlock, and before any row lock the callback takes, the order every metadata
   * writer follows.
   */
  async withAssetMetadataLocks<R>(assetIds: string[], callback: (kysely: Kysely<DB>) => Promise<R>): Promise<R> {
    return this.db.transaction().execute(async (trx) => {
      for (const assetId of [...new Set(assetIds)].toSorted()) {
        await sql`SELECT pg_advisory_xact_lock(-1, hashtext(${assetId})::int)`.execute(trx);
      }
      return callback(trx);
    });
  }

  /**
   * FL-195: one sidecar write per asset at a time, across workers, in its own lock class (-3). Two
   * writes of the same sidecar (three quick tag edits queue three) collide in exiftool's temporary
   * file, and the loser can leave no sidecar behind. Like `withAssetMetadataLock`, callers must run
   * their queries through the transaction passed in: a holder that also needed a second pooled
   * connection could deadlock once the sidecar queue's concurrency reached the pool size.
   */
  async withAssetSidecarLock<R>(assetId: string, callback: (kysely: Kysely<DB>) => Promise<R>): Promise<R> {
    return this.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(-3, hashtext(${assetId})::int)`.execute(trx);
      return callback(trx);
    });
  }

  /**
   * FL-67: per-account lock around a read-check-write of the stored preferences, so a revision
   * check and the write it guards are atomic. Two saves from different tabs can no longer both pass
   * the check against the same revision and overwrite each other. Same shape as
   * `withAssetMetadataLock`, in its own lock class (-2); callers read and write through the
   * transaction passed to the callback.
   */
  async withUserPreferencesLock<R>(userId: string, callback: (kysely: Transaction<DB>) => Promise<R>): Promise<R> {
    return this.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(-2, hashtext(${userId})::int)`.execute(trx);
      return callback(trx);
    });
  }

  private async acquireLock(lock: DatabaseLock, connection: Kysely<DB>): Promise<void> {
    if (!UNBOUNDED_WAIT_LOCKS.has(lock)) {
      await sql`SELECT pg_advisory_lock(${lock})`.execute(connection);
      return;
    }
    // FL-646: the pool's session lock_timeout (5 s) also bounds advisory-lock waits. On a fresh or slow database the
    // first worker holds the migration lock for longer than that, and the other worker's wait was cancelled with
    // "canceling statement due to lock timeout" (55P03). Wait on this reserved session until the holder finishes (or its
    // session ends), then restore the pool default before the session does anything else.
    await sql`SET lock_timeout = 0`.execute(connection);
    try {
      await sql`SELECT pg_advisory_lock(${lock})`.execute(connection);
    } finally {
      await sql`RESET lock_timeout`.execute(connection);
    }
  }

  private async acquireTryLock(lock: DatabaseLock, connection: Kysely<DB>): Promise<boolean> {
    const { rows } = await sql<{
      pg_try_advisory_lock: boolean;
    }>`SELECT pg_try_advisory_lock(${lock})`.execute(connection);
    return rows[0].pg_try_advisory_lock;
  }

  private async releaseLock(lock: DatabaseLock, connection: Kysely<DB>): Promise<void> {
    await withDatabaseCleanup(() => sql`SELECT pg_advisory_unlock(${lock})`.execute(connection));
  }
}
