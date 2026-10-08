import { sql } from 'kysely';
import { type ChildProcess, fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import type { JobItem } from 'src/types.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { defaults } from 'src/dtos/config.dto.js';
import { AssetFileType, JobName, JobStatus, QueueName } from 'src/enum.js';
import { publishJobResult } from 'src/queue/context.js';
import { SharpProcessPool, sharpProcessPool } from 'src/queue/sharp-pool.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { QUEUE_TIMING } from 'src/queue/types.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { MediaService } from 'src/services/media.service.js';
import { ATTEMPT_EVIDENCE_PREFIX } from 'src/utils/attempt-evidence.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { getForGenerateThumbnail } from 'test/mappers.js';
import { getKyselyDB, newTestService } from 'test/utils.js';

/** Real production thumbnail batch + Sharp children + PG facade; unrelated asset publication is a fixture callback. */
describe('thumbnail batch native lifetime', () => {
  it.each([false, true])(
    'completes with two workers and no pending slots (first batch hangs: %s)',
    async (hangFirst) => {
      const db = await getKyselyDB();
      const store = new SqlQueueStore(db);
      const queue = `sharp-batch-${randomUUID()}`;
      const worker = randomUUID();
      await store.initialize([queue], worker);
      const directory = await mkdtemp(join(tmpdir(), 'sharp-batch-'));
      const originalPath = join(directory, 'original.jpg');
      await sharp({ create: { width: 12, height: 8, channels: 3, background: '#a03020' } })
        .jpeg()
        .toFile(originalPath);
      const originalBytes = await readFile(originalPath);
      const children: ChildProcess[] = [];
      const operations: string[] = [];
      const paused = Promise.withResolvers<ChildProcess>();
      let shouldHang = hangFirst;
      const pool = new SharpProcessPool({
        workers: 2,
        pending: 0,
        deadlineMs: 10_000,
        graceMs: 30,
        createChild: () => {
          const child = fork(new URL('../../../../src/queue/sharp-worker.ts', import.meta.url), [], {
            serialization: 'advanced',
            stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
            execArgv: ['--import', 'tsx'],
          });
          children.push(child);
          const send = child.send.bind(child);
          child.send = ((...args: Parameters<typeof child.send>) => {
            const message = args[0] as { operation: string };
            operations.push(message.operation);
            if (shouldHang && message.operation === 'generateImageThumbnails') {
              shouldHang = false;
              child.kill('SIGSTOP');
              paused.resolve(child);
            }
            return Reflect.apply(send, child, args) as boolean;
          }) as typeof child.send;
          return child;
        },
      });
      const delegate = vi.spyOn(sharpProcessPool, 'run').mockImplementation(pool.run.bind(pool));
      const paths = vi
        .spyOn(StorageCore, 'getImagePath')
        .mockImplementation((_asset, options) => join(directory, `${options.fileType}.${options.format}`));
      const { sut, mocks } = newTestService(MediaService);
      const native = new MediaRepository({ setContext: vi.fn() } as never);
      mocks.media.decodeImage.mockImplementation(native.decodeImage.bind(native));
      mocks.media.getImageMetadata.mockImplementation(native.getImageMetadata.bind(native));
      mocks.media.generateThumbhash.mockImplementation(native.generateThumbhash.bind(native));
      mocks.media.generateThumbnail.mockImplementation(native.generateThumbnail.bind(native));
      mocks.media.generateImageThumbnails.mockImplementation(native.generateImageThumbnails.bind(native));
      mocks.storage.mkdirSync.mockImplementation((path) => {
        mkdirSync(path, { recursive: true });
      });
      const asset = getForGenerateThumbnail(
        AssetFactory.from({ originalPath, originalFileName: 'original.jpg' }).exif().build(),
      );
      const adopted = vi.fn();
      let generated: Awaited<ReturnType<MediaService['generateImageThumbnails']>> | undefined;
      const executor: JobRepository = new JobRepository(
        {} as never,
        {} as never,
        { emit: async (_event: string, _queue: string, item: JobItem) => executor.run(item) } as never,
        { setContext: vi.fn(), error: vi.fn() } as never,
        db,
      );
      executor['handlers'][JobName.AssetGenerateThumbnails] = {
        queueName: queue as QueueName,
        handler: async () => {
          generated = await sut['generateImageThumbnails'](asset, defaults);
          await publishJobResult(() => {
            adopted();
            return Promise.resolve();
          });
          return JobStatus.Success;
        },
      } as never;
      const abort = new AbortController();
      let executing: Promise<void> | undefined;
      try {
        await store.enqueue([
          {
            queue,
            name: JobName.AssetGenerateThumbnails,
            data: { id: asset.id },
            safeToRetry: true,
            sensitive: false,
            deadlineMs: QUEUE_TIMING.opaqueDeadline,
          },
        ]);
        const [first] = await store.claim(queue, worker);
        executing = executor['execute'](first, abort);
        if (hangFirst) {
          const hung = await Promise.race([
            paused.promise,
            executing.then(() => {
              throw new Error('Thumbnail handler settled before the hang checkpoint');
            }),
          ]);
          await delay(100); // Give an erroneous early Promise.all rejection time to reach durable settlement.
          expect(children).toHaveLength(1);
          expect(operations.filter((name) => name === 'generateThumbnail')).toEqual([]);
          expect((await sql`select state from job where id = ${first.id}::uuid`.execute(db)).rows).toEqual([
            { state: 'active' },
          ]);
          expect(
            (
              await sql`select key from system_metadata where key = ${ATTEMPT_EVIDENCE_PREFIX + first.token}`.execute(
                db,
              )
            ).rows,
          ).toEqual([]);
          expect(adopted).not.toHaveBeenCalled();
          abort.abort(new Error('stop hung thumbnail attempt'));
          await executing;
          expect(hung.signalCode).toBe('SIGKILL');
          expect(
            (
              await sql`select key from system_metadata where key = ${ATTEMPT_EVIDENCE_PREFIX + first.token}`.execute(
                db,
              )
            ).rows,
          ).toHaveLength(1);
          await sql`update job set "availableAt" = now() where id = ${first.id}::uuid`.execute(db);
          const [retry] = await store.claim(queue, worker);
          expect(retry.attempt).toBe(2);
          await executor['execute'](retry, new AbortController());
        } else {
          await executing;
        }
        expect((await sql`select state from job where id = ${first.id}::uuid`.execute(db)).rows).toEqual([
          { state: 'completed' },
        ]);
        expect(operations).toEqual(Array.from({ length: hangFirst ? 2 : 1 }, () => 'generateImageThumbnails'));
        expect(adopted).toHaveBeenCalledTimes(1);
        expect(generated?.thumbhash).toBeInstanceOf(Buffer);
        expect(generated?.files.map((file) => file.type)).toEqual([
          AssetFileType.Preview,
          AssetFileType.Thumbnail,
          AssetFileType.FullSize,
        ]);
        for (const file of generated!.files) {
          expect((await sharp(file.path).metadata()).width).toBeGreaterThan(0);
        }
        expect(await readFile(originalPath)).toEqual(originalBytes);
      } finally {
        abort.abort();
        await executing;
        await pool.close();
        delegate.mockRestore();
        paths.mockRestore();
        await rm(directory, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
