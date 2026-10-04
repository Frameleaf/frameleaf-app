import { Injectable } from '@nestjs/common';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import { Server as SocketIO } from 'socket.io';
import { ExitCode } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { AppRestartEvent } from 'src/repositories/event.repository.js';
import { RESTART_BUDGET } from 'src/utils/shutdown.js';

@Injectable()
export class AppRepository {
  private closeFn?: (graceMs: number) => Promise<void>;
  private stopping?: boolean;

  /**
   * Restart (entering or leaving maintenance mode, a restart request): the supervisor starts the
   * workers again as soon as they have all exited, so a restart keeps the short {@link RESTART_BUDGET}
   * rather than the stop budget. Running jobs are still handed back, after 1 s instead of the grace
   * period.
   */
  exitApp() {
    this.stop(ExitCode.AppRestart, RESTART_BUDGET);
  }

  /**
   * FL-291: stop this worker gracefully (`closeFn`: in-flight requests and running jobs get the grace
   * period, then the application closes) and exit with `exitCode`. Exits at the worker deadline
   * whatever the teardown is still doing. The budget comes from FRAMELEAF_SHUTDOWN_* unless given.
   */
  stop(exitCode: number = 0, budget?: { graceMs: number; workerDeadlineMs: number }) {
    if (this.stopping) {
      return;
    }
    this.stopping = true;

    const { graceMs, workerDeadlineMs } = budget ?? new ConfigRepository().getEnv().shutdown;

    /* eslint-disable unicorn/no-process-exit */
    // in exceptional circumstance, the application may hang
    setTimeout(() => process.exit(exitCode), workerDeadlineMs);

    void Promise.try(() => this.closeFn?.(graceMs))
      .catch((error) => console.error(`Unable to stop gracefully: ${error}`))
      .finally(() => process.exit(exitCode));
    /* eslint-enable unicorn/no-process-exit */
  }

  setCloseFn(fn: (graceMs: number) => Promise<void>) {
    this.closeFn = fn;
  }

  async sendOneShotAppRestart(state: AppRestartEvent): Promise<void> {
    const server = new SocketIO();
    const { redis } = new ConfigRepository().getEnv();
    const pubClient = new Redis({ ...redis, lazyConnect: true });
    const subClient = pubClient.duplicate();

    try {
      await Promise.all([pubClient.connect(), subClient.connect()]);

      server.adapter(createAdapter(pubClient, subClient));

      // => corresponds to notification.service.ts#onAppRestart
      await new Promise<void>((resolve, reject) => {
        server.emit('AppRestartV1', state, () => {
          void server
            .serverSideEmitWithAck('AppRestart', state)
            .then((responses) => {
              if (responses.some((response) => response !== 'ok')) {
                throw new Error("One or more node(s) returned a non-'ok' response to our restart request!");
              }
            })
            .then(resolve)
            .catch(reject);
        });
      });
    } finally {
      try {
        await server.sockets.adapter.close();
      } finally {
        pubClient.disconnect();
        subClient.disconnect();
      }
    }
  }
}
