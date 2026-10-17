import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { Batcher, CrawlOptions, crawl } from 'src/utils.js';
import { Mock } from 'vitest';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, platform: vi.fn(actual.platform) };
});

interface Test {
  test: string;
  options: Omit<CrawlOptions, 'extensions'>;
  files: Record<string, boolean>;
  skipOnWin32?: boolean;
}

const cwd = process.cwd();

const readContent = (path: string) => {
  return readFileSync(path).toString();
};

const extensions = [
  '.jpg',
  '.jpeg',
  '.png',
  '.heif',
  '.heic',
  '.tif',
  '.nef',
  '.webp',
  '.tiff',
  '.dng',
  '.gif',
  '.mov',
  '.mp4',
  '.webm',
];

const tests: Test[] = [
  {
    test: 'should return empty when crawling an empty path list',
    options: {
      pathsToCrawl: [],
    },
    files: {},
  },
  {
    test: 'should crawl a single folder',
    options: {
      pathsToCrawl: ['/photos/'],
    },
    files: {
      '/photos/image.jpg': true,
    },
  },
  {
    test: 'should crawl folders with quotes',
    options: {
      pathsToCrawl: ["/photo's/", '/photo"s/', '/photo`s/'],
    },
    files: {
      "/photo's/image1.jpg": true,
      '/photo"s/image2.jpg': true,
      '/photo`s/image3.jpg': true,
    },
    skipOnWin32: true, // double quotes are invalid in Windows filenames
  },
  {
    test: 'should crawl a single file',
    options: {
      pathsToCrawl: ['/photos/image.jpg'],
    },
    files: {
      '/photos/image.jpg': true,
    },
  },
  {
    test: 'should crawl a single file and a folder',
    options: {
      pathsToCrawl: ['/photos/image.jpg', '/images/'],
    },
    files: {
      '/photos/image.jpg': true,
      '/images/image2.jpg': true,
    },
  },
  {
    test: 'should exclude by file extension',
    options: {
      pathsToCrawl: ['/photos/'],
      exclusionPattern: '**/*.tif',
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
      exclusionPattern: '**/*.TIF',
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
      exclusionPattern: '**/raw/**',
      recursive: true,
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
      recursive: true,
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
    test: 'should support ignoring full filename',
    options: {
      pathsToCrawl: ['/photos'],
      exclusionPattern: '**/image2.jpg',
    },
    files: {
      '/photos/image1.jpg': true,
      '/photos/image2.jpg': false,
      '/photos/image3.jpg': true,
    },
  },
  {
    test: 'should support ignoring file extensions',
    options: {
      pathsToCrawl: ['/photos'],
      exclusionPattern: '**/*.png',
    },
    files: {
      '/photos/image1.jpg': true,
      '/photos/image2.png': false,
      '/photos/image3.jpg': true,
    },
  },
  {
    test: 'should support ignoring folder names',
    options: {
      pathsToCrawl: ['/photos'],
      recursive: true,
      exclusionPattern: '**/raw/**',
    },
    files: {
      '/photos/image1.jpg': true,
      '/photos/image/image1.jpg': true,
      '/photos/raw/image2.dng': false,
      '/photos/raw/image3.dng': false,
      '/photos/notraw/image3.jpg': true,
    },
  },
  {
    test: 'should support ignoring absolute paths',
    options: {
      // Currently, fast-glob has some caveat when dealing with `/`.
      pathsToCrawl: ['/*s'],
      recursive: true,
      exclusionPattern: '/images/**',
    },
    files: {
      '/photos/image1.jpg': true,
      '/images/image2.jpg': false,
      '/assets/image3.jpg': true,
    },
  },
];

describe('crawl', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'frameleaf-cli-crawl-'));
  });
  afterEach(async () => {
    vi.mocked(platform).mockReset();
    await rm(directory, { recursive: true, force: true });
  });

  it.each(['images/**', 'images/*.{jpg,png}', 'images/image[12].jpg'])(
    'should support Windows separators in absolute ignore glob %s',
    async (pattern) => {
      await mkdir(join(directory, 'images'));
      await writeFile(join(directory, 'images', 'image1.jpg'), 'ignored');
      await writeFile(join(directory, 'image3.jpg'), 'included');
      vi.mocked(platform).mockReturnValue('win32');

      const actual = await crawl({
        pathsToCrawl: [directory],
        exclusionPattern: `${directory.replaceAll('/', '\\')}\\${pattern}`,
        recursive: true,
        extensions,
      });

      expect(actual.map((path) => readContent(path))).toEqual(['included']);
    },
  );

  it('should preserve escaped glob characters in Windows ignore patterns', async () => {
    await writeFile(join(directory, 'image[1].jpg'), 'ignored');
    await writeFile(join(directory, 'image1.jpg'), 'included');
    vi.mocked(platform).mockReturnValue('win32');

    const actual = await crawl({
      pathsToCrawl: [directory],
      exclusionPattern: String.raw`**/image\[1\].jpg`,
      extensions,
    });

    expect(actual.map((path) => readContent(path))).toEqual(['included']);
  });

  describe('crawl', () => {
    for (const { test: name, options, files, skipOnWin32 } of tests) {
      if (process.platform === 'win32' && skipOnWin32) {
        test.skip(name);
        continue;
      }
      it(name, async () => {
        // The file contents is the same as the path.
        for (const file of Object.keys(files)) {
          const path = file.startsWith(`${cwd}/`)
            ? join(directory, 'cwd', file.slice(cwd.length))
            : join(directory, file);
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, file);
        }

        const actual = await crawl({
          ...options,
          pathsToCrawl: options.pathsToCrawl.map((path) =>
            isAbsolute(path) ? `${directory}${path}` : relative(cwd, join(directory, 'cwd', path)),
          ),
          exclusionPattern: options.exclusionPattern?.startsWith('/')
            ? `${directory}${options.exclusionPattern}`
            : options.exclusionPattern,
          extensions,
        });
        const expected = Object.entries(files)
          .filter((entry) => entry[1])
          .map(([file]) => file);

        // Compare file's content instead of path since a file can be represent in multiple ways.
        expect(actual.map((path) => readContent(path)).toSorted()).toEqual(expected.toSorted());
      });
    }
  });
});

describe('Batcher', () => {
  let batcher: Batcher;
  let onBatch: Mock;
  beforeEach(() => {
    onBatch = vi.fn();
    batcher = new Batcher({ batchSize: 2, onBatch });
  });

  it('preserves an item added synchronously by its batch callback', async () => {
    const seen: unknown[][] = [];
    batcher = new Batcher({
      batchSize: 2,
      onBatch: async (items) => {
        seen.push(items);
        if (seen.length === 1) {
          batcher.add('later');
        }
      },
    });
    batcher.add('first');
    await batcher.flush();
    await batcher.flush();
    expect(seen).toEqual([['first'], ['later']]);
  });

  it('allows callers to await completion and observe a callback failure', async () => {
    const gate = Promise.withResolvers<void>();
    batcher = new Batcher({ batchSize: 2, onBatch: () => gate.promise });
    batcher.add('first');
    const pending = batcher.flush();
    expect(pending).toBeInstanceOf(Promise);
    const failure = new Error('upload failed');
    const observed = expect(pending).rejects.toBe(failure);
    gate.reject(failure);
    await observed;
  });

  it.each([undefined, 100])('reports an automatic batch failure with debounce %s', async (debounceTimeMs) => {
    vi.useFakeTimers();
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = new Error('upload failed');
    try {
      batcher = new Batcher({
        batchSize: debounceTimeMs ? 2 : 1,
        debounceTimeMs,
        onBatch: async () => {
          throw failure;
        },
      });
      batcher.add('first');
      await vi.runAllTimersAsync();
      expect(report).toHaveBeenCalledExactlyOnceWith('Batch failed:', failure);
    } finally {
      report.mockRestore();
      vi.useRealTimers();
    }
  });

  it('should trigger onBatch() when a batch limit is reached', async () => {
    batcher.add('a');
    batcher.add('b');
    batcher.add('c');
    expect(onBatch).toHaveBeenCalledOnce();
    expect(onBatch).toHaveBeenCalledWith(['a', 'b']);
  });

  it('should trigger onBatch() when flush() is called', async () => {
    batcher.add('a');
    await batcher.flush();
    expect(onBatch).toHaveBeenCalledOnce();
    expect(onBatch).toHaveBeenCalledWith(['a']);
  });

  it('should trigger onBatch() when debounce time reached', async () => {
    vi.useFakeTimers();
    batcher = new Batcher({ batchSize: 2, debounceTimeMs: 100, onBatch });
    batcher.add('a');
    expect(onBatch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(onBatch).toHaveBeenCalledOnce();
    expect(onBatch).toHaveBeenCalledWith(['a']);
    vi.useRealTimers();
  });
});
