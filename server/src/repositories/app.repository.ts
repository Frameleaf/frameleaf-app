import { Injectable } from '@nestjs/common';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import { Server as SocketIO } from 'socket.io';
import { ExitCode } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { AppRestartEvent } from 'src/repositories/event.repository.js';

@Injectable()
export class AppRepository {
  private closeFn?: () => Promise<void>;
  private stopping?: boolean;

  /** Restart: the worker stops like it does on SIGTERM and the supervisor starts it again. */
  exitApp() {
    this.stop(ExitCode.AppRestart);
  }

  /**
   * FL-291: stop this worker gracefully (`closeFn`: in-flight requests and running jobs get the grace
   * period, then the application closes) and exit with `exitCode`. Exits at the worker deadline
   * (derived from FRAMELEAF_SHUTDOWN_*) whatever the teardown is still doing.
   */
  stop(exitCode: number = 0) {
    if (this.stopping) {
      return;
    }
    this.stopping = true;

    /* eslint-disable unicorn/no-process-exit */
    // in exceptional circumstance, the application may hang
    const { shutdown } = new ConfigRepository().getEnv();
    setTimeout(() => process.exit(exitCode), shutdown.workerDeadlineMs);

    void Promise.try(() => this.closeFn?.())
      .catch((error) => console.error(`Unable to stop gracefully: ${error}`))
      .finally(() => process.exit(exitCode));
    /* eslint-enable unicorn/no-process-exit */
  }

  setCloseFn(fn: () => Promise<void>) {
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
