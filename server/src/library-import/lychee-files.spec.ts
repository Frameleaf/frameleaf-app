import { describe, expect, it } from 'vitest';
import content from 'src/library-import/fixtures/lychee/7.12.0-content.json' with { type: 'json' };
import { resolveLycheeOriginals } from 'src/library-import/lychee-files.js';

const photo = { id: 'photo', live_photo_short_path: null };
const original = {
  id: 1n,
  photo_id: photo.id,
  type: 1n,
  short_path: 'original/photo.jpg',
  storage_disk: 'images',
  filesize: 42n,
  short_path_watermarked: 'original/photo-watermarked.jpg',
};
const integers = (row: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      ['id', 'type', 'filesize'].includes(key) && typeof value === 'number' ? BigInt(value) : value,
    ]),
  );

describe('Lychee original file resolution', () => {
  it('matches all four native original paths and byte lengths without selecting generated variants', () => {
    for (const expected of content.originals) {
      const source = content.rows.photos.find((row) => row.id === expected.photoId)!;
      const variants = content.rows.size_variants
        .filter((row) => row.photo_id === source.id)
        .map((row) => integers(row));
      expect(resolveLycheeOriginals(integers(source), variants)).toEqual([
        expect.objectContaining({
          photoId: source.id,
          storage: 'images',
          path: expected.path.slice('/uploads/'.length),
          bytes: expected.bytes,
          role: 'original',
        }),
      ]);
    }
  });

  it('preserves both RAW and original variants with their integer-safe identities', () => {
    expect(
      resolveLycheeOriginals(photo, [
        original,
        { ...original, id: 9_007_199_254_740_993n, type: 0n, short_path: 'raw/photo.dng' },
      ]),
    ).toEqual([
      {
        photoId: 'photo',
        variantId: '1',
        storage: 'images',
        path: 'original/photo.jpg',
        bytes: '42',
        role: 'original',
      },
      {
        photoId: 'photo',
        variantId: '9007199254740993',
        storage: 'images',
        path: 'raw/photo.dng',
        bytes: '42',
        role: 'original',
      },
    ]);
  });

  it('uses the unwatermarked file even when a separate watermarked rendition exists', () => {
    expect(resolveLycheeOriginals(photo, [original])[0].path).toBe('original/photo.jpg');
  });

  it('retains the Live Photo companion path without inventing a byte count', () => {
    expect(resolveLycheeOriginals({ ...photo, live_photo_short_path: 'original/photo.mov' }, [original])).toEqual([
      expect.objectContaining({ variantId: '1', role: 'original' }),
      {
        photoId: 'photo',
        variantId: null,
        storage: 'images',
        path: 'original/photo.mov',
        bytes: null,
        role: 'companion',
      },
    ]);
  });

  it.each([null, '', 's3', 'unknown'])('refuses unqualified original storage %s', (storage_disk) => {
    expect(() => resolveLycheeOriginals(photo, [{ ...original, storage_disk }])).toThrow('LYCHEE_FILES_INVALID');
  });

  it.each([
    '../photo.jpg',
    '/photo.jpg',
    'a/../photo.jpg',
    String.raw`a\photo.jpg`,
    'https://source/photo.jpg',
    'a\0.jpg',
  ])('refuses unsafe original and companion paths %s', (path) => {
    expect(() => resolveLycheeOriginals(photo, [{ ...original, short_path: path }])).toThrow('LYCHEE_FILES_INVALID');
    expect(() => resolveLycheeOriginals({ ...photo, live_photo_short_path: path }, [original])).toThrow(
      'LYCHEE_FILES_INVALID',
    );
  });

  it('refuses a missing original instead of returning a preview or watermarked path', () => {
    expect(() => resolveLycheeOriginals(photo, [{ ...original, type: 7n }])).toThrow('LYCHEE_FILES_INVALID');
    expect(() => resolveLycheeOriginals(photo, [{ ...original, short_path: '' }])).toThrow('LYCHEE_FILES_INVALID');
  });

  it('refuses duplicate variants, mismatched photos and colliding companion paths', () => {
    for (const changed of [
      original,
      { ...original, id: 2n },
      { ...original, id: 2n, type: 0n },
      { ...original, id: 2n, type: 0n, photo_id: 'other' },
    ]) {
      expect(() => resolveLycheeOriginals(photo, [original, changed])).toThrow('LYCHEE_FILES_INVALID');
    }
    expect(() => resolveLycheeOriginals({ ...photo, live_photo_short_path: original.short_path }, [original])).toThrow(
      'LYCHEE_FILES_INVALID',
    );
  });

  it.each([{ type: 9n }, { id: 0n }, { filesize: -1n }, { filesize: 42 }, { type: 1 }])(
    'refuses malformed source values %s',
    (changed) => {
      expect(() => resolveLycheeOriginals(photo, [{ ...original, ...changed }])).toThrow('LYCHEE_FILES_INVALID');
    },
  );
});
