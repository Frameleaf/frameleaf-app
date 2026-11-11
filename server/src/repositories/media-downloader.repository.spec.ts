import { describe, expect, it } from 'vitest';
import { MediaDownloaderRepository } from 'src/repositories/media-downloader.repository.js';

describe(MediaDownloaderRepository.name, () => {
  const repository = new MediaDownloaderRepository();

  it('rejects a URL with credentials using a fixed error message', async () => {
    const result = repository.inspect('https://fixture:do-not-disclose@example.org/media?token=private');
    await expect(result).rejects.toMatchObject({
      code: 'invalid_url',
      message: 'Enter an HTTP or HTTPS URL without credentials.',
    });
  });

  it('reports an already aborted enumeration before starting the runtime', async () => {
    await expect(
      repository.enumerate('https://example.org/creator', { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ code: 'cancelled' });
  });
});
