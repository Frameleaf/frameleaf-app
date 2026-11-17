// Runs one Server Backup job in its own process, so hours of reading and encrypting never slow Manager's
// own pages. Manager forks this file, sends one job, and gets progress and one final answer back.
import {
  Repository,
  backup,
  dirStore,
  filterSource,
  fsSource,
  measureSource,
  mountSource,
  prune,
  restore,
  s3Store,
  verify,
  type RetentionPolicy,
  type Source,
  type Store,
} from '@frameleaf/backup-core';
import { sep } from 'node:path';

/** Where the repository lives: a folder (tests and pre-release), or storage that Frameleaf Cloud gives out credentials for. */
export type Target =
  | { kind: 'folder'; path: string }
  | { kind: 'cloud'; endpoint: string; region: string; bucket: string; prefix: string; limitMbps: number | null };

export type Job = { target: Target; rootKey: string } & (
  | { kind: 'backup'; folders: string[]; exclusions: string[]; retention: RetentionPolicy; prune: boolean; /** The backup's number in Cloud's signed history. */ sequence?: number }
  | { kind: 'restore'; snapshot: string; items: string[][]; into: string | null }
  | { kind: 'verify' }
);

export type Progress = { files: number; bytes: number; totalFiles: number; totalBytes: number; storedBytes: number };
export type Outcome =
  | { kind: 'backup'; snapshot: string; time: string; files: number; bytes: number; storedBytes: number; problems: number; sizes: Record<string, { files: number; bytes: number }>; removed: number }
  | { kind: 'restore'; files: number; bytes: number; movedAside: number }
  | { kind: 'verify'; snapshots: number; missing: number; damaged: number };
/** What only Manager can do for a run on Cloud storage: it holds the machine's key, the worker never does. */
export type Ask =
  | { what: 'credentials'; operation: 'upload' | 'restore' | 'prune'; renew: boolean }
  | { what: 'record'; stored: { key: string; versionId: string | null; ciphertextSha256: string; time: string } };
export type Message =
  | { type: 'progress'; progress: Progress }
  | { type: 'done'; outcome: Outcome }
  | { type: 'failed'; message: string }
  | { type: 'ask'; id: number; ask: Ask };
export type Reply = { type: 'answer'; id: number; value?: unknown; error?: string };
type Asker = (ask: Ask) => Promise<unknown>;

const segments = (path: string) => path.split(sep).filter(Boolean);

/** `*.tmp` leaves out files by name; `cache/` leaves out folders by name. `*` stands for any run of characters. */
export function skips(patterns: string[]) {
  const compile = (pattern: string) =>
    new RegExp(`^${pattern.split('*').map((part) => part.replaceAll(/[.+?^${}()|[\]\\]/g, String.raw`\$&`)).join('.*')}$`, 'u');
  const folders = patterns.filter((pattern) => pattern.endsWith('/')).map((pattern) => compile(pattern.slice(0, -1)));
  const files = patterns.filter((pattern) => !pattern.endsWith('/')).map(compile);
  return (name: string, folder: boolean) => (folder ? folders : files).some((pattern) => pattern.test(name));
}

const open = (target: Target, operation: 'upload' | 'restore' | 'prune', ask: Asker): Store =>
  target.kind === 'folder'
    ? dirStore(target.path)
    : s3Store({
        endpoint: target.endpoint,
        region: target.region,
        bucket: target.bucket,
        prefix: target.prefix,
        uploadLimit: () => (target.limitMbps === null ? null : target.limitMbps * 125_000),
        credentials: (renew) => ask({ what: 'credentials', operation, renew }) as Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken: string }>,
      });

async function run(job: Job, report: (progress: Progress) => void, signal: AbortSignal, ask: Asker): Promise<Outcome> {
  const store = open(job.target, job.kind === 'backup' ? 'upload' : 'restore', ask);
  const rootKey = Buffer.from(job.rootKey, 'hex');
  const started = (await store.list('config')).length > 0;
  if (!started && job.kind !== 'backup') throw new Error('Nothing has been backed up yet');
  const repository = started ? await Repository.open(store, { rootKey }) : await Repository.init(store, { rootKey });

  if (job.kind === 'backup') {
    const skip = skips(job.exclusions);
    const each = job.folders.map((folder) => ({
      folder,
      source: filterSource(fsSource(folder), (path, entry) => skip(path.at(-1)!, entry.type === 'dir')),
    }));
    // Measured first so progress can be shown as a share of the whole.
    const sizes: Record<string, { files: number; bytes: number }> = {};
    const total = { files: 0, bytes: 0 };
    for (const { folder, source } of each) {
      sizes[folder] = await measureSource(source);
      total.files += sizes[folder].files;
      total.bytes += sizes[folder].bytes;
    }
    const source: Source = mountSource(each.map(({ folder, source }) => ({ path: segments(folder), source })));
    const done = await backup(repository, source, {
      signal,
      onProgress: (progress) => report({ ...progress, totalFiles: total.files, totalBytes: total.bytes }),
      ...(job.sequence === undefined ? {} : { sequence: job.sequence }),
    });
    // Before anything is thinned, the new backup joins Cloud's signed history.
    if (job.target.kind === 'cloud') await ask({ what: 'record', stored: { key: done.key, versionId: done.versionId, ciphertextSha256: done.ciphertextSha256, time: done.snapshot.time } });
    // Removing needs credentials of its own, which uploading ones don't carry.
    const thinned = job.prune && job.target.kind === 'cloud' ? await Repository.open(open(job.target, 'prune', ask), { rootKey }) : repository;
    const removed = job.prune ? (await prune(thinned, { policy: job.retention })).removedSnapshots.length : 0;
    return {
      kind: 'backup',
      snapshot: done.key,
      time: done.snapshot.time,
      files: done.snapshot.stats.files,
      bytes: done.snapshot.stats.bytes,
      storedBytes: done.snapshot.stats.storedBytes,
      problems: done.problems.length,
      sizes,
      removed,
    };
  }

  await repository.loadIndex();
  if (job.kind === 'verify') {
    const result = await verify(repository);
    return { kind: 'verify', snapshots: result.snapshots, missing: result.missing.length, damaged: result.damagedSnapshots.length };
  }

  const snapshot = await repository.readSnapshot(job.snapshot);
  const result = { files: 0, bytes: 0, movedAside: 0 };
  for (const item of job.items) {
    signal.throwIfAborted();
    // Back where it was: a path in a backup is the path it had on this server.
    const into = job.into ?? sep + item.slice(0, -1).join(sep);
    const restored = await restore(repository, snapshot, item, into);
    result.files += restored.files;
    result.bytes += restored.bytes;
    result.movedAside += restored.movedAside.length;
    report({ files: result.files, bytes: result.bytes, totalFiles: 0, totalBytes: 0, storedBytes: 0 });
  }
  return { kind: 'restore', ...result };
}

if (process.send) {
  const stop = new AbortController();
  process.on('SIGTERM', () => stop.abort());
  const send = (message: Message) => process.send!(message);
  let last = 0;
  let asked = 0;
  const waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const ask: Asker = (question) =>
    new Promise((resolve, reject) => {
      waiting.set(++asked, { resolve, reject });
      send({ type: 'ask', id: asked, ask: question });
    });
  process.on('message', (reply: Reply) => {
    if (reply.type !== 'answer') return;
    const { resolve, reject } = waiting.get(reply.id) ?? {};
    waiting.delete(reply.id);
    if (reply.error === undefined) resolve?.(reply.value);
    else reject?.(new Error(reply.error));
  });
  process.once('message', (job: Job) => {
    run(
      job,
      (progress) => {
        // A few times a second is plenty for a progress bar.
        if (Date.now() - last >= 250) {
          last = Date.now();
          send({ type: 'progress', progress });
        }
      },
      stop.signal,
      ask,
    )
      .then((outcome) => send({ type: 'done', outcome }))
      .catch((error: Error) => send({ type: 'failed', message: stop.signal.aborted ? 'stopped' : error.message }))
      .finally(() => process.disconnect?.());
  });
}
