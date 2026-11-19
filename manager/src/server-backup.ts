// Server Backup: Manager's second job. It keeps an encrypted copy of chosen folders, runs on a schedule,
// and restores a file, a folder or everything. The work happens in a separate process
// (server-backup-worker.ts); this file owns the settings, the history and what the screens show.
import { DEFAULT_RETENTION, Repository, dirStore, escrowPassphraseProblem, find, listFolder, parseRecoveryCode, unwrapBucketKey, wrapBucketKey, type KeyEscrowBlob, readFile as readStored, recoveryCode, s3Store, type RetentionPolicy } from '@frameleaf/backup-core';
import { fork, type ChildProcess } from 'node:child_process';
import { hkdfSync, randomBytes } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { CloudError } from './cloud-link.js';
import { Refusal } from './contracts.js';
import { reasonOf, type CloudBackup, type Session } from './server-backup-cloud.js';
import { RECORD, type Job, type Message, type Outcome, type Progress, type Reply, type Target } from './server-backup-worker.js';
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
/**
 * Where a server's backups sit in its Cloud storage. It follows from the recovery key alone, so a
 * replacement server that is given the key finds them without being told anything else. It says nothing about the key.
 */
export function vaultOf(rootKey: string): string {
  const bytes = Buffer.from(hkdfSync('sha256', Buffer.from(rootKey, 'hex'), Buffer.alloc(0), 'frameleaf-server-backup vault', 16));
  // Shaped as a version 8 UUID (RFC 9562: a vendor's own scheme), which is what Cloud takes as a vault id.
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const within = (folder: string, other: string) => folder === other || folder.startsWith(other.endsWith(sep) ? other : other + sep);

export class ServerBackup {
  private child: ChildProcess | null = null;
  private current: Run | null = null;
  private stopping = false;
  /** True while a run is being set up with Cloud, before its worker exists. */
  private starting = false;
  /** Why Manager itself ended the run in flight, when it did. */
  private cause: string | null = null;
  private repository: Repository | null = null;
  /** For the speed shown while a backup runs. */
  private pace: { at: number; bytes: number; perSecond: number } | null = null;

  constructor(
    private store: Store,
    private options: {
      /** A folder to keep backups in, for tests and pre-release. When set, it is used and Cloud is not. */
      target: Target | null;
      /** This Manager's link to Frameleaf Cloud, where backups go. With neither, Server Backup stays hidden. */
      cloud?: CloudBackup | null;
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

  private available() {
    if (!this.options.target && !this.options.cloud) throw new Refusal('server_backup_unavailable');
  }
  /** Where a run reads and writes, and what it holds in Cloud while it goes (nothing, for a folder). */
  private async place(kind: 'backup' | 'restore', rootKey: string, onLost?: () => void): Promise<{ target: Target; session: Session | null }> {
    this.available();
    if (this.options.target) return { target: this.options.target, session: null };
    const cloud = this.options.cloud!;
    if (!cloud.linked) throw new Refusal('server_backup_cloud_not_linked');
    const session = await cloud.begin(kind, vaultOf(rootKey), onLost);
    return { target: { kind: 'cloud', ...session.place, limitMbps: this.saved().settings.limitMbps }, session };
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
    this.available();
    const settings = this.checked(Settings.parse(input));
    if (settings.folders.length === 0) throw new Refusal('server_backup_no_folders');
    await this.rootKey(true);
    this.save({ on: true, settings });
  }
  setSettings(input: unknown) {
    this.save({ settings: this.checked(Settings.parse(input)) });
  }
  /** Shown during set-up, until the owner confirms it is saved. After that Manager asks for the password first. */
  async firstKey() {
    if (this.saved().keySavedAt !== null) throw new Refusal('server_backup_key_already_saved');
    this.available();
    return ServerBackup.shown(await this.rootKey(true));
  }
  async key() {
    return ServerBackup.shown(await this.rootKey(false));
  }
  /** The key as the owner sees and writes it down: the same `FLRK-` code the photo app's recovery kit uses. */
  private static shown(key: string) {
    return { code: recoveryCode(Buffer.from(key, 'hex')) };
  }
  /**
   * On a server that replaces another: the recovery key saved from the old one, so its backups open here.
   * Only before this Manager has a key of its own; a key in use is never swapped.
   */
  async adoptKey(input: unknown) {
    const text = z.string().max(200).parse(input);
    const bare = text.replaceAll(/\s/g, '');
    const key = /^[0-9a-f]{64}$/i.test(bare) ? bare.toLowerCase() : parseRecoveryCode(text)?.toString('hex');
    if (!key) throw new Refusal('server_backup_key_wrong');
    this.available();
    const existing = (await readFile(this.keyFile(), 'utf8').catch(() => null))?.trim();
    // This Manager's own key, back for its own older backups (after disconnecting and connecting again).
    if (existing === key) {
      this.repository = null;
      this.save({ keySavedAt: this.saved().keySavedAt ?? Date.now() });
      await this.refreshSnapshots();
      return;
    }
    if (existing) throw new Refusal('server_backup_key_exists');
    // Kept only once it has opened the backups it is for: a wrong key would otherwise be this server's key for good.
    // Nothing stored under this key's vault, or a store it does not open: either way it is not the key.
    const repository = await this.open(key).catch((error) => {
      if (error instanceof CloudError || (error instanceof Refusal && error.code !== 'server_backup_nothing_stored')) throw error;
      throw new Refusal('server_backup_key_wrong');
    });
    await writeFile(this.keyFile(), key, { mode: 0o600, flag: 'wx' });
    await chmod(this.keyFile(), 0o600);
    this.repository = repository;
    this.save({ keySavedAt: Date.now() });
    await this.refreshSnapshots();
  }
  confirmKeySaved() {
    this.save({ keySavedAt: Date.now() });
  }
  /** Backups stop. What is stored stays where it is and stays restorable. */
  turnOff() {
    if (this.child) throw new Refusal('server_backup_busy');
    this.save({ on: false });
  }
  /**
   * Asks Frameleaf Cloud to delete everything stored for this server. Backups stop at once; what is stored stays
   * restorable through Cloud's 30-day hold, and the owner can keep it until then.
   */
  async deleteBackups() {
    if (this.child || this.starting) throw new Refusal('server_backup_busy');
    if (!this.options.cloud?.linked) throw new Refusal('server_backup_cloud_not_linked');
    const purge = await this.options.cloud.requestPurge();
    this.save({ on: false });
    return purge;
  }

  /**
   * Keeps a copy of the recovery key in Frameleaf Cloud, locked with a passphrase here first: Cloud can't open it.
   * Off by default; the owner chooses it.
   */
  async keepKeyCopy(passphrase: string) {
    if (!this.options.cloud?.linked) throw new Refusal('server_backup_cloud_not_linked');
    if (escrowPassphraseProblem(passphrase)) throw new Refusal('server_backup_passphrase_short');
    await this.options.cloud.putKeyCopy(await wrapBucketKey(Buffer.from(await this.rootKey(false), 'hex'), passphrase));
  }
  async dropKeyCopy() {
    if (!this.options.cloud?.linked) throw new Refusal('server_backup_cloud_not_linked');
    await this.options.cloud.dropKeyCopy();
  }
  /** On a server that took another's backups over: the key from that server's locked copy, opened with its passphrase. */
  async adoptKeyCopy(passphrase: string) {
    if (!this.options.cloud?.linked) throw new Refusal('server_backup_cloud_not_linked');
    const blob = (await this.options.cloud.keyCopy()) as KeyEscrowBlob | null;
    if (!blob) throw new Refusal('server_backup_no_key_copy');
    const key = await unwrapBucketKey(blob, passphrase).catch(() => {
      throw new Refusal('server_backup_passphrase_wrong');
    });
    await this.adoptKey(key.toString('hex'));
  }

  /** Disconnects from Frameleaf Cloud: backups stop, and what this Manager knew of the stored ones is forgotten. The key stays. */
  async disconnect() {
    if (this.child || this.starting) throw new Refusal('server_backup_busy');
    if (!this.options.cloud?.linked) throw new Refusal('server_backup_cloud_not_linked');
    // Holds off any run, by hand or on schedule, while Cloud is asked; released if Cloud can't be reached.
    this.starting = true;
    try {
      await this.options.cloud.unlink();
      this.repository = null;
      this.save({ on: false, snapshots: [], sizes: {} });
    } finally {
      this.starting = false;
    }
  }

  private async launch(kind: RunKind, trigger: Run['trigger'], rootKey: string, work: (target: Target, session: Session | null) => Job): Promise<Run> {
    if (this.child || this.starting) throw new Refusal('server_backup_busy');
    this.starting = true;
    let placed: Awaited<ReturnType<ServerBackup['place']>>;
    try {
      // Cloud's lease is lost: stop at once, without the tidy ending a stop by hand gets.
      placed = await this.place(kind === 'backup' ? 'backup' : 'restore', rootKey, () => {
        this.cause = 'cloud_lease_lost';
        this.child?.kill('SIGKILL');
      });
    } finally {
      this.starting = false;
    }
    const { session } = placed;
    const job = work(placed.target, session);
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
    this.cause = null;
    this.pace = null;
    let saved = 0;
    const settle = (change: Partial<Run>) => {
      if (this.current !== run) return;
      Object.assign(run, change, { finishedAt: Date.now() });
      this.saveRun(run);
      this.child = null;
      this.current = null;
      this.repository = null;
      const done = run.outcome?.kind === 'backup' ? run.outcome : null;
      void session?.end(
        kind === 'backup'
          ? { startedAt: run.startedAt, state: run.state === 'running' ? 'failed' : run.state, bytes: done?.storedBytes ?? 0, files: done?.files ?? 0, snapshot: done?.snapshot ?? null, error: run.error }
          : undefined,
      );
    };
    const failure = (message: string): Partial<Run> =>
      this.cause ? { state: 'failed', error: this.cause } : this.stopping || message === 'stopped' ? { state: 'stopped' } : { state: 'failed', error: message };
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
      } else if (message.type === 'ask') {
        const { id, ask } = message;
        const reply = (answer: Omit<Reply, 'type' | 'id'>) => child.connected && child.send({ type: 'answer', id, ...answer } satisfies Reply);
        // Only a run on Cloud storage asks, and it always has a session.
        (ask.what === 'credentials' ? session!.credentials(ask.operation, ask.renew) : session!.record(ask.stored)).then(
          (value) => reply({ value }),
          (error: unknown) => reply({ error: ask.what === 'record' ? 'cloud_record_failed' : reasonOf(error) }),
        );
      } else settle(failure(message.message));
    });
    child.on('exit', () => settle(failure('worker_exited')));
    child.send(job);
    return run;
  }

  async backUp(trigger: Run['trigger'] = 'you', now = new Date()): Promise<Run> {
    const saved = this.saved();
    if (!saved.on) throw new Refusal('server_backup_off');
    // ponytail: thinning old backups rides along once a week (Sunday's run); give it its own schedule if owners ask.
    const rootKey = await this.rootKey(false);
    return this.launch('backup', trigger, rootKey, (target, session) => ({
      kind: 'backup',
      target,
      rootKey,
      folders: [...this.options.always, ...saved.settings.folders],
      always: this.options.always,
      exclusions: saved.settings.exclusions,
      retention: saved.settings.retention,
      prune: trigger === 'schedule' && now.getDay() === 0,
      ...(session?.sequence ? { sequence: session.sequence } : {}),
    }));
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
    const rootKey = await this.rootKey(false);
    return this.launch('restore', 'you', rootKey, (target) => ({ kind: 'restore', target, rootKey, snapshot, items, into: into === null ? null : resolve(into) }));
  }

  stop() {
    if (!this.child) return;
    this.stopping = true;
    this.child.kill('SIGTERM');
  }

  /** Called every minute. Starts the day's backup at its time, and stops a scheduled one when its window closes. */
  async tick(now = new Date()): Promise<void> {
    const saved = this.saved();
    if (!saved.on || (!this.options.target && !this.options.cloud?.linked)) return;
    const { time, stop } = saved.settings.schedule;
    if (this.current?.trigger === 'schedule' && this.current.kind === 'backup' && stop && clock(now) === stop) return this.stop();
    if (this.child || clock(now) !== time || saved.scheduledOn === day(now)) return;
    this.save({ scheduledOn: day(now) });
    // A backup that could not even start is still part of the history, with its reason.
    await this.backUp('schedule', now).catch((error) => {
      const value: Omit<Run, 'id'> = { kind: 'backup', trigger: 'schedule', state: 'failed', startedAt: now.getTime(), finishedAt: Date.now(), progress: null, outcome: null, error: reasonOf(error) };
      this.store.db.prepare('INSERT INTO server_backup_runs (value) VALUES (?)').run(JSON.stringify(value));
    });
  }

  private async opened(): Promise<Repository> {
    this.repository ??= await this.open(await this.rootKey(false));
    return this.repository;
  }
  /** Opens what `rootKey` protects, where this Manager keeps backups. */
  private async open(rootKey: string): Promise<Repository> {
    const { target, session } = await this.place('restore', rootKey);
    const store =
      target.kind === 'folder'
        ? dirStore(target.path)
        : s3Store({ endpoint: target.endpoint, region: target.region, bucket: target.bucket, prefix: target.prefix, credentials: (renew) => session!.credentials('restore', renew) });
    if ((await store.list('config')).length === 0) throw new Refusal('server_backup_nothing_stored');
    const repository = await Repository.open(store, { rootKey: Buffer.from(rootKey, 'hex') });
    await repository.loadIndex();
    return repository;
  }
  private async refreshSnapshots() {
    const repository = await this.opened();
    const snapshots: Saved['snapshots'] = [];
    for (const { key } of await repository.listSnapshots()) snapshots.push({ key, time: (await repository.readSnapshot(key)).time });
    this.save({ snapshots });
  }

  /**
   * What one backup protected, as it recorded itself: the folders, whose they are and their sizes. This is
   * what a replacement server offers back. Null for a backup from before backups kept this record.
   */
  async contents(input: unknown) {
    const { snapshot } = z.object({ snapshot: z.string().regex(/^s\/\d{12}-[0-9a-f]{16,64}$/) }).strict().parse(input);
    const repository = await this.opened();
    const entry = await find(repository, await repository.readSnapshot(snapshot), RECORD).catch(() => null);
    if (!entry || entry.type !== 'file' || entry.size > 1024 * 1024) return { folders: null };
    const parts: Buffer[] = [];
    for await (const part of readStored(repository, entry)) parts.push(part);
    const record = z
      .object({ folders: z.array(z.object({ path: z.string().min(1).max(4096), kind: z.enum(['manager', 'folder']), files: z.number().int().nonnegative(), bytes: z.number().nonnegative() })).max(100) })
      .safeParse(JSON.parse(Buffer.concat(parts).toString('utf8')));
    // What the old server wrote decides nothing here: a folder is only offered back where this Manager may write.
    return { folders: record.success ? record.data.folders.map((folder) => ({ ...folder, reachable: this.options.inside(resolve(folder.path)) })) : null };
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
        .filter((entry) => entry.type !== 'symlink' && !(path.length === 0 && entry.name === RECORD[0]))
        .map((entry) => ({ name: entry.name, type: entry.type === 'dir' ? 'folder' : 'file', bytes: entry.size, modified: entry.mtime })),
    };
  }

  /** Everything the Server Backup screens show, or null when this Manager has nowhere to back up to. */
  view(now = new Date()) {
    if (!this.options.target && !this.options.cloud) return null;
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
      /** Null when backups go to a folder: there is nothing to connect. */
      cloud: this.options.target ? null : (this.options.cloud?.view() ?? null),
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
