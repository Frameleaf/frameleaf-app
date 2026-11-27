/**
 * FL-1794: told when a claimed job leaves the running state in this process, whatever the outcome (done,
 * failed, deferred, stopped). `JobComplete` only follows a committed success. A listener that throws
 * never reaches the job.
 */
type Listener = (queue: string) => void;

const listeners = new Set<Listener>();

export const onJobSettled = (listener: Listener) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const jobSettled = (queue: string) => {
  for (const listener of listeners) {
    try {
      listener(queue);
    } catch {
      // a listener's failure is its own
    }
  }
};
