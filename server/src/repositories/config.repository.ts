import { DatabaseConnectionParams } from '@frameleaf/sql-tools';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { Request, Response } from 'express';
import { HelmetOptions } from 'helmet';
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
} from 'src/enum.js';
import { AppReleaseConfig, parseAppReleases, parseHelpLinks } from 'src/utils/app-releases.js';
import { EnvAlias, deprecatedEnvWarning, describeEnvName, resolveEnvAliases } from 'src/utils/env-aliases.js';
import { parseWorkerSelection } from 'src/utils/environment-values.js';
import { parseTrustedLanCidrs } from 'src/utils/frameleaf-cloud.js';
import { FRAMELEAF_RELEASES_API, FRAMELEAF_RELEASE_FEED } from 'src/utils/frameleaf-release.js';
import { RecoveryRootConfig, parseRecoveryRoots } from 'src/utils/media-health-roots.js';
import {
  DEFAULT_SHUTDOWN_DEADLINE_SECONDS,
  DEFAULT_SHUTDOWN_GRACE_SECONDS,
  getWorkerDeadlineMs,
} from 'src/utils/shutdown.js';

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
      landmarks: string;
    };
    web: {
      root: string;
      indexHtml: string;
    };
    corePlugin: string;
  };

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

  /** FL-291: the stop budget (FRAMELEAF_SHUTDOWN_GRACE_SECONDS, FRAMELEAF_SHUTDOWN_DEADLINE_SECONDS). */
  shutdown: {
    /** Running jobs and in-flight requests get this long to finish. */
    graceMs: number;
    /** The supervisor kills what is left and exits. */
    deadlineMs: number;
    /** Each worker exits by then, whatever its teardown is doing. */
    workerDeadlineMs: number;
  };

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
    /** FL-293: the push gateway's address (`FRAMELEAF_PUSH_URL`), or null: discovery's, else push is off. */
    pushUrl: string | null;
    identityDir: string | null;
    /** FL-155: single-use headless link token, or null. */
    linkToken: string | null;
    /** FL-292: a pinned setup code (`FRAMELEAF_SETUP_CODE`), or null for a random one per start. */
    setupCode: string | null;
    /** FL-154: the edge worker's direct listener. */
    edge: { port: number; bind: string; secret: string | null; acmeDirectoryUrl: string | null };
    /** FL-158: this server's home-network address, or null. */
    localUrl: string | null;
    /** FL-154: networks treated as home besides RFC 1918 and ULA. */
    trustedLanCidrs: string[];
    /** Integration builds only: the extra licence JWKS file (`FRAMELEAF_LICENSE_EXTRA_JWKS_FILE`), or null. */
    licenseExtraJwksFile: string | null;
  };

  noColor: boolean;
  nodeVersion?: string;

  /** FL-294: deprecated IMMICH_ names this environment uses, each with its FRAMELEAF_ name. */
  deprecatedEnv: Array<Pick<EnvAlias, 'legacy' | 'current'>>;
}

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
  // FL-294: deprecated IMMICH_ names are resolved to their FRAMELEAF_ names before validation, and a
  // pair set to two different values refuses to start
  const { env: resolvedEnv, deprecated: deprecatedEnv } = resolveEnvAliases(process.env);
  const parseResult = EnvSchema.safeParse(resolvedEnv);
  if (!parseResult.success) {
    const messages = ['Invalid environment variables: '];
    for (const issue of parseResult.error.issues) {
      const path = describeEnvName(issue.path.join('.'), deprecatedEnv);
      messages.push(`  - [${path}] ${issue.message}`);
    }
    throw new Error(messages.join('\n'));
  }
  const dto = parseResult.data;
  const helpLinks = parseHelpLinks(dto);

  const workers = parseWorkerSelection(dto);

  const environment = dto.FRAMELEAF_ENV || ImmichEnvironment.Production;
  const buildFolder = dto.FRAMELEAF_BUILD_DATA || '/build';
  const folders = {
    geodata: join(buildFolder, 'geodata'),
    web: join(buildFolder, 'www'),
  };

  const databaseConnection: DatabaseConnectionParams = dto.DB_URL
    ? { connectionType: 'url', url: dto.DB_URL }
    : {
        connectionType: 'parts',
        host: dto.DB_HOSTNAME || 'database',
        port: dto.DB_PORT || 5432,
        username: dto.DB_USERNAME || 'postgres',
        password: dto.DB_PASSWORD || 'postgres',
        database: dto.DB_DATABASE_NAME || 'frameleaf',
        ssl: dto.DB_SSL_MODE || undefined,
      };

  const vectorExtension = DatabaseExtension.Vector;

  const shutdownGraceMs = (dto.FRAMELEAF_SHUTDOWN_GRACE_SECONDS ?? DEFAULT_SHUTDOWN_GRACE_SECONDS) * 1000;
  const shutdownDeadlineMs = (dto.FRAMELEAF_SHUTDOWN_DEADLINE_SECONDS ?? DEFAULT_SHUTDOWN_DEADLINE_SECONDS) * 1000;

  return {
    host: dto.FRAMELEAF_HOST,
    port: dto.FRAMELEAF_PORT || 2283,
    shutdown: {
      graceMs: shutdownGraceMs,
      deadlineMs: shutdownDeadlineMs,
      workerDeadlineMs: getWorkerDeadlineMs(shutdownGraceMs, shutdownDeadlineMs),
    },
    environment,
    configFile: dto.FRAMELEAF_CONFIG_FILE,
    logLevel: dto.FRAMELEAF_LOG_LEVEL,
    logFormat: dto.FRAMELEAF_LOG_FORMAT || LogFormat.Console,

    buildMetadata: {
      build: dto.FRAMELEAF_BUILD,
      buildUrl: dto.FRAMELEAF_BUILD_URL,
      buildImage: dto.FRAMELEAF_BUILD_IMAGE,
      buildImageUrl: dto.FRAMELEAF_BUILD_IMAGE_URL,
      repository: dto.FRAMELEAF_REPOSITORY,
      repositoryUrl: dto.FRAMELEAF_REPOSITORY_URL,
      sourceRef: dto.FRAMELEAF_SOURCE_REF,
      sourceCommit: dto.FRAMELEAF_SOURCE_COMMIT,
      sourceUrl: dto.FRAMELEAF_SOURCE_COMMIT_URL,
      // FL-135: validated https help destinations, `FRAMELEAF_*` first (see `parseHelpLinks`)
      thirdPartySourceUrl: helpLinks.sourceUrl,
      thirdPartyBugFeatureUrl: helpLinks.bugFeatureUrl,
      thirdPartyDocumentationUrl: helpLinks.documentationUrl,
      thirdPartySupportUrl: helpLinks.supportUrl,
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
      config: resolveHelmetFile(dto.FRAMELEAF_HELMET_FILE),
    },

    versionCheck: {
      // FL-80 / FL-192: Frameleaf's own release feeds only; no Immich version service, in any environment.
      url: FRAMELEAF_RELEASE_FEED,
      fallbackUrl: FRAMELEAF_RELEASES_API,
    },

    network: {
      trustedProxies: dto.FRAMELEAF_TRUSTED_PROXIES ?? ['linklocal', 'uniquelocal'],
    },

    resourcePaths: {
      lockFile: join(buildFolder, 'build-lock.json'),
      geodata: {
        dateFile: join(folders.geodata, 'geodata-date.txt'),
        admin1: join(folders.geodata, 'admin1CodesASCII.txt'),
        admin2: join(folders.geodata, 'admin2Codes.txt'),
        cities500: join(folders.geodata, citiesFile),
        naturalEarthCountriesPath: join(folders.geodata, 'ne_10m_admin_0_countries.geojson'),
        landmarks: join(folders.geodata, 'landmarks.ndjson.gz'),
      },
      web: {
        root: folders.web,
        indexHtml: join(folders.web, 'index.html'),
      },
      corePlugin: join(buildFolder, 'plugins', 'immich-plugin-core'),
    },

    setup: {
      allow: dto.FRAMELEAF_ALLOW_SETUP ?? true,
    },

    appReleases: parseAppReleases(dto),

    frameleafCloud: {
      url: dto.FRAMELEAF_CLOUD_URL ? dto.FRAMELEAF_CLOUD_URL.replace(/\/+$/, '') : null,
      pushUrl: dto.FRAMELEAF_PUSH_URL ? dto.FRAMELEAF_PUSH_URL.replace(/\/+$/, '') : null,
      identityDir: dto.FRAMELEAF_IDENTITY_DIR ?? null,
      linkToken: dto.FRAMELEAF_LINK_TOKEN ?? null,
      setupCode: dto.FRAMELEAF_SETUP_CODE ?? null,
      edge: {
        port: dto.FRAMELEAF_EDGE_PORT ?? 2443,
        bind: dto.FRAMELEAF_EDGE_BIND ?? '0.0.0.0',
        secret: dto.FRAMELEAF_EDGE_SECRET ?? null,
        acmeDirectoryUrl: dto.FRAMELEAF_ACME_DIRECTORY_URL ?? null,
      },
      localUrl: dto.FRAMELEAF_LOCAL_URL ? new URL(dto.FRAMELEAF_LOCAL_URL).origin : null,
      trustedLanCidrs: parseTrustedLanCidrs(dto.FRAMELEAF_TRUSTED_LAN_CIDRS),
      licenseExtraJwksFile: dto.FRAMELEAF_LICENSE_EXTRA_JWKS_FILE?.trim() || null,
    },

    storage: {
      ignoreMountCheckErrors: !!dto.FRAMELEAF_IGNORE_MOUNT_CHECK_ERRORS,
      mediaLocation: dto.FRAMELEAF_MEDIA_LOCATION,
      importRoots: dto.FRAMELEAF_IMPORT_ROOTS,
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
        allow: dto.FRAMELEAF_ALLOW_EXTERNAL_PLUGINS ?? false,
        installFolder: dto.FRAMELEAF_PLUGINS_INSTALL_FOLDER,
      },
    },

    noColor: !!dto.NO_COLOR,

    deprecatedEnv,
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

/**
 * FL-294: the one startup warning naming the deprecated IMMICH_ variables in use and their FRAMELEAF_
 * names. The supervisor calls it once; its workers resolve the same environment without repeating it.
 */
export const warnDeprecatedEnv = (warn: (message: string) => void = console.warn) => {
  const warning = deprecatedEnvWarning(new ConfigRepository().getEnv().deprecatedEnv);
  if (warning) {
    warn(warning);
  }
};
