import { describe, expect, it } from 'vitest';
import { AssetType } from 'src/enum.js';
import {
  conversionSourcesOf,
  convertedFileName,
  downloadConversionFor,
  downloadFormatFor,
  estimateDownloadSize,
} from 'src/utils/download-format.js';
import { authStub } from 'test/fixtures/auth.stub.js';

const photo = { type: AssetType.Image, width: 4000, height: 3000 };

describe('download formats (FL-826)', () => {
  it('takes the request, then the account default, never for a shared link, and web for a web-size link', () => {
    expect(downloadFormatFor(authStub.admin, undefined)).toBe('original');
    expect(downloadFormatFor(authStub.admin, undefined, 'jpeg')).toBe('jpeg');
    expect(downloadFormatFor(authStub.admin, 'web', 'jpeg')).toBe('web');
    expect(downloadFormatFor(authStub.adminSharedLink, undefined, 'jpeg')).toBe('original');
    const webOnly = { sharedLink: { ...authStub.adminSharedLink.sharedLink, webSizeOnly: true } };
    expect(downloadFormatFor(webOnly, 'original')).toBe('web');
    expect(downloadFormatFor(webOnly, 'jpeg')).toBe('web');
  });

  it('converts photos only, leaving a JPEG as it is when it already is what was asked for', () => {
    expect(downloadConversionFor(photo, '/a.heic', 'original')).toBeNull();
    expect(downloadConversionFor({ ...photo, type: AssetType.Video }, '/a.mov', 'web')).toBeNull();
    expect(downloadConversionFor(photo, '/a.heic', 'jpeg')).toEqual({ maxEdge: null });
    expect(downloadConversionFor(photo, '/a.CR3', 'jpeg')).toEqual({ maxEdge: null });
    expect(downloadConversionFor(photo, '/a.JPG', 'jpeg')).toBeNull();
    expect(downloadConversionFor(photo, '/a.jpg', 'web')).toEqual({ maxEdge: 2048 });
    expect(downloadConversionFor({ ...photo, width: 2048, height: 1365 }, '/a.jpeg', 'web')).toBeNull();
    // unknown dimensions: resized to be sure
    expect(downloadConversionFor({ ...photo, width: null, height: null }, '/a.jpg', 'web')).toEqual({
      maxEdge: 2048,
    });
  });

  it('names a converted file .jpg', () => {
    expect(convertedFileName('IMG_1.HEIC')).toBe('IMG_1.jpg');
    expect(convertedFileName('archive.v2.dng')).toBe('archive.v2.jpg');
  });

  it('estimates the size of what each format downloads', () => {
    const heic = { ...photo, originalFileName: 'a.heic', size: 2_500_000, fileSizeInByte: 2_000_000 };
    expect(estimateDownloadSize(heic, 'original')).toBe(2_500_000);
    expect(estimateDownloadSize({ ...heic, fullsizeSize: '3100000' }, 'jpeg')).toBe(3_100_000);
    expect(estimateDownloadSize(heic, 'jpeg')).toBe(Math.round(4000 * 3000 * 0.6));
    expect(estimateDownloadSize(heic, 'web')).toBe(Math.round(2048 * 1536 * 0.6));
    expect(estimateDownloadSize({ ...heic, width: null, height: null }, 'jpeg')).toBe(2_000_000);
    expect(estimateDownloadSize({ ...heic, width: null, height: null, fileSizeInByte: 500 }, 'web')).toBe(500);
    expect(estimateDownloadSize({ ...heic, type: AssetType.Video }, 'web')).toBe(2_500_000);
  });

  it('renders an edited photo only from edited pixels, and a RAW from its derived copies', () => {
    const files = {
      originalPath: '/o.heic',
      originalFileName: 'o.heic',
      fullsizePath: '/full.jpeg',
      previewPath: '/preview.jpeg',
      editedPreviewPath: '/edited-preview.jpeg',
    };
    expect(conversionSourcesOf(files)).toEqual(['/o.heic', '/full.jpeg', '/preview.jpeg']);
    expect(conversionSourcesOf({ ...files, shownEditedPath: '/edited.jpeg' })).toEqual([
      '/edited.jpeg',
      '/edited-preview.jpeg',
    ]);
    expect(conversionSourcesOf({ ...files, originalPath: '/o.nef', originalFileName: 'o.nef' })).toEqual([
      '/full.jpeg',
      '/preview.jpeg',
    ]);
  });
});
