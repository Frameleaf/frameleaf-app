import { newestFrameleafRelease, parseFrameleafReleaseTag } from 'src/utils/frameleaf-release.js';

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
