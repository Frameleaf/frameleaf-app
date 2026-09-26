import { ReleaseChannel } from 'src/enum.js';
import {
  FrameleafFeedRelease,
  newestFrameleafRelease,
  parseFrameleafFeedRelease,
  parseFrameleafReleaseTag,
  releaseFeedChannel,
} from 'src/utils/frameleaf-release.js';

// Frameleaf Cloud release feed response (FC-70, `GET /v1/releases/latest`).
// TODO(FC-70): replace with the shared fixture in packages/contracts/fixtures/releases/ when it lands.
const feedRelease: FrameleafFeedRelease = {
  version: '3.2.1',
  tag: 'frameleaf-v3.2.1-4',
  publishedAt: '2026-09-25T12:00:00Z',
  url: 'https://github.com/Frameleaf/frameleaf-app/releases/tag/frameleaf-v3.2.1-4',
  notesUrl: 'https://help.frameleaf.ai/releases/3.2.1',
  minimumSupported: null,
};

describe('releaseFeedChannel', () => {
  it('maps the update channel setting to the feed channel', () => {
    expect(releaseFeedChannel(ReleaseChannel.Stable)).toBe('stable');
    expect(releaseFeedChannel(ReleaseChannel.ReleaseCandidate)).toBe('beta');
  });
});

describe('parseFrameleafFeedRelease', () => {
  it('reads the version and publication time of a feed release', () => {
    expect(parseFrameleafFeedRelease(feedRelease, ReleaseChannel.Stable)).toEqual({
      version: '3.2.1',
      publishedAt: '2026-09-25T12:00:00Z',
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
