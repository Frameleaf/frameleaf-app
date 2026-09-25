import { SemVer } from 'semver';
import { ServerVersionResponseDto } from 'src/dtos/server.dto.js';

describe('ServerVersionResponseDto.fromSemVer (FL-80)', () => {
  it('keeps a stable version as before', () => {
    expect(ServerVersionResponseDto.fromSemVer(new SemVer('3.2.1'))).toEqual({
      major: 3,
      minor: 2,
      patch: 1,
      prerelease: null,
    });
  });

  it.each([
    ['3.3.0-rc.1', 1, 'rc.1'],
    ['3.3.0-beta.2', 2, 'beta.2'],
    ['3.3.0-alpha', null, 'alpha'],
  ])('carries the full pre-release identifier of %s', (version, prerelease, prereleaseName) => {
    expect(ServerVersionResponseDto.fromSemVer(new SemVer(version))).toEqual({
      major: 3,
      minor: 3,
      patch: 0,
      prerelease,
      prereleaseName,
    });
  });
});
