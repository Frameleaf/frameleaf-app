import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { RenderArtifact, openRenderArtifact, receiveRenderArtifact } from 'src/utils/render-artifact.js';

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
