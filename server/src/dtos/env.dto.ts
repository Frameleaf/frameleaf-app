import z from 'zod';
import { ImmichEnvironmentSchema, LogFormatSchema, LogLevelSchema } from 'src/enum.js';
import { IsIPRange } from 'src/validation.js';

// TODO import from sql-tools once the swagger plugin supports external enums
enum DatabaseSslMode {
  Disable = 'disable',
  Allow = 'allow',
  Prefer = 'prefer',
  Require = 'require',
  VerifyFull = 'verify-full',
}

const DatabaseSslModeSchema = z.enum(DatabaseSslMode).describe('Database SSL mode').meta({ id: 'DatabaseSslMode' });
const absolutePath = z.string().regex(/^\//, 'Must be an absolute path').optional();
/**
 * Treat certain strings as booleans and coerce them to boolean
 * Ideal for environment variables that are strings but should be treated as booleans
 * @docs https://zod.dev/api?id=stringbool
 */
const stringBool = z.stringbool();

const trustedProxiesSchema = z
  .string()
  .optional()
  .transform((s) =>
    s
      ? s
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean)
      : undefined,
  )

  .pipe(z.union([z.undefined(), IsIPRange({ requireCIDR: false })]));

export const EnvSchema = z
  .object({
    IMMICH_API_METRICS_PORT: z.coerce.number().int().optional(),
    IMMICH_BUILD_DATA: z.string().optional(),
    IMMICH_BUILD: z.string().optional(),
    IMMICH_BUILD_URL: z.string().optional(),
    IMMICH_BUILD_IMAGE: z.string().optional(),
    IMMICH_BUILD_IMAGE_URL: z.string().optional(),
    IMMICH_CONFIG_FILE: z.string().optional(),
    IMMICH_HELMET_FILE: z.string().optional(),
    IMMICH_ENV: ImmichEnvironmentSchema.optional(),
    IMMICH_HOST: z.string().optional(),
    IMMICH_IGNORE_MOUNT_CHECK_ERRORS: stringBool.optional(),
    /**
     * Directories an administrator permits Google Photos imports to read from (FL-65), comma
     * separated, each an absolute path. Only directories under one of these can be selected.
     */
    IMMICH_IMPORT_ROOTS: z
      .string()
      .optional()
      .transform((value) =>
        value
          ? value
              .split(',')
              .map((root) => root.trim())
              .filter(Boolean)
          : [],
      )
      .pipe(z.array(z.string().regex(/^\//, 'Every import root must be an absolute path'))),
    IMMICH_LOG_LEVEL: LogLevelSchema.optional(),
    IMMICH_LOG_FORMAT: LogFormatSchema.optional(),
    IMMICH_MEDIA_LOCATION: absolutePath,
    IMMICH_MICROSERVICES_METRICS_PORT: z.coerce.number().int().optional(),
    IMMICH_ALLOW_EXTERNAL_PLUGINS: stringBool.optional(),
    IMMICH_PLUGINS_INSTALL_FOLDER: absolutePath,
    IMMICH_PORT: z.coerce.number().int().optional(),
    IMMICH_REPOSITORY: z.string().optional(),
    IMMICH_REPOSITORY_URL: z.string().optional(),
    IMMICH_SOURCE_REF: z.string().optional(),
    IMMICH_SOURCE_COMMIT: z.string().optional(),
    IMMICH_SOURCE_URL: z.string().optional(),
    IMMICH_TELEMETRY_INCLUDE: z.string().optional(),
    IMMICH_TELEMETRY_EXCLUDE: z.string().optional(),
    IMMICH_THIRD_PARTY_SOURCE_URL: z.string().optional(),
    IMMICH_THIRD_PARTY_BUG_FEATURE_URL: z.string().optional(),
    IMMICH_THIRD_PARTY_DOCUMENTATION_URL: z.string().optional(),
    IMMICH_THIRD_PARTY_SUPPORT_URL: z.string().optional(),
    IMMICH_ALLOW_SETUP: stringBool.optional(),
    IMMICH_TRUSTED_PROXIES: trustedProxiesSchema,
    IMMICH_WORKERS_INCLUDE: z.string().optional(),
    IMMICH_WORKERS_EXCLUDE: z.string().optional(),
    /** Library Care recovery locations (FL-69): `Label=/path;Label=/path`, read only, never linked in place. */
    FRAMELEAF_RECOVERY_ROOTS: z.string().optional(),
    /** Signed app release destinations (FL-82); see `src/utils/app-releases.ts`. */
    FRAMELEAF_ANDROID_RELEASE_URL: z.string().optional(),
    FRAMELEAF_ANDROID_APP_ID: z.string().optional(),
    FRAMELEAF_ANDROID_SIGNING_SHA256: z.string().optional(),
    FRAMELEAF_IOS_APP_URL: z.string().optional(),
    /**
     * FL-159: the Frameleaf Cloud base address (deployment configuration, never a setting and never
     * hard-coded). Unset means Frameleaf Cloud is not configured and nothing is ever contacted.
     */
    FRAMELEAF_CLOUD_URL: z.url({ protocol: /^https?$/ }).optional(),
    /** FL-159: where this server's Ed25519 identity key lives (default `<media>/frameleaf/identity`). */
    FRAMELEAF_IDENTITY_DIR: z.string().optional(),
    /**
     * FL-154/FL-155: a single-use link token (`fll_…`, valid at most one hour) that links this server
     * headlessly at boot. A token that already linked, or failed, is never sent again.
     */
    FRAMELEAF_LINK_TOKEN: z
      .string()
      .regex(/^fll_[A-Za-z0-9_-]{8,512}$/)
      .optional(),
    /** FL-154: the edge worker's direct HTTPS port (default 2443) and bind address. */
    FRAMELEAF_EDGE_PORT: z.coerce.number().int().min(1).max(65_535).optional(),
    FRAMELEAF_EDGE_BIND: z.string().min(1).optional(),
    /**
     * FL-158: the per-boot secret the edge worker sends as `X-Frameleaf-Via-Auth`; without it every
     * `X-Frameleaf-Via` header is ignored. FL-161: the supervisor generates a new one on every boot and
     * hands it to its workers; a value set here is used instead.
     */
    FRAMELEAF_EDGE_SECRET: z.string().min(16).optional(),
    /** FL-158: this server's address on the home network, offered to visitors who are on it. */
    FRAMELEAF_LOCAL_URL: z.url({ protocol: /^https?$/ }).optional(),
    /** FL-154: extra networks treated as home (comma-separated CIDRs) besides RFC 1918 and ULA. */
    FRAMELEAF_TRUSTED_LAN_CIDRS: z.string().optional(),
    /** FL-135: the Android store listing and this installation's help destinations (https). */
    FRAMELEAF_ANDROID_STORE_URL: z.string().optional(),
    FRAMELEAF_DOCS_URL: z.string().optional(),
    FRAMELEAF_SUPPORT_URL: z.string().optional(),
    FRAMELEAF_BUG_FEATURE_URL: z.string().optional(),
    FRAMELEAF_SOURCE_URL: z.string().optional(),
    DB_DATABASE_NAME: z.string().optional(),
    DB_HOSTNAME: z.string().optional(),
    DB_PASSWORD: z.string().optional(),
    DB_PORT: z.coerce.number().int().optional(),
    DB_SKIP_MIGRATIONS: stringBool.optional(),
    DB_SSL_MODE: DatabaseSslModeSchema.optional(),
    DB_URL: z.string().optional(),
    DB_USERNAME: z.string().optional(),
    DB_VECTOR_EXTENSION: z.enum(['pgvector', 'vectorchord']).optional(),
    NO_COLOR: z.string().optional(),
    REDIS_HOSTNAME: z.string().optional(),
    REDIS_PORT: z.coerce.number().int().optional(),
    REDIS_DBINDEX: z.coerce.number().int().optional(),
    REDIS_USERNAME: z.string().optional(),
    REDIS_PASSWORD: z.string().optional(),
    REDIS_SOCKET: z.string().optional(),
    REDIS_URL: z.string().optional(),
  })
  .meta({ id: 'EnvDto' });
