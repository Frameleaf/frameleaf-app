import { createHash } from 'node:crypto';
import { z } from 'zod';

export class Refusal extends Error {
  constructor(
    readonly code: string,
    readonly status = 409,
  ) {
    super(code);
  }
}
export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const digest = (value: unknown): string => sha256(JSON.stringify(value));
export const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/);
export const containerId = z.string().regex(/^[a-f0-9]{64}$/);
export const releaseTag = z.string().regex(/^frameleaf-v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?-\d+$/);
export const imageDigest = z.string().regex(/^[a-z0-9./:_-]+@sha256:[a-f0-9]{64}$/);
export const secureToken = z.string().regex(/^[a-f0-9]{64}$/);

export type Mount = { type: 'bind' | 'volume'; source: string; target: string; readOnly: boolean };
export type Database = { container: string; host: string; port: number; name: string; user: string; password: string };
export type Source = {
  id: string;
  project: string | null;
  version: string;
  image: string;
  app: string;
  workers: string[];
  database: Database;
  mounts: Mount[];
  environment: Record<string, string>;
  settings: Record<string, unknown> | null;
  settingsAuthority: 'database' | 'file';
  unsupportedSettings: string[];
  fingerprint: string;
  platform: 'docker' | 'unraid';
  postgres: { major: number; version: string; extensions: { name: string; version: string }[]; identity: string };
  summary: { users: number; assets: number; albums: number; databaseBytes: number };
  restart: Record<string, { Name: string; MaximumRetryCount: number }>;
};
export type Backup = {
  name: string;
  source: string;
  database: string;
  takenAt: number;
  verified: boolean;
  sha256: string;
};
export function recentBackup(backups: Backup[], source: Source, now = Date.now()): Backup | undefined {
  return backups
    .filter(
      (b) =>
        b.source === source.id &&
        b.database === source.postgres.identity &&
        b.verified &&
        now - b.takenAt >= 0 &&
        now - b.takenAt <= 86_400_000 &&
        /^[a-f0-9]{64}$/.test(b.sha256),
    )
    .sort((a, b) => b.takenAt - a.takenAt)[0];
}
export type OperationKind =
  'install' | 'import' | 'update' | 'backup' | 'restore' | 'start' | 'stop' | 'restart' | 'recover-source';
export type Operation = {
  id: string;
  kind: OperationKind;
  state: 'running' | 'interrupted' | 'failed' | 'complete';
  step: string | null;
  completed: string[];
  error: string | null;
  createdAt: number;
  updatedAt: number;
  input: Record<string, unknown>;
  receipts: Record<string, unknown>;
};
export type Installation = {
  name?: string;
  id: string;
  project: string;
  release: string;
  port: number;
  ml: boolean;
  origin: 'new_library' | 'new_import' | 'restored_library';
  /** Original Manager import identity carried by reviewed canonical restore lineage. */
  importInstallation?: string;
  /** Stable database-backup lineage, independent of the current Compose stack identity. */
  libraryId?: string;
  mounts: Mount[];
  sourceId: string | null;
  mayHaveWrittenMedia: boolean;
  databaseRoot: string;
  databasePath: string;
};
export type NasManifest = {
  schemaVersion: 3;
  tag: string;
  sourceCommit: string;
  buildRun: string;
  images: {
    server: string;
    machineLearning: string;
    machineLearningVariants: Record<string, string>;
    postgres: string;
  };
  platforms: string[];
  minimumVersions: { synologyDsm: string; truenas: string; unraid: string };
};
export function publicSource(source: Source) {
  const { database, environment, settings, restart, ...safe } = source;
  return {
    ...safe,
    database: {
      name: database.name,
      user: database.user,
      host: database.host,
      port: database.port,
      credentials: database.password ? 'configured' : 'missing',
    },
    settings: Object.keys(settings ?? {}),
    environment: Object.keys(environment).sort(),
    backupScope: 'database-only' as const,
  };
}
/** Logs are never a route to Docker inspection output, environment values or command arguments. */
export function redact(text: string, secrets: string[] = []): string {
  for (const value of secrets.filter((v) => v.length >= 3).sort((a, b) => b.length - a.length))
    text = text.split(value).join('[redacted]');
  return text
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/((?:password|secret|token|authorization|cookie|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/\b(Bearer|Basic)\s+[^\s]+/gi, '$1 [redacted]')
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}
