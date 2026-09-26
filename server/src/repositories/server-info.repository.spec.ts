import { ReleaseChannel } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { ServerInfoRepository } from 'src/repositories/server-info.repository.js';
import { FrameleafFeedRelease } from 'src/utils/frameleaf-release.js';

// Frameleaf Cloud release feed response (FC-70, `GET /v1/releases/latest`).
// TODO(FC-70): replace with the shared fixture in packages/contracts/fixtures/releases/ when it lands.
const feedRelease = (extra: Partial<FrameleafFeedRelease> = {}): FrameleafFeedRelease => ({
  version: '3.2.1',
  tag: 'frameleaf-v3.2.1-4',
  publishedAt: '2026-09-25T12:00:00Z',
  url: 'https://github.com/Frameleaf/frameleaf-app/releases/tag/frameleaf-v3.2.1-4',
  notesUrl: 'https://help.frameleaf.ai/releases/3.2.1',
  minimumSupported: null,
  ...extra,
});

const FEED = 'https://api.frameleaf.cloud/v1/releases/latest';
const GITHUB = 'https://api.github.com/repos/Frameleaf/frameleaf-app/releases';

const release = (tag_name: string, extra: Record<string, unknown> = {}) => ({
  tag_name,
  published_at: '2026-09-25T12:00:00Z',
  draft: false,
  prerelease: false,
  ...extra,
});

const respond = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  vitest.fn().mockImplementation(() => Promise.resolve(Response.json(body, { status, headers })));

/** The release feed is down; every later request answers with the given GitHub responses in order. */
const feedDownThen = (...responses: Response[]) => {
  const fetch = vitest.fn().mockResolvedValueOnce(Response.json({ message: 'unavailable' }, { status: 503 }));
  for (const response of responses) {
    fetch.mockResolvedValueOnce(response);
  }
  return fetch;
};

describe('Frameleaf version check (FL-80 S-4 / O-8, FL-192)', () => {
  let repository: ServerInfoRepository;

  beforeEach(() => {
    repository = new ServerInfoRepository(new ConfigRepository(), LoggingRepository.create());
  });

  afterEach(() => {
    vitest.unstubAllGlobals();
  });

  describe('Frameleaf Cloud release feed', () => {
    it('reads the stable version from the release feed first', async () => {
      const fetch = respond(feedRelease());
      vitest.stubGlobal('fetch', fetch);

      await expect(repository.getLatestRelease(ReleaseChannel.Stable)).resolves.toEqual({
        version: 'v3.2.1',
        published_at: '2026-09-25T12:00:00Z',
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      const [url, init] = fetch.mock.calls[0];
      expect(url).toBe(`${FEED}?channel=stable`);
      expect(init.headers).toEqual({ Accept: 'application/json', 'User-Agent': 'Frameleaf-Server' });
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it('asks the beta channel for release candidates', async () => {
      const fetch = respond(feedRelease({ version: '3.3.0-rc.1', tag: 'frameleaf-v3.3.0-rc.1-2' }));
      vitest.stubGlobal('fetch', fetch);

      await expect(repository.getLatestRelease(ReleaseChannel.ReleaseCandidate)).resolves.toEqual(
        expect.objectContaining({ version: 'v3.3.0-rc.1' }),
      );
      expect(fetch.mock.calls[0][0]).toBe(`${FEED}?channel=beta`);
    });

    it('sends no instance identifier', async () => {
      const fetch = respond(feedRelease());
      vitest.stubGlobal('fetch', fetch);

      await repository.getLatestRelease(ReleaseChannel.Stable);

      const [url, init] = fetch.mock.calls[0];
      expect([...new URL(url).searchParams.keys()]).toEqual(['channel']);
      expect(init.headers).toEqual({ Accept: 'application/json', 'User-Agent': 'Frameleaf-Server' });
      expect(init.credentials).toBeUndefined();
      expect(init.body).toBeUndefined();
    });

    it.each([
      ['an error status', Response.json({ message: 'unavailable' }, { status: 503 })],
      ['a version with a leading "v"', Response.json(feedRelease({ version: 'v3.2.1' }))],
      ['a body that is not a release', Response.json({ releases: [] })],
      ['a prerelease on the stable channel', Response.json(feedRelease({ version: '3.3.0-rc.1' }))],
    ])('falls back to GitHub releases on %s', async (_, feedResponse) => {
      const fetch = vitest
        .fn()
        .mockResolvedValueOnce(feedResponse)
        .mockResolvedValueOnce(Response.json(release('frameleaf-v3.2.0-2')));
      vitest.stubGlobal('fetch', fetch);

      await expect(repository.getLatestRelease(ReleaseChannel.Stable)).resolves.toEqual({
        version: 'v3.2.0',
        published_at: '2026-09-25T12:00:00Z',
      });
      expect(fetch.mock.calls.map(([url]) => url)).toEqual([`${FEED}?channel=stable`, `${GITHUB}/latest`]);
    });

    it('falls back to GitHub releases when the feed cannot be reached', async () => {
      const fetch = vitest
        .fn()
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce(Response.json(release('frameleaf-v3.2.0-2')));
      vitest.stubGlobal('fetch', fetch);

      await expect(repository.getLatestRelease(ReleaseChannel.Stable)).resolves.toEqual(
        expect.objectContaining({ version: 'v3.2.0' }),
      );
      expect(fetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('GitHub releases fallback', () => {
    it("reads the stable version from Frameleaf's latest GitHub release", async () => {
      const fetch = feedDownThen(Response.json(release('frameleaf-v3.2.1-4')));
      vitest.stubGlobal('fetch', fetch);

      await expect(repository.getLatestRelease(ReleaseChannel.Stable)).resolves.toEqual({
        version: 'v3.2.1',
        published_at: '2026-09-25T12:00:00Z',
      });
      expect(fetch).toHaveBeenCalledTimes(2);
      const [url, init] = fetch.mock.calls[1];
      expect(url).toBe(`${GITHUB}/latest`);
      expect(init.headers).toEqual(expect.objectContaining({ Accept: 'application/vnd.github+json' }));
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it('reads recent releases, prereleases included, for the release-candidate channel', async () => {
      const fetch = feedDownThen(
        Response.json([
          release('frameleaf-v3.2.1-1'),
          release('frameleaf-v3.3.0-rc.1-2', { prerelease: true }),
          release('frameleaf-v9.0.0-1', { draft: true }),
          release('v4.0.0'),
        ]),
      );
      vitest.stubGlobal('fetch', fetch);

      await expect(repository.getLatestRelease(ReleaseChannel.ReleaseCandidate)).resolves.toEqual(
        expect.objectContaining({ version: 'v3.3.0-rc.1' }),
      );
      expect(fetch.mock.calls.map(([url]) => url)).toEqual([`${FEED}?channel=beta`, `${GITHUB}?per_page=30`]);
    });

    it('falls back to the release list for Stable when the latest release is a release candidate', async () => {
      const fetch = feedDownThen(
        Response.json(release('frameleaf-v3.3.0-rc.1-1')),
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
        `${FEED}?channel=stable`,
        `${GITHUB}/latest`,
        `${GITHUB}?per_page=30`,
      ]);
    });

    it('fails when neither source has a Frameleaf release', async () => {
      vitest.stubGlobal('fetch', feedDownThen(Response.json(release('v3.2.1')), Response.json([release('v3.2.1')])));
      await expect(repository.getLatestRelease(ReleaseChannel.Stable)).rejects.toThrow(
        'Failed to fetch latest release',
      );

      vitest.stubGlobal('fetch', respond({ message: 'rate limited' }, 403));
      await expect(repository.getLatestRelease(ReleaseChannel.Stable)).rejects.toThrow(
        'Failed to fetch latest release',
      );
    });

    it('names the status, Retry-After and rate-limit reset of a refused lookup', async () => {
      vitest.stubGlobal(
        'fetch',
        feedDownThen(
          Response.json(
            { message: 'API rate limit exceeded' },
            {
              status: 403,
              headers: { 'retry-after': '60', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1790000000' },
            },
          ),
        ),
      );

      const error = await repository.getLatestRelease(ReleaseChannel.Stable).catch((error_: Error) => error_);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('Failed to fetch latest release');
      expect(((error as Error).cause as Error).message).toBe(
        `Release lookup failed with status 403, Retry-After 60s, rate limit resets at ${new Date(1_790_000_000_000).toISOString()}`,
      );
    });
  });

  it('never contacts an Immich service', async () => {
    for (const fetch of [respond(feedRelease()), respond({ message: 'unavailable' }, 503)]) {
      vitest.stubGlobal('fetch', fetch);
      for (const channel of Object.values(ReleaseChannel)) {
        await repository.getLatestRelease(channel).catch(() => {});
      }
      for (const [url] of fetch.mock.calls) {
        expect(String(url)).not.toMatch(/immich/i);
        expect(['api.frameleaf.cloud', 'api.github.com']).toContain(new URL(String(url)).host);
      }
    }
  });
});
