import type { ArgOf, EmitEvent } from 'src/repositories/event.repository.js';

export class PendingEvents<T extends { [T in EmitEvent]: ArgOf<T> extends { error?: string } ? T : never }[EmitEvent]> {
  private pending = new Map<string, PromiseWithResolvers<ArgOf<T>> & { timeout: NodeJS.Timeout }>();
  private timeoutMs: number;

  constructor({ timeoutMs }: { timeoutMs: number }) {
    this.timeoutMs = timeoutMs;
  }

  wait(key: string, request?: (isPending: () => boolean) => void | Promise<void>): Promise<ArgOf<T>> {
    const existing = this.pending.get(key);
    if (existing) {
      return existing.promise;
    }

    const completer = Promise.withResolvers<ArgOf<T>>();
    const timeout = setTimeout(() => this.complete(key, { error: 'Request timed out' }), this.timeoutMs);
    const pending = { ...completer, timeout };
    this.pending.set(key, pending);
    if (request) {
      const isPending = () => this.pending.get(key) === pending;
      const reject = (error: unknown) => {
        if (isPending()) {
          clearTimeout(timeout);
          this.pending.delete(key);
          pending.reject(error);
        }
      };
      try {
        const started = request(isPending);
        if (started) {
          void started.catch(reject);
        }
      } catch (error) {
        reject(error);
      }
    }
    return completer.promise;
  }

  complete(key: string, value: ArgOf<T> | { error: string }) {
    const pending = this.pending.get(key);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pending.delete(key);
    if ('error' in value) {
      pending.reject(new Error(value.error));
    } else {
      pending.resolve(value);
    }
  }

  rejectByPrefix(prefix: string, error: string) {
    for (const key of this.pending.keys()) {
      if (key.startsWith(prefix)) {
        this.complete(key, { error });
      }
    }
  }
}
