import { ReleaseChannel, type ServerVersionResponseDto } from '@frameleaf/sdk';

/**
 * FL-71 "Installed build channel" (the template's read-only row, `settings-catalog.mjs` `updates`):
 * the channel of the build that is running, read from its version. A pre-release version is a
 * release candidate; any other is a stable build. Unknown until the server reports its version.
 */
export const installedReleaseChannel = (
  version: Pick<ServerVersionResponseDto, 'prerelease'> | undefined | null,
): ReleaseChannel | undefined => {
  if (!version) {
    return undefined;
  }
  return version.prerelease === null || version.prerelease === undefined
    ? ReleaseChannel.Stable
    : ReleaseChannel.ReleaseCandidate;
};
