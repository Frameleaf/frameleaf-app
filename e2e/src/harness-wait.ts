import type { ClientRequest } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

export type WaitContext = { signal: AbortSignal; remaining: () => number };

/** The operation owns its request and must honour the signal. Await it through abort;
 * racing a timer against it would leave its request/callback running in the next test.
 */
export const withDeadline = async <T>(
  description: string,
  timeout: number,
  operation: (context: WaitContext) => Promise<T>,
  parent?: AbortSignal,
): Promise<T> => {
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error(`Invalid ${description} deadline`);
  }
  const controller = new AbortController();
  const deadline = performance.now() + timeout;
  const expired = new Error(`${description} timed out`);
  const cancel = () => controller.abort(parent?.reason);
  parent?.addEventListener('abort', cancel, { once: true });
  if (parent?.aborted) {
    cancel();
  }
  const timer = setTimeout(() => controller.abort(expired), timeout);
  const context: WaitContext = {
    signal: controller.signal,
    remaining: () => {
      if (performance.now() >= deadline) {
        controller.abort(expired);
      }
      controller.signal.throwIfAborted();
      return Math.max(1, Math.ceil(deadline - performance.now()));
    },
  };
  try {
    context.remaining();
    const result = await operation(context);
    context.remaining();
    return result;
  } catch (error) {
    if (error instanceof AggregateError) {
      throw error;
    }
    if (controller.signal.aborted) {
      throw controller.signal.reason;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', cancel);
  }
};

export const waitUntil = async <T>(
  context: WaitContext,
  read: (context: WaitContext) => Promise<T>,
  accept: (value: T) => boolean,
  interval = 200,
): Promise<T> => {
  for (;;) {
    context.remaining();
    const value = await read(context);
    context.remaining();
    if (accept(value)) {
      return value;
    }
    await sleep(Math.min(interval, context.remaining()), undefined, { signal: context.signal });
  }
};

type AbortableRequest<T> = PromiseLike<T> & {
  timeout: (options: { deadline: number }) => unknown;
  abort: () => unknown;
  once?: (event: 'request', listener: (request: { req: ClientRequest }) => void) => unknown;
};

/** One owned request; mutations must never acquire the read-only poller's retry policy. */
export const requestOnce = async <T>(context: WaitContext, create: () => AbortableRequest<T>): Promise<T> => {
  context.remaining();
  const pending = create();
  pending.timeout({ deadline: context.remaining() });
  let transportClosed: Promise<void> | undefined;
  pending.once?.('request', ({ req }) => {
    transportClosed = new Promise<void>((resolve) => {
      req.once('close', resolve);
    });
  });
  const abort = () => {
    pending.abort();
  };
  context.signal.addEventListener('abort', abort, { once: true });
  try {
    context.remaining();
    const result = await pending;
    context.remaining();
    return result;
  } finally {
    try {
      await transportClosed;
    } finally {
      context.signal.removeEventListener('abort', abort);
    }
  }
};

/** SuperTest requests settle before retry. Only connection failures during a known
 * restart are transient; HTTP/SDK errors and malformed response assertions propagate.
 */
export const pollRequest = async <T>(
  context: WaitContext,
  create: () => AbortableRequest<T>,
  accept: (value: T) => boolean,
  interval = 500,
) => {
  let lastConnectionError: unknown;
  try {
    const result = await waitUntil<{ value: T } | { unavailable: true }>(
      context,
      async () => {
        try {
          return { value: await requestOnce(context, create) };
        } catch (error) {
          context.remaining();
          if (!['ECONNREFUSED', 'ECONNRESET'].includes((error as NodeJS.ErrnoException)?.code ?? '')) {
            throw error;
          }
          lastConnectionError = error;
          return { unavailable: true };
        }
      },
      (value) => 'value' in value && accept(value.value),
      interval,
    );
    if ('value' in result) {
      return result.value;
    }
    throw new Error('HTTP poll accepted an unavailable response');
  } catch (error) {
    if (lastConnectionError && context.signal.aborted) {
      throw new AggregateError(
        [context.signal.reason, lastConnectionError],
        'HTTP polling stopped before the server became available',
        { cause: error },
      );
    }
    throw error;
  }
};

export type EventType = 'assetUpload' | 'assetUpdate' | 'assetDelete' | 'userDelete' | 'assetHidden';
export type EventWait = { event: EventType; id?: string; total?: number; signal?: AbortSignal };

export class EventJournal {
  private readonly events = new Map<EventType, Set<string>>();
  private readonly waiters = new Set<{ check: () => void; cancel: (reason: Error) => void }>();

  add(event: EventType, id: string) {
    let ids = this.events.get(event);
    if (!ids) {
      ids = new Set();
      this.events.set(event, ids);
    }
    ids.add(id);
    for (const waiter of this.waiters) {
      waiter.check();
    }
  }

  clear() {
    for (const waiter of this.waiters) {
      waiter.cancel(new Error('Event history reset'));
    }
    this.events.clear();
  }

  wait({ event, id, total, signal }: EventWait): Promise<void> {
    if ((!id && total === undefined) || (total !== undefined && (!Number.isSafeInteger(total) || total <= 0))) {
      return Promise.reject(new Error('id or positive count must be provided for waitForWebsocketEvent'));
    }
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        this.waiters.delete(waiter);
        signal?.removeEventListener('abort', abort);
      };
      const waiter = {
        check: () => {
          const ids = this.events.get(event);
          if ((id && ids?.has(id)) || (total !== undefined && (ids?.size ?? 0) >= total)) {
            cleanup();
            resolve();
          }
        },
        cancel: (reason: Error) => {
          cleanup();
          reject(reason);
        },
      };
      const abort = () => waiter.cancel(signal!.reason);
      this.waiters.add(waiter);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) {
        abort();
      } else {
        waiter.check();
      }
    });
  }
}
