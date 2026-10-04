import { ConfigRepository, clearEnvCache, warnDeprecatedEnv } from 'src/repositories/config.repository.js';
import { ENV_ALIASES } from 'src/utils/env-aliases.js';

const getEnv = () => {
  clearEnvCache();
  return new ConfigRepository().getEnv();
};

const resetEnv = () => {
  for (const env of [
    'FRAMELEAF_ALLOW_EXTERNAL_PLUGINS',
    'FRAMELEAF_SHUTDOWN_GRACE_SECONDS',
    'FRAMELEAF_SHUTDOWN_DEADLINE_SECONDS',
    'FRAMELEAF_ALLOW_SETUP',
    'FRAMELEAF_ENV',
    'FRAMELEAF_WORKERS_INCLUDE',
    'FRAMELEAF_WORKERS_EXCLUDE',
    'FRAMELEAF_TRUSTED_PROXIES',
    'IMMICH_API_METRICS_PORT',
    'FRAMELEAF_MEDIA_LOCATION',
    'IMMICH_MICROSERVICES_METRICS_PORT',
    'IMMICH_TELEMETRY_INCLUDE',
    'IMMICH_TELEMETRY_EXCLUDE',

    'DB_URL',
    'DB_HOSTNAME',
    'DB_PORT',
    'DB_USERNAME',
    'DB_PASSWORD',
    'DB_DATABASE_NAME',
    'DB_SSL_MODE',
    'DB_SKIP_MIGRATIONS',
    'DB_VECTOR_EXTENSION',

    'NO_COLOR',

    'FRAMELEAF_CLOUD_URL',
    'FRAMELEAF_IDENTITY_DIR',
    'FRAMELEAF_LINK_TOKEN',
    'FRAMELEAF_SETUP_CODE',
    'FRAMELEAF_EDGE_PORT',
    'FRAMELEAF_EDGE_BIND',
    'FRAMELEAF_ACME_DIRECTORY_URL',
    'FRAMELEAF_TRUSTED_LAN_CIDRS',
    'FRAMELEAF_EDGE_SECRET',
    'FRAMELEAF_LOCAL_URL',
    'FRAMELEAF_LICENSE_EXTRA_JWKS_FILE',
  ]) {
    delete process.env[env];
  }
  for (const { legacy, current } of ENV_ALIASES) {
    delete process.env[legacy];
    delete process.env[current];
  }
};

describe('getEnv', () => {
  beforeEach(() => {
    resetEnv();
  });

  it('should use defaults', () => {
    const config = getEnv();

    expect(config).toMatchObject({
      host: undefined,
      port: 2283,
      environment: 'production',
      configFile: undefined,
      logLevel: undefined,
    });

    expect(config.plugins.external).toEqual({ allow: false });
    expect(config.setup).toEqual({ allow: true });
  });

  describe('shutdown (FL-291)', () => {
    it('gives running work 5 s and stops by 9 s by default, each worker exiting by 8 s', () => {
      expect(getEnv().shutdown).toEqual({ graceMs: 5000, deadlineMs: 9000, workerDeadlineMs: 8000 });
    });

    it('reads the grace period and deadline from the environment', () => {
      process.env.FRAMELEAF_SHUTDOWN_GRACE_SECONDS = '20';
      process.env.FRAMELEAF_SHUTDOWN_DEADLINE_SECONDS = '28';

      expect(getEnv().shutdown).toEqual({ graceMs: 20_000, deadlineMs: 28_000, workerDeadlineMs: 27_000 });
    });

    it('keeps the worker exit between the grace period and the deadline when they are close', () => {
      process.env.FRAMELEAF_SHUTDOWN_GRACE_SECONDS = '2';
      process.env.FRAMELEAF_SHUTDOWN_DEADLINE_SECONDS = '2.5';

      expect(getEnv().shutdown).toEqual({ graceMs: 2000, deadlineMs: 2500, workerDeadlineMs: 2250 });
    });

    it.each(['0', '-1', 'soon'])('refuses a grace period of %s', (value) => {
      process.env.FRAMELEAF_SHUTDOWN_GRACE_SECONDS = value;

      expect(() => getEnv()).toThrowError(/\[FRAMELEAF_SHUTDOWN_GRACE_SECONDS\]/);
    });

    it.each(['0', '-3', 'later'])('refuses a deadline of %s', (value) => {
      process.env.FRAMELEAF_SHUTDOWN_DEADLINE_SECONDS = value;

      expect(() => getEnv()).toThrowError(/\[FRAMELEAF_SHUTDOWN_DEADLINE_SECONDS\]/);
    });

    it('refuses a grace period that does not end before the deadline', () => {
      process.env.FRAMELEAF_SHUTDOWN_GRACE_SECONDS = '12';

      expect(() => getEnv()).toThrowError(
        '[FRAMELEAF_SHUTDOWN_GRACE_SECONDS] Must be less than FRAMELEAF_SHUTDOWN_DEADLINE_SECONDS (9)',
      );
    });
  });

  describe('FRAMELEAF_MEDIA_LOCATION', () => {
    it('should throw an error for relative paths', () => {
      process.env.FRAMELEAF_MEDIA_LOCATION = './relative/path';
      expect(() => getEnv()).toThrowError('[FRAMELEAF_MEDIA_LOCATION] Must be an absolute path');
    });
  });

  describe('FRAMELEAF_ALLOW_EXTERNAL_PLUGINS', () => {
    it('should disable plugins', () => {
      process.env.FRAMELEAF_ALLOW_EXTERNAL_PLUGINS = 'false';
      const config = getEnv();
      expect(config.plugins.external).toEqual({ allow: false });
    });

    it('should throw an error for invalid value', () => {
      process.env.FRAMELEAF_ALLOW_EXTERNAL_PLUGINS = 'invalid';
      expect(() => getEnv()).toThrowError('[FRAMELEAF_ALLOW_EXTERNAL_PLUGINS] Invalid option: expected one of');
    });
  });

  describe('FRAMELEAF_ALLOW_SETUP', () => {
    it('should disable setup', () => {
      process.env.FRAMELEAF_ALLOW_SETUP = 'false';
      const { setup } = getEnv();
      expect(setup).toEqual({ allow: false });
    });

    it('should throw an error for invalid value', () => {
      process.env.FRAMELEAF_ALLOW_SETUP = 'invalid';
      expect(() => getEnv()).toThrowError('[FRAMELEAF_ALLOW_SETUP] Invalid option: expected one of');
    });
  });

  describe('deprecated IMMICH_ aliases (FL-294)', () => {
    it('reports no deprecated names by default', () => {
      expect(getEnv().deprecatedEnv).toEqual([]);
    });

    it('starts from an unchanged Immich environment, using every old name', () => {
      process.env.IMMICH_PORT = '3001';
      process.env.IMMICH_HOST = '0.0.0.0';
      process.env.IMMICH_ENV = 'development';
      process.env.IMMICH_LOG_LEVEL = 'debug';
      process.env.IMMICH_MEDIA_LOCATION = '/usr/src/app/upload';
      process.env.IMMICH_WORKERS_EXCLUDE = 'microservices';
      process.env.IMMICH_TRUSTED_PROXIES = '10.0.0.0/8';
      process.env.IMMICH_ALLOW_SETUP = 'false';
      process.env.IMMICH_API_METRICS_PORT = '9001';
      process.env.IMMICH_IMPORT_ROOTS = '/imports';

      const env = getEnv();

      expect(env).toMatchObject({
        port: 3001,
        host: '0.0.0.0',
        environment: 'development',
        logLevel: 'debug',
        workers: ['api', 'edge'],
        network: { trustedProxies: ['10.0.0.0/8'] },
        setup: { allow: false },
        storage: { mediaLocation: '/usr/src/app/upload', importRoots: ['/imports'] },
        telemetry: { apiPort: 9001 },
      });
      expect(env.deprecatedEnv).toEqual(
        expect.arrayContaining([
          { legacy: 'IMMICH_PORT', current: 'FRAMELEAF_PORT' },
          { legacy: 'IMMICH_MEDIA_LOCATION', current: 'FRAMELEAF_MEDIA_LOCATION' },
        ]),
      );
      // the inert metrics port keeps its old name only, so it is not reported
      expect(env.deprecatedEnv).toHaveLength(9);
    });

    it('reads the build metadata from the old names, as images built before the rename set them', () => {
      process.env.IMMICH_SOURCE_REF = 'v3.2.0';
      process.env.IMMICH_SOURCE_URL = 'https://github.com/Frameleaf/frameleaf-app/commit/abc';

      expect(getEnv().buildMetadata).toMatchObject({
        sourceRef: 'v3.2.0',
        sourceUrl: 'https://github.com/Frameleaf/frameleaf-app/commit/abc',
      });
    });

    it('prefers nothing when both names agree', () => {
      process.env.IMMICH_PORT = '3001';
      process.env.FRAMELEAF_PORT = '3001';

      expect(getEnv().port).toBe(3001);
    });

    it('refuses to start when an old and a new name disagree', () => {
      process.env.IMMICH_PORT = '3001';
      process.env.FRAMELEAF_PORT = '3002';

      expect(() => getEnv()).toThrowError(/FRAMELEAF_PORT and its deprecated alias IMMICH_PORT/);
    });

    it('refuses before validating, so the conflict is the error reported', () => {
      process.env.IMMICH_MEDIA_LOCATION = './relative';
      process.env.FRAMELEAF_MEDIA_LOCATION = '/data';

      expect(() => getEnv()).toThrowError(/FRAMELEAF_MEDIA_LOCATION and its deprecated alias IMMICH_MEDIA_LOCATION/);
    });

    it('names the old variable when its value is invalid', () => {
      process.env.IMMICH_MEDIA_LOCATION = './relative/path';

      expect(() => getEnv()).toThrowError(
        '[FRAMELEAF_MEDIA_LOCATION (set as IMMICH_MEDIA_LOCATION)] Must be an absolute path',
      );
    });

    it('keeps an invalid legacy help link out instead of refusing to start', () => {
      // eslint-disable-next-line unicorn/prefer-https -- an insecure legacy address must be left out
      process.env.IMMICH_THIRD_PARTY_DOCUMENTATION_URL = 'http://docs.example';
      process.env.IMMICH_THIRD_PARTY_SUPPORT_URL = 'https://support.example';

      const { buildMetadata, deprecatedEnv } = getEnv();
      expect(buildMetadata.thirdPartyDocumentationUrl).toBeUndefined();
      expect(buildMetadata.thirdPartySupportUrl).toBe('https://support.example');
      expect(deprecatedEnv).toHaveLength(2);
    });

    it('warns once, listing each old name with its new name', () => {
      process.env.IMMICH_PORT = '3001';
      process.env.IMMICH_LOG_LEVEL = 'warn';
      const warn = vi.fn();
      clearEnvCache();

      warnDeprecatedEnv(warn);

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('IMMICH_LOG_LEVEL → FRAMELEAF_LOG_LEVEL'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('IMMICH_PORT → FRAMELEAF_PORT'));
    });

    it('does not warn when only new names are used', () => {
      process.env.FRAMELEAF_PORT = '3001';
      const warn = vi.fn();
      clearEnvCache();

      warnDeprecatedEnv(warn);

      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('database', () => {
    it('should use defaults', () => {
      const { database } = getEnv();
      expect(database).toEqual({
        config: {
          connectionType: 'parts',
          host: 'database',
          port: 5432,
          database: 'frameleaf',
          username: 'postgres',
          password: 'postgres',
          ssl: undefined,
        },
        skipMigrations: false,
        vectorExtension: 'vector',
      });
    });

    it('should validate DB_SSL_MODE', () => {
      process.env.DB_SSL_MODE = 'invalid';
      expect(() => getEnv()).toThrow(/\[DB_SSL_MODE\] Invalid option: expected one of/);
    });

    it('should accept a valid DB_SSL_MODE', () => {
      process.env.DB_SSL_MODE = 'prefer';
      const { database } = getEnv();
      expect(database.config).toMatchObject(expect.objectContaining({ ssl: 'prefer' }));
    });

    it('should allow skipping migrations', () => {
      process.env.DB_SKIP_MIGRATIONS = 'true';
      const { database } = getEnv();
      expect(database).toMatchObject({ skipMigrations: true });
    });

    it('should use DB_URL', () => {
      process.env.DB_URL = 'postgres://postgres1:postgres2@database1:54320/immich';
      const { database } = getEnv();
      expect(database.config).toMatchObject({
        connectionType: 'url',
        url: 'postgres://postgres1:postgres2@database1:54320/immich',
      });
    });
  });

  describe('noColor', () => {
    beforeEach(() => {
      delete process.env.NO_COLOR;
    });

    it('should default noColor to false', () => {
      const { noColor } = getEnv();
      expect(noColor).toBe(false);
    });

    it('should map NO_COLOR=1 to true', () => {
      process.env.NO_COLOR = '1';
      const { noColor } = getEnv();
      expect(noColor).toBe(true);
    });

    it('should map NO_COLOR=true to true', () => {
      process.env.NO_COLOR = 'true';
      const { noColor } = getEnv();
      expect(noColor).toBe(true);
    });
  });

  describe('workers', () => {
    it('should return default workers', () => {
      const { workers } = getEnv();
      expect(workers).toEqual(['api', 'microservices', 'edge']);
    });

    it('runs the edge worker without the API only when it is included by name (FL-165)', () => {
      process.env.FRAMELEAF_WORKERS_INCLUDE = 'microservices,edge';
      expect(getEnv().workers).toEqual(['microservices', 'edge']);
    });

    it('should return included workers', () => {
      process.env.FRAMELEAF_WORKERS_INCLUDE = 'api';
      const { workers } = getEnv();
      expect(workers).toEqual(['api']);
    });

    it('should excluded workers from defaults', () => {
      process.env.FRAMELEAF_WORKERS_EXCLUDE = 'api';
      const { workers } = getEnv();
      // the edge worker follows the API unless it is included by name
      expect(workers).toEqual(['microservices']);
    });

    it('should exclude workers from include list', () => {
      process.env.FRAMELEAF_WORKERS_INCLUDE = 'api,microservices,randomservice';
      process.env.FRAMELEAF_WORKERS_EXCLUDE = 'randomservice,microservices';
      const { workers } = getEnv();
      expect(workers).toEqual(['api']);
    });

    it('should remove whitespace from included workers before parsing', () => {
      process.env.FRAMELEAF_WORKERS_INCLUDE = 'api, microservices';
      const { workers } = getEnv();
      expect(workers).toEqual(['api', 'microservices']);
    });

    it('should remove whitespace from excluded workers before parsing', () => {
      process.env.FRAMELEAF_WORKERS_EXCLUDE = 'api, microservices';
      const { workers } = getEnv();
      expect(workers).toEqual([]);
    });

    it('should remove whitespace from included and excluded workers before parsing', () => {
      process.env.FRAMELEAF_WORKERS_INCLUDE = 'api, microservices, randomservice,randomservice2';
      process.env.FRAMELEAF_WORKERS_EXCLUDE = 'randomservice,microservices, randomservice2';
      const { workers } = getEnv();
      expect(workers).toEqual(['api']);
    });

    it('should throw error for invalid workers', () => {
      process.env.FRAMELEAF_WORKERS_INCLUDE = 'api,microservices,randomservice';
      expect(getEnv).toThrowError('Invalid worker(s) found: api,microservices,randomservice');
    });

    it('refuses the "Getting Ready…" worker, which only the supervisor starts (FL-295)', () => {
      process.env.FRAMELEAF_WORKERS_INCLUDE = 'api,first-launch';
      expect(getEnv).toThrowError('Invalid worker(s) found: api,first-launch');
    });
  });

  describe('network', () => {
    it('should return default network options', () => {
      const { network } = getEnv();
      expect(network).toEqual({
        trustedProxies: ['linklocal', 'uniquelocal'],
      });
    });

    it('should parse trusted proxies', () => {
      process.env.FRAMELEAF_TRUSTED_PROXIES = '10.1.0.0,10.2.0.0, 169.254.0.0/16';
      const { network } = getEnv();
      expect(network).toEqual({
        trustedProxies: ['10.1.0.0', '10.2.0.0', '169.254.0.0/16'],
      });
    });

    it('should reject invalid trusted proxies', () => {
      process.env.FRAMELEAF_TRUSTED_PROXIES = '10.1';
      expect(() => getEnv()).toThrow('[FRAMELEAF_TRUSTED_PROXIES] Must be an ip address or ip address range');
    });
  });

  describe('telemetry', () => {
    it('should have default values', () => {
      const { telemetry } = getEnv();
      expect(telemetry).toEqual({
        apiPort: 8081,
        microservicesPort: 8082,
        metrics: new Set(),
      });
    });

    it('should parse custom ports', () => {
      process.env.IMMICH_API_METRICS_PORT = '2001';
      process.env.IMMICH_MICROSERVICES_METRICS_PORT = '2002';
      const { telemetry } = getEnv();
      expect(telemetry).toMatchObject({
        apiPort: 2001,
        microservicesPort: 2002,
        metrics: expect.any(Set),
      });
    });

    it.each(['all', 'io,host,api,repo,job', 'unknown'])('ignores telemetry opt-ins: %s', (included) => {
      process.env.IMMICH_TELEMETRY_INCLUDE = included;
      process.env.IMMICH_TELEMETRY_EXCLUDE = '';
      process.env.OTEL_TRACES_EXPORTER = 'otlp';
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://collector.invalid:4318';
      try {
        expect(getEnv().telemetry.metrics).toEqual(new Set());
      } finally {
        delete process.env.OTEL_TRACES_EXPORTER;
        delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      }
    });
  });

  describe('versionCheck (FL-71)', () => {
    it("asks only Frameleaf's own release services, with no editable address", () => {
      process.env.IMMICH_VERSION_CHECK_URL = 'https://updates.invalid/latest';
      process.env.FRAMELEAF_ENV = 'development';
      try {
        const { versionCheck } = getEnv();
        expect(versionCheck).toEqual({
          url: 'https://api.frameleaf.cloud/v1/releases/latest',
          fallbackUrl: 'https://api.github.com/repos/Frameleaf/frameleaf-app/releases',
        });
        expect(JSON.stringify(versionCheck)).not.toMatch(/immich/i);
      } finally {
        delete process.env.IMMICH_VERSION_CHECK_URL;
      }
    });
  });

  describe('frameleafCloud (FL-154)', () => {
    it('is not configured by default and never falls back to a default host', () => {
      expect(getEnv().frameleafCloud).toEqual({
        url: null,
        pushUrl: null,
        identityDir: null,
        linkToken: null,
        setupCode: null,
        edge: { port: 2443, bind: '0.0.0.0', secret: null, acmeDirectoryUrl: null },
        localUrl: null,
        trustedLanCidrs: [],
        licenseExtraJwksFile: null,
      });
    });

    it('parses the deployment configuration', () => {
      process.env.FRAMELEAF_CLOUD_URL = 'https://frameleaf.cloud.test/';
      process.env.FRAMELEAF_PUSH_URL = 'https://push.frameleaf.cloud.test/';
      process.env.FRAMELEAF_IDENTITY_DIR = '/data/identity';
      process.env.FRAMELEAF_LINK_TOKEN = 'fll_abcdefgh12345678';
      process.env.FRAMELEAF_EDGE_PORT = '8443';
      process.env.FRAMELEAF_EDGE_BIND = '192.168.1.10';
      process.env.FRAMELEAF_TRUSTED_LAN_CIDRS = '100.64.0.0/10, fd00:1234::/32';
      process.env.FRAMELEAF_EDGE_SECRET = 'edge-secret-0123456789';
      process.env.FRAMELEAF_LOCAL_URL = 'http://192.168.1.10:2283/photos';
      process.env.FRAMELEAF_ACME_DIRECTORY_URL = 'https://acme-staging-v02.api.letsencrypt.org/directory';
      process.env.FRAMELEAF_LICENSE_EXTRA_JWKS_FILE = ' /run/secrets/frameleaf-dev-keys.json ';
      process.env.FRAMELEAF_SETUP_CODE = 'abcd-2345';
      expect(getEnv().frameleafCloud).toEqual({
        url: 'https://frameleaf.cloud.test',
        pushUrl: 'https://push.frameleaf.cloud.test',
        identityDir: '/data/identity',
        linkToken: 'fll_abcdefgh12345678',
        setupCode: 'ABCD2345',
        edge: {
          port: 8443,
          bind: '192.168.1.10',
          secret: 'edge-secret-0123456789',
          acmeDirectoryUrl: 'https://acme-staging-v02.api.letsencrypt.org/directory',
        },
        localUrl: 'http://192.168.1.10:2283',
        trustedLanCidrs: ['100.64.0.0/10', 'fd00:1234::/32'],
        licenseExtraJwksFile: '/run/secrets/frameleaf-dev-keys.json',
      });
    });

    it('refuses a malformed link token, port or network', () => {
      process.env.FRAMELEAF_LINK_TOKEN = 'not-a-token';
      expect(() => getEnv()).toThrow('FRAMELEAF_LINK_TOKEN');
      delete process.env.FRAMELEAF_LINK_TOKEN;
      // FL-292: a pinned setup code from the unambiguous alphabet only
      process.env.FRAMELEAF_SETUP_CODE = 'ABCD-234O';
      expect(() => getEnv()).toThrow('FRAMELEAF_SETUP_CODE');
      delete process.env.FRAMELEAF_SETUP_CODE;
      process.env.FRAMELEAF_EDGE_PORT = '70000';
      expect(() => getEnv()).toThrow('FRAMELEAF_EDGE_PORT');
      delete process.env.FRAMELEAF_EDGE_PORT;
      process.env.FRAMELEAF_TRUSTED_LAN_CIDRS = '10.0.0.0/40';
      expect(() => getEnv()).toThrow('FRAMELEAF_TRUSTED_LAN_CIDRS has an invalid network: "10.0.0.0/40"');
    });
  });
});
