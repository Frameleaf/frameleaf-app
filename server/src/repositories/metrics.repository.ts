import { createHash, timingSafeEqual } from 'node:crypto';
import { type Server, createServer } from 'node:http';
import { type AddressInfo } from 'node:net';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { RequestHandler } from 'express';
import { JobName, QueueName } from 'src/enum.js';
import { assistantSwitchBack } from 'src/utils/assistant-switch-back.js';
import { claimsFrameleafVia, isHomeAddress } from 'src/utils/frameleaf-sign-in.js';

type QueueCounts = { waiting: number; active: number; failed: number };
type MetricsSources = {
  disk?: () => Promise<{ total: number; free: number; available: number }>;
  assets?: () => Promise<{ type: string; count: number }[]>;
  queues?: () => Promise<{ queue: string; counts: QueueCounts }[]>;
  database: () => { reserved: number; waiting: number; capacity: number };
};

const prefix = 'frameleaf_';
const jobNames = new Set<string>(Object.values(JobName));
const queueNames = new Set<string>(Object.values(QueueName));
const assetTypes = new Set(['IMAGE', 'VIDEO', 'AUDIO', 'OTHER']);
const digest = (value: string) => createHash('sha256').update(value).digest();

const refresh = (read: () => Promise<void>, intervalMs: number) => {
  let pending: Promise<void> | undefined;
  let next = 0;
  return () => {
    if (pending) return pending;
    if (Date.now() < next) return;
    pending = read().finally(() => {
      next = Date.now() + intervalMs;
      pending = undefined;
    });
    return pending;
  };
};

export class MetricsRepository {
  private readonly registry = new Registry();
  private readonly httpDuration = new Histogram({
    name: `${prefix}http_request_duration_seconds`,
    help: 'API request duration by registered route and response status',
    labelNames: ['route', 'status'] as const,
    registers: [this.registry],
  });
  private readonly jobs = new Counter({
    name: `${prefix}jobs_total`,
    help: 'Queue job attempts by registered job name and outcome',
    labelNames: ['job_name', 'outcome'] as const,
    registers: [this.registry],
  });
  private readonly desktopResultsAdopted = new Counter({
    name: `${prefix}desktop_results_adopted_total`,
    help: 'Desktop inference results adopted by committed Library queue jobs',
    registers: [this.registry],
  });
  private readonly collectors: Array<() => Promise<void> | void> = [];
  private server?: Server;

  constructor(sources?: MetricsSources) {
    collectDefaultMetrics({ register: this.registry, prefix });
    assistantSwitchBack.register(this.registry);
    if (!sources) return;

    const gauge = (name: string, help: string, labelNames: string[]) =>
      new Gauge({ name: `${prefix}${name}`, help, labelNames, registers: [this.registry] });
    const pool = gauge('database_pool_connections', 'Connections in use, waiting, and pool capacity', ['state']);
    this.collectors.push(() => {
      const state = sources.database();
      for (const [key, value] of Object.entries(state)) pool.set({ state: key }, value);
    });

    if (sources.disk) {
      const read = sources.disk;
      const disk = gauge('storage_bytes', 'Library filesystem space in bytes', ['state']);
      this.collectors.push(
        refresh(async () => {
          const value = await read().catch(() => null);
          disk.reset();
          if (value) {
            disk.set({ state: 'used' }, value.total - value.free);
            disk.set({ state: 'available' }, value.available);
          }
        }, 60_000),
      );
    }

    if (sources.assets) {
      const read = sources.assets;
      const assets = gauge('assets', 'Number of library assets by media type', ['type']);
      this.collectors.push(
        refresh(async () => {
          const rows = await read().catch(() => []);
          assets.reset();
          for (const { type, count } of rows) if (assetTypes.has(type)) assets.set({ type }, count);
        }, 300_000),
      );
    }

    if (sources.queues) {
      const read = sources.queues;
      const queues = gauge('queue_jobs', 'Queued jobs by queue and state', ['queue', 'state']);
      this.collectors.push(
        refresh(async () => {
          const rows = await read().catch(() => []);
          queues.reset();
          for (const { queue, counts } of rows) {
            if (!queueNames.has(queue)) continue;
            for (const [state, value] of Object.entries(counts)) queues.set({ queue, state }, value);
          }
        }, 30_000),
      );
    }
  }

  middleware(): RequestHandler {
    return (request, response, next) => {
      const start = process.hrtime.bigint();
      response.once('finish', () => {
        // Express fills this with the registered route after matching. Never label the requested URL.
        const route: unknown = request.route?.path;
        if (typeof route === 'string' && route.startsWith('/api/')) {
          this.observeHttp(route, response.statusCode, Number(process.hrtime.bigint() - start) / 1e9);
        }
      });
      next();
    };
  }

  observeHttp(route: string, status: number, seconds: number) {
    this.httpDuration.observe({ route, status: String(status) }, seconds);
  }

  observeDesktopResultAdoption() {
    this.desktopResultsAdopted.inc();
  }

  observeJob(name: JobName, outcome: 'completed' | 'failed') {
    if (jobNames.has(name)) this.jobs.inc({ job_name: name, outcome });
  }

  async listen(port: number, host: string, token?: string): Promise<URL> {
    const expected = token ? digest(`Bearer ${token}`) : undefined;
    const server = createServer({ requestTimeout: 10_000, headersTimeout: 5000 }, (request, response) => {
      const { headers, socket } = request;
      if (
        request.url !== '/metrics' ||
        request.method !== 'GET' ||
        claimsFrameleafVia(headers) ||
        headers.forwarded !== undefined ||
        headers['x-forwarded-for'] !== undefined ||
        headers['x-forwarded-host'] !== undefined ||
        !isHomeAddress(socket.remoteAddress, [])
      ) {
        response.writeHead(404).end();
        return;
      }
      if (expected && !timingSafeEqual(expected, digest(headers.authorization ?? ''))) {
        response.writeHead(401, { 'WWW-Authenticate': 'Bearer' }).end();
        return;
      }
      void Promise.all(this.collectors.map(async (collect) => collect()))
        .then(() => this.registry.metrics())
        .then((body) =>
          response.writeHead(200, { 'Content-Type': this.registry.contentType, 'Cache-Control': 'no-store' }).end(body),
        )
        .catch(() => response.writeHead(503).end());
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    return new URL(`http://${host}:${(server.address() as AddressInfo).port}/metrics`);
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server?.listening) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
}

// Each API/job worker has a separate module instance and registry.
export let workerMetrics: MetricsRepository | undefined;
export const setWorkerMetrics = (metrics?: MetricsRepository) => {
  workerMetrics = metrics;
};
