import { describe, expect, it } from 'vitest';
import content from 'src/library-import/fixtures/pigallery2/3.5.2-content.json' with { type: 'json' };
import { resolvePigallery2File } from 'src/library-import/pigallery2-files.js';

const directory = { id: 2n, name: 'album', path: './', parentId: 1n };
const media = { id: 1n, directoryId: 2n, name: 'original.jpg', type: 'PhotoEntity', metadataFilesize: 42n };

describe('PiGallery2 source file resolution', () => {
  it('matches all four original paths and lengths from the native fixture', () => {
    const paths: string[] = [];
    for (const source of content.rows.media_entity) {
      const captured = content.rows.directory_entity.find((row) => row.id === source.directoryId)!;
      const result = resolvePigallery2File(
        'media_entity',
        {
          ...source,
          id: BigInt(source.id),
          directoryId: BigInt(source.directoryId),
          metadataFilesize: BigInt(source.metadataFilesize),
        },
        {
          ...captured,
          id: BigInt(captured.id),
          parentId: captured.parentId === null ? null : BigInt(captured.parentId),
        },
      );
      expect(content.originals).toContainEqual(expect.objectContaining({ path: result.path, bytes: result.bytes }));
      paths.push(result.path);
      expect(result.id).toBe(`media_entity:${source.id}`);
      expect(result.role).toBe('original');
    }
    expect(paths.toSorted()).toEqual(content.originals.map((file) => file.path).toSorted());
  });

  it.each(['PhotoEntity', 'VideoEntity'])('resolves %s directly from the configured image tree', (type) => {
    expect(resolvePigallery2File('media_entity', { ...media, type }, directory)).toEqual({
      id: 'media_entity:1',
      directoryId: '2',
      path: 'album/original.jpg',
      bytes: '42',
      role: 'original',
    });
  });

  it('retains metadata files in a separate identity namespace without inventing a byte count', () => {
    expect(
      resolvePigallery2File(
        'file_entity',
        { id: 1n, directoryId: 2n, name: 'notes.md', type: 'MDFileEntity' },
        directory,
      ),
    ).toEqual({ id: 'file_entity:1', directoryId: '2', path: 'album/notes.md', bytes: null, role: 'sidecar' });
    expect(
      resolvePigallery2File(
        'file_entity',
        { id: 1n, directoryId: 2n, name: 'track.gpx', type: 'FileEntity' },
        directory,
      ).path,
    ).toBe('album/track.gpx');
  });

  it('resolves the native root and nested directory representations without losing Unicode names', () => {
    expect(
      resolvePigallery2File(
        'media_entity',
        { ...media, directoryId: 1n },
        { id: 1n, name: '.', path: './', parentId: null },
      ).path,
    ).toBe('original.jpg');
    expect(resolvePigallery2File('media_entity', media, { ...directory, name: 'été', path: 'space album/' }).path).toBe(
      'space album/été/original.jpg',
    );
  });

  it.each(content.directoryPaths)('matches native DiskManager path for "$input"', (record) => {
    const root = record.name === '.';
    expect(
      resolvePigallery2File('media_entity', media, {
        id: 2n,
        name: record.name,
        path: record.path,
        parentId: root ? null : 1n,
      }).path,
    ).toBe(record.relativePath);
  });

  it('preserves integer-safe identities and lengths', () => {
    const id = 9_007_199_254_740_993n;
    expect(resolvePigallery2File('media_entity', { ...media, id, metadataFilesize: id }, directory)).toMatchObject({
      id: `media_entity:${id}`,
      bytes: String(id),
    });
  });

  it.each(['../', '/absolute/', 'a/../', 'a//', './/', String.raw`a\b/`, 'https://source/', 'a\0/'])(
    'refuses unsafe directory path %s',
    (path) => {
      expect(() => resolvePigallery2File('media_entity', media, { ...directory, path })).toThrow(
        'PIGALLERY2_FILES_INVALID',
      );
    },
  );

  it.each(['../original.jpg', '/original.jpg', 'a/original.jpg', String.raw`a\original.jpg`, '.', '..', '', 'a\0.jpg'])(
    'refuses unsafe file name %s',
    (name) => {
      expect(() => resolvePigallery2File('media_entity', { ...media, name }, directory)).toThrow(
        'PIGALLERY2_FILES_INVALID',
      );
    },
  );

  it('refuses mismatched directory identities and malformed root records', () => {
    expect(() => resolvePigallery2File('media_entity', media, { ...directory, id: 3n })).toThrow(
      'PIGALLERY2_FILES_INVALID',
    );
    expect(() => resolvePigallery2File('media_entity', media, { ...directory, name: '.', path: 'parent/' })).toThrow(
      'PIGALLERY2_FILES_INVALID',
    );
    expect(() => resolvePigallery2File('media_entity', media, { ...directory, name: '.', parentId: 1n })).toThrow(
      'PIGALLERY2_FILES_INVALID',
    );
  });

  it.each(['ThumbnailEntity', 'FileEntity', 'MDFileEntity'])('refuses unqualified media discriminator %s', (type) => {
    expect(() => resolvePigallery2File('media_entity', { ...media, type }, directory)).toThrow(
      'PIGALLERY2_FILES_INVALID',
    );
  });

  it('refuses a media record in the metadata-file table and an unknown table', () => {
    expect(() => resolvePigallery2File('file_entity', media, directory)).toThrow('PIGALLERY2_FILES_INVALID');
    expect(() => resolvePigallery2File('cache' as never, media, directory)).toThrow('PIGALLERY2_FILES_INVALID');
  });

  it.each([{ metadataFilesize: undefined }, { metadataFilesize: -1n }, { metadataFilesize: 42 }, { id: 0n }])(
    'refuses malformed source values %s',
    (changed) => {
      expect(() => resolvePigallery2File('media_entity', { ...media, ...changed }, directory)).toThrow(
        'PIGALLERY2_FILES_INVALID',
      );
    },
  );
});
