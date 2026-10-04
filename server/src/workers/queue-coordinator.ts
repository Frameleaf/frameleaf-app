import { Kysely } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import { performance } from 'node:perf_hooks';
import { type MessagePort, parentPort, workerData } from 'node:worker_threads';
import postgres from 'postgres';
import type { ConfigRepository } from 'src/repositories/config.repository.js';
import { queueNotifications } from 'src/queue/notifications.js';
import { pruneQueueHistory } from 'src/queue/retention.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { QUEUE_TIMING, QueueClaim, QueueWorkerMessage } from 'src/queue/types.js';
import { QueueWatchdog, monitorQueueProgress } from 'src/queue/watchdog.js';

type CoordinatorData = {
  workerId: string;
  queues: string[];
  connection: ReturnType<ConfigRepository['getEnv']>['database']['config'];
  supervisor: MessagePort;
};

/** This thread owns no media execution. Even a synchronous handler hang cannot stop its watchdog. */
export async function coordinate({ workerId, queues, connection, supervisor }: CoordinatorData) {
  const createClient = (max: number) => {
    const options = { max, connect_timeout: 5, connection: { statement_timeout: 5000, lock_timeout: 3000 } };
    return connection.connectionType === 'url'
      ? postgres(connection.url, options)
      : postgres({ ...connection, ssl: connection.ssl === 'disable' ? false : connection.ssl, ...options });
  };
  const client = createClient(2);
  // LISTEN owns its own bounded one-connection pool; it can never reserve a dispatch connection.
  const listener = createClient(1);
  const db = new Kysely<any>({ dialect: new PostgresJSDialect({ postgres: client }) });
  const store = new SqlQueueStore(db);
  const watchdog = new QueueWatchdog();
  const active = new Map<string, QueueClaim>();
  let stopping = false;
  let ready = false;
  let busy = false;
  let lastHeartbeat = performance.now();
  let lastSweep = 0;
  let lastBeat = 0;
  let progressBusy = false;
  const progress = new Map<string, number>();

  parentPort!.on('message', (message: QueueWorkerMessage) => {
    switch (message.type) {
      case 'settled': {
        active.delete(message.id);
        watchdog.remove(message.id);
        break;
      }
      case 'progress': {
        watchdog.progress(message.id, message.units, performance.now());
        progress.set(message.id, message.units);
        break;
      }
      case 'stop': {
        stopping = true;
        break;
      }
    }
  });

  // This timer never awaits PostgreSQL. A failed or saturated pool cannot silence cancellation.
  const stopWatchdog = monitorQueueProgress(watchdog, {
    alive: () => supervisor.postMessage({ type: 'alive' }),
    cancel: (id) => parentPort!.postMessage({ type: 'cancel', id }),
    terminate: () => supervisor.postMessage({ type: 'terminate' }),
    lastHeartbeat: () => lastHeartbeat,
  });

  const tick = async () => {
    if (busy) {
      return;
    }
    busy = true;
    try {
      if (!ready) {
        await store.initialize(queues, workerId);
        ready = true;
      }
      const now = performance.now();
      if (now - lastBeat >= QUEUE_TIMING.heartbeat) {
        await store.heartbeat(workerId, active.values().toArray());
        lastBeat = now;
        lastHeartbeat = performance.now();
      }
      if (now - lastSweep >= QUEUE_TIMING.sweep) {
        await store.recoverExpired();
        await pruneQueueHistory(db);
        lastSweep = now;
      }
      if (!progressBusy) {
        progressBusy = true;
        try {
          for (const [id, units] of progress) {
            progress.delete(id);
            const claim = active.get(id);
            if (claim) {
              await store.progress(claim, units);
            }
          }
        } finally {
          progressBusy = false;
        }
      }
      for (const deadline of await store.deadlines(workerId)) {
        watchdog.cancel(deadline.id, performance.now());
        parentPort!.postMessage({ type: 'cancel', id: deadline.id });
      }
      if (!stopping) {
        for (const queue of queues) {
          const claims = await store.claim(queue, workerId);
          for (const claim of claims) {
            active.set(claim.id, claim);
            watchdog.add(claim.id, performance.now(), claim.deadlineMs);
            parentPort!.postMessage({ type: 'execute', claim });
          }
        }
      }
    } catch {
      // The watchdog owns the outage decision. Do not leak connection strings or job payloads.
      parentPort!.postMessage({ type: 'unavailable' });
    } finally {
      busy = false;
    }
  };
  const notifications = queueNotifications(listener, () => void tick());
  notifications.connect();
  const scan = setInterval(() => {
    notifications.connect();
    void tick();
  }, QUEUE_TIMING.scan);
  parentPort!.on('close', () => {
    stopWatchdog();
    clearInterval(scan);
    void notifications.close();
    void client.end({ timeout: 1 });
  });
  await tick();
}

if (parentPort) {
  void coordinate(workerData as CoordinatorData).catch(() => {
    (workerData as CoordinatorData).supervisor.postMessage({ type: 'terminate' });
  });
}
