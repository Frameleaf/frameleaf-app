export { readPiwigoManifest } from 'src/library-import/piwigo-manifest.js';
import { type Connection, type RowDataPacket, createConnection } from 'mysql2/promise';
import { isIP } from 'node:net';
import { z } from 'zod';
import fixture from 'src/library-import/fixtures/piwigo/16.4.0-mariadb.json' with { type: 'json' };
import { readMysqlSourceSchema } from 'src/library-import/mysql-catalog.js';
import { withPasswordCallbackDeadline } from 'src/library-import/password-callback.js';
import {
  ImportedPassword,
  ImportedPasswordContext,
  captureImportedPasswordContext,
} from 'src/library-import/passwords.js';
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

/**
 * Reads an isolated, read_only restored source. Caller proves snapshot identity, source fencing and original-file
 * consistency. `bestEffort` (owner decision FL-1149) skips the version, engine, metadata-visibility and schema
 * fingerprint pins and locks only the projected tables; isolation, pending-upload, batch and cursor checks stay.
 */
export async function* readPiwigoRestore(
  input: Config,
  withPasswords?: (read: (context: ImportedPasswordContext) => Promise<ImportedPassword | undefined>) => Promise<void>,
  { bestEffort = false }: { bestEffort?: boolean } = {},
): AsyncGenerator<{ table: PiwigoTable; rows: PiwigoRow[] }> {
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) refuse('PIWIGO_SOURCE_CONFIG_INVALID');
  const config = parsed.data!;
  if (!bestEffort && config.version !== fixture.source.version) refuse('PIWIGO_VERSION_UNQUALIFIED');
  const loopback = ['127.0.0.1', '::1'].includes(config.host);
  if (!config.tls && !loopback) refuse('PIWIGO_SOURCE_TLS_REQUIRED');
  // mysql2 omits the TLS server name for IP literals; remote identity is qualified only with DNS hosts.
  if (!loopback && isIP(config.host)) refuse('PIWIGO_SOURCE_TLS_HOST_UNQUALIFIED');
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
      if (failed) refuse('PIWIGO_SOURCE_UNAVAILABLE');
      const [rows] = await connection!.query<RowDataPacket[]>({ sql, timeout: 5000 }, parameters);
      if (failed) refuse('PIWIGO_SOURCE_UNAVAILABLE');
      return rows;
    };
    const [profile] = await query(
      bestEffort
        ? 'SELECT VERSION() AS version,@@global.read_only AS read_only,CURRENT_USER() AS account'
        : 'SELECT VERSION() AS version,@@global.read_only AS read_only,@@wsrep_on AS wsrep_on,CURRENT_USER() AS account',
    );
    if (!bestEffort && profile?.version !== fixture.runtime.databaseVersion) refuse('PIWIGO_ENGINE_UNQUALIFIED');
    // MySQL has no wsrep_on variable; an absent row means no Galera replication.
    const wsrep = bestEffort ? (await query("SHOW VARIABLES LIKE 'wsrep_on'"))[0]?.Value : undefined;
    if (
      !profile ||
      profile.read_only !== 1n ||
      (bestEffort ? wsrep !== undefined && String(wsrep).toUpperCase() !== 'OFF' : profile.wsrep_on !== 0n)
    )
      refuse('PIWIGO_RESTORE_NOT_ISOLATED');
    if (
      typeof profile.account !== 'string' ||
      profile.account.split('@').length !== 2 ||
      !profile.account.startsWith(config.user + '@')
    )
      refuse('PIWIGO_METADATA_VISIBILITY_UNQUALIFIED');
    const grants = await query(
      `SELECT PRIVILEGE_TYPE FROM information_schema.USER_PRIVILEGES WHERE GRANTEE=CONCAT(QUOTE(SUBSTRING_INDEX(CURRENT_USER(),'@',1)),'@',QUOTE(SUBSTRING_INDEX(CURRENT_USER(),'@',-1)))`,
    );
    // Complete catalog visibility only matters to the fingerprint, which best effort does not pin.
    if (
      !bestEffort &&
      metadataPrivileges.some((privilege) => grants.every((grant) => grant.PRIVILEGE_TYPE !== privilege))
    )
      refuse('PIWIGO_METADATA_VISIBILITY_UNQUALIFIED');
    await query("SET SESSION time_zone='+00:00'");
    await query('SET SESSION group_concat_max_len=16777216');
    const admit = async () =>
      bestEffort ||
      admitPiwigoSchema({
        schema: await readMysqlSourceSchema(query),
        prefix: config.prefix,
        version: config.version,
        databaseVersion: String(profile.version),
      });
    await admit();
    const table = (name: string) => `${quote(config.database)}.${quote(config.prefix + name)}`;
    if (bestEffort) {
      // Untested installs may lack native tables or run MySQL, which has no LOCK TABLES ... WAIT.
      await query('SET SESSION lock_wait_timeout=5');
      await query(
        'LOCK TABLES ' +
          Object.keys(piwigoProjections)
            .map((name) => table(name) + ' READ')
            .join(','),
      );
    } else
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
    if (withPasswords) {
      let active = true;
      try {
        await withPasswordCallbackDeadline(
          (activity) =>
            withPasswords(async (input) => {
              try {
                const context = captureImportedPasswordContext(input);
                if (!active || failed || !/^[1-9]\d{0,9}$/.test(context.sourceUserId))
                  refuse('PIWIGO_PASSWORD_UNAVAILABLE');
                activity();
                const owners = await query(`SELECT status FROM ${table('user_infos')} WHERE user_id=? LIMIT 2`, [
                  context.sourceUserId,
                ]);
                if (!active || failed || owners.length !== 1 || typeof owners[0].status !== 'string')
                  refuse('PIWIGO_PASSWORD_UNAVAILABLE');
                if (owners[0].status === 'guest') {
                  activity();
                  return;
                }
                const rows = await query(`SELECT password FROM ${table('users')} WHERE id=? LIMIT 2`, [
                  context.sourceUserId,
                ]);
                if (!active || failed || rows.length !== 1) refuse('PIWIGO_PASSWORD_UNAVAILABLE');
                const encoded = rows[0].password;
                if (encoded === null || encoded === '') {
                  activity();
                  return;
                }
                if (typeof encoded !== 'string') refuse('PIWIGO_PASSWORD_UNAVAILABLE');
                const credential = await ImportedPassword.fromSource(context, 'piwigo-password', encoded);
                if (!active || failed) refuse('PIWIGO_PASSWORD_UNAVAILABLE');
                activity();
                return credential;
              } catch {
                // mysql2 errors may contain SQL and values; never disclose a source verifier.
                refuse('PIWIGO_PASSWORD_UNAVAILABLE');
              }
            }),
          new PiwigoSourceError('PIWIGO_PASSWORD_CALLBACK_TIMEOUT'),
        );
      } finally {
        active = false;
      }
    }
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
        cursor = projection.keys.map((key: string) => {
          const value = rows.at(-1)![key];
          if (name === 'rate' && key === 'anonymous_id' && typeof value === 'string') return value;
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
