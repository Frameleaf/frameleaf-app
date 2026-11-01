import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import fixture from 'src/library-import/fixtures/photoprism/261029-files.json' with { type: 'json' };
import { classifyPhotoprismFile } from 'src/library-import/photoprism-files.js';

const file = {
  file_uid: 'file-fixture',
  photo_uid: 'photo-fixture',
  photo_id: 1n,
  file_name: 'owner-a/photo.dng',
  file_root: '/',
  file_size: 9_007_199_254_740_993n,
  file_primary: 0n,
  file_sidecar: 0n,
  file_missing: 0n,
  file_watermark: 0n,
  deleted_at: null,
};
describe('PhotoPrism original file classification', () => {
  it.each(fixture.files)('matches originals indexed by the pinned source application: $expected.path', (entry) => {
    const row = Object.fromEntries(
      Object.entries(entry.source).map(([key, value]) => [key, typeof value === 'number' ? BigInt(value) : value]),
    );
    const result = classifyPhotoprismFile(row);
    const original = Buffer.from(entry.originalBase64, 'base64');
    expect(result.storage).toBe('originals');
    expect(result.role).toBe('original');
    expect(result.path).toBe(entry.expected.path);
    expect(result.bytes).toBe(original.byteLength.toString());
    const actualChecksum = createHash('sha256').update(original).digest('hex');
    expect(actualChecksum).toBe(entry.expected.sha256);
    expect(actualChecksum).not.toBe(entry.source.file_hash);
  });
  it('retains non-primary originals, exact byte counts and photo relationships without using source hashes', () => {
    const result = classifyPhotoprismFile({ ...file, file_hash: 'not-a-content-sha256' });
    expect(result).toMatchObject({
      id: 'file-fixture',
      photoId: 'photo-fixture',
      sourcePhotoId: '1',
      storage: 'originals',
      path: 'owner-a/photo.dng',
      bytes: '9007199254740993',
      role: 'original',
      primary: false,
    });
    expect(result).not.toHaveProperty('sha256');
  });
  it('never substitutes a primary generated preview for an original', () => {
    const result = classifyPhotoprismFile({ ...file, file_root: 'sidecar', file_primary: 1n, file_name: 'photo.jpg' });
    expect(result.storage).toBe('sidecar');
    expect(result.role).toBeUndefined();
  });
  it('retains required original-tree sidecars separately from originals', () => {
    expect(classifyPhotoprismFile({ ...file, file_name: 'owner-a/photo.xmp', file_sidecar: 1n }).role).toBe('sidecar');
  });
  it('does not discard soft-deleted originals that still need byte reconciliation', () => {
    expect(classifyPhotoprismFile({ ...file, deleted_at: '2026-11-01 12:00:00+00:00' }).role).toBe('original');
  });
  it('blocks missing and watermarked originals but allows missing regenerable previews', () => {
    expect(() => classifyPhotoprismFile({ ...file, file_missing: 1n })).toThrow('PHOTOPRISM_ORIGINAL_MISSING');
    expect(() => classifyPhotoprismFile({ ...file, file_watermark: 1n })).toThrow('PHOTOPRISM_ORIGINAL_WATERMARKED');
    expect(classifyPhotoprismFile({ ...file, file_root: 'sidecar', file_missing: 1n }).role).toBeUndefined();
  });
  it.each([
    '../outside.jpg',
    '/host/photo.jpg',
    'a/../../outside.jpg',
    String.raw`a\photo.jpg`,
    'a//photo.jpg',
    'a/./photo.jpg',
    'C:/photo.jpg',
    'a\nphoto.jpg',
  ])('refuses unsafe source relative paths %s', (path) => {
    expect(() => classifyPhotoprismFile({ ...file, file_name: path })).toThrow('PHOTOPRISM_FILE_INVALID');
  });
  it.each([
    { file_root: 'import' },
    { file_root: 'samples' },
    { file_root: '/host/library' },
    { file_size: -1n },
    { file_missing: null },
    { file_sidecar: 2n },
    { photo_uid: '' },
  ])('refuses unqualified roots or incomplete file evidence case %#', (change) => {
    expect(() => classifyPhotoprismFile({ ...file, ...change })).toThrow('PHOTOPRISM_FILE_INVALID');
  });
});
