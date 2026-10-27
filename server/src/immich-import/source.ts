import { createHash } from 'node:crypto';
import {
  CONTENT_TABLES,
  PATH_COLUMNS,
  canonicalJson,
  digest,
  frozenSource,
  newestContainedRelease,
} from 'src/immich-import/adapters.js';
import { assertMediaPolicy, lostOriginalReason, verifyMediaFile } from 'src/immich-import/media.js';
import { readSourceStructure, verifyReadableStructure, verifySourceStructure } from 'src/immich-import/schema.js';
import {
  FrozenSource,
  ImportConfig,
  ImportDatabase,
  ImportRefused,
  ImportRow,
  quote,
} from 'src/immich-import/types.js';

export class ImmichSource {
  readonly fixture: FrozenSource;
  constructor(
    readonly db: ImportDatabase,
    readonly config: ImportConfig,
  ) {
    this.fixture = frozenSource(config.version);
  }

  async preflight(): Promise<string> {
    assertMediaPolicy(this.config.mediaRoots, this.config.media);
    if (!this.config.writersStopped || !this.config.sourceId || this.config.mediaRoots.length === 0) {
      throw new ImportRefused('OFFLINE_SOURCE_AND_MEDIA_MAP_REQUIRED');
    }
    const [role] = await this.db.query(`SELECT r.rolsuper, r.rolbypassrls,
      current_setting('transaction_read_only') AS readonly FROM pg_roles r WHERE r.rolname = current_user`);
    if (!role || role.rolsuper || role.rolbypassrls || role.readonly !== 'on') {
      throw new ImportRefused('SOURCE_ROLE_MUST_BE_READ_ONLY');
    }
    const elevated = await this.db.query(`SELECT 1 FROM pg_roles WHERE
      (rolsuper OR rolbypassrls) AND pg_has_role(current_user, oid, 'MEMBER') LIMIT 1`);
    const writable = await this.db.query(`SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND (
        has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')
        OR pg_has_role(current_user,c.relowner,'MEMBER')) LIMIT 1`);
    // An unprivileged reader sees other roles' sessions but PostgreSQL hides their backend_type.
    // Unknown session metadata cannot prove that every writer has stopped.
    const others = await this.db.query(`SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
      AND pid <> pg_backend_pid() AND (backend_type = 'client backend' OR backend_type IS NULL) LIMIT 1`);
    if (elevated.length > 0 || writable.length > 0 || others.length > 0) {
      throw new ImportRefused('SOURCE_WRITERS_OR_WRITE_AUTHORITY_PRESENT');
    }
    const [frameleaf] = await this.db.query("SELECT to_regclass('public.frameleaf_migrations') IS NOT NULL AS present");
    if (frameleaf?.present) throw new ImportRefused('SOURCE_IS_FRAMELEAF');
    const migrations = await this.db.query('SELECT name FROM public.kysely_migrations ORDER BY name');
    const names = migrations.map((row) => String(row.name));
    const structure = await readSourceStructure(this.db);
    if (this.fixture.exact && canonicalJson(names) === canonicalJson(this.fixture.migrations)) {
      verifySourceStructure(structure, this.fixture.structure);
    } else {
      // A replayed 2.x shape or a newer release: the selected frozen shape must be the newest one its ledger contains.
      const newest = newestContainedRelease(names);
      if (!newest || frozenSource(newest).migrations !== this.fixture.migrations) {
        throw new ImportRefused('UNKNOWN_SOURCE_MIGRATIONS');
      }
      verifyReadableStructure(structure, this.fixture);
    }
    const identity = await this.db.query(`SELECT current_database() AS database,
      (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database_oid,
      system_identifier::text AS system_identifier FROM pg_control_system()`);
    const hash = createHash('sha256').update(
      digest({ structure, identity, migrations, sourceId: this.config.sourceId }),
    );
    for (const table of CONTENT_TABLES) {
      if (!this.fixture.tables[table]) {
        continue;
      }
      hash.update(table);
      for await (const batch of this.batches(table)) {
        for (const { row } of batch) {
          hash.update(canonicalJson(row));
          hash.update('\n');
          if (this.config.media?.mode === 'manager-in-place') {
            for (const column of PATH_COLUMNS[table] ?? []) {
              const path = row[column];
              if (typeof path !== 'string' || !path) continue;
              hash.update(canonicalJson({ column, path }));
              try {
                await verifyMediaFile(
                  path,
                  this.config.mediaRoots,
                  undefined,
                  undefined,
                  this.config.media,
                  (sha256) => {
                    hash.update(sha256);
                  },
                );
              } catch (error) {
                const lost =
                  table === 'asset'
                    ? await lostOriginalReason(error, path, this.config.mediaRoots, this.config.media)
                    : null;
                if (lost) {
                  hash.update(`lost-original:${lost}`);
                } else if (
                  (error as NodeJS.ErrnoException).code !== 'ENOENT' ||
                  (table !== 'asset_file' && table !== 'person')
                ) {
                  throw error;
                } else {
                  hash.update('missing-regenerable-output');
                }
              }
              hash.update('\n');
            }
          }
        }
      }
    }
    return hash.digest('hex');
  }

  async *batches(table: string, after: string[] | null = null): AsyncGenerator<{ row: ImportRow; cursor: string[] }[]> {
    const shape = this.fixture.tables[table];
    if (!shape || shape.key.length === 0 || !(CONTENT_TABLES as readonly string[]).includes(table)) {
      throw new ImportRefused('UNSUPPORTED_IMPORT_TABLE');
    }
    const fields = shape.columns
      .flatMap((column) => [
        `'${column.replaceAll("'", "''")}'`,
        // Text roundtrip preserves bigint values and bytea without JS number precision loss.
        `CASE WHEN pg_typeof(${quote(column)})::text = 'bigint' THEN to_jsonb(${quote(column)}::text) ELSE to_jsonb(${quote(column)}) END`,
      ])
      .join(',');
    const keys = shape.key.map((column) => `${quote(column)}::text COLLATE "C"`);
    let cursor = after;
    while (true) {
      const where = cursor
        ? `WHERE ROW(${keys.join(',')}) > ROW(${cursor.map((_, i) => `$${i + 1}::text COLLATE "C"`).join(',')})`
        : '';
      const results = await this.db.query(
        `SELECT jsonb_build_object(${fields}) AS row,
        ARRAY[${shape.key.map((column) => `${quote(column)}::text`).join(',')}] AS cursor
        FROM ${this.fixture.views[table] ? `(${this.fixture.views[table]}) AS ${quote(table)}` : `public.${quote(table)}`}
        ${where} ORDER BY ${keys.join(',')} LIMIT 250`,
        cursor ?? [],
      );
      if (results.length === 0) {
        return;
      }
      const batch = results.map((result) => ({ row: result.row as ImportRow, cursor: result.cursor as string[] }));
      yield batch;
      cursor = batch.at(-1)!.cursor;
    }
  }
}
