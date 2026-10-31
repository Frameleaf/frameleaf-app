/* eslint-disable unicorn/no-process-exit -- Worker executable owns its process lifetime. */
import { NestFactory } from '@nestjs/core';
import { EdgeModule } from 'src/edge/edge.module.js';
import { lockedKeys } from 'src/utils/locked-key-holder.js';
import { attachLockedKeyIpc } from 'src/utils/locked-key-ipc.js';
import { isStartUpError } from 'src/utils/misc.js';
import { onStopRequest } from 'src/utils/shutdown.js';

/**
 * FL-165: the edge worker. It serves remote access (the direct HTTPS listener; the relay tunnel
 * arrives with CLD-103) and is idle until the server is linked, entitled and remote access is on. It
 * has no HTTP server of its own for the API: it proxies to it over loopback.
 */
async function bootstrap() {
  process.title = 'frameleaf-edge';
  // FL-721: the supervisor hands this process the Locked keys the API loads
  attachLockedKeyIpc(lockedKeys);
  const nativeOwner = process.env.FRAMELEAF_NATIVE_OWNER === '1';
  // The owner may stop a native fork while Nest is still starting.
  let stop = (): void => process.exit(0);
  if (nativeOwner) onStopRequest(() => stop(), { ipc: true });

  const app = await NestFactory.createApplicationContext(EdgeModule, { bufferLogs: true });
  // a stop request (restart, shutdown) runs the module's teardown: every socket closes within 5 s
  if (nativeOwner) {
    stop = () => {
      void app
        .close()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    };
  } else {
    app.enableShutdownHooks(['SIGTERM', 'SIGINT']);

    // the supervisor went away: close everything rather than keep the direct port open
    process.on('disconnect', () => {
      void app.close().finally(() => process.exit(0));
    });
  }
}

bootstrap().catch((error) => {
  if (!isStartUpError(error)) {
    console.error(error);
  }
  process.exit(1);
});
