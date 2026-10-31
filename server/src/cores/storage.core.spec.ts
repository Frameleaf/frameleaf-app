import { vitest } from 'vitest';
import { StorageCore } from 'src/cores/storage.core.js';

vitest.mock('src/constants', () => ({
  IWorker: 'IWorker',
}));

describe('StorageCore', () => {
  describe('isImmichPath', () => {
    beforeAll(() => {
      StorageCore.setMediaLocation('/photos');
    });

    it('should return true for APP_MEDIA_LOCATION path', () => {
      const immichPath = '/photos';
      expect(StorageCore.isImmichPath(immichPath)).toBe(true);
    });

    it('should return true for paths within the APP_MEDIA_LOCATION', () => {
      const immichPath = '/photos/new/';
      expect(StorageCore.isImmichPath(immichPath)).toBe(true);
    });

    it('should return false for paths outside the APP_MEDIA_LOCATION and same starts', () => {
      const nonImmichPath = '/photos_new';
      expect(StorageCore.isImmichPath(nonImmichPath)).toBe(false);
    });

    it('should return false for paths outside the APP_MEDIA_LOCATION', () => {
      const nonImmichPath = '/some/other/path';
      expect(StorageCore.isImmichPath(nonImmichPath)).toBe(false);
    });
  });
});

describe('motion video storage boundary', () => {
  beforeEach(() => StorageCore.setMediaLocation('/photos'));
  it.each([
    ['/photos/encoded-video/owner/video.mp4', true],
    ['/photos/encoded-video-other/video.mp4', false],
    ['/photos/encoded-video2/video.mp4', false],
    ['/photos/library/video.mp4', false],
  ] as const)('classifies %s as generated motion storage: %s', (path, expected) => {
    expect(StorageCore.isAndroidMotionPath(path)).toBe(expected);
  });
});
