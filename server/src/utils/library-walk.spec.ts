import { escapePath, glob } from 'fast-glob';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { Dirent } from 'node:fs';
import { StorageCore } from 'src/cores/storage.core.js';
import { LIBRARY_WALK_BUFFER, LibraryWalkStorage, walkLibraryPaths } from 'src/utils/library-walk.js';
import { mimeTypes } from 'src/utils/mime-types.js';

describe('bounded library source walk', () => {
  let fixture: string;
  let root: string;
  beforeEach(async () => {
    fixture = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'frameleaf-library-walk-')));
    root = path.join(fixture, 'source');
    await fs.mkdir(root);
    StorageCore.setMediaLocation(path.join(fixture, 'managed'));
  });
  afterEach(async () => {
    await fs.rm(fixture, { recursive: true, force: true });
    StorageCore.reset();
  });
  const collect = async (options: Parameters<typeof walkLibraryPaths>[0]) => {
    const found: string[] = [];
    for await (const batch of walkLibraryPaths(options)) found.push(...batch);
    return found;
  };
  const options = (paths: string[]) => ({ pathsToCrawl: paths, includeHidden: false, exclusionPatterns: [], take: 2 });
  const write = async (file: string) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'source remains read-only');
  };

  it('accepts omitted optional exclusion patterns', async () => {
    await write(path.join(root, 'a.jpg'));
    expect(await collect({ pathsToCrawl: [root], take: 1 })).toEqual([path.join(root, 'a.jpg')]);
  });

  it.each(['absolute-brace', 'glob-brace', 'numeric-brace', 'duplicate-slashes', 'negative-ignore'])(
    'preserves fast-glob ignore preprocessing for %s',
    async (kind) => {
      for (const folder of ['public', 'private', 'raw', '1', '2', '3']) {
        await write(path.join(root, folder, 'a.jpg'));
      }
      const patterns: Record<string, string> = {
        'absolute-brace': `${root}/{private,raw}`,
        'glob-brace': '**/{private,raw}',
        'numeric-brace': `${root}/{1..3}`,
        'duplicate-slashes': `${root}//private`,
        'negative-ignore': `!${root}/private`,
      };
      const config = { ...options([root]), exclusionPatterns: [patterns[kind]] };
      const expected = await glob(`${escapePath(root)}/**/*.jpg`, {
        absolute: true,
        onlyFiles: true,
        caseSensitiveMatch: false,
        ignore: config.exclusionPatterns,
      });
      const found = await collect(config);
      expect(found.toSorted()).toEqual(expected.toSorted());
      expect(expected).not.toContain(path.join(root, kind === 'numeric-brace' ? '1' : 'private', 'a.jpg'));
    },
  );

  it.each([false, true])(
    'preserves glob extension, case, hidden, exclusion and overlap matching (hidden=%s)',
    async (includeHidden) => {
      for (const file of [
        'A.JPG',
        'unicode-照片.jpg',
        'skip.XMP',
        '.hidden.jpg',
        '.jpg',
        'sub/a.MP4',
        '.hidden/b.jpg',
        'ignored/c.jpg',
        'sub/skip.jpg',
      ]) {
        await write(path.join(root, file));
      }
      const config = {
        ...options([root, path.join(root, 'sub'), root]),
        includeHidden,
        exclusionPatterns: [path.join(root, 'IGNORED/**'), '**/skip.jpg'],
      };
      const expected = await glob(
        config.pathsToCrawl.map(
          (folder) => `${escapePath(folder)}/**/*{${mimeTypes.getSupportedFileExtensions().join(',')}}`,
        ),
        {
          absolute: true,
          onlyFiles: true,
          caseSensitiveMatch: false,
          dot: includeHidden,
          ignore: config.exclusionPatterns,
        },
      );
      const found = await collect(config);
      expect(found.toSorted()).toEqual(expected.toSorted());
      expect(new Set(found).size).toBe(found.length);
      expect(await fs.readFile(path.join(root, 'A.JPG'), 'utf8')).toBe('source remains read-only');
    },
  );

  it('preserves an explicit hidden nested root while assigning each lexical subtree once', async () => {
    const hidden = path.join(root, '.hidden');
    await write(path.join(hidden, 'a.jpg'));
    const found = await collect(options([root, hidden]));
    expect(found).toEqual([path.join(hidden, 'a.jpg')]);
  });

  it.each([false, true])(
    'preserves overlapping root ownership when a parent prunes the explicit child (reverse=%s)',
    async (reverse) => {
      const child = path.join(root, 'ignored');
      await write(path.join(root, 'a.jpg'));
      await write(path.join(child, 'b.jpg'));
      const roots = reverse ? [child, root] : [root, child];
      const config = { ...options(roots), exclusionPatterns: [child] };
      const expected = await glob(
        roots.map((folder) => `${escapePath(folder)}/**/*{${mimeTypes.getSupportedFileExtensions().join(',')}}`),
        {
          absolute: true,
          onlyFiles: true,
          caseSensitiveMatch: false,
          dot: false,
          ignore: config.exclusionPatterns,
        },
      );
      const found = await collect(config);
      expect(found.toSorted()).toEqual(expected.toSorted());
      expect(new Set(found).size).toBe(found.length);
    },
  );

  it.each(['exact-root', 'directory', 'trailing-directory', 'subtree', 'relative', 'glob-directory'])(
    'preserves production ignore matching for %s patterns',
    async (kind) => {
      await write(path.join(root, 'a.jpg'));
      await write(path.join(root, 'ignored/b.jpg'));
      const patterns: Record<string, string> = {
        'exact-root': root,
        directory: path.join(root, 'ignored'),
        'trailing-directory': `${path.join(root, 'ignored')}/`,
        subtree: `${path.join(root, 'ignored')}/**`,
        relative: `${path.relative(process.cwd(), path.join(root, 'ignored'))}/**`,
        'glob-directory': '**/ignored/',
      };
      const config = { ...options([root]), exclusionPatterns: [patterns[kind]] };
      const expected = await glob([`${escapePath(root)}/**/*{${mimeTypes.getSupportedFileExtensions().join(',')}}`], {
        absolute: true,
        onlyFiles: true,
        caseSensitiveMatch: false,
        dot: false,
        ignore: config.exclusionPatterns,
      });
      expect((await collect(config)).toSorted()).toEqual(expected.toSorted());
    },
  );

  it('follows file/directory aliases, stops ancestor cycles and excludes media-storage links', async () => {
    await write(path.join(root, 'sub/a.jpg'));
    await write(path.join(fixture, 'managed/upload/private.jpg'));
    await fs.symlink(path.join(root, 'sub'), path.join(root, 'alias'));
    await fs.symlink(root, path.join(root, 'sub/cycle'));
    await fs.symlink(path.join(root, 'sub/a.jpg'), path.join(root, 'file.JPG'));
    await fs.symlink(path.join(fixture, 'managed'), path.join(root, 'private'));
    await fs.symlink(path.join(fixture, 'managed/upload/private.jpg'), path.join(root, 'private.jpg'));
    await fs.symlink(path.join(root, 'absent.jpg'), path.join(root, 'broken.jpg'));
    expect((await collect(options([root]))).toSorted()).toEqual(
      [path.join(root, 'sub/a.jpg'), path.join(root, 'alias/a.jpg'), path.join(root, 'file.JPG')].toSorted(),
    );
  });

  it('returns empty readable roots and fails unavailable roots instead of assuming absent files', async () => {
    expect(await collect(options([root]))).toEqual([]);
    await expect(collect(options([path.join(root, 'absent')]))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('closes native directory descriptors when its consumer returns early', async () => {
    await write(path.join(root, 'sub/a.jpg'));
    const close = vi.fn<(folder: string) => void>();
    const storage: LibraryWalkStorage = {
      ...fs,
      opendir: async (folder, config) => {
        const directory = await fs.opendir(folder, config);
        return {
          read: () => directory.read(),
          close: async () => {
            close(folder);
            await directory.close();
          },
        };
      },
    };
    for await (const _batch of walkLibraryPaths({ ...options([root]), take: 1 }, storage)) break;
    expect(close.mock.calls.map(([folder]) => folder).toSorted()).toEqual([root, path.join(root, 'sub')].toSorted());
  });

  it('observes cancellation after a pending read and closes every active descriptor', async () => {
    const waiting = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const controller = new AbortController();
    const close = vi.fn().mockResolvedValue(undefined);
    const storage: LibraryWalkStorage = {
      realpath: (file) => Promise.resolve(file),
      stat: vi.fn(),
      opendir: () =>
        Promise.resolve({
          close,
          read: async () => {
            waiting.resolve();
            await release.promise;
            return {
              name: 'late.jpg',
              isFile: () => true,
              isDirectory: () => false,
              isSymbolicLink: () => false,
            } as Dirent;
          },
        }),
    };
    const iterator = walkLibraryPaths({ ...options([root]), take: 1, signal: controller.signal }, storage);
    const next = iterator.next();
    await waiting.promise;
    controller.abort();
    release.resolve();
    await expect(next).rejects.toMatchObject({ name: 'AbortError' });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('pulls 500,000 synthetic matched entries from one wide directory without retaining its width', async () => {
    const count = 500_000;
    const take = 1000;
    let reads = 0;
    let batches = 0;
    let emitted = 0;
    let directoryBuffer = 0;
    const close = vi.fn().mockResolvedValue(undefined);
    const storage: LibraryWalkStorage = {
      realpath: (file) => Promise.resolve(file),
      stat: vi.fn(),
      opendir: (_folder, config) => {
        directoryBuffer = config.bufferSize;
        return Promise.resolve({
          close,
          read: () => {
            if (reads === count) return Promise.resolve(null);
            const name = `generated-${reads++}.JPG`;
            return Promise.resolve({
              name,
              isFile: () => true,
              isDirectory: () => false,
              isSymbolicLink: () => false,
            } as Dirent);
          },
        });
      },
    };
    for await (const batch of walkLibraryPaths({ ...options([root]), take }, storage)) {
      batches++;
      expect(batch.length).toBe(take);
      emitted += batch.length;
      expect(reads).toBe(emitted); // No next page is pulled while the consumer holds this page.
      expect(batch[0]).toBe(path.join(root, `generated-${emitted - take}.JPG`));
      await new Promise<void>((resolve) => setImmediate(resolve)); // Slow consumer holds the page.
      expect(reads).toBe(emitted);
    }
    expect({ emitted, batches, directoryBuffer }).toEqual({
      emitted: count,
      batches: 500,
      directoryBuffer: LIBRARY_WALK_BUFFER,
    });
    expect(close).toHaveBeenCalledTimes(1);
    expect(storage.stat).not.toHaveBeenCalled();
  });

  it('negative control: the installed glob filter retains every matched path beyond the page bound', () => {
    const require = createRequire(import.meta.url);
    // This is the pinned production dependency's actual uniqueness filter, not a facsimile.
    const EntryFilter = require(
      path.join(path.dirname(require.resolve('fast-glob')), 'providers/filters/entry.js'),
    ).default;
    const filter = new EntryFilter({ unique: true, onlyFiles: true }, { dot: false, nocase: true });
    const accept = filter.getFilter(['**/*.jpg'], []);
    for (let index = 0; index < 10_000; index++) {
      expect(
        accept({
          path: `source/generated-${index}.jpg`,
          dirent: {
            isFile: () => true,
            isDirectory: () => false,
          },
        }),
      ).toBe(true);
    }
    expect(filter.index.size).toBe(10_000);
    expect(filter.index.size).toBeGreaterThan(1000 + LIBRARY_WALK_BUFFER);
  });
});
