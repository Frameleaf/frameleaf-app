import { SemVer, valid } from 'semver';

/**
 * Frameleaf's own release feed (FL-80 S-4 / O-8, owner decision on FL-146, 2026-09-25): the server
 * asks only Frameleaf's GitHub releases about new versions, never an Immich service.
 *
 * Release tags are `frameleaf-v<semver>-<n>` (`.github/frameleaf-release.cjs` `chooseTag`): the base
 * version of the build and a sequence number for rebuilds of that version.
 */
export const FRAMELEAF_RELEASES_API = 'https://api.github.com/repos/Frameleaf/frameleaf-app/releases';

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
