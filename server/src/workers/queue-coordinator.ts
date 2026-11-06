import { Kysely } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import { performance } from 'node:perf_hooks';
import { type MessagePort, parentPort, workerData } from 'node:worker_threads';
import postgres from 'postgres';
import type { ConfigRepository } from 'src/repositories/config.repository.js';
import { coalescedTask } from 'src/queue/coalesced-task.js';
import { queueNotifications } from 'src/queue/notifications.js';
import { pruneQueueHistoryPage } from 'src/queue/retention.js';
import { finishRuns } from 'src/queue/run-summary.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { QUEUE_EXECUTION_CAPACITY, QUEUE_TIMING, QueueClaim, QueueWorkerMessage } from 'src/queue/types.js';
import { QueueWatchdog, monitorQueueProgress } from 'src/queue/watchdog.js';

type CoordinatorData = {
  workerId: string;
  queues: string[];
  /** Jobs run at once across all queues; a `capacity` message changes it live. */
  capacity?: number;
  connection: ReturnType<ConfigRepository['getEnv']>['database']['config'];
  supervisor: MessagePort;
};

/** This thread owns no media execution. Even a synchronous handler hang cannot stop its watchdog. */
export async function coordinate({
  workerId,
  queues,
  capacity: initialCapacity,
  connection,
  supervisor,
}: CoordinatorData) {
  let executionCapacity = initialCapacity ?? QUEUE_EXECUTION_CAPACITY;
  const createClient = (max: number) => {
    const options = { max, connect_timeout: 5, connection: { statement_timeout: 5000, lock_timeout: 3000 } };
    return connection.connectionType === 'url'
      ? postgres(connection.url, options)
      : postgres({ ...connection, ssl: connection.ssl === 'disable' ? false : connection.ssl, ...options });
  };
  const client = createClient(2);
  // LISTEN owns its own bounded one-connection pool; it can never reserve a dispatch connection.
  const listener = createClient(1);
  const heartbeatClient = createClient(1);
  const maintenanceClient = createClient(1);
  const db = new Kysely<any>({ dialect: new PostgresJSDialect({ postgres: client }) });
  const store = new SqlQueueStore(db);
  const heartbeatDb = new Kysely<any>({ dialect: new PostgresJSDialect({ postgres: heartbeatClient }) });
  const heartbeatStore = new SqlQueueStore(heartbeatDb);
  const maintenanceDb = new Kysely<any>({ dialect: new PostgresJSDialect({ postgres: maintenanceClient }) });
  const maintenanceStore = new SqlQueueStore(maintenanceDb);
  const watchdog = new QueueWatchdog();
  const active = new Map<string, QueueClaim>();
  let stopping = false;
  let ready = false;
  let lastHeartbeat = performance.now();
  let lastSweep = 0;
  let maintenance: Promise<void> | undefined;
  let progressBusy = false;
  let nextQueue = 0;
  let reconciliationDue = true;
  // An idle server reconciles every queue less often: the 5 s scan doubles up to 30 s while full
  // passes find nothing to run, and the first claim brings it back. Wakes still check for work each scan.
  let idleReconciliations = 0;
  let scansBeforeReconciliation = 0;
  const progress = new Map<string, number>();

  parentPort!.on('message', (message: QueueWorkerMessage) => {
    switch (message.type) {
      case 'settled': {
        active.delete(message.id);
        watchdog.remove(message.id);
        void tick();
        break;
      }
      case 'progress': {
        watchdog.progress(message.id, message.units, performance.now());
        progress.set(message.id, message.units);
        break;
      }
      case 'capacity': {
        executionCapacity = message.value;
        void tick();
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

  // Maintenance and dispatch must never reserve the lease-renewal connection or delay its timer.
  const beat = coalescedTask(async () => {
    if (!ready) return;
    try {
      await heartbeatStore.heartbeat(workerId, active.values().toArray());
      lastHeartbeat = performance.now();
    } catch {
      parentPort!.postMessage({ type: 'unavailable' });
    }
  });
  const heartbeat = setInterval(() => void beat(), QUEUE_TIMING.heartbeat);

  // A recovery backlog must neither hold dispatch nor reserve one of its database sessions.
  const sweep = () => {
    if (stopping || maintenance || performance.now() - lastSweep < QUEUE_TIMING.sweep) return;
    maintenance = (async () => {
      try {
        await maintenanceStore.recoverExpired();
        // FL-1213: one page per sweep cannot keep up after a big library scan (millions of jobs at 250
        // per 30 seconds), so keep going for a few seconds while pages are full and still deleting. A full
        // page that deleted nothing waits for the next sweep once its history is not yet due; one kept whole for
        // an open run goes on to the history behind it.
        const deadline = performance.now() + QUEUE_TIMING.pruneBudget;
        while (!stopping) {
          const page = await pruneQueueHistoryPage(maintenanceDb);
          if (!page?.fullPage || (page.pruned === 0 && !page.due) || performance.now() >= deadline) break;
        }
        // FL-1265: runs whose work has ended are finished, their counts written once.
        if (!stopping) await finishRuns(maintenanceDb, 10);
        if (!stopping) await maintenanceStore.settleTerminalLibrarySources();
      } catch {
        if (!stopping) parentPort!.postMessage({ type: 'unavailable' });
      } finally {
        lastSweep = performance.now();
        maintenance = undefined;
      }
    })();
  };

  // FL-1265: changed run holds reach their jobs in batches, a little each visit, on the maintenance session.
  let holdsBusy = false;
  const reconcileHolds = () => {
    if (stopping || holdsBusy) return;
    holdsBusy = true;
    void maintenanceStore
      .reconcileHolds(1000)
      .catch(() => {})
      .finally(() => (holdsBusy = false));
  };

  const tick = coalescedTask(async () => {
    const reconcile = reconciliationDue;
    reconciliationDue = false;
    let claimed = 0;
    try {
      if (!ready) {
        await store.initialize(queues, workerId);
        ready = true;
        await beat();
      }
      sweep();
      reconcileHolds();
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
        // Ordinary wakes discover claimable work once, rather than running an idle claim per queue.
        const outstanding = reconcile ? undefined : new Set(await store.queuesWithUnfinishedWork(queues, false));
        const start = nextQueue;
        for (let offset = 0; offset < queues.length; offset++) {
          const capacity = executionCapacity - active.size;
          if (stopping || capacity <= 0) break;
          const index = (start + offset) % queues.length;
          const queue = queues[index];
          if (outstanding && !outstanding.has(queue)) continue;
          // Resume at the next queue after filling the shared budget, so a deep queue cannot starve others.
          nextQueue = (index + 1) % queues.length;
          const claims = await store.claim(queue, workerId, capacity);
          claimed += claims.length;
          for (const claim of claims) {
            active.set(claim.id, claim);
            watchdog.add(claim.id, performance.now(), claim.deadlineMs);
            parentPort!.postMessage({ type: 'execute', claim });
          }
        }
      }
      if (claimed > 0 || active.size > 0) {
        idleReconciliations = 0;
        scansBeforeReconciliation = 0;
      } else if (reconcile) {
        idleReconciliations = Math.min(idleReconciliations + 1, 3);
        // 2, 4, then 6 scans: 10 s, 20 s, then 30 s apart
        scansBeforeReconciliation = Math.min(2 ** idleReconciliations, 6) - 1;
      }
    } catch {
      if (reconcile) reconciliationDue = true;
      // The watchdog owns the outage decision. Do not leak connection strings or job payloads.
      parentPort!.postMessage({ type: 'unavailable' });
    }
  });
  const notifications = queueNotifications(listener, () => void tick());
  notifications.connect();
  const scan = setInterval(() => {
    if (scansBeforeReconciliation-- <= 0) reconciliationDue = true;
    notifications.connect();
    void tick();
  }, QUEUE_TIMING.scan);
  parentPort!.on('close', () => {
    stopping = true;
    stopWatchdog();
    clearInterval(scan);
    clearInterval(heartbeat);
    void notifications.close();
    void client.end({ timeout: 1 });
    void heartbeatClient.end({ timeout: 1 });
    void maintenanceClient.end({ timeout: 1 });
  });
  await tick();
}

if (parentPort) {
  void coordinate(workerData as CoordinatorData).catch(() => {
    (workerData as CoordinatorData).supervisor.postMessage({ type: 'terminate' });
  });
}
