import z from 'zod';

export enum FrameleafWorker {
  Api = 'api',
  Maintenance = 'maintenance',
  Microservices = 'microservices',
  /** FL-165: idle until remote access is enabled for a linked, entitled server. */
  Edge = 'edge',
}

/** The same worker profile is validated before Buddy admission and ordinary supervisor startup. */
export const parseWorkerSelection = (env: {
  FRAMELEAF_WORKERS_INCLUDE?: string;
  FRAMELEAF_WORKERS_EXCLUDE?: string;
}) => {
  const asSet = (value: string | undefined, defaults: FrameleafWorker[]) => {
    const values = (value || '').replaceAll(/\s/g, '').split(',').filter(Boolean);
    return new Set(values.length === 0 ? defaults : (values as FrameleafWorker[]));
  };
  const included = asSet(env.FRAMELEAF_WORKERS_INCLUDE, [
    FrameleafWorker.Api,
    FrameleafWorker.Microservices,
    FrameleafWorker.Edge,
  ]);
  const excluded = asSet(env.FRAMELEAF_WORKERS_EXCLUDE, []);
  let workers = [...included.difference(excluded)];
  // Without an explicit include list, the edge worker follows the API.
  if (!env.FRAMELEAF_WORKERS_INCLUDE && !workers.includes(FrameleafWorker.Api)) {
    workers = workers.filter((worker) => worker !== FrameleafWorker.Edge);
  }
  // The supervisor's Getting Ready worker cannot be selected by configuration.
  const allowed = new Set<FrameleafWorker>(Object.values(FrameleafWorker));
  if (workers.some((worker) => !allowed.has(worker))) {
    throw new Error(`Invalid worker(s) found: ${workers.join(',')}`);
  }
  return workers;
};

export enum LogLevel {
  Verbose = 'verbose',
  Debug = 'debug',
  Log = 'log',
  Warn = 'warn',
  Error = 'error',
  Fatal = 'fatal',
}

export const LogLevelSchema = z.enum(LogLevel).describe('Log level').meta({ id: 'LogLevel' });

export enum LogFormat {
  Console = 'console',
  Json = 'json',
}

export const LogFormatSchema = z.enum(LogFormat).describe('Log format').meta({ id: 'LogFormat' });

export enum FrameleafEnvironment {
  Development = 'development',
  Testing = 'testing',
  Production = 'production',
}

export const FrameleafEnvironmentSchema = z
  .enum(FrameleafEnvironment)
  .describe('Frameleaf environment')
  .meta({ id: 'ImmichEnvironment' });
