import { performance } from 'node:perf_hooks';
import type { MessagePort, Worker } from 'node:worker_threads';

/** Runs in the parent thread: executor event-loop starvation cannot silence this watchdog. */
export function superviseQueueWorker(worker: Worker, silenceMs = 15_000, scanMs = 5000) {
  let watchdog: MessagePort | undefined;
  let lastSeen = performance.now();
  let terminating = false;
  const children = new Set<number>();
  const killChildren = () => {
    for (const pid of children) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* child already exited */
      }
    }
    children.clear();
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
  worker.on('message', (message: { type?: string; port?: MessagePort; pid?: number; active?: boolean }) => {
    if (message.type === 'database-unusable') {
      terminate();
    }
    if (message.type === 'queue-child' && Number.isSafeInteger(message.pid) && message.pid! > 0) {
      if (message.active) {
        children.add(message.pid!);
      } else {
        children.delete(message.pid!);
      }
    }
    if (message.type === 'queue-watchdog-port' && message.port) {
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
  });
  worker.once('exit', () => {
    clearInterval(timer);
    killChildren();
    watchdog?.close();
  });
}
