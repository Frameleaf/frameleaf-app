import { ReleaseChannel } from '@frameleaf/sdk';
import { describe, expect, it } from 'vitest';
import { installedReleaseChannel } from './release-channel';

describe('installedReleaseChannel (FL-71)', () => {
  it.each(['beta', 'rc', 'dev.local'])(
    'recognizes named prerelease %s without a numeric component',
    (prereleaseName) => {
      expect(installedReleaseChannel({ prerelease: null, prereleaseName })).toBe(ReleaseChannel.ReleaseCandidate);
    },
  );

  it('reads a pre-release version as a release candidate and any other as stable', () => {
    expect(installedReleaseChannel({ prerelease: 1 })).toBe(ReleaseChannel.ReleaseCandidate);
    expect(installedReleaseChannel({ prerelease: null })).toBe(ReleaseChannel.Stable);
  });

  it('is unknown until the server reports its version', () => {
    expect(installedReleaseChannel(undefined)).toBeUndefined();
  });
});
