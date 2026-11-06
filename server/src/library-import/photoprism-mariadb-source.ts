import { type Connection, type RowDataPacket, createConnection } from 'mysql2/promise';
import { type Socket, connect, isIP } from 'node:net';
import { z } from 'zod';
import fixture from 'src/library-import/fixtures/photoprism/261029-mariadb114.json' with { type: 'json' };
import { readMysqlSourceSchema } from 'src/library-import/mysql-catalog.js';
import { withPasswordCallbackDeadline } from 'src/library-import/password-callback.js';
import {
  ImportedPassword,
  type ImportedPasswordContext,
  captureImportedPasswordContext,
} from 'src/library-import/passwords.js';
import {
  type PhotoprismInventoryRecord,
  normalizePhotoprismInventoryRow,
} from 'src/library-import/photoprism-inventory.js';
import { admitPhotoprismMariadbSchema } from 'src/library-import/photoprism-mariadb-schema.js';
import {
  type PhotoprismRow,
  photoprismProjections,
  photoprismRelationshipChecks,
  photoprismTables,
} from 'src/library-import/photoprism.js';

const configSchema = z.strictObject({
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65_535),
  user: z.string().regex(/^[a-zA-Z0-9_.-]{1,64}$/u),
  password: z.string().min(1).max(4096),
  database: z.string().regex(/^[a-zA-Z0-9_]{1,64}$/u),
  version: z.string(),
  tls: z.strictObject({ ca: z.string().optional() }).optional(),
});
const integers = new Set(['TINY', 'SHORT', 'LONG', 'LONGLONG', 'INT24', 'YEAR']);
class SourceError extends Error {
  constructor(code: string) {
    super(`PhotoPrism source refused: ${code}`);
  }
}
const refuse = (code: string): never => {
  throw new SourceError(code);
};
const quote = (name: string) => '`' + name.replaceAll('`', '``') + '`';
const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const closeSource = async (
  connection: Connection | undefined,
  transport: Socket | undefined,
  bodyFailed: boolean,
): Promise<void> => {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!connection) return;
    await Promise.race([
      (async () => {
        await connection.query({ sql: 'ROLLBACK', timeout: 5000 });
        await connection.query({ sql: 'UNLOCK TABLES', timeout: 5000 });
        await connection.end();
      })(),
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new SourceError('PHOTOPRISM_SOURCE_UNAVAILABLE')), 10_000);
      }),
    ]);
  } catch {
    try {
      connection?.destroy();
    } catch {
      // Preserve the original source failure while forcing transport cleanup.
    }
    if (!bodyFailed) refuse('PHOTOPRISM_SOURCE_UNAVAILABLE');
  } finally {
    clearTimeout(deadline);
    try {
      // mysql2 destroy() only ends the stream; pending writes require a hard socket close.
      transport?.destroy();
    } catch {
      if (!bodyFailed) refuse('PHOTOPRISM_SOURCE_UNAVAILABLE');
    }
  }
};
const columnTypes = new Map(
  fixture.schema.columns.map((row) => [row.TABLE_NAME + '.' + row.COLUMN_NAME, row.COLUMN_TYPE]),
);

/**
 * Isolated restored database only; the controller separately proves source fencing, ownership and byte integrity.
 * `bestEffort` (owner decision FL-1149) skips the version, engine-version, schema, migration and build pins and keeps
 * every isolation and integrity check; `onQualified` reports whether the source schema, migrations and build match the
 * qualified fixture (the restore engine is the importer's, so its version does not make a source untested).
 */
export async function* readPhotoprismMariadbInventory(
  input: z.infer<typeof configSchema>,
  withPasswords?: (read: (context: ImportedPasswordContext) => Promise<ImportedPassword | undefined>) => Promise<void>,
  options: { bestEffort?: boolean; onQualified?: (qualified: boolean) => void } = {},
): AsyncGenerator<PhotoprismInventoryRecord> {
  const bestEffort = options.bestEffort === true;
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) return refuse('PHOTOPRISM_SOURCE_CONFIG_INVALID');
  const config = parsed.data;
  if (!bestEffort && config.version !== fixture.source.version) return refuse('PHOTOPRISM_VERSION_UNQUALIFIED');
  const loopback = ['127.0.0.1', '::1'].includes(config.host);
  if (!loopback && !config.tls) return refuse('PHOTOPRISM_SOURCE_TLS_REQUIRED');
  if (!loopback && isIP(config.host)) return refuse('PHOTOPRISM_SOURCE_TLS_HOST_UNQUALIFIED');
  let connection: Connection | undefined;
  let transport: Socket | undefined;
  let failed = false;
  let bodyFailed = false;
  try {
    connection = await createConnection({
      stream: () => {
        transport = connect({ host: config.host, port: config.port, noDelay: true, keepAlive: true });
        return transport;
      },
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      connectTimeout: 5000,
      dateStrings: true,
      multipleStatements: false,
      supportBigNumbers: true,
      bigNumberStrings: true,
      charset: 'utf8mb4',
      ssl: config.tls ? { ...config.tls, rejectUnauthorized: true, verifyIdentity: true } : undefined,
      typeCast(field, next) {
        if (integers.has(field.type)) {
          const value = field.string();
          return value === null ? null : BigInt(value);
        }
        return next();
      },
    });
    connection.on('error', () => {
      failed = true;
    });
    const query = async (sql: string, parameters: (string | bigint)[] = []): Promise<RowDataPacket[]> => {
      if (failed) return refuse('PHOTOPRISM_SOURCE_UNAVAILABLE');
      const [rows] = await connection!.query<RowDataPacket[]>({ sql, timeout: 5000 }, parameters);
      if (failed) return refuse('PHOTOPRISM_SOURCE_UNAVAILABLE');
      return rows;
    };
    const profile = async () => {
      const rows = await query(
        'SELECT VERSION() AS version,@@global.read_only AS read_only,@@wsrep_on AS wsrep_on,@@lower_case_table_names AS lower_case_table_names,CURRENT_USER() AS account,CURRENT_ROLE() AS roles',
      );
      const row = rows[0];
      if (
        rows.length !== 1 ||
        (!bestEffort && row.version !== fixture.runtime.databaseVersion) ||
        row.lower_case_table_names !== 0n
      )
        return refuse('PHOTOPRISM_ENGINE_UNQUALIFIED');
      if (row.read_only !== 1n || row.wsrep_on !== 0n) return refuse('PHOTOPRISM_RESTORE_NOT_ISOLATED');
      if (
        typeof row.account !== 'string' ||
        row.account.split('@').length !== 2 ||
        !row.account.startsWith(config.user + '@') ||
        row.roles !== null
      )
        return refuse('PHOTOPRISM_METADATA_VISIBILITY_UNQUALIFIED');
      return row;
    };
    const original = await profile();
    const grants = await query(
      "SELECT PRIVILEGE_TYPE FROM information_schema.USER_PRIVILEGES WHERE GRANTEE=CONCAT(QUOTE(SUBSTRING_INDEX(CURRENT_USER(),'@',1)),'@',QUOTE(SUBSTRING_INDEX(CURRENT_USER(),'@',-1)))",
    );
    if (
      ['SELECT', 'RELOAD', 'TRIGGER', 'EVENT', 'SHOW VIEW', 'SHOW CREATE ROUTINE'].some((p) =>
        grants.every((row) => row.PRIVILEGE_TYPE !== p),
      )
    )
      return refuse('PHOTOPRISM_METADATA_VISIBILITY_UNQUALIFIED');
    const databases = await query(
      "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME NOT IN ('information_schema','performance_schema','mysql','sys')",
    );
    if (databases.length !== 1 || databases[0].SCHEMA_NAME !== config.database)
      return refuse('PHOTOPRISM_RESTORE_NOT_ISOLATED');
    await query("SET SESSION time_zone='+00:00'");
    await query('SET SESSION group_concat_max_len=16777216');
    await query('SET SESSION lock_wait_timeout=5');
    await query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await query('FLUSH TABLES WITH READ LOCK');
    await query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    const normalize = (row: RowDataPacket, table: string): PhotoprismRow =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => {
          if (Buffer.isBuffer(value)) value = text.decode(value);
          const column = columnTypes.get(table + '.' + key);
          // PhotoPrism stores both its UTC capture instant and encoded local wall time in DATETIME columns.
          if (column?.startsWith('datetime') && typeof value === 'string') value = value.replace(' ', 'T') + 'Z';
          return [key, value];
        }),
      );
    const admit = async () => {
      const schema = await readMysqlSourceSchema(query);
      for (const [name, table, columns] of [
        [
          'foreignKeys',
          'REFERENTIAL_CONSTRAINTS',
          [
            'TABLE_NAME',
            'CONSTRAINT_NAME',
            'REFERENCED_TABLE_NAME',
            'UPDATE_RULE',
            'DELETE_RULE',
            'MATCH_OPTION',
            'UNIQUE_CONSTRAINT_NAME',
          ],
        ],
        ['checks', 'CHECK_CONSTRAINTS', ['CONSTRAINT_NAME', 'CHECK_CLAUSE']],
      ] as const) {
        const fields = columns.map((c) => `'${c}',${quote(c)}`).join(',');
        const rows = await query(
          `SELECT JSON_ARRAYAGG(JSON_OBJECT(${fields})) AS records FROM information_schema.${table} WHERE CONSTRAINT_SCHEMA=DATABASE()`,
        );
        if (rows.length !== 1) return refuse('PHOTOPRISM_SCHEMA_UNQUALIFIED');
        schema[name] =
          rows[0].records === null
            ? []
            : typeof rows[0].records === 'string'
              ? JSON.parse(rows[0].records)
              : rows[0].records;
      }
      const admission = {
        schema,
        version: config.version,
        databaseVersion: String(original.version),
        lowerCaseTableNames: Number(original.lower_case_table_names),
        migrations: await query('SELECT id,dialect,stage,error,finished_at FROM migrations'),
        versions: await query('SELECT version,error,migrated_at FROM versions ORDER BY id DESC LIMIT 1'),
      };
      if (!bestEffort) return admitPhotoprismMariadbSchema(admission);
      let qualified = true;
      try {
        admitPhotoprismMariadbSchema({
          ...admission,
          version: fixture.source.version,
          databaseVersion: fixture.runtime.databaseVersion,
        });
      } catch {
        qualified = false;
      }
      options.onQualified?.(qualified);
      return admitPhotoprismMariadbSchema(admission, { bestEffort: true });
    };
    await admit();
    for (const [code, sql] of photoprismRelationshipChecks) if ((await query(sql)).length > 0) return refuse(code);
    if (withPasswords) {
      let active = true;
      try {
        await withPasswordCallbackDeadline(
          (activity) =>
            withPasswords(async (input) => {
              try {
                const context = captureImportedPasswordContext(input);
                if (!active || failed) return refuse('PHOTOPRISM_PASSWORD_UNAVAILABLE');
                activity();
                const rows = await query(
                  'SELECT p.hash AS password FROM auth_users u LEFT JOIN passwords p ON p.uid=u.user_uid WHERE u.user_uid=? LIMIT 2',
                  [context.sourceUserId],
                );
                if (!active || failed || rows.length !== 1) return refuse('PHOTOPRISM_PASSWORD_UNAVAILABLE');
                const value = rows[0].password;
                const encoded = Buffer.isBuffer(value) ? text.decode(value) : value;
                if (encoded === null || encoded === '') return;
                if (typeof encoded !== 'string') return refuse('PHOTOPRISM_PASSWORD_UNAVAILABLE');
                const result = await ImportedPassword.fromSource(context, 'photoprism-bcrypt', encoded);
                if (!active || failed) return refuse('PHOTOPRISM_PASSWORD_UNAVAILABLE');
                activity();
                return result;
              } catch {
                return refuse('PHOTOPRISM_PASSWORD_UNAVAILABLE');
              }
            }),
          new SourceError('PHOTOPRISM_PASSWORD_CALLBACK_TIMEOUT'),
        );
      } finally {
        active = false;
      }
    }
    for (const table of photoprismTables) {
      const projection = photoprismProjections[table];
      const keys = fixture.schema.indexes
        .filter((row) => row.TABLE_NAME === projection.name && row.INDEX_NAME === 'PRIMARY')
        .sort((a, b) => a.SEQ_IN_INDEX - b.SEQ_IN_INDEX)
        .map((row) => row.COLUMN_NAME);
      if (keys.length === 0) return refuse('PHOTOPRISM_SOURCE_CURSOR_INVALID');
      const selected =
        projection.columns === '*'
          ? '*'
          : [...new Set([...keys, ...projection.columns.split(',')])].map((key) => quote(key)).join(',');
      let cursor: (string | bigint)[] = [];
      while (true) {
        const where =
          cursor.length > 0
            ? ` WHERE (${keys.map((key) => quote(key)).join(',')})>(${keys.map(() => '?').join(',')})`
            : '';
        const rows = await query(
          `SELECT ${selected} FROM ${quote(projection.name)}${where} ORDER BY ${keys.map((key) => quote(key)).join(',')} LIMIT 1000`,
          cursor,
        );
        if (rows.length === 0) break;
        if (rows.length > 1000) return refuse('PHOTOPRISM_SOURCE_BATCH_INVALID');
        cursor = keys.map((key) => {
          const value = rows.at(-1)![key];
          if (Buffer.isBuffer(value)) return text.decode(value);
          if (typeof value !== 'string' && typeof value !== 'bigint') return refuse('PHOTOPRISM_SOURCE_CURSOR_INVALID');
          return value;
        });
        for (const raw of rows) {
          const row = normalize(raw, projection.name);
          if (projection.columns !== '*')
            for (const key of keys) if (!projection.columns.split(',').includes(key)) delete row[key];
          const details = table === 'photos' ? await query('SELECT * FROM details WHERE photo_id=?', [raw.id]) : [];
          yield* normalizePhotoprismInventoryRow(table, row, details[0] ? normalize(details[0], 'details') : undefined);
        }
      }
    }
    await admit();
    await profile();
  } catch (error) {
    bodyFailed = true;
    if (error instanceof SourceError) throw error;
    if (error instanceof Error && /^PhotoPrism source refused: PHOTOPRISM_[A-Z_]+$/u.test(error.message)) throw error;
    throw new SourceError('PHOTOPRISM_SOURCE_UNAVAILABLE');
  } finally {
    await closeSource(connection, transport, bodyFailed);
  }
}
