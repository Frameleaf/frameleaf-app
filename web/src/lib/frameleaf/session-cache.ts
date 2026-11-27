import { onLibraryAccessChange } from '$lib/frameleaf/library-access';

/**
 * FL-1802: one answer kept for the session, for lists many screens read and few things change (the
 * tags, the people, the filter panel's places and cameras). Readers at the same moment share one
 * request; later readers get the kept answer without asking. It is dropped when library access
 * changes (a lock or unlock, another account), when `invalidate` is called after a change made here,
 * and after `maxAgeMs`, which is what picks up a change made on another device. A failed read is
 * never kept.
 */
const caches = new Set<() => void>();

/** Forget what every cache holds. Specs call it between tests; nothing in the app does. */
export const resetSessionCaches = () => {
  for (const clear of caches) {
    clear();
  }
};

export const sessionCache = <T>(load: (key: string) => Promise<T>, maxAgeMs = 5 * 60_000) => {
  const entries = new Map<string, { at: number; value: Promise<T> }>();
  let watching = false;
  caches.add(() => entries.clear());

  return {
    get(key = ''): Promise<T> {
      if (!watching) {
        watching = true;
        onLibraryAccessChange(() => entries.clear());
      }
      const kept = entries.get(key);
      if (kept && Date.now() - kept.at <= maxAgeMs) {
        return kept.value;
      }
      // an async call: a loader that throws, or a spec's stand-in that answers nothing, still gives a promise
      const entry = { at: Date.now(), value: (async () => load(key))() };
      entries.set(key, entry);
      entry.value.catch(() => {
        if (entries.get(key) === entry) {
          entries.delete(key);
        }
      });
      return entry.value;
    },
    invalidate(key?: string) {
      if (key === undefined) {
        entries.clear();
      } else {
        entries.delete(key);
      }
    },
  };
};
