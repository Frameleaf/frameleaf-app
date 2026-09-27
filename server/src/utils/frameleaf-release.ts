import { createHash } from 'node:crypto';
import { SemVer, lt, valid } from 'semver';
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
  /** Kill switch (FL-142): a withdrawn release is never offered. Absent means not withdrawn. */
  withdrawn?: boolean | null;
  /** Staged rollout (FL-142): the percentage of servers (0-100) offered this release. Absent or null means all. */
  rolloutPercent?: number | null;
  /**
   * The newest earlier release that is fully rolled out and not withdrawn, in the same shape without its own
   * `fallback`, or null when there is none. Absent from feeds that predate it.
   */
  fallback?: Omit<FrameleafFeedRelease, 'fallback'> | null;
};

/** A validated feed release. `fallback` is undefined when the feed did not send the field at all. */
export type ParsedFeedRelease = {
  version: string;
  publishedAt: string;
  withdrawn: boolean;
  rolloutPercent: number | null;
  fallback?: Omit<ParsedFeedRelease, 'fallback'> | null;
};

/**
 * Whether a release is offered at all (FL-142, owner decision 2026-09-27): a withdrawn release never is, and a
 * staged release only to the share of servers its rollout percentage names.
 */
export type ReleaseOffer = { withdrawn: boolean; rolloutPercent: number | null };

const validPercent = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 100;

/**
 * This server's place (0-99) in a release's staged rollout. The seed is a random value the server keeps to
 * itself and never sends anywhere; mixing in the version gives each release its own order of servers, so the
 * same servers are not always first.
 */
export const rolloutBucket = (seed: string, version: string) =>
  createHash('sha256').update(`${seed}:${version}`).digest().readUInt32BE(0) % 100;

/** Whether this server is offered the release: not withdrawn, and inside its staged rollout. */
export const isReleaseOffered = (offer: ReleaseOffer, seed: string, version: string) =>
  !offer.withdrawn && (offer.rolloutPercent === null || rolloutBucket(seed, version) < offer.rolloutPercent);

/**
 * The kill switch and rollout lines of a GitHub release body, which `Deploy production` writes
 * (`.github/frameleaf-release.cjs` `releaseFlagsBody`): `withdrawn: <reason>` and `rollout: <0-100>%`, each on a
 * line of its own. A malformed rollout line is read as 0%, so a typo never offers a release to everyone.
 */
export const parseReleaseBodyFlags = (body: string | null = ''): ReleaseOffer => {
  const text = body ?? '';
  const withdrawn = /^[ \t]*withdrawn:[ \t]*\S/im.test(text);
  const rollout = /^[ \t]*rollout:[ \t]*(.*?)[ \t]*$/im.exec(text);
  let rolloutPercent: number | null = null;
  if (rollout) {
    const match = /^(\d{1,3})\s*%?$/.exec(rollout[1]);
    const value = match ? Number(match[1]) : NaN;
    rolloutPercent = validPercent(value) ? value : 0;
  }
  return { withdrawn, rolloutPercent };
};

const parseFeedEntry = (body: unknown, channel: ReleaseChannel): Omit<ParsedFeedRelease, 'fallback'> | undefined => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return;
  }
  const { version, publishedAt, withdrawn, rolloutPercent } = body as Partial<FrameleafFeedRelease>;
  if (withdrawn !== undefined && withdrawn !== null && typeof withdrawn !== 'boolean') {
    return;
  }
  if (rolloutPercent !== undefined && rolloutPercent !== null && !validPercent(rolloutPercent)) {
    return;
  }
  // Strict semver without a leading "v" or surrounding spaces; build metadata is accepted and dropped.
  if (typeof version !== 'string' || !/^\d/.test(version) || version !== version.trim()) {
    return;
  }
  const normalized = valid(version);
  if (!normalized) {
    return;
  }
  if (channel === ReleaseChannel.Stable && new SemVer(normalized).prerelease.length > 0) {
    return;
  }
  return {
    version: normalized,
    publishedAt: typeof publishedAt === 'string' ? publishedAt : '',
    withdrawn: withdrawn === true,
    rolloutPercent: rolloutPercent ?? null,
  };
};

/**
 * The version, publication time, kill switch, rollout and fallback from a release feed response, or undefined
 * when the body is not a release in the feed's shape (the GitHub fallback is asked instead). A prerelease on the
 * stable channel is rejected, and so is a malformed `withdrawn` or `rolloutPercent`. `fallback` (FL-142) is
 * validated by the same rules and must be an earlier version than the release; a malformed one rejects the
 * whole answer. Unknown keys are ignored.
 */
export const parseFrameleafFeedRelease = (body: unknown, channel: ReleaseChannel): ParsedFeedRelease | undefined => {
  const release = parseFeedEntry(body, channel);
  if (!release) {
    return;
  }
  const { fallback } = body as Partial<FrameleafFeedRelease>;
  if (fallback === undefined) {
    return release;
  }
  if (fallback === null) {
    return { ...release, fallback: null };
  }
  const parsed = parseFeedEntry(fallback, channel);
  if (!parsed || !lt(parsed.version, release.version)) {
    return;
  }
  return { ...release, fallback: parsed };
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
  body?: string | null;
};

/**
 * The newest Frameleaf release in a list of GitHub releases: drafts and tags that are not Frameleaf
 * release tags are ignored, prereleases only count when `includePrerelease` is set, and a rebuild of
 * the same version (a higher sequence) wins over the earlier one. With `offered`, a release it rejects (withdrawn,
 * or outside this server's staged rollout) is skipped, so an earlier offered release is found instead.
 */
export const newestFrameleafRelease = (
  releases: GitHubRelease[],
  includePrerelease: boolean,
  offered?: (release: GitHubRelease, tag: FrameleafReleaseTag) => boolean,
) => {
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
    if (offered && !offered(release, tag)) {
      continue;
    }
    const order = best ? semver.compare(best.semver) : 1;
    if (order > 0 || (order === 0 && best && tag.sequence > best.tag.sequence)) {
      best = { release, tag, semver };
    }
  }
  return best;
};
