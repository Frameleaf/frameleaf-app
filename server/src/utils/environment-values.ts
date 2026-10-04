import z from 'zod';

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

export enum ImmichEnvironment {
  Development = 'development',
  Testing = 'testing',
  Production = 'production',
}

export const ImmichEnvironmentSchema = z
  .enum(ImmichEnvironment)
  .describe('Frameleaf environment')
  .meta({ id: 'ImmichEnvironment' });
