import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { close as closeFile, createWriteStream } from 'node:fs';
import { mkdtemp, open, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { RenderArtifact, openRenderArtifact, receiveRenderArtifact } from 'src/utils/render-artifact.js';

vi.mock('node:fs', async () => {
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...fs, createWriteStream: vi.fn(fs.createWriteStream), close: vi.fn(fs.close) };
});

vi.mock('node:fs/promises', async () => {
  const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...fs, open: vi.fn(fs.open), rm: vi.fn(fs.rm) };
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

  it('closes the verification descriptor before handing ownership to the database', async () => {
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const files: Awaited<ReturnType<typeof open>>[] = [];
    vi.mocked(open).mockImplementation(async (...args) => {
      const file = await fs.open(...args);
      files.push(file);
      return file;
    });
    try {
      await upload(undefined, () => {
        expect(files.length).toBeGreaterThan(0);
        expect(files.every((file) => file.fd === -1)).toBe(true);
        return Promise.resolve(true);
      });
    } finally {
      vi.mocked(open).mockImplementation(fs.open);
    }
  });

  it('retains the verified file when database commit acknowledgement is uncertain', async () => {
    let recorded!: RenderArtifact;
    const lostAck = new Error('commit acknowledgement lost');
    await expect(
      upload(undefined, (artifact) => {
        recorded = artifact;
        return Promise.reject(lostAck);
      }),
    ).rejects.toBe(lostAck);
    expect(await readFile(recorded.outputPath)).toEqual(bytes);
    expect(await readdir(folder)).toEqual([recorded.outputPath.slice(folder.length + 1)]);
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

  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])(
    'retains unconfirmed descriptors and their failure even with cleanup errors (verification refused: %s, cleanup fails: %s)',
    async (refused, cleanupFails) => {
      const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      let close: (() => Promise<void>) | undefined;
      let opened = false;
      vi.mocked(open).mockImplementation(async (...args) => {
        const handle = await real.open(...args);
        if (String(args[0]).endsWith('.artifact')) {
          opened = true;
          const originalClose = handle.close.bind(handle);
          close = async () => {
            handle.close = originalClose;
            await originalClose();
          };
          handle.close = () => Promise.reject(new Error('close failed'));
        }
        return handle;
      });
      vi.mocked(rm).mockClear();
      vi.mocked(rm).mockImplementation(async (...args) => {
        if (cleanupFails && String(args[0]).endsWith('.partial')) throw new Error('partial cleanup failed');
        return real.rm(...args);
      });
      const commit = vi.fn(() => Promise.resolve(true));
      try {
        await expect(
          receiveRenderArtifact(
            folder,
            Readable.from([bytes]),
            expected,
            () => {
              return refused && opened ? Promise.reject(new Error('authority withdrawn')) : Promise.resolve();
            },
            commit,
          ),
        ).rejects.toThrow('artifact_close_unconfirmed');
        expect(commit).not.toHaveBeenCalled();
        expect(rm).not.toHaveBeenCalled();
        const files = await readdir(folder);
        expect(files).toHaveLength(1);
        expect(await readFile(join(folder, files[0]))).toEqual(bytes);
      } finally {
        vi.mocked(rm).mockImplementation(real.rm);
        await close?.();
      }
    },
  );

  it.each(['complete', 'interrupted'] as const)(
    'retains a stream whose actual close fails after %s input',
    async (kind) => {
      const real = await vi.importActual<typeof import('node:fs')>('node:fs');
      const promises = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      vi.mocked(createWriteStream).mockImplementation(real.createWriteStream);
      vi.mocked(open).mockImplementation(promises.open);
      vi.mocked(rm).mockImplementation(promises.rm).mockClear();
      let descriptor: number | undefined;
      vi.mocked(closeFile).mockImplementationOnce((fd, callback) => {
        descriptor = fd;
        callback!(Object.assign(new Error('synthetic close failure'), { code: 'EIO' }));
      });
      const commit = vi.fn(() => Promise.resolve(true));
      const input =
        kind === 'complete'
          ? Readable.from([bytes])
          : Readable.from(
              (function* () {
                yield bytes.subarray(0, 4);
                throw new Error('input interrupted');
              })(),
            );
      try {
        await expect(receiveRenderArtifact(folder, input, expected, check, commit)).rejects.toThrow(
          'artifact_close_unconfirmed',
        );
        expect(commit).not.toHaveBeenCalled();
        expect(rm).not.toHaveBeenCalled();
        expect(descriptor).toBeTypeOf('number');
        const stat = await new Promise<import('node:fs').Stats>((resolve, reject) =>
          real.fstat(descriptor!, (error, value) => (error ? reject(error) : resolve(value))),
        );
        expect(stat.isFile()).toBe(true);
        const files = await readdir(folder);
        expect(files).toHaveLength(1);
        expect(files[0]).toMatch(/\.partial$/u);
        if (kind === 'complete') expect(await readFile(join(folder, files[0]))).toEqual(bytes);
      } finally {
        vi.mocked(closeFile).mockRestore();
        if (descriptor !== undefined)
          await new Promise<void>((resolve, reject) =>
            real.close(descriptor!, (error) => (error ? reject(error) : resolve())),
          );
      }
    },
  );
  it('refuses an aborted delivery before database publication and removes the closed partial', async () => {
    const controller = new AbortController();
    controller.abort();
    const commit = vi.fn().mockResolvedValue(true);
    await expect(
      receiveRenderArtifact(folder, Readable.from([bytes]), expected, check, commit, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(commit).not.toHaveBeenCalled();
    expect(await readdir(folder)).toEqual([]);
  });
  it('cancels during independent verification before commit and confirms descriptor closure', async () => {
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const controller = new AbortController();
    const files: Awaited<ReturnType<typeof open>>[] = [];
    const commit = vi.fn().mockResolvedValue(true);
    vi.mocked(open).mockImplementation(async (...args) => {
      const file = await fs.open(...args);
      files.push(file);
      if (String(args[0]).endsWith('.artifact')) controller.abort();
      return file;
    });
    try {
      await expect(
        receiveRenderArtifact(folder, Readable.from([bytes]), expected, check, commit, { signal: controller.signal }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(commit).not.toHaveBeenCalled();
      expect(files).toHaveLength(2);
      expect(files.every((file) => file.fd === -1)).toBe(true);
      expect(await readdir(folder)).toEqual([]);
    } finally {
      vi.mocked(open).mockImplementation(fs.open);
    }
  });
});
