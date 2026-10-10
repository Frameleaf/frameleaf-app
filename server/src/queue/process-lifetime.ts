import type { ChildProcess } from 'node:child_process';
import { trackQueueChild } from 'src/queue/child-process.js';
import { advanceJobProgress, jobSignal } from 'src/queue/context.js';
import { QUEUE_TIMING } from 'src/queue/types.js';

/** Own cancellation until child close; progress changes an opaque limit into an idle limit. */
export function superviseMediaProcess(
  child: ChildProcess,
  options: {
    signal?: AbortSignal;
    deadlineMs?: number;
    idleMs?: number;
    graceMs?: number;
    trackChild?: boolean;
    progress?: (units: number) => void;
  } = {},
) {
  const signal = options.signal ?? jobSignal();
  let error: Error | undefined;
  let closed = false;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const stop = (reason: unknown) => {
    if (closed || error) {
      return;
    }
    error = reason instanceof Error ? reason : new Error('Media process was cancelled');
    child.kill('SIGTERM');
    escalation = setTimeout(() => child.kill('SIGKILL'), options.graceMs ?? QUEUE_TIMING.cancelGrace);
    escalation.unref();
  };
  let deadline = setTimeout(
    () => stop(new Error('Media process execution deadline exceeded')),
    options.deadlineMs ?? QUEUE_TIMING.opaqueDeadline,
  );
  deadline.unref();
  const abort = () => stop(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  const cleanup = () => {
    closed = true;
    clearTimeout(deadline);
    clearTimeout(escalation);
    signal?.removeEventListener('abort', abort);
    child.off('close', cleanup);
  };
  if (options.trackChild !== false) {
    trackQueueChild(child);
  }
  child.once('close', cleanup);
  if (signal?.aborted) {
    abort();
  }
  return {
    stop,
    // A successful pooled task can release its listeners without declaring the child stopped.
    release: () => {
      // A late result cannot cancel escalation once termination has begun.
      if (!error) {
        cleanup();
      }
    },
    error: () => error,
    progress(units: number) {
      if (closed || error || !Number.isSafeInteger(units) || units <= 0) {
        return;
      }
      (options.progress ?? advanceJobProgress)(units);
      clearTimeout(deadline);
      deadline = setTimeout(
        () => stop(new Error('Media process stopped making progress')),
        options.idleMs ?? QUEUE_TIMING.noProgressDeadline,
      );
      deadline.unref();
    },
  };
}
