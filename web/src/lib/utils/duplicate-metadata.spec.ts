import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import {
  computeDifferingMetadataFields,
  countDifferingMetadataItems,
  getAllMetadataItems,
  metadataKeys,
  type MetadataFieldKey,
} from '$lib/utils/duplicate-utils';
import { assetFactory } from '@test-data/factories/asset-factory';

const date = '2026-01-02T03:04:05.000Z';
const base = assetFactory.build({
  originalFileName: 'photo.jpg',
  originalPath: '/library/photo.jpg',
  fileCreatedAt: date,
  fileModifiedAt: date,
  localDateTime: date,
  width: 4000,
  height: 3000,
  exifInfo: {},
});
const translate = ((key: string) => key) as Parameters<typeof getAllMetadataItems>[1];
const withExif = (exifInfo: typeof base.exifInfo) => ({ ...base, exifInfo });
const item = (asset: typeof base, key: MetadataFieldKey, locale = 'en') =>
  getAllMetadataItems(asset, translate, locale).find((row) => row.keys.includes(key as never))!;

describe('duplicate metadata contracts', () => {
  it('keeps all comparison keys and the complete display row order', () => {
    expect(metadataKeys).toEqual([
      'originalFileName',
      'originalPath',
      'fileSize',
      'resolution',
      'fileCreatedAt',
      'fileModifiedAt',
      'dateTimeOriginal',
      'timeZone',
      'modifyDate',
      'city',
      'state',
      'country',
      'latitude',
      'longitude',
      'make',
      'model',
      'lensModel',
      'fNumber',
      'focalLength',
      'iso',
      'exposureTime',
      'description',
      'rating',
      'orientation',
      'projectionType',
    ]);
    const rows = getAllMetadataItems(base, translate, 'en');
    expect(rows.map(({ title }) => title)).toEqual([
      'file_name_text',
      'path',
      'file_size',
      'resolution',
      'created_at',
      'updated_at',
      'date_time_original',
      'timezone',
      'modify_date',
      'location',
      'gps',
      'make',
      'model',
      'lens_model',
      'f_number',
      'focal_length',
      'iso',
      'exposure_time',
      'description',
      'rating',
      'orientation',
      'projection_type',
    ]);
    const again = getAllMetadataItems(base, translate, 'fr');
    for (const [index, row] of rows.entries()) {
      expect(Object.keys(row)).toEqual(['icon', 'title', 'render', 'tooltip', 'keys']);
      expect(row.icon).toBeTruthy();
      expect(row.keys).toBe(again[index].keys);
    }
  });

  it('returns every flag for empty and single-asset groups', () => {
    const flags = Object.fromEntries(metadataKeys.map((key) => [key, false]));
    expect(computeDifferingMetadataFields([])).toEqual(flags);
    expect(computeDifferingMetadataFields([base])).toEqual(flags);
  });

  it('ignores absent metadata while keeping empty strings and zero', () => {
    expect(
      computeDifferingMetadataFields([withExif(undefined), withExif({ city: null }), withExif({ city: 'Paris' })]).city,
    ).toBe(false);
    expect(computeDifferingMetadataFields([withExif({ city: '' }), withExif({ city: 'Paris' })]).city).toBe(true);
    expect(computeDifferingMetadataFields([withExif({ iso: 0 }), withExif({ iso: 100 })]).iso).toBe(true);
  });

  it('uses own EXIF properties and top-level dimensions and file dates', () => {
    const inherited = Object.create({ city: 'Paris' }) as NonNullable<typeof base.exifInfo>;
    expect(computeDifferingMetadataFields([withExif(inherited), withExif({ city: 'Tokyo' })]).city).toBe(false);
    const changed = { ...base, width: 2000, fileCreatedAt: '2026-02-02T03:04:05Z' };
    expect(computeDifferingMetadataFields([base, changed])).toMatchObject({ resolution: true, fileCreatedAt: true });
    expect(
      computeDifferingMetadataFields([withExif({ fileSizeInByte: 0 }), withExif({ fileSizeInByte: 1024 })]).fileSize,
    ).toBe(true);
  });

  it.each(['fileCreatedAt', 'fileModifiedAt', 'dateTimeOriginal', 'modifyDate'] as const)(
    'normalizes %s date representations',
    (key) => {
      const asset = (value: string) =>
        key === 'fileCreatedAt' || key === 'fileModifiedAt' ? { ...base, [key]: value } : withExif({ [key]: value });
      expect(computeDifferingMetadataFields([asset(date), asset('2026-01-02T04:04:05+01:00')])[key]).toBe(false);
      expect(computeDifferingMetadataFields([asset('invalid'), asset('invalid')])[key]).toBe(false);
      expect(computeDifferingMetadataFields([asset('invalid'), asset('different-invalid')])[key]).toBe(true);
      expect(computeDifferingMetadataFields([asset(date), asset('2026-01-02T03:04:06Z')])[key]).toBe(true);
    },
  );

  it('uses the displayed comparison precision without coercing other fields', () => {
    const first = withExif({
      fNumber: 2.81,
      focalLength: 35.001,
      latitude: 1.234_561,
      longitude: -2.345_671,
      iso: 100,
    });
    const equal = withExif({
      fNumber: 2.82,
      focalLength: 35.002,
      latitude: 1.234_562,
      longitude: -2.345_672,
      iso: 100,
    });
    expect(computeDifferingMetadataFields([first, equal])).toMatchObject({
      fNumber: false,
      focalLength: false,
      latitude: false,
      longitude: false,
      iso: false,
    });
    const different = withExif({ fNumber: 2.9, focalLength: 35.02, latitude: 1.2347, longitude: -2.3458, iso: 101 });
    expect(computeDifferingMetadataFields([first, different])).toMatchObject({
      fNumber: true,
      focalLength: true,
      latitude: true,
      longitude: true,
      iso: true,
    });
  });

  it('preserves SameValueZero equality for numeric fields', () => {
    expect(computeDifferingMetadataFields([withExif({ iso: Number.NaN }), withExif({ iso: Number.NaN })]).iso).toBe(
      false,
    );
    expect(computeDifferingMetadataFields([withExif({ iso: -0 }), withExif({ iso: 0 })]).iso).toBe(false);
    expect(computeDifferingMetadataFields([withExif({ iso: Number.NaN }), withExif({ iso: 0 })]).iso).toBe(true);
  });

  it('counts multi-key location and GPS rows only once', () => {
    expect(
      countDifferingMetadataItems({
        city: true,
        state: true,
        country: true,
        latitude: true,
        longitude: true,
        rating: false,
      }),
    ).toBe(2);
    expect(countDifferingMetadataItems(Object.fromEntries(metadataKeys.map((key) => [key, true])))).toBe(22);
    expect(countDifferingMetadataItems({})).toBe(0);
  });

  it('renders zero-valued camera and GPS metadata, rejection and missing fields', () => {
    const asset = withExif({
      latitude: 0,
      longitude: 0,
      fNumber: 0,
      focalLength: 0,
      iso: 0,
      isRejected: true,
      rating: 5,
    });
    expect(item(asset, 'latitude').render).toBe('0.0000, 0.0000');
    expect(item(asset, 'fNumber').render).toBe('f/0.0');
    expect(item(asset, 'focalLength').render).toBe('0 mm');
    expect(item(asset, 'iso').render).toBe('ISO 0');
    expect(item(asset, 'rating').render).toBe('frameleaf_library_rating_rejected');
    expect(item(base, 'make').render).toBe('unknown');
    expect(item(withExif({ latitude: 1 }), 'latitude').render).toBe('unknown');
    expect(item(withExif({ city: '', state: 'Ontario', country: 'Canada' }), 'city').render).toBe('Ontario, Canada');
  });

  it('keeps path truncation thresholds, the final filename and the full-path tooltip', () => {
    const path = `${'/parent'.repeat(12)}/photo.jpg`;
    const translator = ((key: string, options?: { values?: { path: string } }) =>
      key === 'full_path' ? options?.values?.path : key) as typeof translate;
    const row = getAllMetadataItems({ ...base, originalPath: path }, translator, 'en')[1];
    expect(row.render).toHaveLength(50);
    expect(row.render.endsWith('.../photo.jpg')).toBe(true);
    expect(row.tooltip).toBe(path);
    for (const length of [49, 50, 51, 100]) {
      const originalPath = 'x'.repeat(length);
      expect(item({ ...base, originalPath }, 'originalPath').render).toBe(
        length <= 50 ? originalPath : `${'x'.repeat(23)}...${'x'.repeat(23)}`,
      );
    }
  });

  it('retains locale and capture-zone formatting', () => {
    const asset = withExif({ timeZone: 'America/Toronto', dateTimeOriginal: date, modifyDate: date });
    for (const locale of ['en', 'fr']) {
      expect(item(asset, 'fileCreatedAt', locale).render).toBe(
        DateTime.fromISO(date, { zone: 'UTC' }).toLocaleString(
          { month: 'short', day: 'numeric', year: 'numeric' },
          { locale },
        ),
      );
      expect(item(asset, 'timeZone', locale).render).toBe('EST');
      expect(item(asset, 'dateTimeOriginal', locale).render).toContain('2026');
    }
    expect(item(base, 'timeZone').render).toBe('UTC');
  });

  it('does not mutate inputs or reuse stale comparisons or capture dates across calls', () => {
    const asset = withExif({ dateTimeOriginal: date, timeZone: 'UTC', city: 'Paris' });
    const snapshot = structuredClone(asset);
    computeDifferingMetadataFields([base, asset]);
    getAllMetadataItems(asset, translate, 'en');
    expect(asset).toEqual(snapshot);
    const previous = item(asset, 'dateTimeOriginal').render;
    asset.exifInfo!.dateTimeOriginal = '2027-01-02T03:04:05Z';
    expect(item(asset, 'dateTimeOriginal').render).not.toBe(previous);
    expect(computeDifferingMetadataFields([withExif({ dateTimeOriginal: date }), asset]).dateTimeOriginal).toBe(true);
  });
});
