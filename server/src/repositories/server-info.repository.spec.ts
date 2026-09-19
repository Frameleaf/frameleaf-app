import { ReleaseChannel } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { ServerInfoRepository } from 'src/repositories/server-info.repository.js';

describe('external version reporting', () => {
  it.each(Object.values(ReleaseChannel))('cannot contact the version service for %s', async (channel) => {
    const fetch = vitest.fn();
    vitest.stubGlobal('fetch', fetch);
    try {
      const repository = new ServerInfoRepository(new ConfigRepository(), LoggingRepository.create());
      await expect(repository.getLatestRelease(channel)).rejects.toThrow('External version checks are disabled');
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vitest.unstubAllGlobals();
    }
  });
});
