import { SemVer, valid } from 'semver';
import { ReleaseChannel } from 'src/enum.js';

/**
 * Frameleaf's own release feeds (FL-80 S-4 / O-8, owner decision on FL-146, 2026-09-25; FL-192): the
 * server asks only Frameleaf about new versions, never an Immich service.
 *
 * The Frameleaf Cloud release feed (FC-70) is asked first. It is public, needs no authentication and
 * can be cached for an hour. Frameleaf's GitHub releases are the fallback when the feed cannot answer.
 *
 * Release tags are `frameleaf-v<semver>-<n>` (`.github/frameleaf-release.cjs` `chooseTag`): the base
 * version of the build and a sequence number for rebuilds of that version.
 */
export const FRAMELEAF_RELEASE_FEED = 'https://api.frameleaf.cloud/v1/releases/latest';
export const FRAMELEAF_RELEASES_API = 'https://api.github.com/repos/Frameleaf/frameleaf-app/releases';

/** The feed's `channel` query value for the admin's update channel setting. */
export const releaseFeedChannel = (channel: ReleaseChannel) =>
  channel === ReleaseChannel.ReleaseCandidate ? 'beta' : 'stable';

/** `GET /v1/releases/latest` on the Frameleaf Cloud release feed. `version` is semver with no leading "v". */
export type FrameleafFeedRelease = {
  version: string;
  tag: string;
  publishedAt: string;
  url: string;
  notesUrl: string;
  minimumSupported: string | null;
};

/**
 * The version and publication time from a release feed response, or undefined when the body is not a
 * release in the feed's shape. A prerelease on the stable channel is rejected as well.
 */
export const parseFrameleafFeedRelease = (body: unknown, channel: ReleaseChannel) => {
  if (!body || typeof body !== 'object') {
    return;
  }
  const { version, publishedAt } = body as Partial<FrameleafFeedRelease>;
  if (typeof version !== 'string' || valid(version) !== version) {
    return;
  }
  if (channel === ReleaseChannel.Stable && new SemVer(version).prerelease.length > 0) {
    return;
  }
  return { version, publishedAt: typeof publishedAt === 'string' ? publishedAt : '' };
};

const TAG = /^frameleaf-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?)-(\d+)$/;

export type FrameleafReleaseTag = { version: string; sequence: number };

/** The base version and sequence of a Frameleaf release tag, or undefined for any other tag. */
export const parseFrameleafReleaseTag = (tag: string): FrameleafReleaseTag | undefined => {
  const match = TAG.exec(tag);
  if (!match) {
    return undefined;
  }
  const [, version, sequence] = match;
  const number = Number(sequence);
  if (!valid(version) || !Number.isSafeInteger(number)) {
    return undefined;
  }
  return { version, sequence: number };
};

export type GitHubRelease = {
  tag_name: string;
  published_at: string | null;
  draft?: boolean;
  prerelease?: boolean;
};

/**
 * The newest Frameleaf release in a list of GitHub releases: drafts and tags that are not Frameleaf
 * release tags are ignored, prereleases only count when `includePrerelease` is set, and a rebuild of
 * the same version (a higher sequence) wins over the earlier one.
 */
export const newestFrameleafRelease = (releases: GitHubRelease[], includePrerelease: boolean) => {
  let best: { release: GitHubRelease; tag: FrameleafReleaseTag; semver: SemVer } | undefined;
  for (const release of releases) {
    const tag = parseFrameleafReleaseTag(release.tag_name);
    if (!tag || release.draft) {
      continue;
    }
    const semver = new SemVer(tag.version);
    if (!includePrerelease && (release.prerelease || semver.prerelease.length > 0)) {
      continue;
    }
    const order = best ? semver.compare(best.semver) : 1;
    if (order > 0 || (order === 0 && best && tag.sequence > best.tag.sequence)) {
      best = { release, tag, semver };
    }
  }
  return best;
};
