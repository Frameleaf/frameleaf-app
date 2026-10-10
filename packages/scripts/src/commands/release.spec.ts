import { describe, expect, it } from 'vitest';
import { getNewVersion, ReleaseError } from './release';

describe(getNewVersion.name, () => {
  describe('transitions', () => {
    const valid = [
      {
        name: 'patch',
        items: [['patch', '2.7.5', '2.7.6']],
      },
      {
        name: 'prepatch',
        items: [
          ['prepatch', '2.7.5', '2.7.6-rc.0'],
          ['prerelease', '2.7.6-rc.0', '2.7.6-rc.1'],
          ['release', '2.7.6-rc.1', '2.7.6'],
        ],
      },
      {
        name: 'minor',
        items: [['minor', '2.7.5', '2.8.0']],
      },
      {
        name: 'preminor',
        items: [
          ['preminor', '2.7.5', '2.8.0-rc.0'],
          ['prerelease', '2.8.0-rc.0', '2.8.0-rc.1'],
          ['release', '2.8.0-rc.1', '2.8.0'],
        ],
      },
      {
        name: 'cutting the next line while on a prerelease',
        items: [
          ['preminor', '3.3.0-rc.0', '3.4.0-rc.0'],
          ['premajor', '3.3.0-rc.0', '4.0.0-rc.0'],
        ],
      },
      {
        name: 'premajor',
        items: [
          ['premajor', '2.7.5', '3.0.0-rc.0'],
          ['prerelease', '3.0.0-rc.0', '3.0.0-rc.1'],
          ['release', '3.0.0-rc.1', '3.0.0'],
        ],
      },
    ];

    for (const group of valid) {
      describe(group.name, () => {
        it.each(group.items)(
          'should allow a $0 from $1 to $2',
          (type, version, next) => {
            expect(getNewVersion(version, type)).toEqual(next);
          },
        );
      });
    }

    describe('invalid', () => {
      it.each([
        ['patch', 'v3.0.0-rc.0'],
        ['prepatch', 'v3.0.0-rc.0'],
        ['minor', 'v3.0.0-rc.0'],
        ['prerelease', 'v3.0.0'],
        ['release', 'v3.0.0'],
      ])('should not allow a $0 on $1', (type, version) => {
        expect(() => getNewVersion(version, type)).toThrow(ReleaseError);
      });
    });
  });
});
