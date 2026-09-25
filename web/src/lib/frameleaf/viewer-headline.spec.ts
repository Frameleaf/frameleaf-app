import { AssetTypeEnum, type AssetResponseDto } from '@immich/sdk';
import {
  cameraLabel,
  dimensionsLabel,
  exposureParts,
  folderOf,
  formatDuration,
  formatFileSize,
  frameRateLabel,
  megapixels,
  viewerHeadline,
  viewerHeadlineText,
} from '$lib/frameleaf/viewer-headline';
import { assetFactory } from '@test-data/factories/asset-factory';

const still = (overrides: Partial<AssetResponseDto> = {}): AssetResponseDto =>
  assetFactory.build({
    type: AssetTypeEnum.Image,
    duration: null,
    width: 6000,
    height: 4000,
    exifInfo: {
      make: 'Fujifilm',
      model: 'X-T5',
      lensModel: 'XF 23mm F1.4',
      fNumber: 1.4,
      exposureTime: '1/125',
      iso: 400,
      focalLength: 23,
      exifImageWidth: 6000,
      exifImageHeight: 4000,
      fileSizeInByte: 24_500_000,
    },
    ...overrides,
  });

describe('formatFileSize', () => {
  it('scales the unit with the size', () => {
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(24_500)).toBe('25 KB');
    expect(formatFileSize(24_500_000)).toBe('24.5 MB');
    expect(formatFileSize(2_400_000_000)).toBe('2.40 GB');
  });

  it('rejects missing and negative sizes', () => {
    expect(formatFileSize(null)).toBeNull();
    expect(formatFileSize(undefined)).toBeNull();
    expect(formatFileSize(-1)).toBeNull();
    expect(formatFileSize(NaN)).toBeNull();
  });
});

describe('megapixels', () => {
  it('keeps one decimal below ten and rounds above', () => {
    expect(megapixels(4000, 3000)).toBe('12 MP');
    expect(megapixels(3000, 2000)).toBe('6.0 MP');
  });

  it('rejects incomplete dimensions', () => {
    expect(megapixels(4000, null)).toBeNull();
    expect(megapixels(0, 100)).toBeNull();
  });
});

describe('formatDuration', () => {
  it('formats the asset DTO milliseconds', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(65_000)).toBe('1:05');
    expect(formatDuration(3_725_000)).toBe('1:02:05');
  });

  it('rejects a missing duration', () => {
    expect(formatDuration(null)).toBeNull();
    expect(formatDuration(-5)).toBeNull();
  });
});

describe('dimensionsLabel', () => {
  it('prefers the EXIF dimensions', () => {
    expect(dimensionsLabel(still())).toBe('6,000 × 4,000');
  });

  it('falls back to the asset dimensions', () => {
    expect(dimensionsLabel(still({ exifInfo: { fileSizeInByte: 10 } }))).toBe('6,000 × 4,000');
  });

  it('is null when nothing is known', () => {
    expect(dimensionsLabel(still({ width: null, height: null, exifInfo: {} }))).toBeNull();
  });
});

describe('cameraLabel', () => {
  it('joins make and model', () => {
    expect(cameraLabel({ make: 'Fujifilm', model: 'X-T5' })).toBe('Fujifilm X-T5');
    expect(cameraLabel({ model: 'X-T5' })).toBe('X-T5');
    expect(cameraLabel({})).toBeNull();
    expect(cameraLabel(undefined)).toBeNull();
  });
});

describe('exposureParts', () => {
  it('renders aperture, shutter, ISO and focal length', () => {
    expect(exposureParts(still().exifInfo)).toEqual(['ƒ/1.4', '1/125 s', 'ISO 400', '23 mm']);
  });

  it('does not double the seconds suffix', () => {
    expect(exposureParts({ exposureTime: '30 s' })).toEqual(['30 s']);
  });

  it('drops the parts it does not have', () => {
    expect(exposureParts({ iso: 100 })).toEqual(['ISO 100']);
    expect(exposureParts(undefined)).toEqual([]);
  });
});

describe('viewerHeadline', () => {
  it('orders a still as camera, lens, exposure, dimensions, size, as the template does (V-26)', () => {
    expect(viewerHeadline(still())).toEqual([
      'Fujifilm X-T5',
      'XF 23mm F1.4',
      'ƒ/1.4',
      '1/125 s',
      'ISO 400',
      '23 mm',
      '6,000 × 4,000',
      '24.5 MB',
    ]);
  });

  it('replaces the exposure of a video with its frame rate and duration (V-26)', () => {
    const headline = viewerHeadline(
      still({ type: AssetTypeEnum.Video, duration: 65_000, exifInfo: { ...still().exifInfo, fps: 29.97 } }),
    );
    expect(headline).not.toContain('ƒ/1.4');
    expect(headline).not.toContain('ISO 400');
    expect(headline).toContain('29.97 fps');
    expect(headline).toContain('1:05');
    expect(headline.indexOf('29.97 fps')).toBeLessThan(headline.indexOf('1:05'));
  });

  it('leaves out an unknown frame rate', () => {
    expect(frameRateLabel(null)).toBeNull();
    expect(frameRateLabel(0)).toBeNull();
    expect(frameRateLabel(60)).toBe('60 fps');
  });

  it('is empty when the asset carries no metadata at all', () => {
    expect(viewerHeadline(still({ width: null, height: null, exifInfo: undefined, duration: null }))).toEqual([]);
    expect(viewerHeadlineText(still({ width: null, height: null, exifInfo: undefined, duration: null }))).toBe('');
  });

  it('joins the parts with a middle dot', () => {
    expect(
      viewerHeadlineText(still({ exifInfo: { make: 'Fujifilm', model: 'X-T5' }, width: null, height: null })),
    ).toBe('Fujifilm X-T5');
  });
});

describe('folderOf', () => {
  it('returns the containing directory of an original path', () => {
    expect(folderOf('/library/taylor/2026/09/IMG_0001.jpg')).toBe('/library/taylor/2026/09');
    expect(folderOf('/IMG_0001.jpg')).toBe('/');
  });

  it('is null without a directory', () => {
    expect(folderOf('IMG_0001.jpg')).toBeNull();
    expect(folderOf(null)).toBeNull();
    expect(folderOf(undefined)).toBeNull();
  });
});
