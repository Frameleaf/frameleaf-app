import { type MessagePort, parentPort as threadPort } from 'node:worker_threads';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

/**
 * FL-291: the stop budget, in seconds, unless FRAMELEAF_SHUTDOWN_GRACE_SECONDS and
 * FRAMELEAF_SHUTDOWN_DEADLINE_SECONDS say otherwise (`ConfigRepository` reads them as `shutdown`):
 *
 * - running jobs and in-flight HTTP requests get the grace period to finish; jobs still running then
 *   go back to waiting, requests still running are cut;
 * - each worker exits shortly before the deadline whatever its teardown is doing
 *   ({@link getWorkerDeadlineMs});
 * - the supervisor kills any worker still alive at the deadline and exits.
 *
 * Docker kills the container when its stop timeout ends, so the server's `stop_grace_period` (10 s in
 * the provided compose files and NAS packages) must be longer than the deadline.
 */
export const DEFAULT_SHUTDOWN_GRACE_SECONDS = 5;
export const DEFAULT_SHUTDOWN_DEADLINE_SECONDS = 9;

/** When a worker exits: a second before the deadline, or halfway between grace and deadline if closer. */
export const getWorkerDeadlineMs = (graceMs: number, deadlineMs: number) =>
  deadlineMs - Math.min(1000, (deadlineMs - graceMs) / 2);

/**
 * FL-291: the budget of a restart (maintenance mode on or off, a restart request). Unlike a stop, the
 * supervisor starts the workers again as soon as they have exited, and callers wait for the server to
 * come back, so a restart keeps the 2 s ceiling it had before graceful stops: in-flight requests and
 * running jobs get 1 s, then jobs still running go back to waiting and the worker exits by 2 s.
 */
export const RESTART_BUDGET = { graceMs: 1000, workerDeadlineMs: 2000 } as const;

/**
 * FL-299: how long closing the database pool waits for queries still in flight before it closes their
 * connections. Short, so a stop with nothing left to hand back ends in a second or two instead of
 * running to the worker deadline behind one long query.
 */
export const DATABASE_CLOSE_TIMEOUT_SECONDS = 0.5;

/** What the supervisor posts to a worker thread (microservices, maintenance) to stop it. */
export const WORKER_STOP_MESSAGE = 'frameleaf:stop';

/** socket.io long-polls stay open until the next ping; they are closed with the gateway instead. */
const isLongPoll = (req: IncomingMessage) => req.url?.startsWith('/api/socket.io') ?? false;

type DrainableServer = Pick<Server, 'on' | 'close' | 'closeIdleConnections' | 'closeAllConnections'>;

/**
 * FL-291: counts the HTTP requests a server is answering, so a stop can wait for them. Attach it as
 * soon as the server exists, before it listens.
 */
export class HttpRequestTracker {
  private inFlight = 0;
  private onIdle?: () => void;

  constructor(private server: DrainableServer) {
    server.on('request', (req: IncomingMessage, res: ServerResponse) => {
      if (isLongPoll(req)) {
        return;
      }
      this.inFlight++;
      let done = false;
      res.once('close', () => {
        if (done) {
          return;
        }
        done = true;
        this.inFlight--;
        if (this.inFlight === 0) {
          this.onIdle?.();
        }
      });
    });
  }

  /**
   * Stop accepting connections, let the requests in flight finish for up to `graceMs`, then close
   * every connection left. Resolves true when nothing had to be cut.
   */
  async drain(graceMs: number): Promise<boolean> {
    this.server.close();
    this.server.closeIdleConnections();

    let drained = true;
    if (this.inFlight > 0) {
      let timer: NodeJS.Timeout | undefined;
      drained = await new Promise<boolean>((resolve) => {
        this.onIdle = () => resolve(true);
        timer = setTimeout(() => resolve(false), graceMs);
      });
      clearTimeout(timer);
      this.onIdle = undefined;
    }

    this.server.closeAllConnections();
    return drained;
  }
}

/**
 * FL-291: the graceful part of a worker's stop. HTTP requests and running jobs share one grace
 * period; then the application closes (Nest's destroy and shutdown hooks: the `AppShutdown` event,
 * queue and database connections). The caller bounds the whole of it with a deadline.
 */
export const closeGracefully = async ({
  http,
  stopJobs,
  close,
  graceMs,
  debug,
}: {
  http?: Pick<HttpRequestTracker, 'drain'>;
  stopJobs?: (graceMs: number) => Promise<void>;
  close: () => Promise<void>;
  graceMs: number;
  /** FL-299: how long each part of the stop took (debug level). */
  debug?: (message: string) => void;
}) => {
  const timed = async (label: string, work: Promise<unknown> | undefined) => {
    if (!work) {
      return;
    }
    const startedAt = performance.now();
    try {
      await work;
    } finally {
      debug?.(`Stop: ${label} took ${Math.round(performance.now() - startedAt)} ms`);
    }
  };

  try {
    await Promise.all([
      timed('draining HTTP requests', http?.drain(graceMs)),
      timed('stopping the job workers', stopJobs?.(graceMs)),
    ]);
  } finally {
    await timed('closing the application', close());
  }
};

/**
 * FL-291: call `stop` once when this worker is asked to stop: on SIGTERM or SIGINT in a forked
 * process (the API), or on the supervisor's message in a worker thread, whose
 * signals belong to the supervisor.
 */
export const onStopRequest = (
  stop: () => void,
  {
    port = threadPort,
    proc = process,
  }: { port?: Pick<MessagePort, 'on'> | null; proc?: Pick<NodeJS.Process, 'on'> } = {},
) => {
  let requested = false;
  const once = () => {
    if (requested) {
      return;
    }

    requested = true;
    stop();
  };

  if (port) {
    port.on('message', (message: unknown) => {
      if (message === WORKER_STOP_MESSAGE) {
        once();
      }
    });
    return;
  }

  proc.on('SIGTERM', once);
  proc.on('SIGINT', once);
};

export type SupervisedWorker = {
  /** Ask the worker to stop gracefully. */
  stop: () => void;
  /** End it now. */
  kill: () => void;
};

/**
 * FL-291: the supervisor's side of a stop. Every worker is asked to stop; the process exits when the
 * last one has, or at the deadline, killing whatever is left.
 */
export class SupervisorStop {
  stopping = false;
  private timer?: NodeJS.Timeout;

  constructor(private options: { exit: (code: number) => void; deadlineMs: number }) {}

  begin(workers: () => SupervisedWorker[]) {
    if (this.stopping) {
      return;
    }
    this.stopping = true;

    const running = workers();
    if (running.length === 0) {
      this.options.exit(0);
      return;
    }

    for (const worker of running) {
      worker.stop();
    }

    this.timer = setTimeout(() => {
      for (const worker of workers()) {
        worker.kill();
      }
      this.options.exit(0);
    }, this.options.deadlineMs);
  }

  /** Called when a worker has exited, with how many are still running. */
  workerExited(remaining: number) {
    if (!this.stopping || remaining > 0) {
      return;
    }
    clearTimeout(this.timer);
    this.options.exit(0);
  }
}
