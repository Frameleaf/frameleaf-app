import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import type { TakeoutSource } from 'src/repositories/takeout.repository.js';
import type { TakeoutZipEntry } from 'src/utils/takeout-zip.js';
import { TakeoutStagingRepository } from 'src/repositories/takeout-staging.repository.js';
import { tryPromise } from 'src/utils/promise.js';

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return { ...original, createReadStream: vi.fn(original.createReadStream) };
});

describe(TakeoutStagingRepository.name, () => {
  const sut = new TakeoutStagingRepository();
  let directory: string;
  const signal = () => new AbortController().signal;
  const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest();
  const created = vi.fn().mockResolvedValue(undefined);

  beforeEach(async () => {
    created.mockClear();
    directory = await realpath(await mkdtemp(join(tmpdir(), 'takeout-staging-')));
    const original = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.mocked(createReadStream).mockReset().mockImplementation(original.createReadStream);
  });
  afterEach(async () => {
    for (const result of vi.mocked(createReadStream).mock.results) {
      if (result.type === 'return') result.value.destroy();
    }
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  const limitReads = async (path: string) => {
    const handle = await open(path, 'r');
    const prototype = Object.getPrototypeOf(handle);
    const read = prototype.read;
    vi.spyOn(prototype, 'read').mockImplementation(function (this: unknown, buffer, offset, length, position) {
      return read.call(this, buffer, offset, Math.min(length as number, 2), position);
    });
    await handle.close();
  };

  it('preserves an existing destination when exclusive creation fails', async () => {
    const staged = join(directory, 'staged'),
      destination = join(directory, 'existing');
    await writeFile(staged, 'new bytes');
    await writeFile(destination, 'original bytes');
    await expect(sut.copyToLibrary(staged, 9, destination, signal(), created)).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect(created).not.toHaveBeenCalled();
    expect(await readFile(destination, 'utf8')).toBe('original bytes');
    expect(await readFile(staged, 'utf8')).toBe('new bytes');
  });

  it('copies and hashes exact bytes without consuming the staged source', async () => {
    const staged = join(directory, 'staged'),
      destination = join(directory, 'copy');
    const bytes = Buffer.from('exact bytes');
    await writeFile(staged, bytes);
    expect(await sut.copyToLibrary(staged, bytes.length, destination, signal(), created)).toEqual({
      size: bytes.length,
      checksum: hash(bytes),
      legacyChecksum: createHash('sha1').update(bytes).digest(),
    });
    expect(await readFile(destination)).toEqual(bytes);
    expect(await readFile(staged)).toEqual(bytes);
  });

  it('records the owned destination before reading or copying its first byte', async () => {
    const staged = join(directory, 'staged'),
      destination = join(directory, 'copy');
    await writeFile(staged, 'data');
    const created = vi.fn(async () => {
      expect(await readFile(destination)).toHaveLength(0);
      expect(createReadStream).not.toHaveBeenCalled();
    });
    await sut.copyToLibrary(staged, 4, destination, signal(), created);
    expect(created).toHaveBeenCalledOnce();
  });

  it('removes its empty output without reading source bytes if recording ownership fails', async () => {
    const staged = join(directory, 'staged'),
      destination = join(directory, 'copy');
    await writeFile(staged, 'data');
    await expect(
      sut.copyToLibrary(staged, 4, destination, signal(), () =>
        tryPromise(() => {
          throw new Error('recording ownership failed');
        }),
      ),
    ).rejects.toThrow('recording ownership failed');
    expect(createReadStream).not.toHaveBeenCalled();
    await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([2, 20])('removes only its newly created output after a size mismatch (%i)', async (declared) => {
    const staged = join(directory, 'staged'),
      destination = join(directory, 'copy');
    await writeFile(staged, 'data');
    await expect(sut.copyToLibrary(staged, declared, destination, signal(), created)).rejects.toThrow();
    await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(staged, 'utf8')).toBe('data');
  });

  it('accepts identical retried chunks after multiple short filesystem reads', async () => {
    const path = join(directory, 'archive'),
      bytes = Buffer.from('01234567');
    await writeFile(path, bytes);
    await limitReads(path);
    await expect(sut.writeChunk({ path, size: 8, received: 8 } as TakeoutSource, 0, bytes)).resolves.toBe(8);
  });

  it('verifies a resume range after multiple short filesystem reads', async () => {
    const path = join(directory, 'archive'),
      bytes = Buffer.from('01234567');
    await writeFile(path, bytes);
    await limitReads(path);
    await expect(
      sut.verifyChunk({ path, received: 8 } as TakeoutSource, 2, 4, hash(bytes.subarray(2, 6)).toString('hex')),
    ).resolves.toBeUndefined();
  });

  it('reads complete ZIP ranges across short reads and stops at actual EOF', async () => {
    const path = join(directory, 'archive'),
      bytes = Buffer.from('01234567');
    await writeFile(path, bytes);
    await limitReads(path);
    const archive = await sut.openArchive(path);
    try {
      expect(await archive.source.read(2, 6)).toEqual(bytes.subarray(2));
      expect(await archive.source.read(6, 6)).toEqual(bytes.subarray(6));
    } finally {
      await archive.close();
    }
  });

  it('refuses a range read larger than any archive read needs, before allocating it', async () => {
    const path = join(directory, 'archive');
    await writeFile(path, Buffer.from('01234567'));
    const allocate = vi.spyOn(Buffer, 'alloc');
    const archive = await sut.openArchive(path);
    try {
      await expect(archive.source.read(0, 2 ** 40)).rejects.toThrow('larger than an import needs');
      expect(allocate).not.toHaveBeenCalledWith(2 ** 40);
    } finally {
      await archive.close();
    }
  });

  it('refuses a descendant directory swapped for a link before descending into it', async () => {
    const selected = join(directory, 'selected'),
      outside = join(directory, 'outside');
    await mkdir(join(selected, 'a-child'), { recursive: true });
    await mkdir(outside);
    await writeFile(join(selected, 'z-first'), 'first');
    await writeFile(join(outside, 'private'), 'outside');
    const walk = sut.walk(selected, signal());
    expect((await walk.next()).value).toMatchObject({ entryName: 'z-first' });
    await rename(join(selected, 'a-child'), join(selected, 'retired'));
    await symlink(outside, join(selected, 'a-child'));
    await expect(walk.next()).rejects.toThrow('The selected folder changed');
  });

  it.each(['store', 'deflate'] as const)('extracts valid %s bytes and preserves both digests', async (compression) => {
    const data = Buffer.from('photo bytes');
    const compressed = compression === 'store' ? data : deflateRawSync(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04_03_4b_50, 0);
    const bytes = Buffer.concat([local, compressed]),
      path = join(directory, 'archive');
    await writeFile(path, bytes);
    const destination = join(directory, 'entry');
    const digest = await sut.stageArchiveEntry(
      path,
      {
        size: bytes.length,
        read: (position, length) => tryPromise(() => bytes.subarray(position, position + length)),
      },
      {
        name: 'photo.jpg',
        compression,
        compressedSize: compressed.length,
        uncompressedSize: data.length,
        crc32: crc32(data),
        localHeaderOffset: 0,
        dataLimit: bytes.length,
        modifiedAt: new Date(0),
      },
      destination,
      signal(),
    );
    expect(digest).toEqual({
      size: data.length,
      checksum: hash(data),
      legacyChecksum: createHash('sha1').update(data).digest(),
    });
    expect(await readFile(destination)).toEqual(data);
    expect(await readFile(path)).toEqual(bytes);
  });

  it.each(['limit', 'abort', 'corrupt'])('closes the compressed source after %s failure', async (failure) => {
    const data = randomBytes(2 * 1024 * 1024);
    const compressed = failure === 'corrupt' ? Buffer.concat([Buffer.from([7]), data]) : deflateRawSync(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04_03_4b_50, 0);
    const bytes = Buffer.concat([local, compressed]),
      path = join(directory, 'archive');
    await writeFile(path, bytes);
    const controller = new AbortController();
    if (failure === 'abort') {
      const original = await vi.importActual<typeof import('node:fs')>('node:fs');
      vi.mocked(createReadStream).mockImplementationOnce((path, options) => {
        const raw = original.createReadStream(path, options);
        raw.once('data', () => controller.abort());
        return raw;
      });
    }
    const entry: TakeoutZipEntry = {
      name: 'photo.jpg',
      compression: 'deflate',
      compressedSize: compressed.length,
      uncompressedSize: failure === 'limit' ? 1 : data.length,
      crc32: crc32(data),
      localHeaderOffset: 0,
      dataLimit: bytes.length,
      modifiedAt: new Date(0),
    };
    const destination = join(directory, 'entry');
    await expect(
      sut.stageArchiveEntry(
        path,
        {
          size: bytes.length,
          read: (position, length) => tryPromise(() => bytes.subarray(position, position + length)),
        },
        entry,
        destination,
        controller.signal,
      ),
    ).rejects.toThrow();
    const raw = vi.mocked(createReadStream).mock.results.at(-1)!.value;
    await vi.waitFor(() => expect(raw.destroyed).toBe(true), { timeout: 200 });
    await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(destination + '.part')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
