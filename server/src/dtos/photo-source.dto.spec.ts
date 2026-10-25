import {
  ApplePhotosSourceCreateDto,
  ApplePhotosSourceResponseDto,
  PhotoSourceCreateDto,
  PhotoSourceItemDto,
  PhotoSourceResponseDto,
  PhotoSourceRunDto,
} from 'src/dtos/photo-source.dto.js';

const id = '11111111-1111-4111-8111-111111111111';
it('accepts explicit folder-copy scope with opaque bounded fingerprints', () => {
  const valid = {
    id,
    deviceId: id,
    kind: 'folder',
    mode: 'copy',
    name: 'Approved folder',
    scopeFingerprint: 'a'.repeat(64),
  };
  expect(PhotoSourceCreateDto.schema.parse(valid)).toEqual(valid);
  expect(PhotoSourceCreateDto.schema.safeParse({ ...valid, kind: 'apple-photos' }).success).toBe(false);
  for (const extra of [
    { mode: 'external' },
    { kind: 'icloud' },
    { root: '/Users/private' },
    { scopeFingerprint: '../escape' },
    { name: '' },
  ]) {
    expect(PhotoSourceCreateDto.schema.safeParse({ ...valid, ...extra }).success).toBe(false);
  }
});
it('bounds whole-run reservations and separates source identity from content', () => {
  expect(PhotoSourceRunDto.schema.parse({ id, maxBytes: 1024, maxItems: 10 })).toEqual({
    id,
    maxBytes: 1024,
    maxItems: 10,
  });
  for (const extra of [
    { maxBytes: 0 },
    { maxItems: 100_001 },
    { maxBytes: Number.MAX_SAFE_INTEGER },
    { maxItems: 1.5 },
  ]) {
    expect(PhotoSourceRunDto.schema.safeParse({ id, maxBytes: 1024, maxItems: 10, ...extra }).success).toBe(false);
  }
  const item = { id, resourceKey: 'a'.repeat(64), version: 'b'.repeat(64), sha256: 'c'.repeat(64), bytes: 100 };
  expect(PhotoSourceItemDto.schema.parse(item)).toEqual(item);
  for (const extra of [
    { bytes: 0 },
    { bytes: 2 ** 31 + 1 },
    { resourceKey: '/photos/one.jpg' },
    { version: '' },
    { sourceIdentity: { kind: 'icloud' } },
  ]) {
    expect(PhotoSourceItemDto.schema.safeParse({ ...item, ...extra }).success).toBe(false);
  }
});

it('accepts explicit source modes without granting paths or asset publication authority', () => {
  const source = {
    id,
    deviceId: id,
    kind: 'apple-photos',
    mode: 'copy',
    name: 'Apple Photos originals',
    scopeFingerprint: 'a'.repeat(64),
  };
  expect(ApplePhotosSourceCreateDto.schema.parse(source)).toEqual(source);
  for (const mode of ['copy', 'reference']) {
    expect(ApplePhotosSourceCreateDto.schema.parse({ ...source, mode }).mode).toBe(mode);
    expect(PhotoSourceCreateDto.schema.parse({ ...source, kind: 'folder', mode }).mode).toBe(mode);
    expect(
      ApplePhotosSourceResponseDto.schema.parse({
        ...source,
        mode,
        revokedAt: null,
        createdAt: '2026-10-21T00:00:00.000Z',
      }).mode,
    ).toBe(mode);
  }
  expect(ApplePhotosSourceCreateDto.schema.safeParse({ ...source, kind: 'folder' }).success).toBe(false);
  const response = { ...source, revokedAt: null, createdAt: '2026-10-21T00:00:00.000Z' };
  expect(ApplePhotosSourceResponseDto.schema.parse(response)).toEqual(response);
  expect(PhotoSourceResponseDto.schema.safeParse(response).success).toBe(false);
  expect(PhotoSourceResponseDto.schema.parse({ ...response, kind: 'folder' }).kind).toBe('folder');
  for (const extra of [
    { mode: 'external' },
    { assetId: 'opaque-local-id' },
    { root: '/Users/private/Photos.photoslibrary' },
  ]) {
    expect(ApplePhotosSourceCreateDto.schema.safeParse({ ...source, ...extra }).success).toBe(false);
  }
});
