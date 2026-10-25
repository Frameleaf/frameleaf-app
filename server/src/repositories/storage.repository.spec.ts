import { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { CrawlOptionsDto } from 'src/dtos/library.dto.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { automock } from 'test/utils.js';

interface Test {
  test: string;
  options: CrawlOptionsDto;
  files: Record<string, boolean>;
}

const cwd = process.cwd();

const tests: Test[] = [
  {
    test: 'should return empty when crawling an empty path list',
    options: {
      pathsToCrawl: [],
    },
    files: {},
  },
  {
    test: 'should crawl a single path',
    options: {
      pathsToCrawl: ['/photos/'],
    },
    files: {
      '/photos/image.jpg': true,
    },
  },
  {
    test: 'should exclude by file extension',
    options: {
      pathsToCrawl: ['/photos/'],
      exclusionPatterns: ['**/*.tif'],
    },
    files: {
      '/photos/image.jpg': true,
      '/photos/image.tif': false,
    },
  },
  {
    test: 'should exclude by file extension without case sensitivity',
    options: {
      pathsToCrawl: ['/photos/'],
      exclusionPatterns: ['**/*.TIF'],
    },
    files: {
      '/photos/image.jpg': true,
      '/photos/image.tif': false,
    },
  },
  {
    test: 'should exclude by folder',
    options: {
      pathsToCrawl: ['/photos/'],
      exclusionPatterns: ['**/raw/**'],
    },
    files: {
      '/photos/image.jpg': true,
      '/photos/raw/image.jpg': false,
      '/photos/raw2/image.jpg': true,
      '/photos/folder/raw/image.jpg': false,
      '/photos/crawl/image.jpg': true,
    },
  },
  {
    test: 'should crawl multiple paths',
    options: {
      pathsToCrawl: ['/photos/', '/images/', '/albums/'],
    },
    files: {
      '/photos/image1.jpg': true,
      '/images/image2.jpg': true,
      '/albums/image3.jpg': true,
    },
  },
  {
    test: 'should crawl a single path without trailing slash',
    options: {
      pathsToCrawl: ['/photos'],
    },
    files: {
      '/photos/image.jpg': true,
    },
  },
  {
    test: 'should crawl a single path',
    options: {
      pathsToCrawl: ['/photos/'],
    },
    files: {
      '/photos/image.jpg': true,
      '/photos/subfolder/image1.jpg': true,
      '/photos/subfolder/image2.jpg': true,
      '/image1.jpg': false,
    },
  },
  {
    test: 'should filter file extensions',
    options: {
      pathsToCrawl: ['/photos/'],
    },
    files: {
      '/photos/image.jpg': true,
      '/photos/image.txt': false,
      '/photos/1': false,
    },
  },
  {
    test: 'should include photo and video extensions',
    options: {
      pathsToCrawl: ['/photos/', '/videos/'],
    },
    files: {
      '/photos/image.jpg': true,
      '/photos/image.jpeg': true,
      '/photos/image.heic': true,
      '/photos/image.heif': true,
      '/photos/image.png': true,
      '/photos/image.gif': true,
      '/photos/image.tif': true,
      '/photos/image.tiff': true,
      '/photos/image.webp': true,
      '/photos/image.dng': true,
      '/photos/image.nef': true,
      '/videos/video.mp4': true,
      '/videos/video.mov': true,
      '/videos/video.webm': true,
    },
  },
  {
    test: 'should check file extensions without case sensitivity',
    options: {
      pathsToCrawl: ['/photos/'],
    },
    files: {
      '/photos/image1.jpg': true,
      '/photos/image2.Jpg': true,
      '/photos/image3.jpG': true,
      '/photos/image4.JPG': true,
      '/photos/image5.jpEg': true,
      '/photos/image6.TIFF': true,
      '/photos/image7.tif': true,
      '/photos/image8.dng': true,
      '/photos/image9.NEF': true,
    },
  },
  {
    test: 'should normalize the path',
    options: {
      pathsToCrawl: ['/photos/1/../2'],
    },
    files: {
      '/photos/1/image.jpg': false,
      '/photos/2/image.jpg': true,
    },
  },
  {
    test: 'should return absolute paths',
    options: {
      pathsToCrawl: ['photos'],
    },
    files: {
      [`${cwd}/photos/1.jpg`]: true,
      [`${cwd}/photos/2.jpg`]: true,
      [`/photos/3.jpg`]: false,
    },
  },
  {
    test: 'should support special characters in paths',
    options: {
      pathsToCrawl: ['/photos (new)'],
    },
    files: {
      ['/photos (new)/1.jpg']: true,
    },
  },
];

describe(StorageRepository.name, () => {
  let sut: StorageRepository;
  let directory: string;
  const fixturePath = (path: string) =>
    path.startsWith(`${cwd}/`) ? join(directory, 'cwd', path.slice(cwd.length)) : join(directory, path);
  const writeFiles = async (files: Record<string, string>) => {
    for (const [file, content] of Object.entries(files)) {
      const path = fixturePath(file);
      await fs.mkdir(dirname(path), { recursive: true });
      await fs.writeFile(path, content);
    }
  };

  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), 'frameleaf-storage-'));
    // eslint-disable-next-line no-sparse-arrays
    sut = new StorageRepository(automock(LoggingRepository, { args: [, { getEnv: () => ({}) }], strict: false }));
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  describe('createZipStream', () => {
    it('joins the actual entry rather than an eagerly buffered input, even with repeated names', async () => {
      const zip = sut.createZipStream();
      zip.addFile(Buffer.alloc(2 * 1024 * 1024, 1), 'same');
      const input = Readable.from([Buffer.from('verified source')]);
      let processed = false;
      const appended = zip.addFile(input, 'same').then(() => {
        processed = true;
      });
      await finished(input);
      expect(processed).toBe(false);
      const consuming = Array.fromAsync(zip.stream);
      await appended;
      await zip.finalize();
      expect(Buffer.concat(await consuming).includes(Buffer.from('verified source'))).toBe(true);
    });
    it('stores a file from disk and bytes made for the archive, such as a details file (FL-423)', async () => {
      await writeFiles({ '/zip/IMG_1.JPG': 'original pixels' });
      const zip = sut.createZipStream();
      const chunks: Buffer[] = [];
      zip.stream.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      const ended = new Promise((resolve, reject) => zip.stream.on('end', resolve).on('error', reject));

      zip.addFile(fixturePath('/zip/IMG_1.JPG'), 'IMG_1.JPG');
      zip.addFile(Buffer.from('<x:xmpmeta>details</x:xmpmeta>', 'utf8'), 'IMG_1.JPG.xmp');
      await zip.finalize();
      await ended;

      // stored, not compressed: each name and its bytes appear as they are
      const archive = Buffer.concat(chunks).toString('latin1');
      expect(archive).toContain('IMG_1.JPG.xmp');
      expect(archive).toContain('original pixels');
      expect(archive).toContain('<x:xmpmeta>details</x:xmpmeta>');
    });
  });

  describe('removeEmptyDirs', () => {
    it('removes empty descendants while retaining files, nonempty directories and the root', async () => {
      await writeFiles({ '/cleanup/full/keep.jpg': 'original', '/cleanup/.hidden/keep.txt': 'hidden' });
      await fs.mkdir(fixturePath('/cleanup/empty/nested'), { recursive: true });
      await sut.removeEmptyDirs(fixturePath('/cleanup'));
      expect((await fs.stat(fixturePath('/cleanup'))).isDirectory()).toBe(true);
      await expect(fs.stat(fixturePath('/cleanup/empty'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.readFile(fixturePath('/cleanup/full/keep.jpg'), 'utf8')).resolves.toBe('original');
      await expect(fs.readFile(fixturePath('/cleanup/.hidden/keep.txt'), 'utf8')).resolves.toBe('hidden');
    });

    it('removes an empty root only when requested', async () => {
      await fs.mkdir(fixturePath('/cleanup/empty'), { recursive: true });
      await sut.removeEmptyDirs(fixturePath('/cleanup'), true);
      await expect(fs.stat(fixturePath('/cleanup'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('never traverses symlinks or removes regular files', async () => {
      await writeFiles({ '/outside/keep.jpg': 'outside', '/cleanup/keep.jpg': 'inside' });
      await fs.mkdir(fixturePath('/outside/empty'));
      await fs.symlink(fixturePath('/outside'), fixturePath('/cleanup/link'), 'dir');
      await sut.removeEmptyDirs(fixturePath('/cleanup'), true);
      await sut.removeEmptyDirs(fixturePath('/cleanup/link'), true);
      await sut.removeEmptyDirs(fixturePath('/cleanup/keep.jpg'), true);
      expect((await fs.lstat(fixturePath('/cleanup/link'))).isSymbolicLink()).toBe(true);
      expect((await fs.stat(fixturePath('/outside/empty'))).isDirectory()).toBe(true);
      await expect(fs.readFile(fixturePath('/outside/keep.jpg'), 'utf8')).resolves.toBe('outside');
      await expect(fs.readFile(fixturePath('/cleanup/keep.jpg'), 'utf8')).resolves.toBe('inside');
    });

    it('propagates missing roots and directory read failures', async () => {
      await expect(sut.removeEmptyDirs(fixturePath('/missing'))).rejects.toMatchObject({ code: 'ENOENT' });
      await fs.mkdir(fixturePath('/cleanup'));
      const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
      const readdir = vi.spyOn(fs, 'readdir').mockRejectedValueOnce(denied);
      try {
        await expect(sut.removeEmptyDirs(fixturePath('/cleanup'))).rejects.toBe(denied);
      } finally {
        readdir.mockRestore();
      }
    });

    it('rechecks a directory replaced by a symlink before descending', async () => {
      await fs.mkdir(fixturePath('/cleanup/child'), { recursive: true });
      await fs.mkdir(fixturePath('/outside/empty'), { recursive: true });
      const child = fixturePath('/cleanup/child');
      const original = fs.lstat;
      let replaced = false;
      const lstat = vi.spyOn(fs, 'lstat').mockImplementation(async (path) => {
        if (String(path) === child && !replaced) {
          replaced = true;
          await fs.rmdir(child);
          await fs.symlink(fixturePath('/outside'), child, 'dir');
        }
        return original(path);
      });
      try {
        await sut.removeEmptyDirs(fixturePath('/cleanup'), true);
        expect((await original(child)).isSymbolicLink()).toBe(true);
        expect((await fs.stat(fixturePath('/outside/empty'))).isDirectory()).toBe(true);
      } finally {
        lstat.mockRestore();
      }
    });

    it.each(['symlink', 'directory'] as const)(
      'does not traverse a %s replacement reached during listing',
      async (kind) => {
        const root = fixturePath('/cleanup');
        await fs.mkdir(join(root, 'empty'), { recursive: true });
        await fs.mkdir(fixturePath('/outside/empty'), { recursive: true });
        const original = fs.readdir;
        const readdir = vi.spyOn(fs, 'readdir').mockImplementationOnce(async (...args) => {
          await fs.rename(root, fixturePath('/moved'));
          if (kind === 'symlink') {
            await fs.symlink(fixturePath('/outside'), root, 'dir');
          } else {
            await fs.mkdir(join(root, 'empty'), { recursive: true });
          }
          return original(...args);
        });
        try {
          await sut.removeEmptyDirs(root, true);
          expect((await fs.stat(fixturePath('/outside/empty'))).isDirectory()).toBe(true);
          expect((await fs.stat(fixturePath('/moved/empty'))).isDirectory()).toBe(true);
          expect((await fs.lstat(root)).isSymbolicLink()).toBe(kind === 'symlink');
          if (kind === 'directory') {
            expect((await fs.stat(join(root, 'empty'))).isDirectory()).toBe(true);
          }
        } finally {
          readdir.mockRestore();
        }
      },
    );

    it('leaves a directory when an entry arrives before rmdir', async () => {
      await fs.mkdir(fixturePath('/cleanup'));
      const rmdir = vi.spyOn(fs, 'rmdir').mockImplementationOnce(async (path) => {
        await fs.writeFile(join(String(path), 'new.jpg'), 'new');
        throw Object.assign(new Error('not empty'), { code: 'ENOTEMPTY' });
      });
      try {
        await expect(sut.removeEmptyDirs(fixturePath('/cleanup'), true)).resolves.toBeUndefined();
        await expect(fs.readFile(fixturePath('/cleanup/new.jpg'), 'utf8')).resolves.toBe('new');
      } finally {
        rmdir.mockRestore();
      }
    });
  });

  describe('crawl', () => {
    for (const { test, options, files } of tests) {
      it(test, async () => {
        await writeFiles(Object.fromEntries(Object.keys(files).map((file) => [file, ''])));

        const actual = await sut.crawl({
          ...options,
          pathsToCrawl: options.pathsToCrawl.map((path) =>
            isAbsolute(path) ? `${directory}${path}` : relative(cwd, join(directory, 'cwd', path)),
          ),
        });
        const expected = Object.entries(files)
          .filter((entry) => entry[1])
          .map(([file]) => fixturePath(file));

        expect(actual.toSorted()).toEqual(expected.toSorted());
      });
    }
  });

  it('adds up the bytes of every file under a folder without following symlinks (FL-79)', async () => {
    await writeFiles({
      '/data/thumbs/a/1.webp': 'x'.repeat(100),
      '/data/thumbs/a/b/2.jpeg': 'x'.repeat(50),
      '/data/thumbs/3.webp': 'x'.repeat(7),
      '/elsewhere/big.bin': 'x'.repeat(10_000),
    });
    await fs.symlink(fixturePath('/elsewhere'), fixturePath('/data/thumbs/link'), 'junction');
    await expect(sut.getFolderBytes(fixturePath('/data/thumbs'))).resolves.toBe(157);
    await expect(sut.getFolderBytes(fixturePath('/data/missing'))).resolves.toBe(0);
  });

  it('reads a large folder in bounded batches with the same total', async () => {
    await writeFiles(
      Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`/data/encoded-video/${index}.mp4`, 'xx'])),
    );
    await expect(sut.getFolderBytes(fixturePath('/data/encoded-video'), 16)).resolves.toBe(80);
    await expect(sut.getFolderBytes(fixturePath('/data/encoded-video'), 1)).resolves.toBe(80);
  });

  it('lists every file below one exact folder, hidden files and links included, without following links (FL-44)', async () => {
    await writeFiles({
      '/data/library/admin/2024/a.jpg': '',
      '/data/library/admin/.hidden.xmp': '',
      '/data/library/Admin-other/other-account.jpg': '',
      '/data/library/admin-2/other-account.jpg': '',
      '/elsewhere/outside.jpg': '',
    });
    await fs.symlink(fixturePath('/elsewhere'), fixturePath('/data/library/admin/link'), 'junction');
    const found = await Array.fromAsync(sut.walkFiles(fixturePath('/data/library/admin')));
    expect(found.toSorted()).toEqual(
      ['/data/library/admin/.hidden.xmp', '/data/library/admin/2024/a.jpg', '/data/library/admin/link'].map((file) =>
        fixturePath(file),
      ),
    );

    await expect(Array.fromAsync(sut.walkFiles(fixturePath('/data/library/missing')))).resolves.toEqual([]);
  });

  it('reads the device of a path, or null when it cannot be read', async () => {
    await writeFiles({ '/data/thumbs/a.webp': 'x' });
    await expect(sut.getDevice(fixturePath('/data/thumbs'))).resolves.toEqual(expect.any(Number));
    await expect(sut.getDevice(fixturePath('/data/missing'))).resolves.toBeNull();
  });

  it('resumes bounded traversal across directories and roots without repeating files or following symlinks', async () => {
    await writeFiles({
      '/first/a/1.jpg': '',
      '/first/a/2.xmp': '',
      '/first/b/3.jpg': '',
      '/first/.hidden/secret.jpg': '',
      '/last/4.jpg': '',
    });
    await fs.symlink(fixturePath('/last'), fixturePath('/first/link'), 'junction');
    let cursor: Array<{ path: string; after?: string }> = [
      { path: fixturePath('/last') },
      { path: fixturePath('/first') },
    ];
    const found: string[] = [];
    let batches = 0;
    while (cursor.length > 0 && batches++ < 20) {
      for await (const file of sut.walkWithCursor(cursor, 2)) {
        found.push(file);
      }
      cursor = JSON.parse(JSON.stringify(cursor));
    }
    expect(cursor).toEqual([]);
    expect(batches).toBeGreaterThan(1);
    expect(found).toEqual(
      ['/first/a/1.jpg', '/first/a/2.xmp', '/first/b/3.jpg', '/last/4.jpg'].map((file) => fixturePath(file)),
    );
  });

  it('resumes immediately after the last yielded file when a consumer stops mid-directory', async () => {
    await writeFiles({ '/root/1.jpg': '', '/root/2.jpg': '', '/root/3.jpg': '' });
    const cursor = [{ path: fixturePath('/root') }];
    for await (const file of sut.walkWithCursor(cursor, 10)) {
      expect(file).toBe(fixturePath('/root/1.jpg'));
      break;
    }
    const remaining = await Array.fromAsync(sut.walkWithCursor(cursor, 10));
    expect(remaining).toEqual(['/root/2.jpg', '/root/3.jpg'].map((file) => fixturePath(file)));
    expect(cursor).toEqual([]);
  });

  it('walks 500,000 files in bounded batches without rereading ancestors for every child directory', async () => {
    let rootReads = 0;
    const read = vi.spyOn(fs, 'readdir').mockImplementation(async (folder) => {
      await Promise.resolve();
      const root = folder === '/managed';
      if (root) {
        rootReads++;
      }
      return Array.from({ length: root ? 500 : 1000 }, (_, index) => ({
        name: `${index.toString().padStart(4, '0')}${root ? '' : '.jpg'}`,
        isDirectory: () => root,
        isFile: () => !root,
        isSymbolicLink: () => false,
      })) as Dirent[] as never;
    });
    let cursor: Array<{ path: string; after?: string }> = [{ path: '/managed' }];
    let count = 0;
    let previous = '';
    let ordered = true;
    let batches = 0;
    let maxCursorBytes = 0;
    try {
      while (cursor.length > 0 && batches++ < 100) {
        let batchCount = 0;
        for await (const file of sut.walkWithCursor(cursor, 10_000)) {
          ordered &&= file > previous;
          previous = file;
          count++;
          batchCount++;
        }
        expect(batchCount).toBeLessThanOrEqual(10_000);
        const serialized = JSON.stringify(cursor);
        maxCursorBytes = Math.max(maxCursorBytes, serialized.length);
        cursor = JSON.parse(serialized);
      }
      expect(count).toBe(500_000);
      expect(ordered).toBe(true);
      expect(previous).toBe('/managed/0499/0999.jpg');
      expect(cursor).toEqual([]);
      expect(rootReads).toBeLessThanOrEqual(batches);
      expect(maxCursorBytes).toBeLessThan(1024);
    } finally {
      read.mockRestore();
    }
  });
});
