import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import content from 'src/library-import/fixtures/librephotos/1.5.1-content.json' with { type: 'json' };
import fixture from 'src/library-import/fixtures/librephotos/1.5.1-files.json' with { type: 'json' };
import { classifyLibrephotosFile, normalizeLibrephotosFileCopy } from 'src/library-import/librephotos-files.js';

const file = { hash: 'opaque-source-file-id', path: '/originals/owner/photo.jpg', type: 1n, missing: 0n };
describe('LibrePhotos original path resolution', () => {
  it.each(fixture.files)('resolves bytes indexed by the pinned source application: $expected.path', (entry) => {
    const row = { ...entry.source, type: BigInt(entry.source.type), missing: BigInt(entry.source.missing) };
    const result = classifyLibrephotosFile(row, '/originals', []);
    const bytes = Buffer.from(entry.originalBase64, 'base64');
    expect(result.path).toBe(entry.expected.path);
    expect(String(bytes.length)).toBe(entry.expected.bytes);
    const checksum = createHash('sha256').update(bytes).digest('hex');
    expect(checksum).toBe(entry.expected.sha256);
    expect(checksum).not.toBe(result.id);
  });

  it.each(fixture.copies)('retains independently verified duplicate bytes: $expected.path', (entry) => {
    const result = normalizeLibrephotosFileCopy({ ...entry.source, id: BigInt(entry.source.id) }, '/originals');
    const original = fixture.files.find((file) => file.source.hash === result.fileId)!;
    const bytes = Buffer.from(entry.originalBase64, 'base64');
    expect(result.path).toBe(entry.expected.path);
    expect(String(bytes.length)).toBe(entry.expected.bytes);
    expect(bytes).toEqual(Buffer.from(original.originalBase64, 'base64'));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry.expected.sha256);
  });
  it.each(content.rows.api_file)('maps captured original $path through an explicit source root', (row) => {
    const result = classifyLibrephotosFile(
      { ...row, type: BigInt(row.type), missing: BigInt(row.missing) },
      '/originals',
      [],
    );
    expect(result).toMatchObject({
      id: row.hash,
      path: row.path.slice('/originals/'.length),
      role: 'original',
      companionOf: [],
    });
    expect(result).not.toHaveProperty('sha256');
    expect(result).not.toHaveProperty('ownerId');
  });

  it.each([
    [1n, 'image'],
    [2n, 'video'],
    [3n, 'metadata'],
    [4n, 'raw'],
  ] as const)('retains source type %s without guessing from a filename', (type, kind) => {
    expect(classifyLibrephotosFile({ ...file, type }, '/originals', [])).toMatchObject({
      kind,
      role: type === 3n ? 'sidecar' : 'original',
    });
  });

  it('retains embedded motion relationships and uses their actual recorded path in a separately mapped media root', () => {
    expect(
      classifyLibrephotosFile(
        { ...file, type: 2n, path: '/media/embedded_media/actual_motion.mp4' },
        '/media/embedded_media',
        ['still-file-id'],
      ),
    ).toMatchObject({ path: 'actual_motion.mp4', role: 'companion', companionOf: ['still-file-id'] });
  });

  it('preserves a duplicate-path alias linked to its physical source record, with no ownership inference', () => {
    const row = content.rows.api_filecopy[0];
    const result = normalizeLibrephotosFileCopy({ ...row, id: BigInt(row.id) }, '/originals');
    expect(result).toEqual({ id: String(row.id), fileId: row.file_id, path: 'blue-copy.png' });
  });

  it('refuses invalid alias identities and paths before returning a file relationship', () => {
    const row = { id: 1n, file_id: 'source-file-id', path: '/originals/copy.png' };
    expect(() => normalizeLibrephotosFileCopy({ ...row, id: 0n }, '/originals')).toThrow(
      'LIBREPHOTOS_FILE_COPY_INVALID',
    );
    expect(() => normalizeLibrephotosFileCopy({ ...row, file_id: '' }, '/originals')).toThrow(
      'LIBREPHOTOS_FILE_COPY_INVALID',
    );
    expect(() => normalizeLibrephotosFileCopy({ ...row, path: '/other/copy.png' }, '/originals')).toThrow(
      'LIBREPHOTOS_FILE_PATH_INVALID',
    );
  });

  it.each([
    '/other/photo.jpg',
    '/originals2/photo.jpg',
    '/originals',
    '/originals/../escape.jpg',
    '/originals//photo.jpg',
    '/originals/./photo.jpg',
    String.raw`/originals/photo\escape.jpg`,
    '/originals/photo\0.jpg',
    'relative.jpg',
    'C:/originals/photo.jpg',
  ])('refuses unsafe or unmapped source path %s', (path) => {
    expect(() => classifyLibrephotosFile({ ...file, path }, '/originals', [])).toThrow('LIBREPHOTOS_FILE_PATH_INVALID');
  });

  it.each(['/', 'relative', '/originals/', '/originals/..'])('refuses ambiguous source root %s', (root) => {
    expect(() => classifyLibrephotosFile(file, root, [])).toThrow('LIBREPHOTOS_FILE_ROOT_INVALID');
  });

  it('refuses missing files, unknown file types and invalid embedded relationships', () => {
    expect(() => classifyLibrephotosFile({ ...file, missing: 1n }, '/originals', [])).toThrow(
      'LIBREPHOTOS_FILE_MISSING',
    );
    expect(() => classifyLibrephotosFile({ ...file, type: 5n }, '/originals', [])).toThrow('LIBREPHOTOS_FILE_INVALID');
    expect(() => classifyLibrephotosFile(file, '/originals', ['still-id'])).toThrow('LIBREPHOTOS_COMPANION_INVALID');
    expect(() => classifyLibrephotosFile({ ...file, type: 2n }, '/originals', [file.hash])).toThrow(
      'LIBREPHOTOS_COMPANION_INVALID',
    );
    expect(() => classifyLibrephotosFile({ ...file, type: 2n }, '/originals', ['parent', 'parent'])).toThrow(
      'LIBREPHOTOS_COMPANION_INVALID',
    );
  });
});
