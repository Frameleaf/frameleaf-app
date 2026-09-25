import { ReleaseChannel } from '@immich/sdk';
import { describe, expect, it } from 'vitest';
import { installedReleaseChannel } from './release-channel';

describe('installedReleaseChannel (FL-71)', () => {
  it('reads a pre-release version as a release candidate and any other as stable', () => {
    expect(installedReleaseChannel({ prerelease: 1 })).toBe(ReleaseChannel.ReleaseCandidate);
    expect(installedReleaseChannel({ prerelease: null })).toBe(ReleaseChannel.Stable);
  });

  it('is unknown until the server reports its version', () => {
    expect(installedReleaseChannel(undefined)).toBeUndefined();
  });
});
