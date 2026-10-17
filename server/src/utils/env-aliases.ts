/**
 * FL-294: every inherited `IMMICH_*` environment variable that does something has a `FRAMELEAF_*` name. The new name is
 * the one the code, docs and Compose files use; the old one keeps working as a deprecated alias, so
 * an unchanged Immich `.env` and Compose file still start this server after the image swap.
 *
 * - Only the old name set: its value is used under the new name, and the old name is reported once
 *   at startup.
 * - Both set to the same value: accepted, and the old name is still reported.
 * - Both set to different values: the server refuses to start, naming both (never the values).
 * - An empty value counts as unset, because Compose turns an undefined `${VAR}` into an empty string.
 *
 * `reportOnly` aliases (the help links, `IMMICH_THIRD_PARTY_*`) are only named in the startup warning.
 * Their existing fallback stays as it was (`parseHelpLinks`): the FRAMELEAF_ value wins, and an invalid
 * legacy value is ignored rather than refused.
 *
 * Not listed, so accepted under their old names only: the inert telemetry and metrics variables
 * (`IMMICH_TELEMETRY_INCLUDE`, `IMMICH_TELEMETRY_EXCLUDE`, `IMMICH_API_METRICS_PORT`,
 * `IMMICH_MICROSERVICES_METRICS_PORT`). This fork collects and serves no metrics, so they do nothing and
 * get no new name.
 */
export type EnvAlias = { legacy: `IMMICH_${string}`; current: `FRAMELEAF_${string}`; reportOnly?: true };

export const ENV_ALIASES = [
  // server: validated in EnvSchema (env.dto.ts)
  { legacy: 'IMMICH_BUILD_DATA', current: 'FRAMELEAF_BUILD_DATA' },
  { legacy: 'IMMICH_BUILD', current: 'FRAMELEAF_BUILD' },
  { legacy: 'IMMICH_BUILD_URL', current: 'FRAMELEAF_BUILD_URL' },
  { legacy: 'IMMICH_BUILD_IMAGE', current: 'FRAMELEAF_BUILD_IMAGE' },
  { legacy: 'IMMICH_BUILD_IMAGE_URL', current: 'FRAMELEAF_BUILD_IMAGE_URL' },
  { legacy: 'IMMICH_CONFIG_FILE', current: 'FRAMELEAF_CONFIG_FILE' },
  { legacy: 'IMMICH_HELMET_FILE', current: 'FRAMELEAF_HELMET_FILE' },
  { legacy: 'IMMICH_ENV', current: 'FRAMELEAF_ENV' },
  { legacy: 'IMMICH_HOST', current: 'FRAMELEAF_HOST' },
  { legacy: 'IMMICH_IGNORE_MOUNT_CHECK_ERRORS', current: 'FRAMELEAF_IGNORE_MOUNT_CHECK_ERRORS' },
  { legacy: 'IMMICH_IMPORT_ROOTS', current: 'FRAMELEAF_IMPORT_ROOTS' },
  { legacy: 'IMMICH_LOG_LEVEL', current: 'FRAMELEAF_LOG_LEVEL' },
  { legacy: 'IMMICH_LOG_FORMAT', current: 'FRAMELEAF_LOG_FORMAT' },
  { legacy: 'IMMICH_MEDIA_LOCATION', current: 'FRAMELEAF_MEDIA_LOCATION' },
  { legacy: 'IMMICH_ALLOW_EXTERNAL_PLUGINS', current: 'FRAMELEAF_ALLOW_EXTERNAL_PLUGINS' },
  { legacy: 'IMMICH_PLUGINS_INSTALL_FOLDER', current: 'FRAMELEAF_PLUGINS_INSTALL_FOLDER' },
  { legacy: 'IMMICH_PORT', current: 'FRAMELEAF_PORT' },
  { legacy: 'IMMICH_REPOSITORY', current: 'FRAMELEAF_REPOSITORY' },
  { legacy: 'IMMICH_REPOSITORY_URL', current: 'FRAMELEAF_REPOSITORY_URL' },
  { legacy: 'IMMICH_SOURCE_REF', current: 'FRAMELEAF_SOURCE_REF' },
  { legacy: 'IMMICH_SOURCE_COMMIT', current: 'FRAMELEAF_SOURCE_COMMIT' },
  // FRAMELEAF_SOURCE_URL is already the help link to the source code (FL-135)
  { legacy: 'IMMICH_SOURCE_URL', current: 'FRAMELEAF_SOURCE_COMMIT_URL' },
  { legacy: 'IMMICH_THIRD_PARTY_SOURCE_URL', current: 'FRAMELEAF_SOURCE_URL', reportOnly: true },
  { legacy: 'IMMICH_THIRD_PARTY_BUG_FEATURE_URL', current: 'FRAMELEAF_BUG_FEATURE_URL', reportOnly: true },
  { legacy: 'IMMICH_THIRD_PARTY_DOCUMENTATION_URL', current: 'FRAMELEAF_DOCS_URL', reportOnly: true },
  { legacy: 'IMMICH_THIRD_PARTY_SUPPORT_URL', current: 'FRAMELEAF_SUPPORT_URL', reportOnly: true },
  { legacy: 'IMMICH_ALLOW_SETUP', current: 'FRAMELEAF_ALLOW_SETUP' },
  { legacy: 'IMMICH_TRUSTED_PROXIES', current: 'FRAMELEAF_TRUSTED_PROXIES' },
  { legacy: 'IMMICH_WORKERS_INCLUDE', current: 'FRAMELEAF_WORKERS_INCLUDE' },
  { legacy: 'IMMICH_WORKERS_EXCLUDE', current: 'FRAMELEAF_WORKERS_EXCLUDE' },
  // server: read where they are used, through readAliasedEnv
  { legacy: 'IMMICH_MACHINE_LEARNING_ENABLED', current: 'FRAMELEAF_MACHINE_LEARNING_ENABLED' },
  { legacy: 'IMMICH_MACHINE_LEARNING_URL', current: 'FRAMELEAF_MACHINE_LEARNING_URL' },
  { legacy: 'IMMICH_PROCESS_INVALID_IMAGES', current: 'FRAMELEAF_PROCESS_INVALID_IMAGES' },
  { legacy: 'IMMICH_MEDIA_VALIDATION_TIMEOUT_MS', current: 'FRAMELEAF_MEDIA_VALIDATION_TIMEOUT_MS' },
  { legacy: 'IMMICH_ICLOUD_BRIDGE_URL', current: 'FRAMELEAF_ICLOUD_BRIDGE_URL' },
  { legacy: 'IMMICH_ICLOUD_BRIDGE_TOKEN_FILE', current: 'FRAMELEAF_ICLOUD_BRIDGE_TOKEN_FILE' },
  { legacy: 'IMMICH_ICLOUD_KEY_FILE', current: 'FRAMELEAF_ICLOUD_KEY_FILE' },
  { legacy: 'IMMICH_ICLOUD_CA_FILE', current: 'FRAMELEAF_ICLOUD_CA_FILE' },
  { legacy: 'IMMICH_ICLOUD_STAGING_PATH', current: 'FRAMELEAF_ICLOUD_STAGING_PATH' },
  { legacy: 'IMMICH_ICLOUD_FREE_SPACE_BYTES', current: 'FRAMELEAF_ICLOUD_FREE_SPACE_BYTES' },
  { legacy: 'IMMICH_ICLOUD_MAX_CONCURRENCY', current: 'FRAMELEAF_ICLOUD_MAX_CONCURRENCY' },
  { legacy: 'IMMICH_ICLOUD_MAX_STAGING_BYTES', current: 'FRAMELEAF_ICLOUD_MAX_STAGING_BYTES' },
] as const satisfies readonly EnvAlias[];

export type AliasedEnvName = (typeof ENV_ALIASES)[number]['current'];

type Env = Record<string, string | undefined>;

const isSet = (value: string | undefined): value is string => value !== undefined && value !== '';

const legacyOf = new Map<string, string>(ENV_ALIASES.map(({ legacy, current }) => [current, legacy]));

export class EnvAliasConflictError extends Error {
  constructor(readonly conflicts: Array<Pick<EnvAlias, 'legacy' | 'current'>>) {
    super(
      [
        'Conflicting environment variables: each pair below is set to two different values.',
        ...conflicts.map(({ legacy, current }) => `  - ${current} and its deprecated alias ${legacy}`),
        'Keep the FRAMELEAF_ name and remove the IMMICH_ one.',
      ].join('\n'),
    );
    this.name = 'EnvAliasConflictError';
  }
}

/**
 * The environment with every old name's value also under its new name (report-only aliases excepted),
 * and the old names in use. Throws an {@link EnvAliasConflictError} when a pair disagrees.
 */
export const resolveEnvAliases = (input: Env) => {
  const env: Env = { ...input };
  const deprecated: Array<Pick<EnvAlias, 'legacy' | 'current'>> = [];
  const conflicts: Array<Pick<EnvAlias, 'legacy' | 'current'>> = [];

  for (const alias of ENV_ALIASES as readonly EnvAlias[]) {
    const { legacy, current } = alias;
    const legacyValue = input[legacy];
    if (!isSet(legacyValue)) {
      continue;
    }

    if (alias.reportOnly) {
      deprecated.push({ legacy, current });
      continue;
    }

    const currentValue = input[current];
    if (isSet(currentValue) && currentValue !== legacyValue) {
      conflicts.push({ legacy, current });
      continue;
    }

    deprecated.push({ legacy, current });
    env[current] = legacyValue;
  }

  if (conflicts.length > 0) {
    throw new EnvAliasConflictError(conflicts);
  }

  return { env, deprecated };
};

/** The one startup warning naming each old variable in use and its new name, or undefined. */
export const deprecatedEnvWarning = (deprecated: Array<Pick<EnvAlias, 'legacy' | 'current'>>) => {
  if (deprecated.length === 0) {
    return;
  }

  const pairs = deprecated.map(({ legacy, current }) => `${legacy} → ${current}`).join(', ');
  return `Deprecated environment variable names in use; rename them: ${pairs}. The old names still work in this major version and stop working in the next major release.`;
};

/**
 * A variable read outside EnvSchema: its FRAMELEAF_ name, else its deprecated IMMICH_ alias. A
 * conflict between the two has already stopped the server at startup (ConfigRepository.getEnv).
 */
export const readAliasedEnv = (name: AliasedEnvName, env: Env = process.env): string | undefined => {
  const value = env[name];
  if (isSet(value)) {
    return value;
  }

  const legacy = legacyOf.get(name);
  const legacyValue = legacy === undefined ? undefined : env[legacy];
  return isSet(legacyValue) ? legacyValue : value;
};

/** For validation messages: which name a value really came from. */
export const describeEnvName = (name: string, deprecated: Array<Pick<EnvAlias, 'legacy' | 'current'>>) => {
  const alias = deprecated.find(({ current }) => current === name);
  return alias ? `${name} (set as ${alias.legacy})` : name;
};
