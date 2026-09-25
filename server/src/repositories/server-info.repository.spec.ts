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

const respond = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  vitest.fn().mockResolvedValue(Response.json(body, { status, headers }));

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
    expect(init.signal).toBeInstanceOf(AbortSignal);
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

  it('falls back to the release list for Stable when the latest release is a release candidate', async () => {
    const fetch = vitest
      .fn()
      .mockResolvedValueOnce(Response.json(release('frameleaf-v3.3.0-rc.1-1')))
      .mockResolvedValueOnce(
        Response.json([
          release('frameleaf-v3.3.0-rc.1-1'),
          release('frameleaf-v3.2.1-2'),
          release('frameleaf-v3.2.0-1'),
        ]),
      );
    vitest.stubGlobal('fetch', fetch);

    await expect(repository.getLatestRelease(ReleaseChannel.Stable)).resolves.toEqual(
      expect.objectContaining({ version: 'v3.2.1' }),
    );
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      'https://api.github.com/repos/Frameleaf/frameleaf-app/releases/latest',
      'https://api.github.com/repos/Frameleaf/frameleaf-app/releases?per_page=30',
    ]);
  });

  it('names the status, Retry-After and rate-limit reset of a refused lookup', async () => {
    vitest.stubGlobal(
      'fetch',
      respond({ message: 'API rate limit exceeded' }, 403, {
        'retry-after': '60',
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': '1790000000',
      }),
    );

    const error = await repository.getLatestRelease(ReleaseChannel.Stable).catch((error_: Error) => error_);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Failed to fetch latest release');
    expect(((error as Error).cause as Error).message).toBe(
      `Release lookup failed with status 403, Retry-After 60s, rate limit resets at ${new Date(1_790_000_000_000).toISOString()}`,
    );
  });
});
