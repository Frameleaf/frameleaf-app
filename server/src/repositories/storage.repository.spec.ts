import mockfs from 'mock-fs';
import { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
      '/photos/image.jpg': true,
      '/photos/image.Jpg': true,
      '/photos/image.jpG': true,
      '/photos/image.JPG': true,
      '/photos/image.jpEg': true,
      '/photos/image.TIFF': true,
      '/photos/image.tif': true,
      '/photos/image.dng': true,
      '/photos/image.NEF': true,
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

  beforeEach(() => {
    // eslint-disable-next-line no-sparse-arrays
    sut = new StorageRepository(automock(LoggingRepository, { args: [, { getEnv: () => ({}) }], strict: false }));
  });

  afterEach(() => {
    // eslint-disable-next-line import-x/no-named-as-default-member
    mockfs.restore();
  });

  describe('crawl', () => {
    for (const { test, options, files } of tests) {
      it(test, async () => {
        mockfs(Object.fromEntries(Object.keys(files).map((file) => [file, ''])));

        const actual = await sut.crawl(options);
        const expected = Object.entries(files)
          .filter((entry) => entry[1])
          .map(([file]) => file);

        expect(actual.toSorted()).toEqual(expected.toSorted());
      });
    }
  });

  it('adds up the bytes of every file under a folder without following symlinks (FL-79)', async () => {
    mockfs({
      '/data/thumbs/a/1.webp': 'x'.repeat(100),
      '/data/thumbs/a/b/2.jpeg': 'x'.repeat(50),
      '/data/thumbs/3.webp': 'x'.repeat(7),
      '/elsewhere/big.bin': 'x'.repeat(10_000),
      // eslint-disable-next-line import-x/no-named-as-default-member
      '/data/thumbs/link': mockfs.symlink({ path: '/elsewhere' }),
    });
    await expect(sut.getFolderBytes('/data/thumbs')).resolves.toBe(157);
    await expect(sut.getFolderBytes('/data/missing')).resolves.toBe(0);
  });

  it('reads a large folder in bounded batches with the same total', async () => {
    mockfs(Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`/data/encoded-video/${index}.mp4`, 'xx'])));
    await expect(sut.getFolderBytes('/data/encoded-video', 16)).resolves.toBe(80);
    await expect(sut.getFolderBytes('/data/encoded-video', 1)).resolves.toBe(80);
  });

  it('lists every file below one exact folder, hidden files and links included, without following links (FL-44)', async () => {
    mockfs({
      '/data/library/admin/2024/a.jpg': '',
      '/data/library/admin/.hidden.xmp': '',
      '/data/library/Admin/other-account.jpg': '',
      '/data/library/admin-2/other-account.jpg': '',
      '/elsewhere/outside.jpg': '',
      // eslint-disable-next-line import-x/no-named-as-default-member
      '/data/library/admin/link': mockfs.symlink({ path: '/elsewhere' }),
    });
    const found = await Array.fromAsync(sut.walkFiles('/data/library/admin'));
    expect(found.toSorted()).toEqual([
      '/data/library/admin/.hidden.xmp',
      '/data/library/admin/2024/a.jpg',
      '/data/library/admin/link',
    ]);

    await expect(Array.fromAsync(sut.walkFiles('/data/library/missing'))).resolves.toEqual([]);
  });

  it('reads the device of a path, or null when it cannot be read', async () => {
    mockfs({ '/data/thumbs/a.webp': 'x' });
    await expect(sut.getDevice('/data/thumbs')).resolves.toEqual(expect.any(Number));
    await expect(sut.getDevice('/data/missing')).resolves.toBeNull();
  });

  it('resumes bounded traversal across directories and roots without repeating files or following symlinks', async () => {
    mockfs({
      '/first/a/1.jpg': '',
      '/first/a/2.xmp': '',
      '/first/b/3.jpg': '',
      '/first/.hidden/secret.jpg': '',
      '/last/4.jpg': '',
      // eslint-disable-next-line import-x/no-named-as-default-member
      '/first/link': mockfs.symlink({ path: '/last' }),
    });
    let cursor: Array<{ path: string; after?: string }> = [{ path: '/last' }, { path: '/first' }];
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
    expect(found).toEqual(['/first/a/1.jpg', '/first/a/2.xmp', '/first/b/3.jpg', '/last/4.jpg']);
  });

  it('resumes immediately after the last yielded file when a consumer stops mid-directory', async () => {
    mockfs({ '/root/1.jpg': '', '/root/2.jpg': '', '/root/3.jpg': '' });
    const cursor = [{ path: '/root' }];
    for await (const file of sut.walkWithCursor(cursor, 10)) {
      expect(file).toBe('/root/1.jpg');
      break;
    }
    const remaining = await Array.fromAsync(sut.walkWithCursor(cursor, 10));
    expect(remaining).toEqual(['/root/2.jpg', '/root/3.jpg']);
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

describe('StorageRepository.createPacedZipStream (FL-54)', () => {
  const newSut = () =>
    // eslint-disable-next-line no-sparse-arrays
    new StorageRepository(automock(LoggingRepository, { args: [, { getEnv: () => ({}) }], strict: false }));

  it('resolves whenIdle only once the reader has taken the entries added so far', async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), 'paced-zip-'));
    const file = join(directory, 'large.bin');
    await fs.writeFile(file, Buffer.alloc(8 * 1024 * 1024, 1));
    const zip = newSut().createPacedZipStream();
    zip.addFile(file, 'large.bin');

    let idle = false;
    const whenIdle = zip.whenIdle().then(() => (idle = true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    // nobody reads the stream, so the entry cannot be written past the stream's buffer
    expect(idle).toBe(false);

    zip.stream.resume();
    await whenIdle;
    expect(idle).toBe(true);
    expect(zip.isClosed()).toBe(false);

    zip.addBuffer(Buffer.from('b'), 'b.txt');
    await zip.whenIdle();
    await zip.finalize();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('wakes a waiting producer and reports closed once the reader goes away', async () => {
    const zip = newSut().createPacedZipStream();
    zip.addBuffer(Buffer.alloc(256 * 1024, 1), 'a.bin');
    const whenIdle = zip.whenIdle();

    zip.stream.destroy();

    await whenIdle;
    expect(zip.isClosed()).toBe(true);
    await expect(zip.whenIdle()).resolves.toBeUndefined();
  });
});
