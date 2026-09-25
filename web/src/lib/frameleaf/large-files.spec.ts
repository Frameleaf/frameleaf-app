import { AssetTypeEnum, type AssetResponseDto } from '@immich/sdk';
import { describe, expect, it } from 'vitest';
import {
  canTrashLargeFile,
  filterLargeFiles,
  LARGE_FILES_ALL_ACCOUNTS,
  largeFileExport,
  largeFileFormat,
  largeFileOwners,
  largeFileStatus,
} from '$lib/frameleaf/large-files';

const asset = (id: string, ownerId: string, bytes: number | null, name = `${id}.mov`) =>
  ({
    id,
    ownerId,
    originalFileName: name,
    exifInfo: bytes === null ? undefined : { fileSizeInByte: bytes },
  }) as AssetResponseDto;

const me = 'user-1';
const partner = 'user-2';

describe('large files (FL-47)', () => {
  const assets = [
    asset('small', me, 10),
    asset('huge', me, 5000, 'Lake morning.mov'),
    asset('shared', partner, 3000),
    asset('unknown', me, null),
  ];
  const describeRow = (row: AssetResponseDto) => (row.ownerId === me ? 'Taylor' : 'Jamie');

  it('should list the largest originals first', () => {
    const context = { userId: me, trashed: new Set<string>() };
    const rows = filterLargeFiles(assets, context, {
      owner: LARGE_FILES_ALL_ACCOUNTS,
      show: 'open',
      query: '',
      describe: describeRow,
    });
    expect(rows.map(({ id }) => id)).toEqual(['huge', 'shared', 'small', 'unknown']);
  });

  it('should hide what went to the trash unless all results are shown', () => {
    const context = { userId: me, trashed: new Set(['huge']) };
    const filters = { owner: LARGE_FILES_ALL_ACCOUNTS, query: '', describe: describeRow };
    expect(filterLargeFiles(assets, context, { ...filters, show: 'open' }).map(({ id }) => id)).not.toContain('huge');
    expect(filterLargeFiles(assets, context, { ...filters, show: 'all' }).map(({ id }) => id)).toContain('huge');
  });

  it('should filter by account and by file name or owner words', () => {
    const context = { userId: me, trashed: new Set<string>() };
    expect(
      filterLargeFiles(assets, context, { owner: partner, show: 'open', query: '', describe: describeRow }).map(
        ({ id }) => id,
      ),
    ).toEqual(['shared']);
    expect(
      filterLargeFiles(assets, context, {
        owner: LARGE_FILES_ALL_ACCOUNTS,
        show: 'open',
        query: 'lake taylor',
        describe: describeRow,
      }).map(({ id }) => id),
    ).toEqual(['huge']);
  });

  it("should only let the owner move their own items, and never a partner's", () => {
    const context = { userId: me, trashed: new Set(['small']) };
    expect(largeFileStatus(assets[1], context)).toBe('open');
    expect(largeFileStatus(assets[2], context)).toBe('shared');
    expect(largeFileStatus(assets[0], context)).toBe('trashed');
    expect(canTrashLargeFile(assets[1], context)).toBe(true);
    expect(canTrashLargeFile(assets[2], context)).toBe(false);
    expect(canTrashLargeFile(assets[0], context)).toBe(false);
  });

  it('should offer the signed-in account first', () => {
    expect(largeFileOwners(assets, me)).toEqual([me, partner]);
  });

  it('should export names, owners and sizes only', () => {
    expect(largeFileExport([assets[1]], { owner: LARGE_FILES_ALL_ACCOUNTS, ownerName: () => 'Taylor' })).toEqual({
      scope: 'all',
      items: [{ id: 'huge', name: 'Lake morning.mov', owner: 'Taylor', bytes: 5000 }],
    });
  });
});

describe('largeFileFormat (UT-15)', () => {
  const original = (
    originalFileName: string,
    type: AssetTypeEnum,
    width?: number,
    height?: number,
    originalMimeType?: string,
  ) =>
    ({
      originalFileName,
      originalMimeType,
      type,
      exifInfo: width === undefined ? undefined : { exifImageWidth: width, exifImageHeight: height },
    }) as AssetResponseDto;

  it('names a video by its type and resolution, portrait or landscape', () => {
    expect(largeFileFormat(original('Lake morning.mov', AssetTypeEnum.Video, 3840, 2160))).toEqual({
      type: 'MOV',
      videoResolution: '4K',
    });
    expect(largeFileFormat(original('Camp.mp4', AssetTypeEnum.Video, 1080, 1920))).toEqual({
      type: 'MP4',
      videoResolution: '1080p',
    });
    expect(largeFileFormat(original('Drone.mp4', AssetTypeEnum.Video, 7680, 4320))).toEqual({
      type: 'MP4',
      videoResolution: '8K',
    });
  });

  it('names a photo by its type and whole megapixels', () => {
    expect(largeFileFormat(original('Summit panorama.tif', AssetTypeEnum.Image, 8000, 6000))).toEqual({
      type: 'TIF',
      megapixels: 48,
    });
  });

  it('leaves out what is unknown, using the media type when the name has no extension', () => {
    expect(largeFileFormat(original('scan', AssetTypeEnum.Image, undefined, undefined, 'image/heic'))).toEqual({
      type: 'HEIC',
    });
    expect(largeFileFormat(original('tiny.png', AssetTypeEnum.Image, 10, 10))).toEqual({ type: 'PNG' });
    expect(largeFileFormat(original('noext', AssetTypeEnum.Other))).toEqual({ type: undefined });
  });
});
