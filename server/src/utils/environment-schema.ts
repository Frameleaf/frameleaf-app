import z from 'zod';
// eslint-disable-next-line no-restricted-imports -- The schema loads under plain Node before the application alias graph.
import { ImmichEnvironmentSchema, LogFormatSchema, LogLevelSchema } from './environment-values.ts';
// eslint-disable-next-line no-restricted-imports -- The schema loads under plain Node before the application alias graph.
import { IsIPRange } from './ip-range.ts';
// eslint-disable-next-line no-restricted-imports -- The schema loads under plain Node before the application alias graph.
import { DEFAULT_SHUTDOWN_DEADLINE_SECONDS, DEFAULT_SHUTDOWN_GRACE_SECONDS } from './shutdown.ts';

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

/**
 * Every variable is validated under its FRAMELEAF_ name. Deprecated IMMICH_ names are resolved to these
 * first (FL-294, `src/utils/env-aliases.ts`), in ConfigRepository.getEnv.
 */
export const EnvSchema = z
  .object({
    /** FL-294: inert (no metrics are served or collected), so accepted under the old name only. */
    IMMICH_API_METRICS_PORT: z.coerce.number().int().optional(),
    FRAMELEAF_BUILD_DATA: z.string().optional(),
    FRAMELEAF_BUILD: z.string().optional(),
    FRAMELEAF_BUILD_URL: z.string().optional(),
    FRAMELEAF_BUILD_IMAGE: z.string().optional(),
    FRAMELEAF_BUILD_IMAGE_URL: z.string().optional(),
    FRAMELEAF_CONFIG_FILE: z.string().optional(),
    FRAMELEAF_HELMET_FILE: z.string().optional(),
    FRAMELEAF_ENV: ImmichEnvironmentSchema.optional(),
    FRAMELEAF_HOST: z.string().optional(),
    FRAMELEAF_IGNORE_MOUNT_CHECK_ERRORS: stringBool.optional(),
    /**
     * Directories an administrator permits Google Photos imports to read from (FL-65), comma
     * separated, each an absolute path. Only directories under one of these can be selected.
     */
    FRAMELEAF_IMPORT_ROOTS: z
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
    FRAMELEAF_LOG_LEVEL: LogLevelSchema.optional(),
    FRAMELEAF_LOG_FORMAT: LogFormatSchema.optional(),
    FRAMELEAF_MEDIA_LOCATION: absolutePath,
    IMMICH_MICROSERVICES_METRICS_PORT: z.coerce.number().int().optional(),
    FRAMELEAF_ALLOW_EXTERNAL_PLUGINS: stringBool.optional(),
    FRAMELEAF_PLUGINS_INSTALL_FOLDER: absolutePath,
    FRAMELEAF_PORT: z.coerce.number().int().optional(),
    FRAMELEAF_REPOSITORY: z.string().optional(),
    /** FL-291: how long running jobs and in-flight requests get to finish when the server stops. */
    FRAMELEAF_SHUTDOWN_GRACE_SECONDS: z.coerce.number().positive().optional(),
    /** FL-291: when the server has exited after a stop, whatever is still running. */
    FRAMELEAF_SHUTDOWN_DEADLINE_SECONDS: z.coerce.number().positive().optional(),
    FRAMELEAF_REPOSITORY_URL: z.string().optional(),
    FRAMELEAF_SOURCE_REF: z.string().optional(),
    FRAMELEAF_SOURCE_COMMIT: z.string().optional(),
    FRAMELEAF_SOURCE_COMMIT_URL: z.string().optional(),
    /** FL-294: inert (telemetry cannot be enabled in this fork), so accepted under the old name only. */
    IMMICH_TELEMETRY_INCLUDE: z.string().optional(),
    IMMICH_TELEMETRY_EXCLUDE: z.string().optional(),
    /**
     * FL-294: deprecated aliases of FRAMELEAF_SOURCE_URL, FRAMELEAF_BUG_FEATURE_URL, FRAMELEAF_DOCS_URL and
     * FRAMELEAF_SUPPORT_URL. They keep their own fields because an invalid legacy value is ignored rather
     * than refused (`parseHelpLinks`); every other IMMICH_ name is resolved before validation.
     */
    IMMICH_THIRD_PARTY_SOURCE_URL: z.string().optional(),
    IMMICH_THIRD_PARTY_BUG_FEATURE_URL: z.string().optional(),
    IMMICH_THIRD_PARTY_DOCUMENTATION_URL: z.string().optional(),
    IMMICH_THIRD_PARTY_SUPPORT_URL: z.string().optional(),
    FRAMELEAF_ALLOW_SETUP: stringBool.optional(),
    FRAMELEAF_TRUSTED_PROXIES: trustedProxiesSchema,
    FRAMELEAF_WORKERS_INCLUDE: z.string().optional(),
    FRAMELEAF_WORKERS_EXCLUDE: z.string().optional(),
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
    FRAMELEAF_PUSH_URL: z.url({ protocol: /^https?$/ }).optional(),
    /**
     * Pre-release integration builds only (owner decision 2026-09-27): an absolute path to a mounted,
     * read-only JWKS whose Ed25519 keys may also sign licence certificates. Release builds ignore it.
     */
    FRAMELEAF_LICENSE_EXTRA_JWKS_FILE: z.string().optional(),
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
    /**
     * FL-292: pins the setup code a new server asks for (8 characters of
     * ABCDEFGHJKMNPQRSTUVWXYZ23456789, the dash optional), for automated installs and tests. Whoever
     * sets it already controls the host. A pinned code is not replaced after wrong tries; it locks
     * until the next start instead.
     */
    FRAMELEAF_SETUP_CODE: z
      .string()
      .transform((value) => value.toUpperCase().replaceAll('-', ''))
      .pipe(z.string().regex(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/))
      .optional(),
    /** FL-154: the edge worker's direct HTTPS port (default 2443) and bind address. */
    FRAMELEAF_EDGE_PORT: z.coerce.number().int().min(1).max(65_535).optional(),
    FRAMELEAF_EDGE_BIND: z.string().min(1).optional(),
    /**
     * FL-165: the ACME directory the edge worker obtains its certificates from (default Let’s Encrypt
     * production). Only for Let’s Encrypt staging or a test CA; Frameleaf Cloud pins the direct names’
     * CAA records to Let’s Encrypt.
     */
    FRAMELEAF_ACME_DIRECTORY_URL: z.url({ protocol: /^https?$/ }).optional(),
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
    DB_VECTOR_EXTENSION: z.enum(['pgvector']).optional(),
    NO_COLOR: z.string().optional(),
  })
  .superRefine((env, context) => {
    // FL-291: running work must be handed back before the deadline ends the server
    const grace = env.FRAMELEAF_SHUTDOWN_GRACE_SECONDS ?? DEFAULT_SHUTDOWN_GRACE_SECONDS;
    const deadline = env.FRAMELEAF_SHUTDOWN_DEADLINE_SECONDS ?? DEFAULT_SHUTDOWN_DEADLINE_SECONDS;
    if (grace >= deadline) {
      context.addIssue({
        code: 'custom',
        path: ['FRAMELEAF_SHUTDOWN_GRACE_SECONDS'],
        message: `Must be less than FRAMELEAF_SHUTDOWN_DEADLINE_SECONDS (${deadline})`,
      });
    }
  })
  .meta({ id: 'EnvDto' });
