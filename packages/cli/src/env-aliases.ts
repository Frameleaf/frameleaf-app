import { existsSync } from 'node:fs';

/**
 * FL-294: the CLI's environment variables are FRAMELEAF_*. The IMMICH_* names still work as deprecated
 * aliases: an old name's value is used under the new name with one warning, and two different values
 * stop the CLI before it does anything.
 */
export const CLI_ENV_ALIASES = [
  'CONFIG_DIR',
  'INSTANCE_URL',
  'API_KEY',
  'RECURSIVE',
  'IGNORE_PATHS',
  'SKIP_HASH',
  'INCLUDE_HIDDEN',
  'AUTO_CREATE_ALBUM',
  'ALBUM_NAME',
  'VISIBILITY',
  'DRY_RUN',
  'UPLOAD_CONCURRENCY',
  'JSON_OUTPUT',
  'DELETE_ASSETS',
  'DELETE_DUPLICATES',
  'PROGRESS_BAR',
  'WATCH_CHANGES',
  'FROM_URL',
  'FROM_KEY',
  'TO_URL',
  'TO_KEY',
  'MIGRATE_LEDGER',
  'MIGRATE_CONCURRENCY',
  'MIGRATE_PORT',
].map((suffix) => [`IMMICH_${suffix}`, `FRAMELEAF_${suffix}`] as const);

const isSet = (value: string | undefined): value is string => value !== undefined && value !== '';

/** Resolves the aliases in place. Returns the conflicting pairs, after explaining them; empty when none. */
export const applyCliEnvAliases = (env: NodeJS.ProcessEnv, warn: (message: string) => void): string[] => {
  const deprecated: string[] = [];
  const conflicts: string[] = [];

  for (const [legacy, current] of CLI_ENV_ALIASES) {
    const legacyValue = env[legacy];
    if (!isSet(legacyValue)) {
      continue;
    }
    if (isSet(env[current]) && env[current] !== legacyValue) {
      conflicts.push(`  - ${current} and its deprecated alias ${legacy}`);
      continue;
    }
    env[current] = legacyValue;
    deprecated.push(`${legacy} → ${current}`);
  }

  if (conflicts.length > 0) {
    warn(
      [
        'Conflicting environment variables: each pair below is set to two different values.',
        ...conflicts,
        'Keep the FRAMELEAF_ name and remove the IMMICH_ one.',
      ].join('\n'),
    );
    return conflicts;
  }

  if (deprecated.length > 0) {
    warn(
      `Deprecated environment variable names in use; rename them: ${deprecated.join(', ')}. The old names still work in this major version and stop working in the next major release.`,
    );
  }

  return [];
};

/** The new default location, unless only the old one exists (a saved login, a resumable ledger). */
export const preferExisting = (current: string, legacy: string) =>
  !existsSync(current) && existsSync(legacy) ? legacy : current;
