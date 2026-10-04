import { parentPort } from 'node:worker_threads';
import type { ChildProcess } from 'node:child_process';

/** The parent can terminate native work even when its executor's event loop is unresponsive. */
export function trackQueueChild(child: ChildProcess): void {
  const register = () => {
    if (child.pid) parentPort?.postMessage({ type: 'queue-child', pid: child.pid, active: true });
  };
  if (child.pid) register();
  else child.once('spawn', register);
  child.once('close', () => {
    if (child.pid) parentPort?.postMessage({ type: 'queue-child', pid: child.pid, active: false });
  });
}
