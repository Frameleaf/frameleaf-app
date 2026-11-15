import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { AssetResponseDto } from 'src/dtos/asset-response.dto.js';
import { ExifResponseSchema } from 'src/dtos/exif.dto.js';
import { AssetType, AssetVisibility } from 'src/enum.js';
import { DUPLICATE_KEEP_RULES } from 'src/utils/duplicate-keep-rules.js';
import {
  DEFAULT_DUPLICATE_KEEP_RULES,
  getExifCount,
  getFormatRank,
  resolveKeepRules,
  suggestDuplicate,
  suggestDuplicateKeepAssetIds,
} from 'src/utils/duplicate.js';

type ExifInfoInput = Partial<z.infer<typeof ExifResponseSchema>>;

const createAsset = (
  id: string,
  fileSizeInByte: number | null = null,
  exifFields: ExifInfoInput = {},
  originalFileName = 'asset.jpg',
): AssetResponseDto => ({
  id,
  type: AssetType.Image,
  thumbhash: null,
  localDateTime: new Date().toISOString(),
  duration: 0,
  hasMetadata: true,
  width: 1920,
  height: 1080,
  createdAt: new Date().toISOString(),
  ownerId: 'owner-1',
  originalPath: '/path/to/asset',
  originalFileName,
  fileCreatedAt: new Date().toISOString(),
  fileModifiedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  isFavorite: false,
  isArchived: false,
  isTrashed: false,
  isOffline: false,
  isEdited: false,
  visibility: AssetVisibility.Timeline,
  checksum: 'checksum',
  exifInfo:
    fileSizeInByte !== null || Object.keys(exifFields).length > 0
      ? ExifResponseSchema.parse({ fileSizeInByte, ...exifFields })
      : undefined,
});

const heic = (id: string, size: number) => createAsset(id, size, {}, `${id}.heic`);
const jpg = (id: string, size: number) => createAsset(id, size, {}, `${id}.jpg`);
const raw = (id: string, size: number) => createAsset(id, size, {}, `${id}.dng`);

describe('duplicate utils', () => {
  describe('getExifCount', () => {
    it('should return 0 for asset without exifInfo', () => {
      const asset = createAsset('asset-1');
      asset.exifInfo = undefined;
      expect(getExifCount(asset)).toBe(0);
    });

    it('should return 0 for empty exifInfo', () => {
      const asset = createAsset('asset-1');
      asset.exifInfo = ExifResponseSchema.parse({});
      expect(getExifCount(asset)).toBe(0);
    });

    it('should count all truthy values in exifInfo', () => {
      const asset = createAsset('asset-1', 1000, {
        make: 'Canon',
        model: 'EOS 5D',
        dateTimeOriginal: new Date().toISOString(),
        timeZone: 'UTC',
        latitude: 40.7128,
        longitude: -74.006,
        city: 'New York',
        state: 'NY',
        country: 'USA',
        description: 'A photo',
        rating: 5,
      });
      // fileSizeInByte (1000) + 11 other truthy fields = 12
      expect(getExifCount(asset)).toBe(12);
    });

    it('counts own enumerable EXIF values without converting or changing them', () => {
      const exif = Object.assign(Object.create({ inherited: 'ignored' }), {
        zero: 0,
        negativeZero: -0,
        notANumber: NaN,
        empty: '',
        missing: undefined,
        disabled: false,
        negative: -1,
        text: '0',
        list: [],
        object: {},
      });
      Object.defineProperties(exif, {
        hidden: { value: 'ignored' },
        [Symbol('ignored')]: { value: 'ignored', enumerable: true },
      });
      const asset = { ...createAsset('mixed'), exifInfo: exif };
      expect(getExifCount(asset)).toBe(4);
      expect(asset.exifInfo).toBe(exif);
      expect(Object.is(exif.negativeZero, -0)).toBe(true);
    });

    it('should not count null or undefined values', () => {
      const asset = createAsset('asset-1', 1000, {
        make: 'Canon',
        model: null,
        latitude: undefined,
        city: '',
        rating: null,
      });
      // fileSizeInByte (1000) + make ('Canon') = 2 truthy values
      // model (null), latitude (undefined), city (''), rating (0) are all falsy
      expect(getExifCount(asset)).toBe(2);
    });
  });

  describe('suggestDuplicate', () => {
    it('keeps the first tied asset reference without changing the input order', () => {
      const first = jpg('same', 1000);
      const second = jpg('same', 1000);
      const inputs = [first, jpg('smaller', 500), second];

      expect(suggestDuplicate(inputs)).toBe(first);
      expect(inputs[0]).toBe(first);
      expect(inputs[1].id).toBe('smaller');
      expect(inputs[2]).toBe(second);
    });

    it('ranks candidates in a linear number of format reads', () => {
      let formatReads = 0;
      const assets = Array.from({ length: 128 }, (_, index) => {
        const asset = jpg(`asset-${index}`, (index * 73) % 128);
        Object.defineProperty(asset, 'originalFileName', {
          get: () => {
            formatReads++;
            return 'asset.jpg';
          },
        });
        return asset;
      });

      expect(suggestDuplicate(assets)?.id).toBe('asset-7');
      expect(formatReads).toBeLessThanOrEqual(assets.length * 2);
    });

    it('should return undefined for empty list', () => {
      expect(suggestDuplicate([])).toBeUndefined();
    });

    it('should return the single asset for list with one asset', () => {
      const asset = createAsset('asset-1', 1000);
      expect(suggestDuplicate([asset])).toEqual(asset);
    });

    it('should return asset with largest file size', () => {
      const small = createAsset('small', 1000);
      const large = createAsset('large', 5000);
      const medium = createAsset('medium', 3000);

      expect(suggestDuplicate([small, large, medium])?.id).toBe('large');
      expect(suggestDuplicate([large, small, medium])?.id).toBe('large');
      expect(suggestDuplicate([medium, small, large])?.id).toBe('large');
    });

    it('should use EXIF count as tie-breaker when file sizes are equal', () => {
      const lessExif = createAsset('less-exif', 1000, { make: 'Canon' });
      const moreExif = createAsset('more-exif', 1000, {
        make: 'Canon',
        model: 'EOS 5D',
        dateTimeOriginal: new Date().toISOString(),
        city: 'New York',
      });

      expect(suggestDuplicate([lessExif, moreExif])?.id).toBe('more-exif');
      expect(suggestDuplicate([moreExif, lessExif])?.id).toBe('more-exif');
    });

    it('should handle assets with no exifInfo (treat as 0 file size)', () => {
      const noExif = createAsset('no-exif');
      noExif.exifInfo = undefined;
      const withExif = createAsset('with-exif', 1000);

      expect(suggestDuplicate([noExif, withExif])?.id).toBe('with-exif');
    });

    it('should handle assets with exifInfo but no fileSizeInByte', () => {
      const noFileSize = createAsset('no-file-size');
      noFileSize.exifInfo = ExifResponseSchema.parse({ make: 'Canon', model: 'EOS 5D' });
      const withFileSize = createAsset('with-file-size', 1000);

      expect(suggestDuplicate([noFileSize, withFileSize])?.id).toBe('with-file-size');
    });

    it('should return last asset when all have same file size and EXIF count', () => {
      const asset1 = createAsset('asset-1', 1000, { make: 'Canon' });
      const asset2 = createAsset('asset-2', 1000, { make: 'Nikon' });

      // Both have same file size (1000) and same EXIF count (2: fileSizeInByte + make)
      // Should return the last one in the sorted array
      const result = suggestDuplicate([asset1, asset2]);
      // Since they're equal, the last one after sorting should be returned
      expect(result).toBeDefined();
      expect(['asset-1', 'asset-2']).toContain(result?.id);
    });

    it('should prioritize file size over EXIF count', () => {
      const largeWithLessExif = createAsset('large-less-exif', 5000, { make: 'Canon' });
      const smallWithMoreExif = createAsset('small-more-exif', 1000, {
        make: 'Canon',
        model: 'EOS 5D',
        dateTimeOriginal: new Date().toISOString(),
        city: 'New York',
        state: 'NY',
        country: 'USA',
      });

      expect(suggestDuplicate([largeWithLessExif, smallWithMoreExif])?.id).toBe('large-less-exif');
    });
  });

  describe('suggestDuplicate with preferOriginalFormat', () => {
    it('should prefer a HEIC over a larger JPG when enabled', () => {
      const largeJpg = jpg('large-jpg', 9000);
      const smallHeic = heic('small-heic', 1000);

      expect(suggestDuplicate([largeJpg, smallHeic], { preferOriginalFormat: true })?.id).toBe('small-heic');
    });

    it('should prefer RAW over HEIC and JPG when enabled', () => {
      const dng = raw('raw-dng', 1000);
      const heicAsset = heic('heic', 8000);
      const jpgAsset = jpg('jpg', 9000);

      expect(suggestDuplicate([jpgAsset, heicAsset, dng], { preferOriginalFormat: true })?.id).toBe('raw-dng');
    });

    it('should fall back to file size among assets of the same format tier', () => {
      const smallHeic = heic('small-heic', 1000);
      const largeHeic = heic('large-heic', 5000);
      const jpgAsset = jpg('jpg', 9000);

      expect(suggestDuplicate([smallHeic, largeHeic, jpgAsset], { preferOriginalFormat: true })?.id).toBe('large-heic');
    });

    it('should retain HEIC even when the legacy setting is disabled', () => {
      const largeJpg = jpg('large-jpg', 9000);
      const smallHeic = heic('small-heic', 1000);

      expect(suggestDuplicate([largeJpg, smallHeic], { preferOriginalFormat: false })?.id).toBe('small-heic');
      expect(suggestDuplicate([largeJpg, smallHeic])?.id).toBe('small-heic');
    });

    it.each(['HEIC', 'heif', 'HIF'])('prefers %s with missing file size over a larger JPEG', (extension) => {
      const original = createAsset('original', null, {}, `IMG_1.${extension}`);
      expect(suggestDuplicate([jpg('large-jpg', 9000), original])?.id).toBe('original');
    });

    it('retains RAW before HEIC without caller options', () => {
      expect(suggestDuplicate([heic('large-heic', 9000), raw('small-raw', 1000)])?.id).toBe('small-raw');
    });

    it('has a stable tie-breaker independent of group order', () => {
      const a = jpg('a', 1000);
      const b = jpg('b', 1000);
      expect(suggestDuplicate([a, b])?.id).toBe('a');
      expect(suggestDuplicate([b, a])?.id).toBe('a');
    });

    it('should pass options through suggestDuplicateKeepAssetIds', () => {
      const largeJpg = jpg('large-jpg', 9000);
      const smallHeic = heic('small-heic', 1000);

      expect(suggestDuplicateKeepAssetIds([largeJpg, smallHeic], { preferOriginalFormat: true })).toEqual([
        'small-heic',
      ]);
    });
  });

  describe('suggestDuplicateKeepAssetIds', () => {
    it('should return empty array for empty list', () => {
      expect(suggestDuplicateKeepAssetIds([])).toEqual([]);
    });

    it('should return array with single asset ID', () => {
      const asset = createAsset('asset-1', 1000);
      expect(suggestDuplicateKeepAssetIds([asset])).toEqual(['asset-1']);
    });

    it('should return array with best asset ID', () => {
      const small = createAsset('small', 1000);
      const large = createAsset('large', 5000);

      expect(suggestDuplicateKeepAssetIds([small, large])).toEqual(['large']);
    });
  });
  describe('FL-832 keep rules', () => {
    /** The keeper choice exactly as it was before keep rules existed. */
    const legacySuggest = (assets: AssetResponseDto[]) => {
      let best: AssetResponseDto | undefined;
      for (const asset of assets) {
        if (best === undefined) {
          best = asset;
          continue;
        }
        const comparison =
          getFormatRank(best) - getFormatRank(asset) ||
          (best.exifInfo?.fileSizeInByte ?? 0) - (asset.exifInfo?.fileSizeInByte ?? 0) ||
          getExifCount(best) - getExifCount(asset) ||
          (asset.id < best.id ? -1 : asset.id > best.id ? 1 : 0);
        if (comparison < 0) {
          best = asset;
        }
      }
      return best;
    };

    /** Deterministic pseudo-random numbers, so the matrix is the same on every run. */
    const random = (() => {
      let seed = 832;
      return () => {
        seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
        return seed / 2_147_483_648;
      };
    })();
    const pick = <T>(values: readonly T[]) => values[Math.floor(random() * values.length)];

    it('suggests exactly what it did before when no rules are set', () => {
      const names = ['a.jpg', 'b.JPG', 'c.heic', 'd.HEIF', 'e.hif', 'f.dng', 'g.CR3', 'h.png', 'i'];
      const sizes = [null, 0, 1000, 1000, 5000, 9000];
      const details = [{}, { make: 'Canon' }, { make: 'Canon', model: 'R5' }, { city: 'Oslo', rating: 5 }];
      for (let group = 0; group < 2000; group++) {
        const assets = Array.from({ length: 2 + Math.floor(random() * 4) }, () =>
          createAsset(`id-${Math.floor(random() * 6)}`, pick(sizes), pick(details), pick(names)),
        );
        const expected = legacySuggest(assets);
        expect(suggestDuplicate(assets)).toBe(expected);
        expect(suggestDuplicate(assets, { rules: [] })).toBe(expected);
        expect(suggestDuplicate(assets, { rules: [...DEFAULT_DUPLICATE_KEEP_RULES] })).toBe(expected);
      }
    });

    it('applies the owner rules first, then the default order, without repeats or unknown values', () => {
      expect(resolveKeepRules()).toEqual(['raw', 'heic', 'largest', 'mostMetadata']);
      expect(resolveKeepRules(['favorite', 'favorite', 'nope', 'largest'])).toEqual([
        'favorite',
        'largest',
        'raw',
        'heic',
        'mostMetadata',
      ]);
      expect(new Set(resolveKeepRules([...DUPLICATE_KEEP_RULES])).size).toBe(DUPLICATE_KEEP_RULES.length);
    });

    it('raw prefers a RAW original', () => {
      expect(suggestDuplicate([jpg('big', 9000), raw('small', 10)], { rules: ['raw'] })?.id).toBe('small');
    });

    it('heic prefers a HEIC original, even over RAW when listed first', () => {
      expect(suggestDuplicate([raw('raw', 9000), heic('heic', 10)], { rules: ['heic'] })?.id).toBe('heic');
    });

    it('largest prefers the biggest file, even over RAW when listed first', () => {
      expect(suggestDuplicate([raw('raw', 1000), jpg('jpg', 9000)], { rules: ['largest'] })?.id).toBe('jpg');
    });

    it('highestResolution prefers the most pixels, from the asset or its EXIF', () => {
      const small = { ...jpg('small', 9000), width: 1000, height: 1000 };
      const big = { ...jpg('big', 10), width: 4000, height: 3000 };
      expect(suggestDuplicate([small, big], { rules: ['highestResolution'] })?.id).toBe('big');

      const exifOnly = {
        ...createAsset('exif', 10, { exifImageWidth: 6000, exifImageHeight: 4000 }),
        width: null,
        height: null,
      };
      const unknown = { ...jpg('unknown', 9000), width: null, height: null };
      expect(suggestDuplicate([small, exifOnly, unknown], { rules: ['highestResolution'] })?.id).toBe('exif');
      // an unknown size never wins
      expect(suggestDuplicate([unknown, small], { rules: ['highestResolution'] })?.id).toBe('small');
    });

    it('oldest and newest compare when the photo was taken, else when the file was created', () => {
      const early = createAsset('b-early', 10, { dateTimeOriginal: '2020-01-01T00:00:00.000Z' });
      const late = { ...jpg('a-late', 9000), fileCreatedAt: '2024-01-01T00:00:00.000Z' };
      expect(suggestDuplicate([late, early], { rules: ['oldest'] })?.id).toBe('b-early');
      expect(suggestDuplicate([early, late], { rules: ['newest'] })?.id).toBe('a-late');

      const undated = { ...jpg('undated', 1), fileCreatedAt: 'not a date' };
      expect(suggestDuplicate([undated, late], { rules: ['oldest'] })?.id).toBe('a-late');
      expect(suggestDuplicate([undated, late], { rules: ['newest'] })?.id).toBe('a-late');
    });

    it('falls back to when the file was created when the capture date does not parse', () => {
      const early = createAsset('b-early', 10, { dateTimeOriginal: '2020-01-01T00:00:00.000Z' });
      const badExif = {
        ...createAsset('a-bad-exif', 10, { dateTimeOriginal: 'not a date' }),
        fileCreatedAt: '2024-01-01T00:00:00.000Z',
      };
      expect(suggestDuplicate([early, badExif], { rules: ['newest'] })?.id).toBe('a-bad-exif');
      expect(suggestDuplicate([badExif, early], { rules: ['oldest'] })?.id).toBe('b-early');
    });

    it('inAlbum prefers a copy in one of the owner albums', () => {
      const assets = [raw('raw', 9000), jpg('jpg', 10)];
      expect(suggestDuplicate(assets, { rules: ['inAlbum'], inAlbumIds: new Set(['jpg']) })?.id).toBe('jpg');
      // nothing known about albums: the default order decides
      expect(suggestDuplicate(assets, { rules: ['inAlbum'] })?.id).toBe('raw');
    });

    it('hasEdits prefers an edited copy or one with develop history', () => {
      const assets = [raw('raw', 9000), jpg('jpg', 10)];
      expect(suggestDuplicate(assets, { rules: ['hasEdits'], editedIds: new Set(['jpg']) })?.id).toBe('jpg');
      expect(suggestDuplicate([assets[0], { ...assets[1], isEdited: true }], { rules: ['hasEdits'] })?.id).toBe('jpg');
    });

    it('favorite prefers a favourite', () => {
      expect(
        suggestDuplicate([raw('raw', 9000), { ...jpg('jpg', 10), isFavorite: true }], { rules: ['favorite'] })?.id,
      ).toBe('jpg');
    });

    it('mostMetadata prefers the most details, even over size when listed first', () => {
      const detailed = createAsset('detailed', 10, { make: 'Canon', model: 'R5', city: 'Oslo' });
      expect(suggestDuplicate([jpg('big', 9000), detailed], { rules: ['mostMetadata'] })?.id).toBe('detailed');
    });

    it('a tie on one rule goes to the next, then the default order, then the lowest id', () => {
      const favoriteJpg = { ...jpg('b-jpg', 9000), isFavorite: true };
      const favoriteRaw = { ...raw('c-raw', 10), isFavorite: true };
      const plain = jpg('a-plain', 99_999);
      // favourite ties, largest decides
      expect(suggestDuplicate([plain, favoriteRaw, favoriteJpg], { rules: ['favorite', 'largest'] })?.id).toBe('b-jpg');
      // favourite ties, the default order (RAW first) decides
      expect(suggestDuplicate([plain, favoriteJpg, favoriteRaw], { rules: ['favorite'] })?.id).toBe('c-raw');
      // everything ties: the lowest id
      expect(suggestDuplicate([jpg('z', 10), jpg('m', 10)], { rules: ['favorite', 'hasEdits', 'inAlbum'] })?.id).toBe(
        'm',
      );
    });
  });
});
