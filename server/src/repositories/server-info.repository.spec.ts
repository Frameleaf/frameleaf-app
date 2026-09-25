import { ReleaseChannel } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { ServerInfoRepository } from 'src/repositories/server-info.repository.js';

const release = (tag_name: string, extra: Record<string, unknown> = {}) => ({
  tag_name,
  published_at: '2026-09-25T12:00:00Z',
  draft: false,
  prerelease: false,
  ...extra,
});

const respond = (body: unknown, status = 200) => vitest.fn().mockResolvedValue(Response.json(body, { status }));

describe('Frameleaf version check (FL-80 S-4 / O-8)', () => {
  let repository: ServerInfoRepository;

  beforeEach(() => {
    repository = new ServerInfoRepository(new ConfigRepository(), LoggingRepository.create());
  });

  afterEach(() => {
    vitest.unstubAllGlobals();
  });

  it("reads the stable version from Frameleaf's latest GitHub release", async () => {
    const fetch = respond(release('frameleaf-v3.2.1-4'));
    vitest.stubGlobal('fetch', fetch);

    await expect(repository.getLatestRelease(ReleaseChannel.Stable)).resolves.toEqual({
      version: 'v3.2.1',
      published_at: '2026-09-25T12:00:00Z',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/Frameleaf/frameleaf-app/releases/latest');
    expect(init.headers).toEqual(expect.objectContaining({ Accept: 'application/vnd.github+json' }));
  });

  it('reads recent releases, prereleases included, for the release-candidate channel', async () => {
    const fetch = respond([
      release('frameleaf-v3.2.1-1'),
      release('frameleaf-v3.3.0-rc.1-2', { prerelease: true }),
      release('frameleaf-v9.0.0-1', { draft: true }),
      release('v4.0.0'),
    ]);
    vitest.stubGlobal('fetch', fetch);

    await expect(repository.getLatestRelease(ReleaseChannel.ReleaseCandidate)).resolves.toEqual(
      expect.objectContaining({ version: 'v3.3.0-rc.1' }),
    );
    expect(fetch.mock.calls[0][0]).toBe('https://api.github.com/repos/Frameleaf/frameleaf-app/releases?per_page=30');
  });

  it('never contacts an Immich service', async () => {
    const fetch = respond(release('frameleaf-v3.2.1-1'));
    vitest.stubGlobal('fetch', fetch);

    for (const channel of Object.values(ReleaseChannel)) {
      await repository.getLatestRelease(channel).catch(() => {});
    }
    for (const [url] of fetch.mock.calls) {
      expect(String(url)).not.toMatch(/immich/i);
      expect(new URL(String(url)).host).toBe('api.github.com');
    }
  });

  it('fails on a response that is not a Frameleaf release, or an error status', async () => {
    vitest.stubGlobal('fetch', respond(release('v3.2.1')));
    await expect(repository.getLatestRelease(ReleaseChannel.Stable)).rejects.toThrow('Failed to fetch latest release');

    vitest.stubGlobal('fetch', respond({ message: 'rate limited' }, 403));
    await expect(repository.getLatestRelease(ReleaseChannel.Stable)).rejects.toThrow('Failed to fetch latest release');
  });
});
