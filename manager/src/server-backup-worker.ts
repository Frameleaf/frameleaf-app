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
  verify,
  type RetentionPolicy,
  type Source,
  type Store,
} from '@frameleaf/backup-core';
import { sep } from 'node:path';

/** Where the repository lives. Frameleaf Cloud joins this list when Manager can link to it. */
export type Target = { kind: 'folder'; path: string };

export type Job = { target: Target; rootKey: string } & (
  | { kind: 'backup'; folders: string[]; exclusions: string[]; retention: RetentionPolicy; prune: boolean }
  | { kind: 'restore'; snapshot: string; items: string[][]; into: string | null }
  | { kind: 'verify' }
);

export type Progress = { files: number; bytes: number; totalFiles: number; totalBytes: number; storedBytes: number };
export type Outcome =
  | { kind: 'backup'; snapshot: string; time: string; files: number; bytes: number; storedBytes: number; problems: number; sizes: Record<string, { files: number; bytes: number }>; removed: number }
  | { kind: 'restore'; files: number; bytes: number; movedAside: number }
  | { kind: 'verify'; snapshots: number; missing: number; damaged: number };
export type Message = { type: 'progress'; progress: Progress } | { type: 'done'; outcome: Outcome } | { type: 'failed'; message: string };

const segments = (path: string) => path.split(sep).filter(Boolean);

/** `*.tmp` leaves out files by name; `cache/` leaves out folders by name. `*` stands for any run of characters. */
export function skips(patterns: string[]) {
  const compile = (pattern: string) =>
    new RegExp(`^${pattern.split('*').map((part) => part.replaceAll(/[.+?^${}()|[\]\\]/g, String.raw`\$&`)).join('.*')}$`, 'u');
  const folders = patterns.filter((pattern) => pattern.endsWith('/')).map((pattern) => compile(pattern.slice(0, -1)));
  const files = patterns.filter((pattern) => !pattern.endsWith('/')).map(compile);
  return (name: string, folder: boolean) => (folder ? folders : files).some((pattern) => pattern.test(name));
}

const open = (target: Target): Store => dirStore(target.path);

async function run(job: Job, report: (progress: Progress) => void, signal: AbortSignal): Promise<Outcome> {
  const store = open(job.target);
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
    });
    const removed = job.prune ? (await prune(repository, { policy: job.retention })).removedSnapshots.length : 0;
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
    )
      .then((outcome) => send({ type: 'done', outcome }))
      .catch((error: Error) => send({ type: 'failed', message: stop.signal.aborted ? 'stopped' : error.message }))
      .finally(() => process.disconnect?.());
  });
}
