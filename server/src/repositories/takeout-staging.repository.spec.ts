import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import type { TakeoutSource } from 'src/repositories/takeout.repository.js';
import type { TakeoutZipEntry } from 'src/utils/takeout-zip.js';
import { StorageCore } from 'src/cores/storage.core.js';
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

  it('reads a .tgz in a server folder in place, with long names, links refused and unread entries skipped', async () => {
    const selected = join(directory, 'selected'),
      tree = join(directory, 'tree');
    const album = `Takeout/Google Photos/${'A very long album name '.repeat(6).trim()}`;
    const photo = randomBytes(300 * 1024);
    await mkdir(join(tree, album), { recursive: true });
    await mkdir(selected);
    await writeFile(join(tree, album, 'skipped.jpg'), randomBytes(5000));
    await writeFile(join(tree, album, 'IMG_1.jpg'), photo);
    await symlink('/etc/passwd', join(tree, album, 'link.jpg'));
    const archivePath = join(selected, 'takeout-001.tgz');
    // macOS tar would add AppleDouble `._` entries for extended attributes.
    execFileSync('tar', ['-czf', archivePath, '-C', tree, 'Takeout'], {
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    });

    const [file] = await Array.fromAsync(sut.walk(selected, signal()));
    const seen: Array<{ name: string; refused?: string }> = [];
    for await (const entry of sut.readFolderTar(selected, file)) {
      seen.push({ name: entry.name.replace(/\/$/u, ''), refused: entry.refused });
      if (entry.name === `${album}/IMG_1.jpg`) {
        const destination = join(directory, 'staged');
        const digest = await sut.stageTarEntry(entry, destination, signal());
        expect(digest).toMatchObject({ size: photo.length, checksum: hash(photo) });
        expect(await readFile(destination)).toEqual(photo);
      }
    }
    expect(seen).toEqual(
      expect.arrayContaining([
        { name: `${album}/IMG_1.jpg`, refused: undefined },
        { name: `${album}/skipped.jpg`, refused: undefined },
        { name: `${album}/link.jpg`, refused: 'link' },
      ]),
    );
  });

  it('refuses a damaged .tgz as a damaged archive', async () => {
    const selected = join(directory, 'selected');
    await mkdir(selected);
    await writeFile(join(selected, 'broken.tgz'), randomBytes(4096));
    const [file] = await Array.fromAsync(sut.walk(selected, signal()));
    await expect(Array.fromAsync(sut.readFolderTar(selected, file))).rejects.toThrow('damaged');
  });

  it('allows the built-in Imports folder inside the media location, but nothing else of the library', async () => {
    vi.spyOn(StorageCore, 'getMediaLocation').mockReturnValue(join(directory, 'media'));
    await mkdir(join(directory, 'media', 'imports', 'Google export'), { recursive: true });
    await mkdir(join(directory, 'media', 'upload'), { recursive: true });

    await expect(sut.resolveDirectory(join(directory, 'media', 'imports'), 'Google export')).resolves.toBe(
      join(directory, 'media', 'imports', 'Google export'),
    );
    await expect(sut.resolveDirectory(join(directory, 'media', 'imports'), '')).resolves.toBe(
      join(directory, 'media', 'imports'),
    );
    await expect(sut.resolveDirectory(directory, 'media/upload')).rejects.toThrow('outside the library’s own storage');
    await expect(sut.resolveDirectory(directory, 'media')).rejects.toThrow('outside the library’s own storage');
  });

  it('lists what a permitted location and each folder in it hold, without leaving it', async () => {
    vi.spyOn(StorageCore, 'getMediaLocation').mockReturnValue(join(directory, 'library'));
    await mkdir(join(directory, 'library'));
    await mkdir(join(directory, 'Exports'));
    await writeFile(join(directory, 'Exports', 'takeout-001.zip'), 'zip');
    await writeFile(join(directory, 'Exports', 'takeout-002.tgz'), 'tgz!');
    await mkdir(join(directory, 'Unpacked', 'Takeout'), { recursive: true });
    await mkdir(join(directory, 'Google Photos'));
    await mkdir(join(directory, '.hidden'));
    await writeFile(join(directory, 'takeout-003.tar.gz'), 'tar.gz');
    await writeFile(join(directory, 'notes.txt'), 'text');
    await symlink(tmpdir(), join(directory, 'linked'));

    const empty = { zip: 0, tgz: 0, bytes: 0, unpacked: false };
    await expect(sut.listFolder(directory, '')).resolves.toEqual({
      here: { zip: 0, tgz: 1, bytes: 6, unpacked: true },
      folders: [
        { name: 'Exports', zip: 1, tgz: 1, bytes: 7, unpacked: false },
        { name: 'Google Photos', ...empty, unpacked: true },
        { name: 'library', ...empty },
        { name: 'Unpacked', ...empty, unpacked: true },
      ],
    });
    await expect(sut.listFolder(directory, '..')).rejects.toThrow('inside the permitted import location');
    await expect(sut.listFolder(directory, 'linked')).rejects.toThrow();
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
    const archive = await sut.openArchive(path);
    const digest = await sut.stageArchiveEntry(
      archive,
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
    await archive.close();
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
    const archive = await sut.openArchive(path);
    const streams: ReturnType<typeof archive.handle.createReadStream>[] = [];
    const openStream = archive.handle.createReadStream.bind(archive.handle);
    vi.spyOn(archive.handle, 'createReadStream').mockImplementation((options) => {
      const raw = openStream(options);
      if (failure === 'abort') {
        raw.once('data', () => controller.abort());
      }
      streams.push(raw);
      return raw;
    });
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
    await expect(sut.stageArchiveEntry(archive, entry, destination, controller.signal)).rejects.toThrow();
    const raw = streams.at(-1)!;
    await vi.waitFor(() => expect(raw.destroyed).toBe(true), { timeout: 200 });
    await archive.close();
    await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(destination + '.part')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
