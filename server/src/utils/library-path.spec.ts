import { mapAsset } from 'src/dtos/asset-response.dto.js';
import { displayPath, isInOwnerFolder, ownLibraryPath } from 'src/utils/library-path.js';
import { AssetFactory } from 'test/factories/asset.factory.js';

const alice = { id: '11111111-1111-4111-8111-111111111111', storageLabel: 'alice' };
const bob = { id: '22222222-2222-4222-8222-222222222222', storageLabel: 'bob' };
const photo = {
  id: 'abcdef00-0000-4000-8000-000000000000',
  originalFileName: 'Beach.jpg',
  localDateTime: new Date('2023-07-14T10:30:00.000Z'),
};

describe('FL-417 library path', () => {
  describe(isInOwnerFolder.name, () => {
    it.each([
      [`/data/library/alice/2023/a.jpg`, alice, true],
      [`/data/library/${alice.id}/2023/a.jpg`, alice, true],
      [`/data/upload/${alice.id}/ab/cd/a.jpg`, alice, true],
      [`/data/upload/alice/ab/cd/a.jpg`, alice, false],
      [`/data/library/alice/2023/a.jpg`, bob, false],
      [`/data/upload/${alice.id}/ab/cd/a.jpg`, bob, false],
      ['/elsewhere/a.jpg', alice, false],
    ])('%s for %o is %s', (path, owner, expected) => {
      expect(isInOwnerFolder(path, owner)).toBe(expected);
    });
  });

  describe(ownLibraryPath.name, () => {
    it('builds a library path from the owner’s own label, date and name, never the other account’s', () => {
      const path = ownLibraryPath({ ...photo, originalPath: '/data/library/alice/Holidays/IMG_1.jpg' }, bob);
      expect(path).toBe('/data/library/bob/2023/2023-07-14/Beach.jpg');
      expect(path).not.toContain('alice');
      expect(path).not.toContain('Holidays');
    });

    it('uses the owner id when there is no storage label', () => {
      expect(
        ownLibraryPath({ ...photo, originalPath: '/data/library/alice/x.jpg' }, { id: bob.id, storageLabel: null }),
      ).toBe(`/data/library/${bob.id}/2023/2023-07-14/Beach.jpg`);
    });

    it('builds an upload path from the owner and the photo’s own id beside an upload', () => {
      expect(ownLibraryPath({ ...photo, originalPath: `/data/upload/${alice.id}/12/34/other.HEIC` }, bob)).toBe(
        `/data/upload/${bob.id}/ab/cd/${photo.id}.HEIC`,
      );
    });

    it('never lets a file name add folders', () => {
      expect(
        ownLibraryPath({ ...photo, originalFileName: '../a/b.jpg', originalPath: '/data/library/alice/x.jpg' }, bob),
      ).toBe('/data/library/bob/2023/2023-07-14/.._a_b.jpg');
    });
  });

  describe('the asset response', () => {
    it('shows the photo’s own path while it shares a file kept in another folder', () => {
      const asset = AssetFactory.from({
        originalPath: '/data/library/alice/Holidays/IMG_1.jpg',
        libraryPath: '/data/upload/bob/ab/cd/own.jpg',
      }).build();
      expect(displayPath(asset)).toBe('/data/upload/bob/ab/cd/own.jpg');
      expect(mapAsset(asset as never).originalPath).toBe('/data/upload/bob/ab/cd/own.jpg');
      expect(JSON.stringify(mapAsset(asset as never))).not.toContain('alice');
    });

    it('shows the original path when it is the photo’s own', () => {
      const asset = AssetFactory.from({ originalPath: '/data/library/bob/own.jpg' }).build();
      expect(mapAsset(asset as never).originalPath).toBe('/data/library/bob/own.jpg');
    });
  });
});
