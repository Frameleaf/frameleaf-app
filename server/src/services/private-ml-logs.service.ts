import { Injectable } from '@nestjs/common';
import type { PrivateLogInput, PrivateLogStore } from 'src/utils/private-log-store.js';
import { OnEvent } from 'src/decorators.js';
import { FrameleafWorker } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { MachineLearningRepository } from 'src/repositories/machine-learning.repository.js';
import { privateLogStore } from 'src/utils/private-log-runtime.js';
import { privateLogLevels } from 'src/utils/private-log-store.js';

@Injectable()
export class PrivateMlLogsService {
  private timer?: NodeJS.Timeout;
  private busy = false;
  private since = '';
  private store?: PrivateLogStore;
  private initialized?: Promise<void>;
  private readonly seen = new Map<string, string>();

  constructor(
    private config: ConfigRepository,
    private ml: MachineLearningRepository,
  ) {}

  @OnEvent({ name: 'AppBootstrap', workers: [FrameleafWorker.Microservices] })
  start() {
    const env = this.config.getEnv();
    this.store = privateLogStore(env.logRetentionDays, env.storage.mediaLocation);
    this.initialized = this.restoreCursor(this.store).catch(() => {});
    this.timer = setInterval(() => void this.poll(), 5000).unref();
  }

  @OnEvent({ name: 'AppShutdown', workers: [FrameleafWorker.Microservices] })
  stop() {
    clearInterval(this.timer);
  }

  private async restoreCursor(store: PrivateLogStore) {
    const { entries } = await store.list({ worker: 'machine-learning', limit: 1 });
    if (entries.length === 0 || this.since) return;
    this.since = new Date(Date.parse(entries[0].at) - 60_000).toISOString();
    for await (const batch of store.read({ worker: 'machine-learning', since: this.since })) {
      for (const { id, at } of batch) {
        if (this.seen.size >= 25_000) return;
        this.seen.set(id, at);
      }
    }
  }

  private async poll() {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.initialized;
      const body = await this.ml.readBundledWorkerLogs(this.since);
      if (!body) return;
      const fresh = new Map<string, PrivateLogInput>();
      for (const line of body.split('\n').slice(0, 5000)) {
        if (!line) continue;
        try {
          const row = JSON.parse(line) as PrivateLogInput & { id?: string };
          if (
            typeof row.id !== 'string' ||
            row.id.length !== 36 ||
            this.seen.has(row.id) ||
            !privateLogLevels.includes(row.level) ||
            typeof row.message !== 'string' ||
            typeof row.at !== 'string' ||
            !Number.isFinite(Date.parse(row.at))
          )
            continue;
          fresh.set(row.id, {
            level: row.level,
            message: row.message,
            at: row.at,
            context: 'MachineLearning',
            sourceId: row.id,
          });
        } catch {
          // An invalid line does not discard the rest of the worker's log batch.
        }
      }
      await this.store?.append('machine-learning', fresh.values().toArray());
      for (const [id, { at }] of fresh) this.seen.set(id, at!);
      this.since = new Date(Date.now() - 60_000).toISOString();
      for (const [id, at] of this.seen) if (at < this.since) this.seen.delete(id);
      while (this.seen.size > 25_000) this.seen.delete(this.seen.keys().next().value!);
    } catch {
      // An unavailable local ML worker must not make the job worker unhealthy.
    } finally {
      this.busy = false;
    }
  }
}
