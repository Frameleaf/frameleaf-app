import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Refusal, type SourceFence } from './contracts.js';
import { SOURCE_RESTORE_READER, sourceRestoreName, type Docker, type SourceRestore } from './docker.js';
import { type Fencing } from './fencing.js';
import { fileHash } from './files.js';
import { type ImportPlan } from './import-plan.js';
import { type PhotoAppPlan } from './photo-app-sources.js';
import { captureFencedSqliteSource } from './source-capture.js';

/** The `capture-common-source` receipt. It holds no credentials: the copy's password stays in the private store. */
export type PhotoAppCapture = {
  fence: SourceFence;
  originalsPath: string;
  sourceRootPath: string;
  source: ImportPlan['source'];
  database: 'sqlite' | 'mysql' | 'postgres';
  /** SQLite snapshot inside the operation's private staging directory. */
  snapshotPath?: string;
  /** Disposable restored copy of a MySQL/PostgreSQL source, reached by the preparation over its loopback. */
  restore?: {
    name: string;
    container: string;
    engine: 'mysql' | 'postgres';
    database: string;
  };
};
export type PhotoAppCaptureOptions = {
  operationId: string;
  stagingRoot: string;
  /** Fresh random passwords for the copy's root and its read-only reader, already in the Manager's private store. */
  restoreSecrets?: { root: string; reader: string };
  /** Journals the copy's name before it is created, so cancellation and recovery always remove it. */
  beforeRestore?: (name: string) => Promise<void> | void;
  readyAttempts?: number;
  readyDelayMs?: number;
};

const sourceIdentity = (plan: PhotoAppPlan) => ({
  kind: plan.kind,
  version: plan.version ?? 'unknown',
  identity: plan.container,
});

/** The caller owns the operation lock and has journaled the fence before anything stops. */
export async function capturePhotoAppSource(
  fencing: Fencing,
  docker: Docker,
  plan: PhotoAppPlan,
  options: PhotoAppCaptureOptions,
): Promise<PhotoAppCapture> {
  const { fence, originalsPath, sourceRootPath } = plan;
  if (plan.sqlitePath) {
    const snapshot = await captureFencedSqliteSource(fencing, fence, {
      databasePath: plan.sqlitePath,
      stagingRoot: options.stagingRoot,
    });
    return {
      fence,
      originalsPath,
      sourceRootPath,
      database: 'sqlite',
      snapshotPath: snapshot.path,
      source: {
        ...sourceIdentity(plan),
        revision: snapshot.sha256,
        schemaSha256: snapshot.schemaSha256,
      },
    };
  }
  const server = plan.server;
  if (!server || !options.restoreSecrets || !options.beforeRestore) throw new Refusal('invalid_import_authority');
  // The app containers stop; the database container keeps running so its own client can dump it.
  await fencing.stop(fence);
  const directory = join(options.stagingRoot, 'source-database');
  await mkdir(directory, { mode: 0o700, recursive: true });
  const dump = join(directory, server.engine === 'mysql' ? 'source.sql' : 'source.pgdump');
  await rm(dump, { force: true });
  await docker.dumpSourceDatabase(server, dump);
  await fencing.verify(fence);
  const sha256 = await fileHash(dump);
  const restore: SourceRestore = {
    engine: server.engine,
    name: sourceRestoreName(options.operationId),
    image: server.image,
    database: server.name,
    password: options.restoreSecrets.root,
  };
  await options.beforeRestore(restore.name);
  // A retried capture replaces an earlier, possibly half-loaded copy.
  await docker.removeSourceRestore(restore.name);
  const container = await docker.startSourceRestore(restore, options.operationId);
  let ready = false;
  for (let attempt = 0; attempt < (options.readyAttempts ?? 180) && !ready; attempt++) {
    if (attempt) await sleep(options.readyDelayMs ?? 1000);
    ready = await docker.sourceRestoreReady(restore);
  }
  if (!ready) throw new Refusal('source_database_restore_failed');
  await docker.restoreSourceDatabase(restore, dump);
  // The readers need a read-only server and a reader account with no write grants and no roles.
  await docker.secureSourceRestore(restore, options.restoreSecrets.reader);
  await fencing.verify(fence);
  return {
    fence,
    originalsPath,
    sourceRootPath,
    database: server.engine,
    // The dump is the frozen evidence: its hash is both the revision and the schema identity.
    source: { ...sourceIdentity(plan), revision: sha256, schemaSha256: sha256 },
    restore: {
      name: restore.name,
      container,
      engine: server.engine,
      database: server.name,
    },
  };
}

/** The preparation's view of the copy: the read-only reader over loopback, through the shared network namespace. */
export function restoreDatabaseUrl(restore: NonNullable<PhotoAppCapture['restore']>, readerPassword: string): string {
  const url = new URL(
    restore.engine === 'mysql'
      ? `mysql://${SOURCE_RESTORE_READER}@127.0.0.1:3306/${restore.database}`
      : `postgres://${SOURCE_RESTORE_READER}@127.0.0.1:5432/${restore.database}`,
  );
  url.password = encodeURIComponent(readerPassword);
  return url.toString();
}
