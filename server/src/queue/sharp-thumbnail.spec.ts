import { type ChildProcess, fork } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { AssetEditAction, type AssetEditActionItem } from 'src/dtos/editing.dto.js';
import { Colorspace, ImageFormat } from 'src/enum.js';
import { SharpOperations } from 'src/queue/sharp-operations.js';
import { SharpProcessPool } from 'src/queue/sharp-pool.js';
import { sharpPayloadBytes } from 'src/queue/sharp-protocol.js';

describe('isolated thumbnail batch', () => {
  it('retains the decoded-buffer limit before writing any output', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sharp-thumbnail-limit-'));
    const input = join(directory, 'original.png');
    const output = join(directory, 'preview.jpeg');
    await sharp({ create: { width: 128, height: 128, channels: 3, background: 'red' } })
      .png()
      .toFile(input);
    const pool = new SharpProcessPool({ workers: 1, pending: 0, maxBytes: 4096 });
    try {
      await expect(
        pool.run('generateImageThumbnails', [
          input,
          { colorspace: Colorspace.Srgb, processInvalidImages: false },
          {
            outputs: [{ path: output, options: { format: ImageFormat.Jpeg, quality: 80 } }],
            edits: [],
            checkTransparency: false,
          },
        ]),
      ).rejects.toThrow('decoded buffer is too large');
      await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await pool.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it('distinguishes decode failures from output failures for RAW fallback', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sharp-thumbnail-error-'));
    const input = await sharp({ create: { width: 16, height: 8, channels: 3, background: 'red' } })
      .png()
      .toBuffer();
    const pool = new SharpProcessPool({ workers: 1, pending: 0 });
    const decode = { colorspace: Colorspace.Srgb, processInvalidImages: false };
    const batch = {
      outputs: [
        { path: join(directory, 'missing', 'preview.jpeg'), options: { format: ImageFormat.Jpeg, quality: 80 } },
      ],
      edits: [],
      checkTransparency: false,
    };
    try {
      await expect(
        pool.run('generateImageThumbnails', [Buffer.from('damaged image'), decode, batch]),
      ).rejects.toMatchObject({
        decodeFailure: true,
      });
      await expect(pool.run('generateImageThumbnails', [input, decode, batch])).rejects.toMatchObject({
        decodeFailure: false,
      });
    } finally {
      await pool.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it.each([false, true])(
    'keeps decoded pixels in one zero-pending child request (fullsize: %s)',
    async (fullsize) => {
      const directory = await mkdtemp(join(tmpdir(), 'sharp-thumbnail-'));
      const input = join(directory, 'original.png');
      const pixels = Buffer.alloc(512 * 256 * 4);
      for (let index = 0; index < pixels.length; index++) {
        pixels[index] = index % 251;
      }
      await sharp(pixels, { raw: { width: 512, height: 256, channels: 4 } })
        .withMetadata({ orientation: 6 })
        .png()
        .toFile(input);
      const original = await readFile(input);
      const requests: unknown[] = [];
      const results: unknown[] = [];
      const progress: number[] = [];
      const pool = new SharpProcessPool({
        workers: 1,
        pending: 0,
        createChild: () => {
          const child = fork(new URL('sharp-worker.ts', import.meta.url), [], {
            serialization: 'advanced',
            stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
            execArgv: ['--import', 'tsx'],
          });
          const send = child.send.bind(child);
          child.send = ((...args: Parameters<ChildProcess['send']>) => {
            requests.push(args[0]);
            return Reflect.apply(send, child, args) as boolean;
          }) as ChildProcess['send'];
          child.on('message', (message: { type: string; value: unknown; completed: number }) => {
            if (message.type === 'result') results.push(message.value);
            else if (message.type === 'progress') progress.push(message.completed);
          });
          return child;
        },
      });
      const decode = { colorspace: Colorspace.P3, processInvalidImages: false, size: fullsize ? undefined : 128 };
      const outputs = [
        { path: join(directory, 'thumbnail.webp'), options: { format: ImageFormat.Webp, quality: 80, size: 32 } },
        {
          path: join(directory, 'preview.jpeg'),
          options: { format: ImageFormat.Jpeg, quality: 80, size: 64, progressive: true },
        },
        ...(fullsize
          ? [{ path: join(directory, 'fullsize.webp'), options: { format: ImageFormat.Webp, quality: 100 } }]
          : []),
      ];
      const edits: AssetEditActionItem[] = [{ action: AssetEditAction.Rotate, parameters: { angle: 90 } }];
      try {
        const result = await pool.run('generateImageThumbnails', [
          input,
          decode,
          { outputs, edits, checkTransparency: true },
        ]);
        expect(result.info).toMatchObject({ width: fullsize ? 256 : 128, height: fullsize ? 512 : 256, channels: 4 });
        expect(result.isTransparent).toBe(true);
        expect(requests).toHaveLength(1);
        expect(results).toHaveLength(1);
        expect(sharpPayloadBytes(requests[0])).toBeLessThan(4096);
        expect(sharpPayloadBytes(results[0])).toBeLessThan(4096);
        expect(result).not.toHaveProperty('data');
        expect(progress).toHaveLength(2 + outputs.length);

        // The former separate operations are the byte-for-byte compatibility reference.
        const legacy = new SharpOperations();
        const { data, info } = await legacy.decodeImage(input, decode);
        const base = { colorspace: decode.colorspace, processInvalidImages: false, raw: info, edits };
        expect(result.thumbhash).toEqual(await legacy.generateThumbhash(data, base));
        for (const output of outputs) {
          const reference = output.path + '.reference';
          await legacy.generateThumbnail(data, { ...output.options, ...base }, reference);
          expect(await readFile(output.path)).toEqual(await readFile(reference));
          const metadata = await sharp(output.path).metadata();
          expect(metadata.exif).toBeUndefined();
          expect(metadata.icc).toBeDefined();
        }
        expect((await sharp(outputs[1].path).metadata()).isProgressive).toBe(true);
        expect(await readFile(input)).toEqual(original);
      } finally {
        await pool.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
