import assert from 'node:assert/strict';
import test from 'node:test';
import { StorageCore } from '../../dist/cores/storage.core.js';
import { walkLibraryPaths } from '../../dist/utils/library-walk.js';

// Native ESM loads the compiled production module and actual fast-glob CommonJS namespace.
// Vite's import interop can hide an unsupported named export during source unit tests.
test('compiled library walker preserves glob task/case/exclusion semantics under plain Node', async () => {
  StorageCore.setMediaLocation('/synthetic-managed');
  let closed = 0;
  const storage = {
    async realpath(value) {
      return value;
    },
    async stat() {
      return { isDirectory: () => true, isFile: () => false };
    },
    async opendir(folder) {
      const names = folder === '/synthetic' ? ['PHOTO.JPG', 'private', 'raw'] : ['private.jpg'];
      let after = 0;
      return {
        async read() {
          const name = names[after++];
          return name
            ? {
                name,
                isDirectory: () => !name.includes('.'),
                isFile: () => name.includes('.'),
                isSymbolicLink: () => false,
              }
            : undefined;
        },
        async close() {
          closed++;
        },
      };
    },
  };
  const pages = await Array.fromAsync(
    walkLibraryPaths(
      { pathsToCrawl: ['/synthetic'], take: 1, exclusionPatterns: ['/synthetic/{private,raw}/**'] },
      storage,
    ),
  );
  assert.deepEqual(pages, [['/synthetic/PHOTO.JPG']]);
  assert.equal(closed, 1);
});
