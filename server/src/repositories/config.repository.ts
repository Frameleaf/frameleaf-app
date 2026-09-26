import { DatabaseConnectionParams } from '@immich/sql-tools';
import { RegisterQueueOptions } from '@nestjs/bullmq';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { QueueOptions } from 'bullmq';
import { Request, Response } from 'express';
import { HelmetOptions } from 'helmet';
import { RedisOptions } from 'ioredis';
import { CLS_ID, ClsModuleOptions } from 'nestjs-cls';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VectorExtension } from 'src/types.js';
import { IWorker, citiesFile } from 'src/constants.js';
import { EnvSchema } from 'src/dtos/env.dto.js';
import {
  DatabaseExtension,
  ImmichEnvironment,
  ImmichHeader,
  ImmichTelemetry,
  ImmichWorker,
  LogFormat,
  LogLevel,
  QueueName,
} from 'src/enum.js';
import { AppReleaseConfig, parseAppReleases, parseHelpLinks } from 'src/utils/app-releases.js';
import { parseTrustedLanCidrs } from 'src/utils/frameleaf-cloud.js';
import { FRAMELEAF_RELEASE_FEED, FRAMELEAF_RELEASES_API } from 'src/utils/frameleaf-release.js';
import { RecoveryRootConfig, parseRecoveryRoots } from 'src/utils/media-health-roots.js';
import { setDifference } from 'src/utils/set.js';

export interface EnvData {
  host?: string;
  port: number;
  environment: ImmichEnvironment;
  configFile?: string;
  logLevel?: LogLevel;
  logFormat?: LogFormat;

  buildMetadata: {
    build?: string;
    buildUrl?: string;
    buildImage?: string;
    buildImageUrl?: string;
    repository?: string;
    repositoryUrl?: string;
    sourceRef?: string;
    sourceCommit?: string;
    sourceUrl?: string;
    thirdPartySourceUrl?: string;
    thirdPartyBugFeatureUrl?: string;
    thirdPartyDocumentationUrl?: string;
    thirdPartySupportUrl?: string;
  };

  bull: {
    config: QueueOptions;
    queues: RegisterQueueOptions[];
  };

  cls: {
    config: ClsModuleOptions;
  };

  helmet: {
    config?: HelmetOptions;
  };

  database: {
    config: DatabaseConnectionParams;
    skipMigrations: boolean;
    vectorExtension?: VectorExtension;
  };

  versionCheck: {
    /** Frameleaf Cloud release feed, asked first. */
    url: string;
    /** Frameleaf's GitHub releases, asked only when the feed cannot answer. */
    fallbackUrl: string;
  };

  network: {
    trustedProxies: string[];
  };

  resourcePaths: {
    lockFile: string;
    geodata: {
      dateFile: string;
      admin1: string;
      admin2: string;
      cities500: string;
      naturalEarthCountriesPath: string;
    };
    web: {
      root: string;
      indexHtml: string;
    };
    corePlugin: string;
  };

  redis: RedisOptions;

  setup: {
    allow: boolean;
  };

  telemetry: {
    apiPort: number;
    microservicesPort: number;
    metrics: Set<ImmichTelemetry>;
  };

  storage: {
    ignoreMountCheckErrors: boolean;
    mediaLocation?: string;
    /** Directories administrators may select Google Photos imports from (FL-65). */
    importRoots: string[];
    /** Library Care recovery locations (FL-69). Searched and read only; never linked in place. */
    recoveryRoots?: RecoveryRootConfig[];
  };

  workers: ImmichWorker[];

  plugins: {
    external: {
      allow: boolean;
      installFolder?: string;
    };
  };

  /** Signed release destinations of this installation's apps (FL-82). */
  appReleases: AppReleaseConfig;

  /** FL-159: Frameleaf Cloud deployment configuration. `url` null means not configured. */
  frameleafCloud: {
    url: string | null;
    identityDir: string | null;
    /** FL-155: single-use headless link token, or null. */
    linkToken: string | null;
    /** FL-154: the edge worker's direct listener. */
    edge: { port: number; bind: string; secret: string | null };
    /** FL-158: this server's home-network address, or null. */
    localUrl: string | null;
    /** FL-154: networks treated as home besides RFC 1918 and ULA. */
    trustedLanCidrs: string[];
  };

  noColor: boolean;
  nodeVersion?: string;
}

const WORKER_TYPES = new Set(Object.values(ImmichWorker));

const asSet = <T>(value: string | undefined, defaults: T[]) => {
  const values = (value || '').replaceAll(/\s/g, '').split(',').filter(Boolean);
  return new Set(values.length === 0 ? defaults : (values as T[]));
};

const resolveHelmetFile = (helmetFile: 'true' | 'false' | string | undefined) => {
  // default is off
  if (!helmetFile || helmetFile === 'false') {
    return;
  }

  helmetFile = helmetFile === 'true' ? join(import.meta.dirname, '..', '..', 'helmet.json') : helmetFile;

  try {
    return JSON.parse(readFileSync(helmetFile).toString()) as HelmetOptions;
  } catch (error) {
    throw new Error(`Failed to read helmet file: ${helmetFile}`, { cause: error });
  }
};

const getEnv = (): EnvData => {
  const parseResult = EnvSchema.safeParse(process.env);
  if (!parseResult.success) {
    const messages = ['Invalid environment variables: '];
    for (const issue of parseResult.error.issues) {
      const path = issue.path.join('.');
      messages.push(`  - [${path}] ${issue.message}`);
    }
    throw new Error(messages.join('\n'));
  }
  const dto = parseResult.data;
  const helpLinks = parseHelpLinks(dto);

  const includedWorkers = asSet(dto.IMMICH_WORKERS_INCLUDE, [ImmichWorker.Api, ImmichWorker.Microservices]);
  const excludedWorkers = asSet(dto.IMMICH_WORKERS_EXCLUDE, []);
  const workers = [...setDifference(includedWorkers, excludedWorkers)];
  for (const worker of workers) {
    if (!WORKER_TYPES.has(worker)) {
      throw new Error(`Invalid worker(s) found: ${workers.join(',')}`);
    }
  }

  const environment = dto.IMMICH_ENV || ImmichEnvironment.Production;
  const buildFolder = dto.IMMICH_BUILD_DATA || '/build';
  const folders = {
    geodata: join(buildFolder, 'geodata'),
    web: join(buildFolder, 'www'),
  };

  let redisConfig = {
    host: dto.REDIS_HOSTNAME || 'redis',
    port: dto.REDIS_PORT || 6379,
    db: dto.REDIS_DBINDEX || 0,
    username: dto.REDIS_USERNAME || undefined,
    password: dto.REDIS_PASSWORD || undefined,
    path: dto.REDIS_SOCKET || undefined,
  };

  const redisUrl = dto.REDIS_URL;
  if (redisUrl && redisUrl.startsWith('ioredis://')) {
    try {
      redisConfig = JSON.parse(Buffer.from(redisUrl.slice(10), 'base64').toString());
    } catch (error) {
      throw new Error('Failed to decode redis options', { cause: error });
    }
  }

  const databaseConnection: DatabaseConnectionParams = dto.DB_URL
    ? { connectionType: 'url', url: dto.DB_URL }
    : {
        connectionType: 'parts',
        host: dto.DB_HOSTNAME || 'database',
        port: dto.DB_PORT || 5432,
        username: dto.DB_USERNAME || 'postgres',
        password: dto.DB_PASSWORD || 'postgres',
        database: dto.DB_DATABASE_NAME || 'immich',
        ssl: dto.DB_SSL_MODE || undefined,
      };

  let vectorExtension: VectorExtension | undefined;
  if (dto.DB_VECTOR_EXTENSION) {
    switch (dto.DB_VECTOR_EXTENSION) {
      case 'pgvector': {
        vectorExtension = DatabaseExtension.Vector;
        break;
      }
      case 'vectorchord': {
        vectorExtension = DatabaseExtension.VectorChord;
        break;
      }
    }
  }

  return {
    host: dto.IMMICH_HOST,
    port: dto.IMMICH_PORT || 2283,
    environment,
    configFile: dto.IMMICH_CONFIG_FILE,
    logLevel: dto.IMMICH_LOG_LEVEL,
    logFormat: dto.IMMICH_LOG_FORMAT || LogFormat.Console,

    buildMetadata: {
      build: dto.IMMICH_BUILD,
      buildUrl: dto.IMMICH_BUILD_URL,
      buildImage: dto.IMMICH_BUILD_IMAGE,
      buildImageUrl: dto.IMMICH_BUILD_IMAGE_URL,
      repository: dto.IMMICH_REPOSITORY,
      repositoryUrl: dto.IMMICH_REPOSITORY_URL,
      sourceRef: dto.IMMICH_SOURCE_REF,
      sourceCommit: dto.IMMICH_SOURCE_COMMIT,
      sourceUrl: dto.IMMICH_SOURCE_URL,
      // FL-135: validated https help destinations, `FRAMELEAF_*` first (see `parseHelpLinks`)
      thirdPartySourceUrl: helpLinks.sourceUrl,
      thirdPartyBugFeatureUrl: helpLinks.bugFeatureUrl,
      thirdPartyDocumentationUrl: helpLinks.documentationUrl,
      thirdPartySupportUrl: helpLinks.supportUrl,
    },

    bull: {
      config: {
        prefix: 'immich_bull',
        connection: { ...redisConfig },
        defaultJobOptions: {
          attempts: 1,
          removeOnComplete: true,
          // FL-71: failed jobs are kept for the Job manager to review, retry or remove; each queue
          // keeps its newest 1,000, the most one "Remove failed records" clears.
          removeOnFail: { count: 1000 },
        },
      },
      queues: Object.values(QueueName).map((name) => ({ name })),
    },

    cls: {
      config: {
        middleware: {
          mount: true,
          generateId: true,
          setup: (cls, req: Request, res: Response) => {
            const cid = req.header(ImmichHeader.CorrelationId) || cls.get(CLS_ID);
            cls.set(CLS_ID, cid);
            res.header(ImmichHeader.CorrelationId, cid);
          },
        },
      },
    },

    database: {
      config: databaseConnection,
      skipMigrations: dto.DB_SKIP_MIGRATIONS ?? false,
      vectorExtension,
    },

    helmet: {
      config: resolveHelmetFile(dto.IMMICH_HELMET_FILE),
    },

    versionCheck: {
      // FL-80 / FL-192: Frameleaf's own release feeds only; no Immich version service, in any environment.
      url: FRAMELEAF_RELEASE_FEED,
      fallbackUrl: FRAMELEAF_RELEASES_API,
    },

    network: {
      trustedProxies: dto.IMMICH_TRUSTED_PROXIES ?? ['linklocal', 'uniquelocal'],
    },

    redis: redisConfig,

    resourcePaths: {
      lockFile: join(buildFolder, 'build-lock.json'),
      geodata: {
        dateFile: join(folders.geodata, 'geodata-date.txt'),
        admin1: join(folders.geodata, 'admin1CodesASCII.txt'),
        admin2: join(folders.geodata, 'admin2Codes.txt'),
        cities500: join(folders.geodata, citiesFile),
        naturalEarthCountriesPath: join(folders.geodata, 'ne_10m_admin_0_countries.geojson'),
      },
      web: {
        root: folders.web,
        indexHtml: join(folders.web, 'index.html'),
      },
      corePlugin: join(buildFolder, 'plugins', 'immich-plugin-core'),
    },

    setup: {
      allow: dto.IMMICH_ALLOW_SETUP ?? true,
    },

    appReleases: parseAppReleases(dto),

    frameleafCloud: {
      url: dto.FRAMELEAF_CLOUD_URL ? dto.FRAMELEAF_CLOUD_URL.replace(/\/+$/, '') : null,
      identityDir: dto.FRAMELEAF_IDENTITY_DIR ?? null,
      linkToken: dto.FRAMELEAF_LINK_TOKEN ?? null,
      edge: {
        port: dto.FRAMELEAF_EDGE_PORT ?? 2443,
        bind: dto.FRAMELEAF_EDGE_BIND ?? '0.0.0.0',
        secret: dto.FRAMELEAF_EDGE_SECRET ?? null,
      },
      localUrl: dto.FRAMELEAF_LOCAL_URL ? new URL(dto.FRAMELEAF_LOCAL_URL).origin : null,
      trustedLanCidrs: parseTrustedLanCidrs(dto.FRAMELEAF_TRUSTED_LAN_CIDRS),
    },

    storage: {
      ignoreMountCheckErrors: !!dto.IMMICH_IGNORE_MOUNT_CHECK_ERRORS,
      mediaLocation: dto.IMMICH_MEDIA_LOCATION,
      importRoots: dto.IMMICH_IMPORT_ROOTS,
      recoveryRoots: parseRecoveryRoots(dto.FRAMELEAF_RECOVERY_ROOTS),
    },

    telemetry: {
      apiPort: dto.IMMICH_API_METRICS_PORT || 8081,
      microservicesPort: dto.IMMICH_MICROSERVICES_METRICS_PORT || 8082,
      // Legacy telemetry settings cannot enable collection or export in this fork.
      metrics: new Set<ImmichTelemetry>(),
    },

    workers,

    plugins: {
      external: {
        allow: dto.IMMICH_ALLOW_EXTERNAL_PLUGINS ?? false,
        installFolder: dto.IMMICH_PLUGINS_INSTALL_FOLDER,
      },
    },

    noColor: !!dto.NO_COLOR,
  };
};

let cached: EnvData | undefined;

@Injectable()
export class ConfigRepository {
  constructor(@Inject(IWorker) @Optional() private worker?: ImmichWorker) {}

  getEnv() {
    if (!cached) {
      cached = getEnv();
    }

    return cached;
  }

  isDev() {
    return this.getEnv().environment === ImmichEnvironment.Development;
  }

  isProduction() {
    return this.getEnv().environment === ImmichEnvironment.Production;
  }

  getWorker() {
    return this.worker;
  }
}

export const clearEnvCache = () => (cached = undefined);
