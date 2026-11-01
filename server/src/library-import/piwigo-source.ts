import { type Connection, type RowDataPacket, createConnection } from 'mysql2/promise';
import { z } from 'zod';
import fixture from 'src/library-import/fixtures/piwigo/16.4.0-mariadb.json' with { type: 'json' };
import { readMysqlSourceSchema } from 'src/library-import/mysql-catalog.js';
import { piwigoProjections } from 'src/library-import/piwigo-projections.js';
import { admitPiwigoSchema } from 'src/library-import/piwigo-schema.js';

const configSchema = z.strictObject({
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65_535),
  user: z.string().regex(/^[a-zA-Z0-9_.-]{1,64}$/u),
  password: z.string().min(1).max(4096),
  database: z
    .string()
    .min(1)
    .max(64)
    .refine((value) => [...value].every((c) => !(c < ' '))),
  prefix: z.string().regex(/^(?!\d)[a-zA-Z0-9_$]{0,20}$/u),
  version: z.string(),
  tls: z.strictObject({ ca: z.string().optional() }).optional(),
});
type Config = z.infer<typeof configSchema>;
export type PiwigoRow = Record<string, string | number | bigint | Buffer | null>;
export type PiwigoTable = keyof typeof piwigoProjections;
class PiwigoSourceError extends Error {
  constructor(code: string) {
    super(`Piwigo source refused: ${code}`);
  }
}
const refuse = (code: string): never => {
  throw new PiwigoSourceError(code);
};
const quote = (value: string) => '`' + value.replaceAll('`', '``') + '`';
const integerTypes = new Set(['TINY', 'SHORT', 'LONG', 'LONGLONG', 'INT24', 'YEAR']);
const metadataPrivileges = ['SELECT', 'LOCK TABLES', 'TRIGGER', 'EVENT', 'SHOW VIEW', 'SHOW CREATE ROUTINE'];
const close = (connection: Connection | undefined, bodyFailed: boolean): void => {
  try {
    connection?.destroy();
  } catch {
    if (!bodyFailed) refuse('PIWIGO_SOURCE_UNAVAILABLE');
  }
};

/** Reads an isolated, read_only restored source. Caller proves snapshot identity, source fencing and original-file consistency. */
export async function* readPiwigoRestore(input: Config): AsyncGenerator<{ table: PiwigoTable; rows: PiwigoRow[] }> {
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) refuse('PIWIGO_SOURCE_CONFIG_INVALID');
  const config = parsed.data!;
  if (config.version !== fixture.source.version) refuse('PIWIGO_VERSION_UNQUALIFIED');
  if (!config.tls && !['127.0.0.1', '::1'].includes(config.host)) refuse('PIWIGO_SOURCE_TLS_REQUIRED');
  let connection: Connection | undefined;
  let failed = false;
  let bodyFailed = false;
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
      ssl: config.tls ? { ...config.tls, rejectUnauthorized: true } : undefined,
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
      if (failed) refuse('PIWIGO_SOURCE_UNAVAILABLE');
      const [rows] = await connection!.query<RowDataPacket[]>({ sql, timeout: 5000 }, parameters);
      if (failed) refuse('PIWIGO_SOURCE_UNAVAILABLE');
      return rows;
    };
    const [profile] = await query(
      'SELECT VERSION() AS version,@@global.read_only AS read_only,@@wsrep_on AS wsrep_on,CURRENT_USER() AS account',
    );
    if (profile?.version !== fixture.runtime.databaseVersion) refuse('PIWIGO_ENGINE_UNQUALIFIED');
    if (profile.read_only !== 1n || profile.wsrep_on !== 0n) refuse('PIWIGO_RESTORE_NOT_ISOLATED');
    if (
      typeof profile.account !== 'string' ||
      profile.account.split('@').length !== 2 ||
      !profile.account.startsWith(config.user + '@')
    )
      refuse('PIWIGO_METADATA_VISIBILITY_UNQUALIFIED');
    const grants = await query(
      `SELECT PRIVILEGE_TYPE FROM information_schema.USER_PRIVILEGES WHERE GRANTEE=CONCAT(QUOTE(SUBSTRING_INDEX(CURRENT_USER(),'@',1)),'@',QUOTE(SUBSTRING_INDEX(CURRENT_USER(),'@',-1)))`,
    );
    if (metadataPrivileges.some((privilege) => grants.every((grant) => grant.PRIVILEGE_TYPE !== privilege)))
      refuse('PIWIGO_METADATA_VISIBILITY_UNQUALIFIED');
    await query("SET SESSION time_zone='+00:00'");
    await query('SET SESSION group_concat_max_len=16777216');
    const admit = async () =>
      admitPiwigoSchema({
        schema: await readMysqlSourceSchema(query, config.prefix),
        prefix: config.prefix,
        version: config.version,
        databaseVersion: String(profile.version),
      });
    await admit();
    const table = (name: string) => `${quote(config.database)}.${quote(config.prefix + name)}`;
    await query(
      'LOCK TABLES ' +
        fixture.schema.tables
          .map((row) => table(row.TABLE_NAME.slice(fixture.tablePrefix.length)) + ' READ')
          .join(',') +
        ' WAIT 5',
    );
    await admit();
    if ((await query(`SELECT image_id,category_id FROM ${table('lounge')} LIMIT 1000`)).length > 0)
      refuse('PIWIGO_PENDING_UPLOADS');
    for (const [name, projection] of Object.entries(piwigoProjections)) {
      const keys = projection.keys.map((key) => quote(key));
      let cursor: string[] = [];
      while (true) {
        const where = cursor.length > 0 ? ` WHERE (${keys.join(',')})>(${keys.map(() => '?').join(',')})` : '';
        const rows = await query(
          `SELECT ${projection.columns.map((column) => quote(column)).join(',')} FROM ${table(name)}${where} ORDER BY ${keys.join(',')} LIMIT 1000`,
          cursor,
        );
        if (rows.length === 0) break;
        if (rows.length > 1000) refuse('PIWIGO_SOURCE_BATCH_INVALID');
        cursor = projection.keys.map((key) => {
          const value = rows.at(-1)![key];
          if (typeof value !== 'bigint' || value < 0n) refuse('PIWIGO_SOURCE_CURSOR_INVALID');
          return String(value);
        });
        yield { table: name as PiwigoTable, rows };
      }
    }
    await admit();
  } catch (error) {
    bodyFailed = true;
    if (error instanceof PiwigoSourceError) throw error;
    if (
      error instanceof Error &&
      /^Piwigo source refused: PIWIGO_(?:SCHEMA|VERSION|ENGINE)_UNQUALIFIED$/u.test(error.message)
    )
      throw error;
    throw new PiwigoSourceError('PIWIGO_SOURCE_UNAVAILABLE');
  } finally {
    close(connection, bodyFailed);
  }
}
