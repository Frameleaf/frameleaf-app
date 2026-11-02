import { describe, expect, it } from 'vitest';
import content from 'src/library-import/fixtures/piwigo/16.4.0-content.json' with { type: 'json' };
import paths from 'src/library-import/fixtures/piwigo/16.4.0-paths.json' with { type: 'json' };
import { resolvePiwigoOriginals } from 'src/library-import/piwigo-files.js';

const image = { id: 3n, path: './upload/2026/11/01/photo.name.png', representative_ext: 'jpg', filesize: 1n };
const format = { format_id: 9n, image_id: 3n, ext: 'cr2', filesize: 2n };

describe('Piwigo original paths', () => {
  it.each(paths.cases)('matches pinned native PHP format resolution for $path', (entry) => {
    const result = resolvePiwigoOriginals({ ...image, path: entry.path }, [{ ...format, ext: entry.ext }]);
    expect(result[1].path).toBe(entry.format.replace(/^\.\//u, ''));
    expect(result.map((file) => file.path)).not.toContain(entry.representative.replace(/^\.\//u, ''));
  });

  it.each(content.originals)('resolves native uploaded original $id without using a preview or KB size', (original) => {
    const row = content.rows.images.find((row) => row.id === original.id)!;
    expect(resolvePiwigoOriginals({ ...row, id: BigInt(row.id) }, [])).toEqual([
      { imageId: String(original.id), formatId: null, path: original.path.slice(2), role: 'original' },
    ]);
  });

  it('retains the primary original and additional formats independently of representatives', () => {
    expect(resolvePiwigoOriginals(image, [format, { ...format, format_id: 10n, ext: 'DNG' }])).toEqual([
      { imageId: '3', formatId: null, path: 'upload/2026/11/01/photo.name.png', role: 'original' },
      { imageId: '3', formatId: '9', path: 'upload/2026/11/01/pwg_format/photo.name.cr2', role: 'original' },
      { imageId: '3', formatId: '10', path: 'upload/2026/11/01/pwg_format/photo.name.DNG', role: 'original' },
    ]);
  });

  it('resolves local filesystem gallery originals without decoding literal URL-like filenames', () => {
    expect(resolvePiwigoOriginals({ id: 4n, path: './galleries/旅行/100%20real.tif' }, [])).toEqual([
      { imageId: '4', formatId: null, path: 'galleries/旅行/100%20real.tif', role: 'original' },
    ]);
  });

  it.each([
    '../outside.jpg',
    '/absolute.jpg',
    './galleries/../outside.jpg',
    '././galleries/photo.jpg',
    'https://example.invalid/photo.jpg',
    '//example.invalid/photo.jpg',
    'file:photo.jpg',
    'C:/photos/photo.jpg',
    String.raw`./galleries\photo.jpg`,
    './galleries//photo.jpg',
    './galleries/photo\0.jpg',
    './galleries/pwg_representative/photo.jpg',
    './_data/i/photo-me.jpg',
    './galleries/pwg_format/photo.dng',
    './galleries/photo',
    './galleries/.jpg',
    './galleries/photo.',
  ])('refuses unavailable, generated or unsafe original path %j', (path) => {
    expect(() => resolvePiwigoOriginals({ ...image, path }, [])).toThrow('PIWIGO_FILES_INVALID');
  });

  it.each(
    [
      [{ ...format, image_id: 4n }],
      [{ ...format, format_id: 0n }],
      [{ ...format, ext: '../jpg' }],
      [{ ...format, ext: 'tar.gz' }],
      [format, format],
      [format, { ...format, format_id: 10n }],
    ].map((formats) => ({ formats })),
  )('refuses invalid, dangling or colliding format records %#', ({ formats }) => {
    expect(() => resolvePiwigoOriginals(image, formats)).toThrow('PIWIGO_FILES_INVALID');
  });

  it('requires native integer identity and preserves values beyond JavaScript precision', () => {
    expect(() => resolvePiwigoOriginals({ ...image, id: 3 }, [])).toThrow('PIWIGO_FILES_INVALID');
    expect(
      resolvePiwigoOriginals({ ...image, id: 9_007_199_254_740_993n }, [
        { ...format, image_id: 9_007_199_254_740_993n },
      ])[0].imageId,
    ).toBe('9007199254740993');
  });

  it('refuses additional paths that exceed the shared file-path limit', () => {
    expect(() => resolvePiwigoOriginals({ ...image, path: `galleries/${'x'.repeat(4078)}.jpg` }, [format])).toThrow(
      'PIWIGO_FILES_INVALID',
    );
  });
});
