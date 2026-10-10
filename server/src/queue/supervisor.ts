import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import type { MessagePort, Worker } from 'node:worker_threads';
import type { WorkerStoppedProof } from 'src/queue/worker-stop-proof.js';

/** Runs in the parent thread: executor event-loop starvation cannot silence this watchdog. */
export function superviseQueueWorker(
  worker: Worker,
  silenceMs = 15_000,
  scanMs = 5000,
  options: {
    recordStopped?: (proof: WorkerStoppedProof) => Promise<void>;
    diagnostic?: (message: string) => void;
    stopWaitMs?: number;
    childScanMs?: number;
  } = {},
) {
  let watchdog: MessagePort | undefined;
  let workerId: string | undefined;
  let identityConflict = false;
  let lastSeen = performance.now();
  let terminating = false;
  const children = new Set<number>();
  const diagnostic = options.diagnostic ?? ((message: string) => console.error(message));
  const absent = (pid: number) => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
  };
  const killChildren = () => {
    for (const pid of children) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // A failed kill is not absence evidence; retain the PID for confirmation.
      }
    }
  };
  const terminate = () => {
    if (terminating) {
      return;
    }
    terminating = true;
    killChildren();
    void worker.terminate();
  };
  const timer = setInterval(() => {
    if (watchdog && performance.now() - lastSeen > silenceMs) {
      terminate();
    }
  }, scanMs);
  worker.on(
    'message',
    (message: { type?: string; port?: MessagePort; pid?: number; active?: boolean; workerId?: string }) => {
      if (message.type === 'database-unusable') {
        terminate();
      }
      if (message.type === 'queue-child' && Number.isSafeInteger(message.pid) && message.pid! > 0) {
        if (message.active) {
          children.add(message.pid!);
          if (terminating) killChildren();
        } else {
          // A reported close is useful, but only OS absence permits durable stop evidence.
          if (absent(message.pid!)) children.delete(message.pid!);
        }
      }
      if (message.type === 'queue-watchdog-port' && message.port) {
        if (
          typeof message.workerId === 'string' &&
          /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(message.workerId)
        ) {
          if (!workerId && !identityConflict) workerId = message.workerId;
          else if (workerId !== message.workerId) {
            diagnostic('Queue worker identity changed; durable stop proof refused');
            identityConflict = true;
            workerId = undefined;
            terminate();
            return;
          }
        }
        watchdog?.close();
        watchdog = message.port;
        lastSeen = performance.now();
        watchdog.on('message', (event: { type?: string }) => {
          lastSeen = performance.now();
          if (event.type === 'terminate') {
            terminate();
          }
        });
      }
    },
  );
  const stopped = new Promise<void>((resolve) => {
    worker.once('exit', () => {
      clearInterval(timer);
      killChildren();
      watchdog?.close();
      const confirm = async () => {
        const deadline = performance.now() + (options.stopWaitMs ?? 5000);
        let waitingReported = false;
        while (true) {
          for (const pid of children) if (absent(pid)) children.delete(pid);
          if (children.size === 0) break;
          if (!waitingReported) {
            waitingReported = true;
            diagnostic(
              `Queue worker ${workerId ?? 'unknown'} exited; stop proof withheld while confirming native children (${[...children].join(', ')}). Check host processes and mounts if they cannot stop.`,
            );
          }
          if (performance.now() >= deadline) {
            diagnostic(
              `Queue worker ${workerId ?? 'unknown'} exited but native children remain unconfirmed (${[...children].join(', ')}); no stop proof written. Check host processes and mounts.`,
            );
            return;
          }
          await delay(options.childScanMs ?? 50);
        }
        if (!workerId || identityConflict) {
          if (options.recordStopped)
            diagnostic('Queue worker exited without a verified worker ID; no stop proof written');
          return;
        }
        await options.recordStopped?.({ workerId, stoppedAt: Date.now() });
      };
      void confirm()
        .catch(() =>
          diagnostic(`Queue worker ${workerId ?? 'unknown'} stop proof unavailable; retained work remains fenced`),
        )
        .finally(resolve);
    });
  });
  return { stopped };
}
