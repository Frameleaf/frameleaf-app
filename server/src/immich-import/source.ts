import { createHash } from 'node:crypto';
import { canonicalJson, CONTENT_TABLES, digest, frozenSource } from './adapters.js';
import { FrozenSource, ImportConfig, ImportDatabase, ImportRefused, ImportRow, quote } from './types.js';

export class ImmichSource {
  readonly fixture: FrozenSource;
  constructor(
    readonly db: ImportDatabase,
    readonly config: ImportConfig,
  ) {
    this.fixture = frozenSource(config.version);
  }

  async preflight(): Promise<string> {
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
    const others = await this.db.query(`SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
      AND pid <> pg_backend_pid() AND backend_type = 'client backend' LIMIT 1`);
    if (elevated.length || writable.length || others.length) {
      throw new ImportRefused('SOURCE_WRITERS_OR_WRITE_AUTHORITY_PRESENT');
    }
    const migrations = await this.db.query('SELECT name FROM public.kysely_migrations ORDER BY name');
    if (canonicalJson(migrations.map((row) => row.name)) !== canonicalJson(this.fixture.migrations)) {
      throw new ImportRefused('UNKNOWN_SOURCE_MIGRATIONS');
    }
    const columns = await this.db.query(`SELECT c.relname AS table_name, a.attname AS column_name,
      format_type(a.atttypid,a.atttypmod) AS type, a.attnotnull AS not_null
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
      WHERE n.nspname='public' AND c.relkind IN ('r','p') ORDER BY c.relname,a.attname`);
    const actual: Record<string, string[]> = {};
    const bookkeeping = new Set(['migrations', 'kysely_migrations', 'kysely_migrations_lock']);
    for (const column of columns) {
      const table = String(column.table_name);
      if (!bookkeeping.has(table)) {
        (actual[table] ??= []).push(String(column.column_name));
      }
    }
    for (const column of columns) {
      const expectedType = this.fixture.tables[String(column.table_name)]?.types[String(column.column_name)];
      const actualType = String(column.type).replace(/^public\./u, '');
      if (
        expectedType &&
        (expectedType === 'vector'
          ? !/^(?:vectors\.)?vector(?:\(\d+\))?$/u.test(actualType)
          : expectedType !== actualType)
      ) {
        throw new ImportRefused('UNKNOWN_SOURCE_COLUMN_TYPE');
      }
    }
    const expected = Object.fromEntries(
      Object.entries(this.fixture.tables).map(([table, shape]) => [table, [...shape.columns].sort()]),
    );
    if (canonicalJson(actual) !== canonicalJson(expected)) {
      throw new ImportRefused('UNKNOWN_SOURCE_SCHEMA');
    }
    // Types, nullability, constraints and source instance identity are bound to every restart, too.
    const constraints = await this.db.query(`SELECT c.relname AS table_name, p.conname,
      pg_get_constraintdef(p.oid) AS definition FROM pg_constraint p JOIN pg_class c ON c.oid=p.conrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY c.relname,p.conname`);
    const identity = await this.db.query(`SELECT current_database() AS database,
      (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database_oid,
      system_identifier::text AS system_identifier FROM pg_control_system()`);
    const hash = createHash('sha256').update(
      digest({ columns, constraints, identity, migrations, sourceId: this.config.sourceId }),
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
        }
      }
    }
    return hash.digest('hex');
  }

  async *batches(table: string, after: string[] | null = null): AsyncGenerator<{ row: ImportRow; cursor: string[] }[]> {
    const shape = this.fixture.tables[table];
    if (!shape || !shape.key.length || !(CONTENT_TABLES as readonly string[]).includes(table)) {
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
        FROM public.${quote(table)} ${where} ORDER BY ${keys.join(',')} LIMIT 250`,
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
