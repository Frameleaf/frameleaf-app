import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { RenderArtifact, openRenderArtifact, receiveRenderArtifact } from 'src/utils/render-artifact.js';

vi.mock('node:fs', async () => {
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...fs, createWriteStream: vi.fn(fs.createWriteStream) };
});

describe('server-owned render artifacts', () => {
  let folder: string;
  const bytes = Buffer.from('real encoded bytes\0with a second block');
  const expected = { checksum: createHash('sha256').update(bytes).digest('hex'), sizeInBytes: String(bytes.length) };
  const check = async () => {};
  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'render-artifact-'));
  });
  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });
  const upload = (
    input = Readable.from([bytes]),
    commit: (artifact: RenderArtifact) => Promise<boolean> = () => Promise.resolve(true),
  ) => receiveRenderArtifact(folder, input, expected, check, commit);

  it('accepts a required server-sealed zero-cue sibling but retains the positive media-size boundary', async () => {
    const empty = { checksum: createHash('sha256').update('').digest('hex'), sizeInBytes: '0' };
    let recorded: RenderArtifact | undefined;
    await expect(
      receiveRenderArtifact(
        folder,
        Readable.from([]),
        empty,
        check,
        (artifact) => {
          recorded = artifact;
          return Promise.resolve(true);
        },
        { allowEmpty: true },
      ),
    ).resolves.toBe(true);
    expect(await readFile(recorded!.outputPath)).toEqual(Buffer.alloc(0));
    await expect(
      receiveRenderArtifact(folder, Readable.from([]), empty, check, () => Promise.resolve(true)),
    ).rejects.toThrow();
  });

  it('streams, hashes and durably records actual bytes with a private server filename', async () => {
    let recorded: RenderArtifact | undefined;
    await expect(
      upload(Readable.from([bytes.subarray(0, 4), bytes.subarray(4)]), async (artifact) => {
        expect(await readFile(artifact.outputPath)).toEqual(bytes);
        recorded = artifact;
        return true;
      }),
    ).resolves.toBe(true);
    const stream = await openRenderArtifact(folder, recorded!, check);
    const output = await Array.fromAsync(stream);
    expect(Buffer.concat(output)).toEqual(bytes);
    expect(await readdir(folder)).toEqual([recorded!.outputPath.slice(folder.length + 1)]);
  });

  it.each(['short', 'long', 'wrong-digest', 'disconnected'] as const)(
    'removes every partial/final file on %s upload',
    async (failure) => {
      const input =
        failure === 'short'
          ? Readable.from([bytes.subarray(1)])
          : failure === 'long'
            ? Readable.from([bytes, Buffer.from('x')])
            : failure === 'wrong-digest'
              ? Readable.from([Buffer.alloc(bytes.length)])
              : Readable.from(
                  (async function* () {
                    yield bytes.subarray(0, 4);
                    await Promise.reject(new Error('disconnected'));
                  })(),
                );
      let completed = false;
      await expect(
        upload(input, () => {
          completed = true;
          return Promise.resolve(true);
        }),
      ).rejects.toThrow();
      expect(completed).toBe(false);
      expect(await readdir(folder)).toEqual([]);
    },
  );

  it('waits for delayed file open/close before cleaning an overlong upload', async () => {
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.mocked(createWriteStream).mockImplementationOnce((path, options) =>
      fs.createWriteStream(path, {
        ...(typeof options === 'object' && options),
        fs: {
          ...fs,
          open: ((...args: unknown[]) => {
            setTimeout(() => Reflect.apply(fs.open, fs, args), 25);
          }) as typeof fs.open,
        },
      }),
    );
    await expect(upload(Readable.from([bytes, Buffer.from('extra')]))).rejects.toThrow('declared size');
    // Wait past the controlled open; cleanup must still hold, rather than winning only a readdir race.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await readdir(folder)).toEqual([]);
  });

  it('removes an uploaded file when the claim loses the durable checkpoint race', async () => {
    await expect(upload(undefined, () => Promise.resolve(false))).resolves.toBe(false);
    expect(await readdir(folder)).toEqual([]);
  });

  it('refuses revoked access before durable completion and cleans the file', async () => {
    let checks = 0;
    await expect(
      receiveRenderArtifact(
        folder,
        Readable.from([bytes]),
        expected,
        () => {
          if (++checks > 1) {
            throw new Error('revoked');
          }
          return Promise.resolve();
        },
        () => Promise.resolve(true),
      ),
    ).rejects.toThrow('revoked');
    expect(await readdir(folder)).toEqual([]);
  });

  it.each(['missing', 'corrupt', 'symlink', 'foreign-path'] as const)(
    'refuses %s recovery without serving bytes',
    async (failure) => {
      let recorded!: RenderArtifact;
      await upload(undefined, (artifact) => {
        recorded = artifact;
        return Promise.resolve(true);
      });
      switch (failure) {
        case 'missing': {
          await rm(recorded.outputPath);
          break;
        }
        case 'corrupt': {
          await writeFile(recorded.outputPath, Buffer.alloc(bytes.length));
          break;
        }
        case 'symlink': {
          await rename(recorded.outputPath, join(folder, 'original'));
          await symlink(join(folder, 'original'), recorded.outputPath);
          break;
        }
        case 'foreign-path': {
          recorded.outputPath = join(folder, '..', 'other.artifact');
          break;
        }
      }
      await expect(openRenderArtifact(folder, recorded, check)).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  it('serves the verified descriptor if the pathname is replaced after verification', async () => {
    let recorded!: RenderArtifact;
    await upload(undefined, (artifact) => {
      recorded = artifact;
      return Promise.resolve(true);
    });
    const stream = await openRenderArtifact(folder, recorded, check);
    await rename(recorded.outputPath, join(folder, 'old'));
    await writeFile(recorded.outputPath, Buffer.alloc(bytes.length));
    const chunks = await Array.fromAsync(stream);
    expect(Buffer.concat(chunks)).toEqual(bytes);
  });
});
