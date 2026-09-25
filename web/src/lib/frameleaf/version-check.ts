import { checkVersionNow, getVersionCheck } from '@immich/sdk';
import { semverToName } from '$lib/utils';

/**
 * Frameleaf's version check (FL-80 S-4 / O-8; owner decision on FL-146, 2026-09-25). The server asks
 * only Frameleaf's GitHub releases; the web never contacts a release feed itself and never links to
 * an Immich release.
 */

/** GitHub release notes of a Frameleaf version (`frameleaf-v<version>-<n>` tags). */
export const releaseNotesUrl = (version: string) =>
  `https://github.com/Frameleaf/frameleaf-app/releases?q=frameleaf-v${encodeURIComponent(version.replace(/^v/, ''))}&expanded=true`;

type Parsed = { core: [number, number, number]; prerelease: string | undefined };

const parse = (version: string): Parsed | undefined => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version.trim());
  if (!match) {
    return undefined;
  }
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4] };
};

/** Whether `release` is newer than `running`; undefined when either is not a version. */
export const isNewerVersion = (release: string, running: string): boolean | undefined => {
  const a = parse(release);
  const b = parse(running);
  if (!a || !b) {
    return undefined;
  }
  for (let index = 0; index < 3; index++) {
    if (a.core[index] !== b.core[index]) {
      return a.core[index] > b.core[index];
    }
  }
  if (a.prerelease === b.prerelease) {
    return false;
  }
  // A release is newer than its own prereleases; two prereleases compare as text.
  if (!a.prerelease || !b.prerelease) {
    return !a.prerelease;
  }
  return a.prerelease.localeCompare(b.prerelease, undefined, { numeric: true }) > 0;
};

export type UpdateCheckResult =
  { status: 'available' | 'current'; version: string; checkedAt: string } | { status: 'unknown'; checkedAt?: string };

/**
 * About → "Check for updates". An administrator asks the server to check now; any other account
 * reads the server's last check, which an administrator's automatic or manual check recorded.
 */
export const checkForUpdates = async (isAdmin: boolean, runningVersion: string): Promise<UpdateCheckResult> => {
  if (isAdmin) {
    const release = await checkVersionNow();
    return {
      status: release.isAvailable ? 'available' : 'current',
      version: semverToName(release.releaseVersion),
      checkedAt: release.checkedAt,
    };
  }

  const state = await getVersionCheck();
  if (!state.releaseVersion || !state.checkedAt) {
    return { status: 'unknown' };
  }
  const newer = isNewerVersion(state.releaseVersion, runningVersion);
  if (newer === undefined) {
    return { status: 'unknown', checkedAt: state.checkedAt };
  }
  return { status: newer ? 'available' : 'current', version: state.releaseVersion, checkedAt: state.checkedAt };
};
