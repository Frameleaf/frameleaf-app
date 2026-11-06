import { type Connection, type RowDataPacket, createConnection } from 'mysql2/promise';
import { isIP } from 'node:net';
import { z } from 'zod';
import fixture from 'src/library-import/fixtures/pigallery2/3.5.2-mysql84.json' with { type: 'json' };
import { readMysqlSourceSchema } from 'src/library-import/mysql-catalog.js';
import { mysqlSchemaFingerprint } from 'src/library-import/mysql-schema.js';
import { withPasswordCallbackDeadline } from 'src/library-import/password-callback.js';
import {
  ImportedPassword,
  ImportedPasswordContext,
  captureImportedPasswordContext,
} from 'src/library-import/passwords.js';
import { admitPigallery2MysqlSchema } from 'src/library-import/pigallery2-mysql-schema.js';
import { pigallery2Projections } from 'src/library-import/pigallery2-projections.js';
import { type Pigallery2Row, type Pigallery2Table } from 'src/library-import/pigallery2.js';

const configSchema = z.strictObject({
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65_535),
  user: z.string().regex(/^[a-zA-Z0-9_.-]{1,64}$/u),
  password: z.string().min(1).max(4096),
  database: z
    .string()
    .min(1)
    .max(64)
    .refine((v) => [...v].every((c) => c >= ' ')),
  version: z.string(),
  tls: z.strictObject({ ca: z.string().optional() }).optional(),
});
type Config = z.infer<typeof configSchema>;
class Pigallery2MysqlError extends Error {
  constructor(code: string) {
    super(`PiGallery2 source refused: ${code}`);
  }
}
const refuse = (code: string): never => {
  throw new Pigallery2MysqlError(code);
};
const quote = (name: string) => '`' + name.replaceAll('`', '``') + '`';
const integerTypes = new Set(['TINY', 'SHORT', 'LONG', 'LONGLONG', 'INT24', 'YEAR']);
const privileges = ['SELECT', 'RELOAD', 'TRIGGER', 'EVENT', 'SHOW VIEW'];

/**
 * Isolated restored database only. The controller separately proves original source identity, fencing and privacy.
 * `bestEffort` (owner decision FL-1149) skips the version, engine, schema-fingerprint and structure-version pins and
 * keeps every isolation, relationship and inventory check; `onQualified` reports whether the source schema and
 * structure version match the qualified fixture (the restore engine is the importer's, not the source's).
 */
export async function* readPigallery2MysqlRestore(
  input: Config,
  withPasswords?: (read: (context: ImportedPasswordContext) => Promise<ImportedPassword | undefined>) => Promise<void>,
  options: { bestEffort?: boolean; onQualified?: (qualified: boolean) => void } = {},
): AsyncGenerator<{ table: Pigallery2Table; rows: Pigallery2Row[] }> {
  const bestEffort = options.bestEffort === true;
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) return refuse('PIGALLERY2_SOURCE_CONFIG_INVALID');
  const config = parsed.data;
  if (!bestEffort && config.version !== fixture.source.version) return refuse('PIGALLERY2_VERSION_UNQUALIFIED');
  const loopback = ['127.0.0.1', '::1'].includes(config.host);
  if (!loopback && !config.tls) return refuse('PIGALLERY2_SOURCE_TLS_REQUIRED');
  if (!loopback && isIP(config.host)) return refuse('PIGALLERY2_SOURCE_TLS_HOST_UNQUALIFIED');
  let connection: Connection | undefined,
    failed = false,
    bodyFailed = false;
  try {
    connection = await createConnection({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      connectTimeout: 5000,
      dateStrings: true,
      decimalNumbers: false,
      jsonStrings: true,
      multipleStatements: false,
      supportBigNumbers: true,
      bigNumberStrings: true,
      charset: 'utf8mb4',
      ssl: config.tls ? { ...config.tls, rejectUnauthorized: true, verifyIdentity: true } : undefined,
      typeCast(field, next) {
        if (integerTypes.has(field.type)) {
          const value = field.string();
          return value === null ? null : BigInt(value);
        }
        return next();
      },
    });
    connection.on('error', () => {
      failed = true;
    });
    const query = async (sql: string, parameters: string[] = []): Promise<RowDataPacket[]> => {
      if (failed) return refuse('PIGALLERY2_SOURCE_UNAVAILABLE');
      const [rows] = await connection!.query<RowDataPacket[]>({ sql, timeout: 5000 }, parameters);
      if (failed) return refuse('PIGALLERY2_SOURCE_UNAVAILABLE');
      return rows;
    };
    const profile = async () => {
      const rows = await query(
        'SELECT VERSION() AS version,@@global.read_only AS read_only,@@global.super_read_only AS super_read_only,CURRENT_USER() AS account,CURRENT_ROLE() AS roles,DATABASE() AS `database`,@@lower_case_table_names AS lower_case_table_names,@@server_uuid AS server_uuid',
      );
      const row = rows[0];
      if (rows.length !== 1 || (!bestEffort && row.version !== fixture.runtime.databaseVersion))
        return refuse('PIGALLERY2_ENGINE_UNQUALIFIED');
      if (
        row.read_only !== 1n ||
        row.super_read_only !== 1n ||
        row.database !== config.database ||
        row.lower_case_table_names !== 0n
      )
        return refuse('PIGALLERY2_RESTORE_NOT_ISOLATED');
      if (
        typeof row.account !== 'string' ||
        row.account.split('@').length !== 2 ||
        !row.account.startsWith(config.user + '@') ||
        row.roles !== 'NONE' ||
        typeof row.server_uuid !== 'string'
      )
        return refuse('PIGALLERY2_METADATA_VISIBILITY_UNQUALIFIED');
      return row;
    };
    const original = await profile();
    const grants = await query(
      "SELECT PRIVILEGE_TYPE FROM information_schema.USER_PRIVILEGES WHERE GRANTEE=CONCAT(QUOTE(SUBSTRING_INDEX(CURRENT_USER(),'@',1)),'@',QUOTE(SUBSTRING_INDEX(CURRENT_USER(),'@',-1)))",
    );
    if (privileges.some((p) => grants.every((g) => g.PRIVILEGE_TYPE !== p)))
      return refuse('PIGALLERY2_METADATA_VISIBILITY_UNQUALIFIED');
    const databases = await query(
      "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME NOT IN ('information_schema','performance_schema','mysql','sys')",
    );
    if (databases.length !== 1 || databases[0].SCHEMA_NAME !== config.database)
      return refuse('PIGALLERY2_RESTORE_NOT_ISOLATED');
    await query("SET SESSION time_zone='+00:00'");
    await query('SET SESSION lock_wait_timeout=5');
    await query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await query('FLUSH TABLES WITH READ LOCK');
    // A global read lock survives START TRANSACTION; ordinary LOCK TABLES does not.
    await query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    const table = (name: string) => quote(config.database) + '.' + quote(name);
    const admit = async () => {
      const schema = await readMysqlSourceSchema(query, 'mysql');
      if (!bestEffort) {
        if (mysqlSchemaFingerprint(schema, '') !== fixture.schemaSha256) return refuse('PIGALLERY2_SCHEMA_UNQUALIFIED');
        const versions = await query(`SELECT version FROM ${table('version_entity')} LIMIT 2`);
        if (versions.length !== 1 || versions[0].version !== BigInt(fixture.runtime.dataStructureVersion))
          return refuse('PIGALLERY2_STRUCTURE_VERSION_UNQUALIFIED');
        return admitPigallery2MysqlSchema({
          schema,
          version: config.version,
          databaseVersion: String(original.version),
          structureVersion: Number(versions[0].version),
        });
      }
      let qualified = false;
      try {
        const versions = await query(`SELECT version FROM ${table('version_entity')} LIMIT 2`);
        admitPigallery2MysqlSchema({
          schema,
          version: fixture.source.version,
          databaseVersion: fixture.runtime.databaseVersion,
          structureVersion: versions.length === 1 ? Number(versions[0].version) : undefined,
        });
        qualified = true;
      } catch {
        // An unknown structure only makes a best-effort source untested.
      }
      options.onQualified?.(qualified);
      return admitPigallery2MysqlSchema(
        { schema, version: '', databaseVersion: '', structureVersion: undefined },
        { bestEffort },
      );
    };
    await admit();
    for (const relation of fixture.schema.foreignKeys) {
      const keys = fixture.schema.keys
        .filter((k) => k.TABLE_NAME === relation.TABLE_NAME && k.CONSTRAINT_NAME === relation.CONSTRAINT_NAME)
        .sort((a, b) => a.ORDINAL_POSITION - b.ORDINAL_POSITION);
      const join = keys.map((k) => `c.${quote(k.COLUMN_NAME)}=p.${quote(k.REFERENCED_COLUMN_NAME!)}`).join(' AND ');
      const present = keys.map((k) => `c.${quote(k.COLUMN_NAME)} IS NOT NULL`).join(' AND ');
      if (
        (
          await query(
            `SELECT 1 FROM ${table(relation.TABLE_NAME)} c LEFT JOIN ${table(relation.REFERENCED_TABLE_NAME)} p ON ${join} WHERE ${present} AND p.${quote(keys[0].REFERENCED_COLUMN_NAME!)} IS NULL LIMIT 1`,
          )
        ).length > 0
      )
        return refuse('PIGALLERY2_RELATIONSHIPS_INVALID');
    }
    const counts = new Map<string, bigint>();
    for (const name of Object.keys(pigallery2Projections)) {
      const rows = await query(`SELECT COUNT(*) AS count FROM ${table(name)}`);
      if (rows.length !== 1 || typeof rows[0].count !== 'bigint' || rows[0].count < 0n)
        return refuse('PIGALLERY2_INVENTORY_CHANGED');
      counts.set(name, rows[0].count);
    }
    if (withPasswords) {
      let active = true;
      try {
        await withPasswordCallbackDeadline(
          (activity) =>
            withPasswords(async (input) => {
              try {
                const context = captureImportedPasswordContext(input);
                if (
                  !active ||
                  failed ||
                  !/^(?:0|-?[1-9]\d{0,9})$/.test(context.sourceUserId) ||
                  BigInt(context.sourceUserId) < -2_147_483_648n ||
                  BigInt(context.sourceUserId) > 2_147_483_647n
                )
                  return refuse('PIGALLERY2_PASSWORD_UNAVAILABLE');
                activity();
                const rows = await query(`SELECT password FROM ${table('user_entity')} WHERE id=? LIMIT 2`, [
                  context.sourceUserId,
                ]);
                if (!active || failed || rows.length !== 1) return refuse('PIGALLERY2_PASSWORD_UNAVAILABLE');
                const encoded = rows[0].password;
                if (encoded === null || encoded === '') {
                  activity();
                  return;
                }
                if (typeof encoded !== 'string') return refuse('PIGALLERY2_PASSWORD_UNAVAILABLE');
                const credential = await ImportedPassword.fromSource(context, 'bcrypt', encoded);
                if (!active || failed) return refuse('PIGALLERY2_PASSWORD_UNAVAILABLE');
                activity();
                return credential;
              } catch {
                return refuse('PIGALLERY2_PASSWORD_UNAVAILABLE');
              }
            }),
          new Pigallery2MysqlError('PIGALLERY2_PASSWORD_CALLBACK_TIMEOUT'),
        );
      } finally {
        active = false;
      }
    }
    for (const [name, projection] of Object.entries(pigallery2Projections)) {
      let cursor: bigint | undefined,
        read = 0n;
      while (true) {
        const rows = await query(
          `SELECT ${projection} FROM ${table(name)}${cursor === undefined ? '' : ' WHERE id>?'} ORDER BY id LIMIT 1000`,
          cursor === undefined ? [] : [String(cursor)],
        );
        if (rows.length === 0) break;
        if (rows.length > 1000) return refuse('PIGALLERY2_SOURCE_BATCH_INVALID');
        for (const row of rows) {
          if (typeof row.id !== 'bigint' || (cursor !== undefined && row.id <= cursor))
            return refuse('PIGALLERY2_SOURCE_CURSOR_INVALID');
          cursor = row.id;
        }
        read += BigInt(rows.length);
        if (read > counts.get(name)!) return refuse('PIGALLERY2_INVENTORY_CHANGED');
        yield { table: name as Pigallery2Table, rows: rows as Pigallery2Row[] };
      }
      if (read !== counts.get(name)) return refuse('PIGALLERY2_INVENTORY_CHANGED');
    }
    await admit();
    if (
      JSON.stringify(await profile(), (_k, v) => (typeof v === 'bigint' ? String(v) : v)) !==
      JSON.stringify(original, (_k, v) => (typeof v === 'bigint' ? String(v) : v))
    )
      return refuse('PIGALLERY2_RESTORE_NOT_ISOLATED');
  } catch (error) {
    bodyFailed = true;
    if (error instanceof Pigallery2MysqlError) throw error;
    if (
      error instanceof Error &&
      /^PiGallery2 source refused: PIGALLERY2_(?:SCHEMA|VERSION|ENGINE|STRUCTURE_VERSION)_UNQUALIFIED$/.test(
        error.message,
      )
    )
      throw error;
    throw new Pigallery2MysqlError('PIGALLERY2_SOURCE_UNAVAILABLE');
  } finally {
    try {
      connection?.destroy();
    } catch {
      if (!bodyFailed) refuse('PIGALLERY2_SOURCE_UNAVAILABLE');
    }
  }
}
