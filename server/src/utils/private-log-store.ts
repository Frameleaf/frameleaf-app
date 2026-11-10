import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { redactPrivateLog } from 'src/utils/private-log-redaction.js';

export const privateLogWorkers = ['api', 'microservices', 'maintenance', 'machine-learning'] as const;
export const privateLogLevels = ['verbose', 'debug', 'log', 'warn', 'error', 'fatal'] as const;
export type PrivateLogWorker = (typeof privateLogWorkers)[number];
export type PrivateLogLevel = (typeof privateLogLevels)[number];

export type PrivateLogInput = {
  level: PrivateLogLevel;
  context: string;
  message: string;
  requestId?: string;
  route?: string;
  jobName?: string;
  jobId?: string;
  assetId?: string;
  at?: string;
};
type PrivateLog = PrivateLogInput & { at: string; id: string; worker: PrivateLogWorker };
export type PrivateLogQuery = {
  worker?: PrivateLogWorker;
  level?: PrivateLogLevel;
  q?: string;
  since?: string;
  before?: string;
  after?: string;
  limit: number;
};

const DAY_MS = 86_400_000;
const dayKey = (date: Date) => date.toISOString().slice(0, 10).replaceAll('-', '');
const fileNamePattern = /^(api|microservices|maintenance|machine-learning)-(\d{8})-\d{13}-[a-f0-9-]{36}\.jsonl$/u;
const cursor = (entry: PrivateLog) => `${entry.at}|${entry.id}`;
const safeId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
const safeLabel = /^[a-z0-9_.:/()-]{1,160}$/iu;
const sanitize = (value: string | undefined, pattern: RegExp) => (value && pattern.test(value) ? value : undefined);
const notFound = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

export class PrivateLogStore {
  private current = new Map<PrivateLogWorker, { name: string; day: string; bytes: number }>();

  constructor(
    private root: string,
    private days = 7,
    private workerBytes = 50 * 1024 ** 2,
    private segmentBytes = 4 * 1024 ** 2,
  ) {}

  async append(worker: PrivateLogWorker, inputs: readonly PrivateLogInput[], now = new Date()): Promise<void> {
    if (inputs.length === 0) return;
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if (!(await lstat(this.root)).isDirectory()) return;
    const day = dayKey(now);
    const rows = inputs.map((entry) => {
      const parsed = entry.at ? new Date(entry.at) : now;
      const at = !Number.isNaN(parsed.getTime()) && parsed <= now ? parsed.toISOString() : now.toISOString();
      return (
        JSON.stringify({
          id: randomUUID(),
          worker,
          at,
          level: entry.level,
          context: sanitize(entry.context, safeLabel) ?? 'Worker',
          message: redactPrivateLog(entry.message),
          requestId: sanitize(entry.requestId, safeId),
          route: sanitize(entry.route, safeLabel),
          jobName: sanitize(entry.jobName, safeLabel),
          jobId: sanitize(entry.jobId, safeId),
          assetId: sanitize(entry.assetId, safeId),
        } satisfies PrivateLog) + '\n'
      );
    });

    let active = this.current.get(worker);
    let batch: string[] = [];
    const write = async () => {
      if (!active || batch.length === 0) return;
      const file = await open(
        join(this.root, active.name),
        constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await file.writeFile(batch.join(''), 'utf8');
      } finally {
        await file.close();
      }
      batch = [];
    };
    for (const row of rows) {
      const bytes = Buffer.byteLength(row);
      if (!active || active.day !== day || active.bytes + bytes > this.segmentBytes) {
        await write();
        active = { name: `${worker}-${day}-${now.getTime()}-${randomUUID()}.jsonl`, day, bytes: 0 };
        this.current.set(worker, active);
      }
      batch.push(row);
      active.bytes += bytes;
    }
    await write();
    await this.prune(worker, now);
  }

  async prune(worker?: PrivateLogWorker, now = new Date()): Promise<void> {
    const cutoff = dayKey(new Date(now.getTime() - (this.days - 1) * DAY_MS));
    const bytes = new Map<PrivateLogWorker, number>();
    for (const file of await this.files(worker)) {
      const path = join(this.root, file.name);
      const total = (bytes.get(file.worker) ?? 0) + file.bytes;
      if (file.day >= cutoff && total <= this.workerBytes) {
        bytes.set(file.worker, total);
      } else {
        await unlink(path).catch((error: unknown) => {
          if (!notFound(error)) throw error;
        });
      }
    }
  }

  async list(query: PrivateLogQuery, now = new Date()): Promise<{ entries: PrivateLog[]; nextCursor: string | null }> {
    const entries: PrivateLog[] = [];
    for await (const batch of this.read(query, now)) {
      entries.push(...batch);
      entries.sort((left, right) =>
        query.after ? cursor(left).localeCompare(cursor(right)) : cursor(right).localeCompare(cursor(left)),
      );
      entries.length = Math.min(entries.length, query.limit + 1);
    }
    const nextCursor = entries.length > query.limit ? cursor(entries[query.limit - 1]) : null;
    return { entries: entries.slice(0, query.limit), nextCursor };
  }

  async *read(query: Omit<PrivateLogQuery, 'limit'>, now = new Date()) {
    const retained = new Date(now.getTime() - (this.days - 1) * DAY_MS);
    retained.setUTCHours(0, 0, 0, 0);
    const since = query.since ? new Date(Math.max(retained.getTime(), Date.parse(query.since))) : retained;
    const search = query.q?.toLowerCase();
    const afterAt = query.after ? Date.parse(query.after.split('|', 1)[0]) : 0;
    for (const item of await this.files(query.worker)) {
      if (item.day < dayKey(since)) break;
      if (item.modified < afterAt) continue;
      const file = await open(join(this.root, item.name), constants.O_RDONLY | constants.O_NOFOLLOW).catch(
        (error: unknown) => {
          if (!notFound(error)) throw error;
        },
      );
      if (!file) continue;
      let content: string;
      try {
        const bytes = Buffer.alloc(Math.min(item.bytes, this.segmentBytes + 16_384));
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        content = bytes.subarray(0, bytesRead).toString('utf8');
      } finally {
        await file.close();
      }
      const entries: PrivateLog[] = [];
      // A worker can be killed midway through the last append. Other complete rows stay readable.
      for (const line of content.split('\n').slice(0, -1)) {
        try {
          const entry = JSON.parse(line) as PrivateLog;
          if (
            entry.at < since.toISOString() ||
            (query.level && entry.level !== query.level) ||
            (query.before && cursor(entry) >= query.before) ||
            (query.after && cursor(entry) <= query.after) ||
            (search && !`${entry.context} ${entry.message}`.toLowerCase().includes(search))
          )
            continue;
          entries.push(entry);
        } catch {
          // A damaged line does not prevent access to adjacent entries.
        }
      }
      if (entries.length > 0) yield entries;
    }
  }

  private async files(worker?: PrivateLogWorker) {
    const root = await lstat(this.root).catch((error: unknown) => {
      if (!notFound(error)) throw error;
    });
    if (!root?.isDirectory()) return [];
    const files = [];
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      const match = fileNamePattern.exec(entry.name);
      if (!entry.isFile() || !match || (worker && worker !== match[1])) continue;
      const info = await lstat(join(this.root, entry.name)).catch((error: unknown) => {
        if (!notFound(error)) throw error;
      });
      if (info?.isFile())
        files.push({
          name: entry.name,
          worker: match[1] as PrivateLogWorker,
          day: match[2],
          bytes: info.size,
          modified: info.mtimeMs,
        });
    }
    return files.sort((left, right) => right.day.localeCompare(left.day) || right.name.localeCompare(left.name));
  }
}
