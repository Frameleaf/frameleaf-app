// Server Backup: Manager's second job. It keeps an encrypted copy of chosen folders, runs on a schedule,
// and restores a file, a folder or everything. The work happens in a separate process
// (server-backup-worker.ts); this file owns the settings, the history and what the screens show.
import { DEFAULT_RETENTION, Repository, dirStore, listFolder, type RetentionPolicy } from '@frameleaf/backup-core';
import { fork, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Refusal } from './contracts.js';
import type { Job, Message, Outcome, Progress, Target } from './server-backup-worker.js';
import type { Store } from './store.js';

const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const Settings = z
  .object({
    folders: z.array(z.string().min(1).max(4096)).max(64),
    exclusions: z.array(z.string().min(1).max(200).regex(/^[^/\0]+\/?$/)).max(100),
    schedule: z.object({ time: Time, stop: Time.nullable() }).strict(),
    /** Megabits per second, or null for no limit. Applies once backups go to Frameleaf Cloud. */
    limitMbps: z.number().positive().max(10_000).nullable(),
    retention: z
      .object({ keepLast: z.number().int().min(1).max(100), keepDays: z.number().int().min(0).max(3650), keepMonthly: z.number().int().min(0).max(120) })
      .strict(),
  })
  .strict();
export type Settings = z.infer<typeof Settings>;

export const DEFAULT_SETTINGS: Settings = {
  folders: [],
  exclusions: ['*.tmp', 'cache/', 'Cache/', '.Trash-*/', 'node_modules/'],
  schedule: { time: '02:00', stop: null },
  limitMbps: null,
  retention: DEFAULT_RETENTION satisfies RetentionPolicy,
};

type RunKind = Job['kind'];
export interface Run {
  id: number;
  kind: RunKind;
  trigger: 'you' | 'schedule';
  state: 'running' | 'done' | 'failed' | 'stopped';
  startedAt: number;
  finishedAt: number | null;
  progress: Progress | null;
  outcome: Outcome | null;
  error: string | null;
}

interface Saved {
  on: boolean;
  settings: Settings;
  keySavedAt: number | null;
  sizes: Record<string, { files: number; bytes: number }>;
  snapshots: { key: string; time: string }[];
  /** The day (local, YYYY-MM-DD) the schedule last started a run, so it starts one a day. */
  scheduledOn: string | null;
}

const KEY = 'server-backup';
const day = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const clock = (date: Date) => `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
const within = (folder: string, other: string) => folder === other || folder.startsWith(other.endsWith(sep) ? other : other + sep);

export class ServerBackup {
  private child: ChildProcess | null = null;
  private current: Run | null = null;
  private stopping = false;
  private repository: Repository | null = null;
  /** For the speed shown while a backup runs. */
  private pace: { at: number; bytes: number; perSecond: number } | null = null;

  constructor(
    private store: Store,
    private options: {
      /** Where backups go. Null until this Manager has somewhere to put them: Server Backup then stays hidden. */
      target: Target | null;
      /** Whether Manager may read and restore this path: inside the folders mapped into it. */
      inside: (path: string) => boolean;
      /** Protected whatever the owner chooses: Manager's own recovery points. */
      always: string[];
    },
  ) {
    store.db.exec('CREATE TABLE IF NOT EXISTS server_backup_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT NOT NULL)');
    // A run cut short by a restart lost nothing it had stored; the next run carries on from there.
    for (const run of this.runs(50).filter((item) => item.state === 'running')) {
      this.saveRun({ ...run, state: 'stopped', finishedAt: Date.now(), error: 'manager_restarted' });
    }
  }

  private saved(): Saved {
    return this.store.get<Saved>(KEY) ?? { on: false, settings: DEFAULT_SETTINGS, keySavedAt: null, sizes: {}, snapshots: [], scheduledOn: null };
  }
  private save(change: Partial<Saved>) {
    this.store.set(KEY, { ...this.saved(), ...change });
  }

  runs(limit = 20): Run[] {
    const rows = this.store.db.prepare('SELECT id, value FROM server_backup_runs ORDER BY id DESC LIMIT ?').all(limit) as { id: number; value: string }[];
    return rows.map((row) => ({ ...(JSON.parse(row.value) as Omit<Run, 'id'>), id: row.id }));
  }
  private saveRun(run: Run) {
    const { id, ...value } = run;
    this.store.db.prepare('UPDATE server_backup_runs SET value=? WHERE id=?').run(JSON.stringify(value), id);
  }

  private keyFile() {
    return join(this.store.directory, 'server-backup.key');
  }
  /** The key that opens this server's backups. Made here once and kept only here. */
  private async rootKey(create: boolean): Promise<string> {
    const existing = await readFile(this.keyFile(), 'utf8').catch(() => null);
    if (existing) return existing.trim();
    if (!create) throw new Refusal('server_backup_key_missing');
    const key = randomBytes(32).toString('hex');
    await writeFile(this.keyFile(), key, { mode: 0o600, flag: 'wx' });
    await chmod(this.keyFile(), 0o600);
    return key;
  }

  private target(): Target {
    if (!this.options.target) throw new Refusal('server_backup_unavailable');
    return this.options.target;
  }

  /** Every folder must be one Manager can read, and none may sit inside another: that would store files twice. */
  private checked(settings: Settings): Settings {
    const folders = [...new Set(settings.folders.map((folder) => resolve(folder)))];
    for (const folder of folders) {
      if (!this.options.inside(folder)) throw new Refusal('server_backup_folder_outside', 409, folder);
      if ([...folders, ...this.options.always].some((other) => other !== folder && (within(folder, other) || within(other, folder))))
        throw new Refusal('server_backup_folders_overlap', 409, folder);
    }
    return { ...settings, folders };
  }

  async turnOn(input: unknown) {
    this.target();
    const settings = this.checked(Settings.parse(input));
    if (settings.folders.length === 0) throw new Refusal('server_backup_no_folders');
    await this.rootKey(true);
    this.save({ on: true, settings });
  }
  setSettings(input: unknown) {
    this.save({ settings: this.checked(Settings.parse(input)) });
  }
  /** Shown during set-up, until the owner confirms it is saved. After that Manager asks for the password first. */
  firstKey() {
    if (this.saved().keySavedAt !== null) throw new Refusal('server_backup_key_already_saved');
    this.target();
    return this.rootKey(true);
  }
  key() {
    return this.rootKey(false);
  }
  confirmKeySaved() {
    this.save({ keySavedAt: Date.now() });
  }
  /** Backups stop. What is stored stays where it is and stays restorable. */
  turnOff() {
    if (this.child) throw new Refusal('server_backup_busy');
    this.save({ on: false });
  }

  private async launch(kind: RunKind, trigger: Run['trigger'], job: Job): Promise<Run> {
    if (this.child) throw new Refusal('server_backup_busy');
    const value: Omit<Run, 'id'> = { kind, trigger, state: 'running', startedAt: Date.now(), finishedAt: null, progress: null, outcome: null, error: null };
    const { lastInsertRowid } = this.store.db.prepare('INSERT INTO server_backup_runs (value) VALUES (?)').run(JSON.stringify(value));
    const run: Run = { ...value, id: Number(lastInsertRowid) };
    // Built: the worker sits beside this file as JavaScript. Under tsx (tests) it is still TypeScript.
    const self = fileURLToPath(import.meta.url);
    const worker = self.replace(/server-backup\.(ts|js)$/, 'server-backup-worker.$1');
    const child = fork(worker, { execArgv: self.endsWith('.ts') ? ['--import', 'tsx'] : [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    this.child = child;
    this.current = run;
    this.stopping = false;
    this.pace = null;
    let saved = 0;
    const settle = (change: Partial<Run>) => {
      if (this.current !== run) return;
      Object.assign(run, change, { finishedAt: Date.now() });
      this.saveRun(run);
      this.child = null;
      this.current = null;
      this.repository = null;
    };
    child.on('message', (message: Message) => {
      if (message.type === 'progress') {
        const now = Date.now();
        if (this.pace && now > this.pace.at) {
          const perSecond = ((message.progress.bytes - this.pace.bytes) / (now - this.pace.at)) * 1000;
          this.pace = { at: now, bytes: message.progress.bytes, perSecond: this.pace.perSecond ? this.pace.perSecond * 0.7 + perSecond * 0.3 : perSecond };
        } else this.pace ??= { at: now, bytes: message.progress.bytes, perSecond: 0 };
        run.progress = message.progress;
        // The page reads progress from memory; the journal only needs it now and then.
        if (now - saved > 5000) {
          saved = now;
          this.saveRun(run);
        }
      } else if (message.type === 'done') {
        if (message.outcome.kind === 'backup') {
          const { snapshot, time, sizes } = message.outcome;
          this.save({ sizes, snapshots: [...this.saved().snapshots.filter((item) => item.key !== snapshot), { key: snapshot, time }] });
          // Retention may have removed older backups; the list is read again from storage when next browsed.
          if (message.outcome.removed > 0) void this.refreshSnapshots().catch(() => undefined);
        }
        settle({ state: 'done', outcome: message.outcome });
      } else settle(this.stopping || message.message === 'stopped' ? { state: 'stopped' } : { state: 'failed', error: message.message });
    });
    child.on('exit', () => settle(this.stopping ? { state: 'stopped' } : { state: 'failed', error: 'worker_exited' }));
    child.send(job);
    return run;
  }

  async backUp(trigger: Run['trigger'] = 'you', now = new Date()): Promise<Run> {
    const saved = this.saved();
    if (!saved.on) throw new Refusal('server_backup_off');
    // ponytail: thinning old backups rides along once a week (Sunday's run); give it its own schedule if owners ask.
    return this.launch('backup', trigger, {
      kind: 'backup',
      target: this.target(),
      rootKey: await this.rootKey(false),
      folders: [...this.options.always, ...saved.settings.folders],
      exclusions: saved.settings.exclusions,
      retention: saved.settings.retention,
      prune: trigger === 'schedule' && now.getDay() === 0,
    });
  }

  async restore(input: unknown): Promise<Run> {
    const { snapshot, items, into } = z
      .object({
        snapshot: z.string().regex(/^s\/\d{12}-[0-9a-f]{16,64}$/),
        items: z.array(z.array(z.string().min(1).max(255).regex(/^[^/\0]+$/)).min(1).max(256)).min(1).max(500),
        into: z.string().min(1).max(4096).nullable(),
      })
      .strict()
      .parse(input);
    for (const item of items) {
      const place = into === null ? sep + item.join(sep) : resolve(into);
      if (item.includes('..') || item.includes('.') || !this.options.inside(place)) throw new Refusal('server_backup_folder_outside', 409, place);
    }
    return this.launch('restore', 'you', { kind: 'restore', target: this.target(), rootKey: await this.rootKey(false), snapshot, items, into: into === null ? null : resolve(into) });
  }

  stop() {
    if (!this.child) return;
    this.stopping = true;
    this.child.kill('SIGTERM');
  }

  /** Called every minute. Starts the day's backup at its time, and stops a scheduled one when its window closes. */
  async tick(now = new Date()): Promise<void> {
    const saved = this.saved();
    if (!saved.on || !this.options.target) return;
    const { time, stop } = saved.settings.schedule;
    if (this.current?.trigger === 'schedule' && this.current.kind === 'backup' && stop && clock(now) === stop) return this.stop();
    if (this.child || clock(now) !== time || saved.scheduledOn === day(now)) return;
    this.save({ scheduledOn: day(now) });
    await this.backUp('schedule', now);
  }

  private async opened(): Promise<Repository> {
    if (!this.repository) {
      const repository = await Repository.open(dirStore(this.target().path), { rootKey: Buffer.from(await this.rootKey(false), 'hex') });
      await repository.loadIndex();
      this.repository = repository;
    }
    return this.repository;
  }
  private async refreshSnapshots() {
    const repository = await this.opened();
    const snapshots: Saved['snapshots'] = [];
    for (const { key } of await repository.listSnapshots()) snapshots.push({ key, time: (await repository.readSnapshot(key)).time });
    this.save({ snapshots });
  }

  /** What a folder held in one backup. An empty path is the top. */
  async browse(input: unknown) {
    const { snapshot, path } = z
      .object({ snapshot: z.string().regex(/^s\/\d{12}-[0-9a-f]{16,64}$/), path: z.array(z.string().min(1).max(255)).max(256) })
      .strict()
      .parse(input);
    const repository = await this.opened();
    const entries = await listFolder(repository, await repository.readSnapshot(snapshot), path).catch(() => {
      throw new Refusal('server_backup_no_such_folder');
    });
    return {
      path,
      entries: entries
        .filter((entry) => entry.type !== 'symlink')
        .map((entry) => ({ name: entry.name, type: entry.type === 'dir' ? 'folder' : 'file', bytes: entry.size, modified: entry.mtime })),
    };
  }

  /** Everything the Server Backup screens show, or null when this Manager has nowhere to back up to. */
  view(now = new Date()) {
    if (!this.options.target) return null;
    const saved = this.saved();
    const runs = this.runs();
    const lastBackup = runs.find((run) => run.kind === 'backup' && run.state !== 'running');
    const lastComplete = runs.find((run) => run.kind === 'backup' && run.state === 'done');
    const running = this.current;
    const progress = running?.progress;
    const perSecond = this.pace?.perSecond ?? 0;
    const due = new Date(now);
    const [hours, minutes] = saved.settings.schedule.time.split(':').map(Number) as [number, number];
    due.setHours(hours, minutes, 0, 0);
    if (due <= now || saved.scheduledOn === day(now)) due.setDate(due.getDate() + 1);
    return {
      state: saved.on ? 'on' : 'off',
      settings: saved.settings,
      key: { saved: saved.keySavedAt !== null, savedAt: saved.keySavedAt },
      folders: [
        ...this.options.always.map((path) => ({ kind: 'manager', path, ...saved.sizes[path] })),
        ...saved.settings.folders.map((path) => ({ kind: 'folder', path, ...saved.sizes[path] })),
      ],
      running: running
        ? {
            kind: running.kind,
            trigger: running.trigger,
            startedAt: running.startedAt,
            files: progress?.files ?? 0,
            bytes: progress?.bytes ?? 0,
            totalBytes: progress?.totalBytes ?? 0,
            bytesPerSecond: Math.round(perSecond),
            secondsLeft: progress && perSecond > 0 && progress.totalBytes > progress.bytes ? Math.round((progress.totalBytes - progress.bytes) / perSecond) : null,
          }
        : null,
      last: lastBackup ? { state: lastBackup.state, at: lastBackup.finishedAt ?? lastBackup.startedAt, error: lastBackup.error, completeAt: lastComplete?.finishedAt ?? null } : null,
      next: saved.on ? due.getTime() : null,
      runs: runs.map(({ id, kind, trigger, state, startedAt, finishedAt, outcome, error }) => ({ id, kind, trigger, state, startedAt, finishedAt, outcome, error })),
      snapshots: saved.snapshots.toSorted((a, b) => (a.key < b.key ? 1 : -1)),
    };
  }
}
