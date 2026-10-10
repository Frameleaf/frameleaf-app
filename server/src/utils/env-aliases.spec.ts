import {
  ENV_ALIASES,
  EnvAliasConflictError,
  deprecatedEnvWarning,
  readAliasedEnv,
  resolveEnvAliases,
} from 'src/utils/env-aliases.js';

describe('env aliases (FL-294)', () => {
  describe('ENV_ALIASES', () => {
    it('gives every inherited IMMICH_ name a FRAMELEAF_ name', () => {
      for (const { legacy, current } of ENV_ALIASES) {
        expect(legacy).toMatch(/^IMMICH_[A-Z0-9_]+$/);
        expect(current).toMatch(/^FRAMELEAF_[A-Z0-9_]+$/);
      }
    });

    it('maps each old name, and each new name, exactly once', () => {
      const legacy = ENV_ALIASES.map((alias) => alias.legacy);
      const current = ENV_ALIASES.map((alias) => alias.current);
      expect(new Set(legacy).size).toBe(legacy.length);
      expect(new Set(current).size).toBe(current.length);
    });

    it('covers the server variables the audit found', () => {
      const legacy = new Set<string>(ENV_ALIASES.map((alias) => alias.legacy));
      for (const name of [
        'IMMICH_BUILD_DATA',
        'IMMICH_BUILD',
        'IMMICH_BUILD_URL',
        'IMMICH_BUILD_IMAGE',
        'IMMICH_BUILD_IMAGE_URL',
        'IMMICH_CONFIG_FILE',
        'IMMICH_HELMET_FILE',
        'IMMICH_ENV',
        'IMMICH_HOST',
        'IMMICH_IGNORE_MOUNT_CHECK_ERRORS',
        'IMMICH_IMPORT_ROOTS',
        'IMMICH_LOG_LEVEL',
        'IMMICH_LOG_FORMAT',
        'IMMICH_MEDIA_LOCATION',
        'IMMICH_ALLOW_EXTERNAL_PLUGINS',
        'IMMICH_PLUGINS_INSTALL_FOLDER',
        'IMMICH_PORT',
        'IMMICH_REPOSITORY',
        'IMMICH_REPOSITORY_URL',
        'IMMICH_SOURCE_REF',
        'IMMICH_SOURCE_COMMIT',
        'IMMICH_SOURCE_URL',
        'IMMICH_THIRD_PARTY_SOURCE_URL',
        'IMMICH_THIRD_PARTY_BUG_FEATURE_URL',
        'IMMICH_THIRD_PARTY_DOCUMENTATION_URL',
        'IMMICH_THIRD_PARTY_SUPPORT_URL',
        'IMMICH_ALLOW_SETUP',
        'IMMICH_TRUSTED_PROXIES',
        'IMMICH_WORKERS_INCLUDE',
        'IMMICH_WORKERS_EXCLUDE',
        'IMMICH_MACHINE_LEARNING_ENABLED',
        'IMMICH_MACHINE_LEARNING_URL',
        'IMMICH_PROCESS_INVALID_IMAGES',
        'IMMICH_MEDIA_VALIDATION_TIMEOUT_MS',
        'IMMICH_ICLOUD_BRIDGE_URL',
        'IMMICH_ICLOUD_BRIDGE_TOKEN_FILE',
        'IMMICH_ICLOUD_KEY_FILE',
        'IMMICH_ICLOUD_CA_FILE',
        'IMMICH_ICLOUD_STAGING_PATH',
        'IMMICH_ICLOUD_FREE_SPACE_BYTES',
        'IMMICH_ICLOUD_MAX_CONCURRENCY',
        'IMMICH_ICLOUD_MAX_STAGING_BYTES',
      ]) {
        expect(legacy.has(name), name).toBe(true);
      }
    });

    it('does not reuse the help-link FRAMELEAF_SOURCE_URL for the build commit address', () => {
      const commit = ENV_ALIASES.find((alias) => alias.legacy === 'IMMICH_SOURCE_URL');
      const help = ENV_ALIASES.find((alias) => alias.legacy === 'IMMICH_THIRD_PARTY_SOURCE_URL');
      expect(commit?.current).toBe('FRAMELEAF_SOURCE_COMMIT_URL');
      expect(help?.current).toBe('FRAMELEAF_SOURCE_URL');
    });
  });

  describe('resolveEnvAliases', () => {
    it('copies an old name to its new name and reports it as deprecated', () => {
      const { env, deprecated } = resolveEnvAliases({ IMMICH_PORT: '3001', DB_HOSTNAME: 'db' });

      expect(env.FRAMELEAF_PORT).toBe('3001');
      expect(env.DB_HOSTNAME).toBe('db');
      expect(deprecated).toEqual([{ legacy: 'IMMICH_PORT', current: 'FRAMELEAF_PORT' }]);
    });

    it('uses a new name as is and reports nothing', () => {
      const { env, deprecated } = resolveEnvAliases({ FRAMELEAF_PORT: '3002' });

      expect(env.FRAMELEAF_PORT).toBe('3002');
      expect(deprecated).toEqual([]);
    });

    it('accepts both names when they agree, still reporting the old one', () => {
      const { env, deprecated } = resolveEnvAliases({ IMMICH_HOST: '0.0.0.0', FRAMELEAF_HOST: '0.0.0.0' });

      expect(env.FRAMELEAF_HOST).toBe('0.0.0.0');
      expect(deprecated).toEqual([{ legacy: 'IMMICH_HOST', current: 'FRAMELEAF_HOST' }]);
    });

    it('refuses both names when they differ, naming every conflict', () => {
      const run = () =>
        resolveEnvAliases({
          IMMICH_PORT: '3001',
          FRAMELEAF_PORT: '3002',
          IMMICH_LOG_LEVEL: 'debug',
          FRAMELEAF_LOG_LEVEL: 'warn',
        });

      expect(run).toThrow(EnvAliasConflictError);
      expect(run).toThrow(/FRAMELEAF_PORT.*IMMICH_PORT/);
      expect(run).toThrow(/FRAMELEAF_LOG_LEVEL.*IMMICH_LOG_LEVEL/);
    });

    it('never puts a value into the conflict message', () => {
      try {
        resolveEnvAliases({ IMMICH_ICLOUD_KEY_FILE: '/run/secrets/a', FRAMELEAF_ICLOUD_KEY_FILE: '/run/secrets/b' });
        expect.unreachable();
      } catch (error) {
        expect(String(error)).not.toContain('/run/secrets');
      }
    });

    it('treats an empty value as unset, as Compose leaves an undefined substitution empty', () => {
      expect(resolveEnvAliases({ IMMICH_PORT: '', FRAMELEAF_PORT: '3002' })).toEqual({
        env: { IMMICH_PORT: '', FRAMELEAF_PORT: '3002' },
        deprecated: [],
      });
      expect(resolveEnvAliases({ IMMICH_PORT: '3001', FRAMELEAF_PORT: '' }).env.FRAMELEAF_PORT).toBe('3001');
    });

    it('does not change the environment it is given', () => {
      const input = { IMMICH_PORT: '3001' };
      resolveEnvAliases(input);
      expect(input).toEqual({ IMMICH_PORT: '3001' });
    });

    it('only reports a help link, leaving its existing fallback to parseHelpLinks', () => {
      const value = 'https://docs.example';
      const { env, deprecated } = resolveEnvAliases({ IMMICH_THIRD_PARTY_DOCUMENTATION_URL: value });

      expect(env.FRAMELEAF_DOCS_URL).toBeUndefined();
      expect(env.IMMICH_THIRD_PARTY_DOCUMENTATION_URL).toBe(value);
      expect(deprecated).toEqual([{ legacy: 'IMMICH_THIRD_PARTY_DOCUMENTATION_URL', current: 'FRAMELEAF_DOCS_URL' }]);
    });

    it('lets a FRAMELEAF_ help link win over its old name, as before', () => {
      const { env } = resolveEnvAliases({
        IMMICH_THIRD_PARTY_SUPPORT_URL: 'https://a.example',
        FRAMELEAF_SUPPORT_URL: 'https://b.example',
      });

      expect(env.FRAMELEAF_SUPPORT_URL).toBe('https://b.example');
    });

    it('gives the inert telemetry and metrics variables no new name', () => {
      const legacy = new Set<string>(ENV_ALIASES.map((alias) => alias.legacy));
      for (const name of [
        'IMMICH_TELEMETRY_INCLUDE',
        'IMMICH_TELEMETRY_EXCLUDE',
        'IMMICH_API_METRICS_PORT',
        'IMMICH_MICROSERVICES_METRICS_PORT',
      ]) {
        expect(legacy.has(name), name).toBe(false);
      }
    });
  });

  describe('deprecatedEnvWarning', () => {
    it('is empty when no old name is in use', () => {
      expect(deprecatedEnvWarning([])).toBeUndefined();
    });

    it('lists every old name with its new name in one message', () => {
      const message = deprecatedEnvWarning([
        { legacy: 'IMMICH_PORT', current: 'FRAMELEAF_PORT' },
        { legacy: 'IMMICH_LOG_LEVEL', current: 'FRAMELEAF_LOG_LEVEL' },
      ]);

      expect(message).toContain('IMMICH_PORT → FRAMELEAF_PORT');
      expect(message).toContain('IMMICH_LOG_LEVEL → FRAMELEAF_LOG_LEVEL');
      expect(message).toMatch(/deprecated/i);
      expect(message).toContain(
        'The old names still work in this major version and stop working in the next major release.',
      );
      expect(message!.split('\n')).toHaveLength(1);
    });
  });

  describe('readAliasedEnv', () => {
    it('prefers the new name', () => {
      expect(
        readAliasedEnv('FRAMELEAF_ICLOUD_CA_FILE', { FRAMELEAF_ICLOUD_CA_FILE: '/a', IMMICH_ICLOUD_CA_FILE: '/a' }),
      ).toBe('/a');
    });

    it('falls back to the old name', () => {
      expect(readAliasedEnv('FRAMELEAF_ICLOUD_CA_FILE', { IMMICH_ICLOUD_CA_FILE: '/b' })).toBe('/b');
    });

    it('returns undefined when neither is set', () => {
      expect(readAliasedEnv('FRAMELEAF_ICLOUD_CA_FILE', {})).toBeUndefined();
    });

    it('reads process.env by default', () => {
      vi.stubEnv('FRAMELEAF_PROCESS_INVALID_IMAGES', '');
      vi.stubEnv('IMMICH_PROCESS_INVALID_IMAGES', 'true');
      try {
        expect(readAliasedEnv('FRAMELEAF_PROCESS_INVALID_IMAGES')).toBe('true');
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });
});
