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
