import { type MessagePort, parentPort as threadPort } from 'node:worker_threads';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

/**
 * FL-291: the stop budget. Docker sends SIGTERM and kills the container 10 s later unless the
 * compose file says otherwise, so everything below fits inside that default:
 *
 * - running jobs and in-flight HTTP requests get {@link SHUTDOWN_GRACE_MS} to finish; jobs still
 *   running then go back to waiting, requests still running are cut;
 * - each worker exits by {@link SHUTDOWN_WORKER_DEADLINE_MS} whatever its teardown is doing;
 * - the supervisor kills any worker still alive at {@link SHUTDOWN_SUPERVISOR_DEADLINE_MS} and exits.
 */
export const SHUTDOWN_GRACE_MS = 5000;
export const SHUTDOWN_WORKER_DEADLINE_MS = 8000;
export const SHUTDOWN_SUPERVISOR_DEADLINE_MS = 9000;

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
export const closeGracefully = async (
  {
    http,
    stopJobs,
    close,
  }: {
    http?: Pick<HttpRequestTracker, 'drain'>;
    stopJobs?: (graceMs: number) => Promise<void>;
    close: () => Promise<void>;
  },
  graceMs = SHUTDOWN_GRACE_MS,
) => {
  try {
    await Promise.all([http?.drain(graceMs), stopJobs?.(graceMs)]);
  } finally {
    await close();
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

  constructor(
    private options: { exit: (code: number) => void; deadlineMs?: number } = {
      exit: (code) => process.exit(code),
    },
  ) {}

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
    }, this.options.deadlineMs ?? SHUTDOWN_SUPERVISOR_DEADLINE_MS);
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
