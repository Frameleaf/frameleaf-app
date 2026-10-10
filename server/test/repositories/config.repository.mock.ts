import { Mocked, vitest } from 'vitest';
import type { RepositoryInterface } from 'src/types.js';
import { DatabaseExtension, ImmichEnvironment, ImmichWorker, LogFormat } from 'src/enum.js';
import { ConfigRepository, EnvData } from 'src/repositories/config.repository.js';

export const envData: EnvData = {
  port: 2283,
  shutdown: { graceMs: 5000, deadlineMs: 9000, workerDeadlineMs: 8000 },
  environment: ImmichEnvironment.Production,
  logFormat: LogFormat.Console,

  buildMetadata: {},
  cls: {
    config: {},
  },

  database: {
    config: {
      connectionType: 'parts',
      database: 'frameleaf',
      host: 'database',
      port: 5432,
      username: 'postgres',
      password: 'postgres',
    },
    skipMigrations: false,
    vectorExtension: DatabaseExtension.Vector,
  },

  helmet: {
    config: {},
  },

  versionCheck: {
    url: 'https://api.frameleaf.cloud/v1/releases/latest',
    fallbackUrl: 'https://api.github.com/repos/Frameleaf/frameleaf-app/releases',
  },

  network: {
    trustedProxies: [],
  },

  resourcePaths: {
    lockFile: 'build-lock.json',
    geodata: {
      dateFile: '/build/geodata/geodata-date.txt',
      admin1: '/build/geodata/admin1CodesASCII.txt',
      admin2: '/build/geodata/admin2Codes.txt',
      cities500: '/build/geodata/cities500.txt',
      naturalEarthCountriesPath: 'build/ne_10m_admin_0_countries.geojson',
      landmarks: 'build/landmarks.ndjson.gz',
      landmarkIcons: 'build/landmark-icons',
    },
    web: {
      root: '/build/www',
      indexHtml: '/build/www/index.html',
    },
    corePlugin: '/build/plugins/immich-plugin-core',
  },

  setup: {
    allow: true,
  },

  storage: {
    ignoreMountCheckErrors: false,
    importRoots: [],
  },

  telemetry: {
    apiPort: 8081,
    microservicesPort: 8082,
    metrics: new Set(),
  },

  workers: [ImmichWorker.Api, ImmichWorker.Microservices],

  plugins: {
    external: {
      allow: true,
      installFolder: '/app/data/plugins',
    },
  },

  appReleases: {},
  frameleafCloud: {
    url: null,
    pushUrl: null,
    identityDir: null,
    linkToken: null,
    setupCode: null,
    edge: { port: 2443, bind: '0.0.0.0', secret: null, acmeDirectoryUrl: null },
    localUrl: null,
    trustedLanCidrs: [],
    licenseExtraJwksFile: null,
  },

  noColor: false,
  deprecatedEnv: [],
};

export const mockEnvData = (config: Partial<EnvData>) => ({ ...envData, ...config });
export const newConfigRepositoryMock = (): Mocked<RepositoryInterface<ConfigRepository>> => {
  return {
    getEnv: vitest.fn().mockReturnValue(mockEnvData({})),
    getWorker: vitest.fn().mockReturnValue(ImmichWorker.Api),
    isDev: vitest.fn().mockReturnValue(false),
    isProduction: vitest.fn().mockReturnValue(true),
  };
};
