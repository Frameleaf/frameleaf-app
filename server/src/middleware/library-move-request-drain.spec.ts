import { Controller, Module, Post, Res } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, NestFactory } from '@nestjs/core';
import { request } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import type { Response } from 'express';
import { LibraryMoveFenceGuard } from 'src/middleware/library-move-fence.guard.js';
import { libraryMoveFence } from 'src/utils/frameleaf-library-move-fence.js';

it.each(['success', 'failure'])(
  'keeps a disconnected write counted until its controller settles with %s',
  async (outcome) => {
    const entered = Promise.withResolvers<void>();
    const disconnected = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const settled = Promise.withResolvers<void>();
    @Controller()
    class SlowWriteController {
      @Post('write')
      async write(@Res({ passthrough: true }) response: Response) {
        response.once('close', () => disconnected.resolve());
        entered.resolve();
        try {
          await release.promise;
          if (outcome === 'failure') throw new Error('write failed');
          return { written: true };
        } finally {
          settled.resolve();
        }
      }
    }
    @Module({
      controllers: [SlowWriteController],
      providers: [
        { provide: APP_GUARD, useClass: LibraryMoveFenceGuard },
        { provide: APP_INTERCEPTOR, useClass: LibraryMoveFenceGuard },
      ],
    })
    class TestModule {}
    let app: INestApplication | undefined;
    let upload: ReturnType<typeof request> | undefined;
    try {
      app = await NestFactory.create(TestModule, { logger: false });
      await app.listen(0, '127.0.0.1');
      upload = request(`${await app.getUrl()}/write`, { method: 'POST' });
      upload.on('error', () => {});
      upload.end();
      await entered.promise;
      expect(libraryMoveFence.writesInFlight).toBe(1);
      libraryMoveFence.raise();
      upload.destroy();
      await disconnected.promise;

      expect(libraryMoveFence.writesInFlight).toBe(1);

      release.resolve();
      await settled.promise;
      await vi.waitFor(() => expect(libraryMoveFence.writesInFlight).toBe(0));
    } finally {
      release.resolve();
      upload?.destroy();
      await app?.close();
      libraryMoveFence.lower();
    }
  },
);
