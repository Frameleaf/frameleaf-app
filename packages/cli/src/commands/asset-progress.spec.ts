import { checkForDuplicates } from 'src/commands/asset';

it.each([1, 0])('releases its progress interrupt listener after a batch with concurrency %s', async (concurrency) => {
  const before = process.listeners('SIGINT');
  try {
    for (let index = 0; index < 3; index++) {
      const pending = checkForDuplicates([], { concurrency, progress: true });
      if (concurrency === 0) {
        await expect(pending).rejects.toThrow();
      } else {
        await expect(pending).resolves.toEqual({ newFiles: [], duplicates: [] });
      }
      expect(process.listeners('SIGINT')).toEqual(before);
    }
  } finally {
    for (const listener of process.listeners('SIGINT')) {
      if (!before.includes(listener)) {
        process.off('SIGINT', listener);
      }
    }
  }
});
