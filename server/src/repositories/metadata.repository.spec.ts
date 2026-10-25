import { ExifTool, Tags } from 'exiftool-vendored';
import { copyFile, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { StorageCore } from 'src/cores/storage.core.js';
import { trackQueueChild } from 'src/queue/child-process.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MetadataRepository } from 'src/repositories/metadata.repository.js';
import { automock } from 'test/utils.js';

vi.mock('src/queue/child-process.js', () => ({ trackQueueChild: vi.fn() }));

describe('metadata reads', () => {
  let sut: MetadataRepository;
  beforeEach(() => {
    vi.mocked(trackQueueChild).mockClear();
    sut = new MetadataRepository(
      automock(LoggingRepository, { args: [undefined, { getEnv: () => ({}) }], strict: false }),
    );
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await sut.teardown();
  });

  it('propagates a rejected read', async () => {
    const failure = new Error('unreadable');
    vi.spyOn(ExifTool.prototype, 'read').mockRejectedValue(failure);
    await expect(sut.readTags('original.jpg')).rejects.toBe(failure);
  });
  it.each([{ errors: ['corrupt metadata'] }, { Error: 'truncated file' }])(
    'rejects resolved ExifTool errors: %j',
    async (result) => {
      vi.spyOn(ExifTool.prototype, 'read').mockResolvedValue(result as Tags);
      await expect(sut.readTags('original.jpg')).rejects.toThrow(/corrupt metadata|truncated file/);
    },
  );
  it('permits a successful metadata-free image', async () => {
    vi.spyOn(ExifTool.prototype, 'read').mockResolvedValue({ FileType: 'JPEG', errors: [] } as Tags);
    await expect(sut.readTags('original.jpg')).resolves.toMatchObject({ FileType: 'JPEG' });
  });
  it.each(['Camera A or Camera B, editor', 'digest', 'Unknown (digest)'])(
    'retains raw digest and explanatory lookup %s',
    async (lookup) => {
      const read = vi
        .spyOn(ExifTool.prototype, 'readRaw')
        .mockResolvedValueOnce({ JPEGDigest: 'digest' } as unknown as Tags)
        .mockResolvedValueOnce({ JPEGDigest: lookup } as unknown as Tags);
      await expect(sut.readJpegSignature('original.jpg')).resolves.toEqual({
        method: 'jpeg-signature',
        signature: 'digest',
        matches: lookup === 'Camera A or Camera B, editor' ? lookup : null,
      });
      expect(read).toHaveBeenNthCalledWith(1, 'original.jpg', { readArgs: ['-JPEGDigest', '-n'] });
      expect(read).toHaveBeenNthCalledWith(2, 'original.jpg', { readArgs: ['-JPEGDigest'] });
    },
  );
  it('rejects optional read errors and returns null for a missing digest', async () => {
    const read = vi
      .spyOn(ExifTool.prototype, 'readRaw')
      .mockResolvedValueOnce({ errors: ['digest failed'] } as Tags)
      .mockResolvedValueOnce({} as Tags);
    await expect(sut.readJpegSignature('original.jpg')).rejects.toThrow('digest failed');
    read.mockResolvedValue({} as Tags);
    await expect(sut.readJpegSignature('original.jpg')).resolves.toBeNull();
  });

  it('joins the owned metadata process before returning a borrowed-input lease', async () => {
    const raw = vi.spyOn(ExifTool.prototype, 'readRaw').mockResolvedValue({} as Tags);
    const ended = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const end = ExifTool.prototype.end;
    vi.spyOn(ExifTool.prototype, 'end').mockImplementationOnce(async () => {
      entered.resolve();
      await ended.promise;
      await end.call(raw.mock.contexts[0]);
    });
    const pending = sut.acquireBorrowedLocationFreeOriginal('/private/input.artifact', '.jpg');
    await entered.promise;
    let returned = false;
    void pending.then(() => {
      returned = true;
    });
    await Promise.resolve();
    expect(returned).toBe(false);
    ended.resolve();
    const lease = await pending;
    expect(lease.path).toBe('/private/input.artifact');
    await lease.release();
  });

  it('joins an owned read context and uses the original filename for video read options', async () => {
    const read = vi.spyOn(ExifTool.prototype, 'read').mockResolvedValue({ FileType: 'MP4' } as Tags);
    const entered = Promise.withResolvers<void>();
    const stopped = Promise.withResolvers<void>();
    const end = ExifTool.prototype.end;
    vi.spyOn(ExifTool.prototype, 'end').mockImplementationOnce(async () => {
      entered.resolve();
      await stopped.promise;
      await end.call(read.mock.contexts[0]);
    });
    let returned = false;
    const pending = sut
      .withBorrowedRead('/private/input.artifact', 'clip.mp4', async (reader) => {
        await reader.readTags('/private/input.artifact');
        await reader.readTags('/managed/sidecar.xmp');
      })
      .then((value) => {
        returned = true;
        return value;
      });
    await entered.promise;
    expect(returned).toBe(false);
    expect(read).toHaveBeenNthCalledWith(1, '/private/input.artifact', { readArgs: ['-ee'] });
    expect(read).toHaveBeenNthCalledWith(2, '/managed/sidecar.xmp', undefined);
    stopped.resolve();
    await pending;
  });

  it('refuses later borrowed tools when an owned read shutdown is unconfirmed', async () => {
    const read = vi.spyOn(ExifTool.prototype, 'read').mockResolvedValue({} as Tags);
    const end = ExifTool.prototype.end;
    vi.spyOn(ExifTool.prototype, 'end').mockImplementationOnce(async () => {
      await end.call(read.mock.contexts[0]);
      throw new Error('shutdown acknowledgement lost');
    });
    await expect(
      sut.withBorrowedRead('/private/input.artifact', 'photo.jpg', async (reader) => {
        await reader.readTags('/private/input.artifact');
      }),
    ).rejects.toThrow('source_original_shutdown_unconfirmed');
    await expect(sut.acquireBorrowedLocationFreeOriginal('/private/next.artifact', '.jpg')).rejects.toThrow(
      'source_original_shutdown_unconfirmed',
    );
  });

  it('cancels the owned reader but joins pending parallel work before rejecting', async () => {
    const abort = new AbortController();
    const entered = Promise.withResolvers<void>();
    const work = Promise.withResolvers<void>();
    const end = vi.spyOn(ExifTool.prototype, 'end');
    let settled = false;
    const pending = sut.withBorrowedRead(
      '/private/input.artifact',
      'video.mp4',
      async () => {
        entered.resolve();
        await work.promise;
      },
      abort.signal,
    );
    const rejected = expect(pending).rejects.toThrow('cancelled');
    void pending.catch(() => {
      settled = true;
    });
    try {
      await entered.promise;
      abort.abort(new Error('cancelled'));
      expect(end).toHaveBeenCalledWith(false);
      expect(settled).toBe(false);
    } finally {
      work.resolve();
      await rejected;
    }
  });

  it('copies only panorama tags into an independent output and refuses writing its borrowed input', async () => {
    const write = vi.spyOn(ExifTool.prototype, 'write').mockResolvedValue({ created: 0, updated: 1, unchanged: 0 });
    await sut.withBorrowedRead('/private/input.artifact', 'photo.jpg', async (reader) => {
      await expect(reader.copyPanoramaTags('/private/input.artifact')).rejects.toThrow('source_read_only');
      expect(write).not.toHaveBeenCalled();
      await expect(reader.copyPanoramaTags('/owned/preview.jpg')).resolves.toBe(true);
    });
    expect(write).toHaveBeenCalledWith(
      '/owned/preview.jpg',
      {},
      expect.objectContaining({
        writeArgs: ['-TagsFromFile', '/private/input.artifact', '-XMP-GPano:all>XMP-GPano:all', '-overwrite_original'],
      }),
    );
  });

  it('keeps a real sanitized copy independent from a borrowed .artifact input', async () => {
    const root = await mkdtemp(join(tmpdir(), 'borrowed-location-'));
    const reader = new ExifTool({ maxProcs: 1 });
    vi.spyOn(StorageCore, 'getMediaLocation').mockReturnValue(root);
    const original = join(root, 'original.jpg');
    const input = join(root, 'input.artifact');
    let lease: Awaited<ReturnType<MetadataRepository['acquireBorrowedLocationFreeOriginal']>> | undefined;
    try {
      await sharp({ create: { width: 8, height: 8, channels: 3, background: '#3366aa' } })
        .jpeg()
        .toFile(original);
      await reader.write(
        original,
        { GPSLatitude: 39.115, GPSLatitudeRef: 'N', GPSLongitude: -108.4009, GPSLongitudeRef: 'W' },
        { writeArgs: ['-overwrite_original'] },
      );
      await copyFile(original, input);
      const before = await readFile(input);
      await sut.withBorrowedRead(input, 'original.jpg', async (reader) => {
        expect((await reader.readTags(input)).FileType).toBe('JPEG');
      });
      lease = await sut.acquireBorrowedLocationFreeOriginal(input, '.jpg');
      expect(lease.path).not.toBe(input);
      expect(lease.path.endsWith('.jpg')).toBe(true);
      expect((await reader.read(lease.path)).GPSLatitude).toBeUndefined();
      expect(trackQueueChild).toHaveBeenCalledTimes(2);
      for (const [child] of vi.mocked(trackQueueChild).mock.calls) {
        expect(child.pid).toBeGreaterThan(0);
        expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      }
      expect(await readFile(input)).toEqual(before);
      await lease.release();
      await expect(readFile(lease.path)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await lease?.release();
      await reader.end();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retains borrowed output when owned metadata shutdown cannot be confirmed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'borrowed-location-'));
    vi.spyOn(StorageCore, 'getMediaLocation').mockReturnValue(root);
    const raw = vi
      .spyOn(ExifTool.prototype, 'readRaw')
      .mockResolvedValueOnce({ 'GPS:GPSLatitude': 1 } as Tags)
      .mockResolvedValue({} as Tags);
    vi.spyOn(sut, 'writeLocationFreeCopy').mockImplementation(async (_source, destination) => {
      await writeFile(destination, 'private copy');
    });
    const end = ExifTool.prototype.end;
    vi.spyOn(ExifTool.prototype, 'end').mockImplementationOnce(async () => {
      await end.call(raw.mock.contexts[0]);
      throw new Error('exit unconfirmed');
    });
    try {
      await expect(sut.acquireBorrowedLocationFreeOriginal('/private/input.artifact', '.jpg')).rejects.toThrow(
        'source_original_shutdown_unconfirmed',
      );
      const folder = join(root, 'tmp', 'location-free');
      const children = await readdir(folder);
      expect(children).toHaveLength(1);
      expect(await readdir(join(folder, children[0]))).toEqual(['original.artifact']);
      const old = new Date(0);
      await utimes(join(folder, children[0]), old, old);
      await sut.sweepLocationFree(folder);
      expect(await readdir(folder)).toEqual(children);
      const reads = raw.mock.calls.length;
      await expect(sut.acquireBorrowedLocationFreeOriginal('/private/second.artifact', '.jpg')).rejects.toThrow(
        'source_original_shutdown_unconfirmed',
      );
      expect(raw).toHaveBeenCalledTimes(reads);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['../jpg', '.exe', '.jpg/../../input'])('rejects an unsafe borrowed format %s', async (extension) => {
    const read = vi.spyOn(ExifTool.prototype, 'readRaw');
    await expect(sut.acquireBorrowedLocationFreeOriginal('/private/input.artifact', extension)).rejects.toThrow(
      'source_format_unavailable',
    );
    expect(read).not.toHaveBeenCalled();
  });

  it('serializes owned readers and skips a cancelled queued reader', async () => {
    const entered = Promise.withResolvers<void>();
    const reading = Promise.withResolvers<Tags>();
    const read = vi.spyOn(ExifTool.prototype, 'readRaw').mockImplementationOnce(() => {
      entered.resolve();
      return reading.promise;
    });
    const first = sut.acquireBorrowedLocationFreeOriginal('/private/first.artifact', '.jpg');
    await entered.promise;
    const controller = new AbortController();
    const second = sut.acquireBorrowedLocationFreeOriginal('/private/second.artifact', '.jpg', controller.signal);
    const rejected = expect(second).rejects.toThrow('cancelled');
    controller.abort(new Error('cancelled'));
    expect(read).toHaveBeenCalledTimes(1);
    reading.resolve({} as Tags);
    await (await first).release();
    await rejected;
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('joins an active cancelled reader before rejecting', async () => {
    const entered = Promise.withResolvers<void>();
    const reading = Promise.withResolvers<Tags>();
    const stopped = Promise.withResolvers<void>();
    const raw = vi.spyOn(ExifTool.prototype, 'readRaw').mockImplementationOnce(() => {
      entered.resolve();
      return reading.promise;
    });
    const end = ExifTool.prototype.end;
    let ending: Promise<void> | undefined;
    const shutdown = vi.spyOn(ExifTool.prototype, 'end').mockImplementation(() => {
      ending ??= stopped.promise.then(() => end.call(raw.mock.contexts[0]));
      return ending;
    });
    const controller = new AbortController();
    let settled = false;
    const pending = sut.acquireBorrowedLocationFreeOriginal('/private/input.artifact', '.jpg', controller.signal);
    const rejected = expect(pending).rejects.toThrow('cancelled');
    void pending.catch(() => {
      settled = true;
    });
    await entered.promise;
    controller.abort(new Error('cancelled'));
    expect(shutdown).toHaveBeenCalledWith(false);
    reading.resolve({} as Tags);
    await Promise.resolve();
    expect(settled).toBe(false);
    stopped.resolve();
    await rejected;
  });

  it.each(['copy failed', 'source_location_removal_failed'])(
    'removes a failed private copy only after confirmed shutdown: %s',
    async (failure) => {
      const root = await mkdtemp(join(tmpdir(), 'borrowed-location-'));
      vi.spyOn(StorageCore, 'getMediaLocation').mockReturnValue(root);
      vi.spyOn(ExifTool.prototype, 'readRaw').mockResolvedValue({ 'GPS:GPSLatitude': 1 } as Tags);
      vi.spyOn(sut, 'writeLocationFreeCopy').mockImplementation(async (_source, destination) => {
        await writeFile(destination, 'partial');
        if (failure === 'copy failed') throw new Error(failure);
      });
      const end = ExifTool.prototype.end;
      const entered = Promise.withResolvers<void>();
      const stopped = Promise.withResolvers<void>();
      vi.spyOn(ExifTool.prototype, 'end').mockImplementationOnce(async function (this: ExifTool) {
        entered.resolve();
        await stopped.promise;
        await end.call(this);
      });
      try {
        const pending = sut.acquireBorrowedLocationFreeOriginal('/private/input.artifact', '.jpg');
        const rejected = expect(pending).rejects.toThrow(failure);
        await entered.promise;
        expect(await readdir(join(root, 'tmp', 'location-free'))).toHaveLength(1);
        stopped.resolve();
        await rejected;
        expect(await readdir(join(root, 'tmp', 'location-free'))).toEqual([]);
      } finally {
        stopped.resolve();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
