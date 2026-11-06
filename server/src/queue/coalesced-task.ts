/** Serialize coordinator visits requested by local settlement and PostgreSQL notifications. */
export function coalescedTask(action: () => Promise<void>): () => Promise<void> {
  let active: Promise<void> | undefined;
  let requested = false;
  return () => {
    requested = true;
    active ??= (async () => {
      try {
        do {
          requested = false;
          await action();
        } while (requested);
      } finally {
        active = undefined;
      }
    })();
    return active;
  };
}

/**
 * A read shared by everyone who asks while it runs. One that took at least `minCostMs` is then reused for `factor`
 * times as long as it took, so a costly read cannot keep the database busy however often it is polled; a cheaper one
 * is never reused, so a page refreshed after an action, or a test, always sees the change. Activity's run counts recount an unfinished run's whole ledger: 3.5M rows took 12 s and spilled 2.2 GB of
 * temporary files per read, and every open tab polled it every 2.5 s.
 * `clear()` forgets every reuse; a read still in flight when it is called is not kept either.
 * ponytail: per-process memo, so each server process reads at most once per window; incremental counts for live
 * runs would remove the recount itself.
 */
export function costReusedRead<K, T>(
  load: (key: K) => Promise<T>,
  { factor = 10, minCostMs = 1000, now = () => Date.now() } = {},
) {
  const reads = new Map<string, { value: Promise<T>; reusableUntil: number }>();
  const read = (key: K): Promise<T> => {
    const id = JSON.stringify(key);
    const started = now();
    for (const [other, read] of reads) if (read.reusableUntil <= started) reads.delete(other);
    const reused = reads.get(id);
    if (reused) return reused.value;
    const entry = { value: load(key), reusableUntil: Infinity };
    reads.set(id, entry);
    entry.value
      .then(() => {
        const cost = now() - started;
        if (cost >= minCostMs) entry.reusableUntil = now() + factor * cost;
        else if (reads.get(id) === entry) reads.delete(id);
      })
      .catch(() => reads.get(id) === entry && reads.delete(id));
    return entry.value;
  };
  return Object.assign(read, { clear: () => reads.clear() });
}
