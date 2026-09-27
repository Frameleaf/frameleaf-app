import { ReleaseChannel } from 'src/enum.js';
import {
  FrameleafFeedRelease,
  isReleaseOffered,
  newestFrameleafRelease,
  parseFrameleafFeedRelease,
  parseFrameleafReleaseTag,
  parseReleaseBodyFlags,
  releaseFeedChannel,
  rolloutBucket,
} from 'src/utils/frameleaf-release.js';
import { cloudContractFixture } from 'test/fixtures/frameleaf-cloud-contracts.js';

// Frameleaf Cloud release feed response (FC-70, `GET /v1/releases/latest`), in this app's own tag format; the
// cloud's published answers are read from `releases/` below.
const feedRelease: FrameleafFeedRelease = {
  version: '3.2.1',
  tag: 'frameleaf-v3.2.1-4',
  publishedAt: '2026-09-25T12:00:00Z',
  url: 'https://github.com/Frameleaf/frameleaf-app/releases/tag/frameleaf-v3.2.1-4',
  notesUrl: 'https://help.frameleaf.app/releases/3.2.1',
  minimumSupported: null,
};

describe('releaseFeedChannel', () => {
  it('maps the update channel setting to the feed channel', () => {
    expect(releaseFeedChannel(ReleaseChannel.Stable)).toBe('stable');
    expect(releaseFeedChannel(ReleaseChannel.ReleaseCandidate)).toBe('beta');
  });
});

describe('parseFrameleafFeedRelease', () => {
  it('reads the release feed answers the cloud publishes', () => {
    const stable = cloudContractFixture<FrameleafFeedRelease>('releases/latest-stable.json');
    const beta = cloudContractFixture<FrameleafFeedRelease>('releases/latest-beta.json');
    // FC-70 staged rollout (frameleaf-cloud#83): stable is offered to 25% of servers, with a fallback.
    expect(parseFrameleafFeedRelease(stable, ReleaseChannel.Stable)).toEqual({
      version: '3.2.1',
      publishedAt: '2026-09-10T12:00:00Z',
      withdrawn: false,
      rolloutPercent: 25,
      fallback: { version: '3.2.0', publishedAt: '2026-08-20T09:00:00Z', withdrawn: false, rolloutPercent: 100 },
    });
    expect(parseFrameleafFeedRelease(beta, ReleaseChannel.ReleaseCandidate)).toEqual({
      version: '3.3.0-rc.1',
      publishedAt: '2026-09-20T08:30:00Z',
      withdrawn: false,
      rolloutPercent: 100,
      fallback: null,
    });
    expect(parseFrameleafFeedRelease(beta, ReleaseChannel.Stable)).toBeUndefined();
    expect(parseFrameleafReleaseTag(stable.tag)).toEqual({ version: stable.version, sequence: 4 });
    expect(parseFrameleafReleaseTag(beta.tag)).toEqual({ version: beta.version, sequence: 2 });
  });

  it('offers the published stable release to servers inside its 25% rollout and its fallback to the rest', () => {
    const stable = parseFrameleafFeedRelease(
      cloudContractFixture('releases/latest-stable.json'),
      ReleaseChannel.Stable,
    )!;
    const seeds = Array.from({ length: 400 }, (_, i) => `seed-${i}`);
    const inside: string[] = [];
    for (const seed of seeds) {
      const offered = isReleaseOffered(stable, seed, stable.version);
      expect(offered).toBe(rolloutBucket(seed, stable.version) < 25);
      if (offered) {
        inside.push(seed);
      } else {
        // every server outside the rollout is offered the fully rolled-out 3.2.0
        expect(isReleaseOffered(stable.fallback!, seed, stable.fallback!.version)).toBe(true);
      }
    }
    // roughly a quarter of servers get 3.2.1
    expect(inside.length).toBeGreaterThan(60);
    expect(inside.length).toBeLessThan(140);
    const beta = parseFrameleafFeedRelease(
      cloudContractFixture('releases/latest-beta.json'),
      ReleaseChannel.ReleaseCandidate,
    )!;
    expect(seeds.every((seed) => isReleaseOffered(beta, seed, beta.version))).toBe(true);
  });

  it('reads the version and publication time of a feed release', () => {
    expect(parseFrameleafFeedRelease(feedRelease, ReleaseChannel.Stable)).toEqual({
      version: '3.2.1',
      publishedAt: '2026-09-25T12:00:00Z',
      withdrawn: false,
      rolloutPercent: null,
    });
    expect(parseFrameleafFeedRelease({ ...feedRelease, minimumSupported: '3.0.0' }, ReleaseChannel.Stable)).toEqual(
      expect.objectContaining({ version: '3.2.1' }),
    );
  });

  it('accepts build metadata', () => {
    expect(parseFrameleafFeedRelease({ ...feedRelease, version: '3.2.1+build.5' }, ReleaseChannel.Stable)).toEqual(
      expect.objectContaining({ version: '3.2.1' }),
    );
    expect(
      parseFrameleafFeedRelease({ ...feedRelease, version: '3.3.0-rc.1+sha.abc' }, ReleaseChannel.ReleaseCandidate),
    ).toEqual(expect.objectContaining({ version: '3.3.0-rc.1' }));
  });

  it('accepts a prerelease only on the beta channel', () => {
    const candidate = { ...feedRelease, version: '3.3.0-rc.1', tag: 'frameleaf-v3.3.0-rc.1-2' };
    expect(parseFrameleafFeedRelease(candidate, ReleaseChannel.ReleaseCandidate)?.version).toBe('3.3.0-rc.1');
    expect(parseFrameleafFeedRelease(candidate, ReleaseChannel.Stable)).toBeUndefined();
  });

  it.each([
    ['a leading "v"', { ...feedRelease, version: 'v3.2.1' }],
    ['a version that is not semver', { ...feedRelease, version: '3.2' }],
    ['surrounding spaces', { ...feedRelease, version: ' 3.2.1' }],
    ['an "=" prefix', { ...feedRelease, version: '=3.2.1' }],
    ['a missing version', { ...feedRelease, version: undefined }],
    ['a list', [feedRelease]],
    ['no body', null],
    ['text', 'latest'],
  ])('rejects %s', (_, body) => {
    expect(parseFrameleafFeedRelease(body, ReleaseChannel.Stable)).toBeUndefined();
  });
});

describe('parseFrameleafReleaseTag', () => {
  it.each([
    ['frameleaf-v3.2.0-1', { version: '3.2.0', sequence: 1 }],
    ['frameleaf-v3.2.0-12', { version: '3.2.0', sequence: 12 }],
    ['frameleaf-v3.3.0-rc.1-2', { version: '3.3.0-rc.1', sequence: 2 }],
    ['frameleaf-v10.0.0-beta-7', { version: '10.0.0-beta', sequence: 7 }],
  ])('parses %s', (tag, expected) => {
    expect(parseFrameleafReleaseTag(tag)).toEqual(expected);
  });

  it.each([
    'v3.2.0',
    'frameleaf-v3.2.0',
    'frameleaf-3.2.0-1',
    'frameleaf-v3.2-1',
    'frameleaf-v3.2.0-x',
    'immich-v3.2.0-1',
  ])('rejects %s', (tag) => {
    expect(parseFrameleafReleaseTag(tag)).toBeUndefined();
  });
});

describe('newestFrameleafRelease', () => {
  const release = (tag_name: string, extra = {}) => ({ tag_name, published_at: null, ...extra });

  it('picks the highest version, then the highest rebuild sequence', () => {
    const releases = [release('frameleaf-v3.1.0-9'), release('frameleaf-v3.2.0-1'), release('frameleaf-v3.2.0-3')];
    expect(newestFrameleafRelease(releases, false)?.release.tag_name).toBe('frameleaf-v3.2.0-3');
  });

  it('skips drafts, foreign tags and, unless asked, prereleases', () => {
    const releases = [
      release('frameleaf-v3.2.0-1'),
      release('frameleaf-v4.0.0-1', { draft: true }),
      release('v9.0.0'),
      release('frameleaf-v3.3.0-rc.1-1', { prerelease: true }),
    ];
    expect(newestFrameleafRelease(releases, false)?.tag.version).toBe('3.2.0');
    expect(newestFrameleafRelease(releases, true)?.tag.version).toBe('3.3.0-rc.1');
    expect(newestFrameleafRelease([release('v1.0.0')], true)).toBeUndefined();
  });
});

describe('kill switch and staged rollout (FL-142)', () => {
  it('reads the withdrawn and rollout lines of a release body', () => {
    expect(parseReleaseBodyFlags(null)).toEqual({ withdrawn: false, rolloutPercent: null });
    expect(parseReleaseBodyFlags('Certified source: abc\n\nrollout: 25%\n')).toEqual({
      withdrawn: false,
      rolloutPercent: 25,
    });
    expect(parseReleaseBodyFlags('Withdrawn: database migration fails on ARM\nrollout: 100')).toEqual({
      withdrawn: true,
      rolloutPercent: 100,
    });
    // a typo never offers a release to everyone
    expect(parseReleaseBodyFlags('rollout: half').rolloutPercent).toBe(0);
    expect(parseReleaseBodyFlags('rollout: 250%').rolloutPercent).toBe(0);
    // an empty reason, or the word inside a sentence, is not a withdrawal
    expect(parseReleaseBodyFlags('withdrawn:\nThis fixes a release that was withdrawn: no').withdrawn).toBe(false);
  });

  it('places a server in a release rollout by its private seed, with a separate order per release', () => {
    expect(rolloutBucket('seed', '3.2.1')).toBe(rolloutBucket('seed', '3.2.1'));
    const buckets = new Set(Array.from({ length: 200 }, (_, i) => rolloutBucket(`seed-${i}`, '3.2.1')));
    expect(buckets.size).toBeGreaterThan(50);
    for (const bucket of buckets) {
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(100);
    }
    const orders = Array.from(
      { length: 20 },
      (_, i) => rolloutBucket(`seed-${i}`, '3.2.1') === rolloutBucket(`seed-${i}`, '3.3.0'),
    );
    expect(orders.every(Boolean)).toBe(false);
  });

  it('offers a release unless it is withdrawn or staged past this server', () => {
    const bucket = rolloutBucket('seed', '3.2.1');
    expect(isReleaseOffered({ withdrawn: false, rolloutPercent: null }, 'seed', '3.2.1')).toBe(true);
    expect(isReleaseOffered({ withdrawn: true, rolloutPercent: null }, 'seed', '3.2.1')).toBe(false);
    expect(isReleaseOffered({ withdrawn: false, rolloutPercent: bucket }, 'seed', '3.2.1')).toBe(false);
    expect(isReleaseOffered({ withdrawn: false, rolloutPercent: bucket + 1 }, 'seed', '3.2.1')).toBe(true);
    expect(isReleaseOffered({ withdrawn: false, rolloutPercent: 0 }, 'seed', '3.2.1')).toBe(false);
    expect(isReleaseOffered({ withdrawn: false, rolloutPercent: 100 }, 'seed', '3.2.1')).toBe(true);
  });

  it('reads the kill switch and rollout of a feed release', () => {
    expect(
      parseFrameleafFeedRelease({ ...feedRelease, withdrawn: true, rolloutPercent: 10 }, ReleaseChannel.Stable),
    ).toEqual(expect.objectContaining({ withdrawn: true, rolloutPercent: 10 }));
    expect(parseFrameleafFeedRelease({ ...feedRelease, rolloutPercent: 101 }, ReleaseChannel.Stable)).toBeUndefined();
    expect(parseFrameleafFeedRelease({ ...feedRelease, withdrawn: 'no' }, ReleaseChannel.Stable)).toBeUndefined();
  });

  describe('fallback (the newest earlier fully rolled-out release)', () => {
    const fallback = { ...feedRelease, version: '3.2.0', tag: 'frameleaf-v3.2.0-2', rolloutPercent: 100 };

    it('reads a valid fallback with the same rules as the release', () => {
      expect(
        parseFrameleafFeedRelease({ ...feedRelease, rolloutPercent: 10, fallback }, ReleaseChannel.Stable),
      ).toEqual({
        version: '3.2.1',
        publishedAt: '2026-09-25T12:00:00Z',
        withdrawn: false,
        rolloutPercent: 10,
        fallback: { version: '3.2.0', publishedAt: '2026-09-25T12:00:00Z', withdrawn: false, rolloutPercent: 100 },
      });
    });

    it('keeps an explicit null fallback apart from a feed that predates the field', () => {
      expect(parseFrameleafFeedRelease({ ...feedRelease, fallback: null }, ReleaseChannel.Stable)?.fallback).toBeNull();
      expect(parseFrameleafFeedRelease(feedRelease, ReleaseChannel.Stable)).not.toHaveProperty('fallback');
    });

    it.each([
      ['a version with a leading "v"', { ...fallback, version: 'v3.2.0' }],
      ['a prerelease on the stable channel', { ...fallback, version: '3.2.1-rc.1' }],
      ['a version that is not earlier', { ...fallback, version: '3.2.1' }],
      ['a later version', { ...fallback, version: '3.3.0' }],
      ['a malformed rollout', { ...fallback, rolloutPercent: 101 }],
      ['a malformed kill switch', { ...fallback, withdrawn: 'no' }],
      ['a string', '3.2.0'],
      ['an array', [fallback]],
    ])('rejects the whole answer for a fallback with %s', (_, bad) => {
      expect(parseFrameleafFeedRelease({ ...feedRelease, fallback: bad }, ReleaseChannel.Stable)).toBeUndefined();
    });

    it('ignores unknown keys and a nested fallback inside the fallback', () => {
      expect(
        parseFrameleafFeedRelease(
          { ...feedRelease, cohort: 'b', fallback: { ...fallback, fallback: 'ignored', extra: 1 } },
          ReleaseChannel.Stable,
        )?.fallback,
      ).toEqual({ version: '3.2.0', publishedAt: '2026-09-25T12:00:00Z', withdrawn: false, rolloutPercent: 100 });
    });
  });
});
