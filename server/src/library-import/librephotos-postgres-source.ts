import postgres from 'postgres';
import fixture from 'src/library-import/fixtures/librephotos/1.5.1-postgres18.json' with { type: 'json' };
import { createLibrephotosPostgresDecoder } from 'src/library-import/librephotos-postgres.js';
import { librephotosProjections } from 'src/library-import/librephotos-projections.js';
import { LibrephotosRow, LibrephotosTable } from 'src/library-import/librephotos.js';
import {
  ImportedPassword,
  ImportedPasswordContext,
  captureImportedPasswordContext,
} from 'src/library-import/passwords.js';
import { readPostgresSourceSchema } from 'src/library-import/postgres-schema.js';

class LibrephotosSnapshotError extends Error {
  constructor(readonly code: string) {
    super(`LibrePhotos source refused: ${code}`);
  }
}

/**
 * The caller fences source services and restarts; the exclusive reservation cannot silently switch snapshots.
 * `bestEffort` (owner decision FL-1149) skips the version, engine, catalog fingerprint and migration pins; the
 * read-only role, exclusive client, row decoding and inventory-count checks stay.
 */
export const openLibrephotosPostgresSnapshot = async (
  url: string,
  version: string,
  writersStopped: boolean,
  { bestEffort = false }: { bestEffort?: boolean } = {},
) => {
  if (!bestEffort && version !== fixture.source.version)
    throw new LibrephotosSnapshotError('LIBREPHOTOS_VERSION_UNQUALIFIED');
  if (!writersStopped) throw new LibrephotosSnapshotError('LIBREPHOTOS_WRITERS_NOT_FENCED');
  let pool: postgres.Sql | undefined;
  let connection: postgres.ReservedSql | undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    // Ending the private read-only connection rolls back without queuing SQL behind a stalled query.
    try {
      try {
        connection?.release();
      } finally {
        await pool?.end({ timeout: 5 });
      }
    } catch {
      throw new LibrephotosSnapshotError('LIBREPHOTOS_POSTGRES_CLOSE_FAILED');
    }
  };
  let decoder: ReturnType<typeof createLibrephotosPostgresDecoder>;
  let qualified = !bestEffort;
  try {
    pool = postgres(url, {
      max: 1,
      connect_timeout: 10,
      onnotice: () => {},
      connection: { application_name: 'frameleaf-import-library', default_transaction_read_only: true },
    });
    connection = await pool.reserve();
    await connection.unsafe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await connection.unsafe(
      "SELECT pg_catalog.set_config('search_path','pg_catalog,public',true), pg_catalog.set_config('timezone','UTC',true), pg_catalog.set_config('DateStyle','ISO,YMD',true)",
    );
    const [role] = await connection.unsafe(`SELECT r.rolsuper,r.rolbypassrls,
      pg_catalog.current_setting('transaction_read_only') AS readonly,
      EXISTS (SELECT 1 FROM pg_catalog.pg_roles elevated
        WHERE (elevated.rolsuper OR elevated.rolbypassrls)
        AND pg_catalog.pg_has_role(current_user,elevated.oid,'MEMBER')) AS elevated,
      EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind IN ('r','p') AND (
          pg_catalog.has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')
          OR pg_catalog.has_any_column_privilege(current_user,c.oid,'INSERT,UPDATE')
          OR pg_catalog.pg_has_role(current_user,c.relowner,'MEMBER')
          OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles writer
            WHERE pg_catalog.pg_has_role(current_user,writer.oid,'${bestEffort ? 'MEMBER' : 'SET'}')
            AND (pg_catalog.has_table_privilege(writer.oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')
              OR pg_catalog.has_any_column_privilege(writer.oid,c.oid,'INSERT,UPDATE'))))) AS writable,
      EXISTS (SELECT 1 FROM pg_catalog.pg_stat_activity WHERE datname=current_database()
        AND pid<>pg_backend_pid() AND (backend_type='client backend' OR backend_type IS NULL)) AS other_clients
      FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`);
    if (
      !role ||
      role.readonly !== 'on' ||
      [role.rolsuper, role.rolbypassrls, role.elevated, role.writable, role.other_clients].some(
        (value) => value !== false,
      )
    ) {
      throw new LibrephotosSnapshotError('LIBREPHOTOS_SOURCE_NOT_READ_ONLY');
    }
    const [engine] = await connection.unsafe("SELECT current_setting('server_version') AS version");
    const reserved = connection;
    // Every pin, in order; best effort records the first failure as untested instead of refusing.
    const qualify = async () => {
      if (version !== fixture.source.version) throw new LibrephotosSnapshotError('LIBREPHOTOS_VERSION_UNQUALIFIED');
      if (engine?.version !== fixture.source.database.version)
        throw new LibrephotosSnapshotError('LIBREPHOTOS_POSTGRES_ENGINE_UNQUALIFIED');
      const schema = await readPostgresSourceSchema(async (statement) => [...(await reserved.unsafe(statement))]);
      const strict = createLibrephotosPostgresDecoder(schema, version, engine.version);
      const required = new Set(fixture.migrations.map(({ app, name }) => JSON.stringify([app, name])));
      for (const row of await reserved.unsafe(
        'SELECT app,name,pg_catalog.isfinite(applied) AS finished FROM public.django_migrations ORDER BY app,name',
      )) {
        if (
          typeof row.app !== 'string' ||
          typeof row.name !== 'string' ||
          row.finished !== true ||
          !required.delete(JSON.stringify([row.app, row.name]))
        ) {
          throw new LibrephotosSnapshotError('LIBREPHOTOS_MIGRATIONS_INCOMPLETE');
        }
      }
      if (required.size > 0) throw new LibrephotosSnapshotError('LIBREPHOTOS_MIGRATIONS_INCOMPLETE');
      return strict;
    };
    if (bestEffort) {
      // A failed catalog query would abort the snapshot transaction; the savepoint keeps it readable.
      await reserved.unsafe('SAVEPOINT frameleaf_qualification');
      try {
        decoder = await qualify();
        qualified = true;
        await reserved.unsafe('RELEASE SAVEPOINT frameleaf_qualification');
      } catch {
        await reserved.unsafe('ROLLBACK TO SAVEPOINT frameleaf_qualification');
        decoder = createLibrephotosPostgresDecoder(undefined, version, String(engine?.version), { bestEffort });
      }
    } else decoder = await qualify();
  } catch (error) {
    await close();
    if (error instanceof LibrephotosSnapshotError) throw error;
    // Schema and decoder errors carry only fixed codes; driver errors can contain credentials or source values.
    if (error instanceof Error && 'code' in error && error.code === 'LIBREPHOTOS_POSTGRES_SCHEMA_UNQUALIFIED')
      throw new LibrephotosSnapshotError(error.code);
    throw new LibrephotosSnapshotError('LIBREPHOTOS_POSTGRES_SNAPSHOT_UNAVAILABLE');
  }
  const reserved = connection;
  const plans = Object.fromEntries(
    Object.entries(librephotosProjections).map(([table, projection]) => {
      const columns = fixture.structure.columns.filter((column) => column.table_name === table);
      const names = projection === '*' ? columns.map((column) => column.name) : projection.split(',');
      const key =
        table === 'api_file' ? 'hash' : ['api_photo_caption', 'api_photo_ocr'].includes(table) ? 'photo_id' : 'id';
      const select = `${names.map((name) => `"${name}"::text AS "${name}"`).join(',')},"${key}"::text AS __frameleaf_cursor`;
      return [table, { key, select }];
    }),
  );
  return {
    version,
    schemaSha256: decoder.schemaSha256,
    /** Every version, engine, catalog and migration pin matched; always true outside best effort. */
    qualified,
    password: async (input: ImportedPasswordContext): Promise<ImportedPassword | undefined> => {
      if (closed) throw new LibrephotosSnapshotError('LIBREPHOTOS_POSTGRES_SNAPSHOT_CLOSED');
      try {
        const context = captureImportedPasswordContext(input);
        const rows = await reserved.unsafe('SELECT password FROM ONLY public.api_user WHERE id=$1', [
          context.sourceUserId,
        ]);
        if (closed) throw new LibrephotosSnapshotError('LIBREPHOTOS_POSTGRES_SNAPSHOT_CLOSED');
        if (rows.length !== 1) throw new Error('Source owner missing');
        const encoded = rows[0].password;
        if (encoded === null || encoded === '' || (typeof encoded === 'string' && encoded.startsWith('!'))) return;
        if (typeof encoded !== 'string') throw new Error('Source password encoding unsupported');
        const credential = await ImportedPassword.fromSource(context, 'django-password', encoded);
        if (closed) throw new LibrephotosSnapshotError('LIBREPHOTOS_POSTGRES_SNAPSHOT_CLOSED');
        return credential;
      } catch (error) {
        if (error instanceof LibrephotosSnapshotError) throw error;
        throw new LibrephotosSnapshotError('LIBREPHOTOS_POSTGRES_PASSWORD_UNAVAILABLE');
      }
    },
    async *rows(table: LibrephotosTable): AsyncGenerator<LibrephotosRow[]> {
      if (!Object.hasOwn(librephotosProjections, table))
        throw new LibrephotosSnapshotError('LIBREPHOTOS_TABLE_NOT_ALLOWED');
      if (closed) throw new LibrephotosSnapshotError('LIBREPHOTOS_POSTGRES_SNAPSHOT_CLOSED');
      const { key, select } = plans[table];
      let cursor: string | undefined;
      try {
        const counts = await reserved.unsafe(`SELECT count(*)::text AS count FROM ONLY public."${table}"`);
        if (counts.length !== 1 || typeof counts[0].count !== 'string' || !/^(0|[1-9]\d*)$/.test(counts[0].count))
          throw new Error('Invalid source inventory count');
        const expected = BigInt(counts[0].count);
        let read = 0n;
        while (true) {
          if (closed) throw new LibrephotosSnapshotError('LIBREPHOTOS_POSTGRES_SNAPSHOT_CLOSED');
          const where = cursor === undefined ? '' : ` WHERE "${key}">$1`;
          const page = await reserved.unsafe(
            `SELECT ${select} FROM ONLY public."${table}"${where} ORDER BY "${table}"."${key}" LIMIT 1000`,
            cursor === undefined ? [] : [cursor],
          );
          if (closed) throw new LibrephotosSnapshotError('LIBREPHOTOS_POSTGRES_SNAPSHOT_CLOSED');
          if (page.length === 0) {
            if (read !== expected) throw new Error('Incomplete source inventory');
            return;
          }
          read += BigInt(page.length);
          if (read > expected) throw new Error('Source inventory exceeded');
          const next = page.at(-1)!.__frameleaf_cursor;
          if (page.length > 1000 || typeof next !== 'string' || next === cursor) throw new Error('Invalid source page');
          const batch = page.map(({ __frameleaf_cursor: _cursor, ...row }) =>
            decoder.decode(table, row as Record<string, string | null>),
          );
          cursor = next;
          yield batch;
        }
      } catch (error) {
        if (error instanceof LibrephotosSnapshotError) throw error;
        throw new LibrephotosSnapshotError('LIBREPHOTOS_POSTGRES_READ_FAILED');
      }
    },
    close,
  };
};
