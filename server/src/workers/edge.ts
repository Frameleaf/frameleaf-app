import { NestFactory } from '@nestjs/core';
import { EdgeModule } from 'src/edge/edge.module.js';
import { isStartUpError } from 'src/utils/misc.js';

/**
 * FL-165: the edge worker. It serves remote access (the direct HTTPS listener; the relay tunnel
 * arrives with CLD-103) and is idle until the server is linked, entitled and remote access is on. It
 * has no HTTP server of its own for the API: it proxies to it over loopback.
 */
async function bootstrap() {
  process.title = 'frameleaf-edge';

  const app = await NestFactory.createApplicationContext(EdgeModule, { bufferLogs: true });
  // a stop request (restart, shutdown) runs the module's teardown: every socket closes within 5 s
  app.enableShutdownHooks(['SIGTERM', 'SIGINT']);

  // the supervisor went away: close everything rather than keep the direct port open
  process.on('disconnect', () => {
    void app.close().finally(() => process.exit(0));
  });
}

bootstrap().catch((error) => {
  if (!isStartUpError(error)) {
    console.error(error);
  }
  // eslint-disable-next-line unicorn/no-process-exit
  process.exit(1);
});
