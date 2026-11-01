import { describe, expect, it } from 'vitest';
import { parseImportManifest, manifestFingerprint } from './manifest.js';

const manifest = () => ({
  format: 'frameleaf-library-import',
  version: 1,
  source: {
    kind: 'ente',
    version: 'test-export-1',
    identity: 'synthetic-account',
    revision: 'rev-1',
    schemaSha256: 'a'.repeat(64),
  },
  inventory: {
    complete: true,
    ownershipComplete: true,
    privacyComplete: true,
    writersStopped: true,
    revisionBefore: 'rev-1',
    revisionAfter: 'rev-1',
  },
  users: [{ id: 'alice', name: 'Alice' }],
  files: [{ id: 'f1', path: 'originals/image.jpg', bytes: '12', sha256: 'b'.repeat(64), role: 'original' }],
  assets: [
    { id: 'a1', ownerId: 'alice', fileIds: ['f1'], visibility: 'hidden', metadata: { description: 'Edited caption' } },
  ],
  albums: [{ id: 'album1', ownerId: 'alice', name: 'Family', assetIds: ['a1'], members: [] }],
  losses: [],
});

describe('library import manifest trust boundary', () => {
  it('accepts an explicit complete inventory without changing privacy', () => {
    expect(parseImportManifest(manifest()).assets[0].visibility).toBe('hidden');
  });
  it.each(['complete', 'ownershipComplete', 'privacyComplete', 'writersStopped'])(
    'refuses missing %s evidence',
    (key) => {
      const value = manifest();
      Object.assign(value.inventory, { [key]: false });
      expect(() => parseImportManifest(value)).toThrow();
    },
  );
  it('refuses revisions that changed during export', () => {
    const value = manifest();
    value.inventory.revisionAfter = 'rev-2';
    expect(() => parseImportManifest(value)).toThrow();
  });
  it.each(['../outside.jpg', '/absolute.jpg', 'a/../b.jpg', 'a\\b.jpg', 'a//b.jpg', './photo.jpg', 'a/./b.jpg'])(
    'refuses unsafe bundle path %s',
    (path) => {
      const value = manifest();
      value.files[0].path = path;
      expect(() => parseImportManifest(value)).toThrow();
    },
  );
  it('refuses unknown properties instead of discarding unsupported privacy fields', () => {
    const value = { ...manifest(), access: 'unknown' };
    expect(() => parseImportManifest(value)).toThrow();
  });
  it('refuses duplicate IDs', () => {
    const value = manifest();
    value.assets.push(value.assets[0]);
    expect(() => parseImportManifest(value)).toThrow();
  });
  it('refuses missing owners and file references', () => {
    const value = manifest();
    value.assets[0].ownerId = 'missing';
    expect(() => parseImportManifest(value)).toThrow();
    value.assets[0].ownerId = 'alice';
    value.assets[0].fileIds = ['missing'];
    expect(() => parseImportManifest(value)).toThrow();
  });
  it('does not allow a preview to stand in for an original', () => {
    const value = manifest();
    value.files[0].role = 'preview';
    expect(() => parseImportManifest(value)).toThrow();
  });
  it('refuses cross-owner album inclusion without an explicit permission model', () => {
    const value = manifest();
    value.users.push({ id: 'bob', name: 'Bob' });
    value.albums[0].ownerId = 'bob';
    expect(() => parseImportManifest(value)).toThrow();
  });
  it('permits shared physical bytes without merging owners', () => {
    const value = manifest();
    value.users.push({ id: 'bob', name: 'Bob' });
    value.assets.push({ ...value.assets[0], id: 'a2', ownerId: 'bob' });
    expect(parseImportManifest(value).assets).toHaveLength(2);
  });
  it('requires canonical decimal byte lengths beyond Number precision', () => {
    const value = manifest();
    value.files[0].bytes = '9007199254740993';
    expect(parseImportManifest(value).files[0].bytes).toBe('9007199254740993');
    value.files[0].bytes = '-1';
    expect(() => parseImportManifest(value)).toThrow();
  });
  it('keeps fingerprints stable after JSON persistence of optional fields', () => {
    const value = parseImportManifest(manifest());
    value.assets[0].metadata.title = undefined;
    expect(manifestFingerprint(value)).toBe(manifestFingerprint(JSON.parse(JSON.stringify(value))));
  });
  it('requires an original even when every file role is valid', () => {
    const value = manifest();
    value.files[0].role = 'sidecar';
    expect(() => parseImportManifest(value)).toThrow('MISSING_ORIGINAL');
  });
  it('canonicalizes object key order but pins array order', () => {
    const value = manifest();
    value.users.push({ id: 'bob', name: 'Bob' });
    const parsed = parseImportManifest(value);
    const reversed = Object.fromEntries(Object.entries(parsed).reverse());
    expect(manifestFingerprint(parsed)).toBe(manifestFingerprint(parseImportManifest(reversed)));
    const reordered = parseImportManifest(value);
    reordered.users.reverse();
    expect(manifestFingerprint(parsed)).not.toBe(manifestFingerprint(reordered));
  });
  it('pins metadata and array ordering while ignoring object property order', () => {
    const value = parseImportManifest(manifest());
    expect(manifestFingerprint(value)).toBe(manifestFingerprint({ ...value, source: { ...value.source } }));
    const changed = parseImportManifest(manifest());
    changed.assets[0].metadata.description = 'Changed';
    expect(manifestFingerprint(value)).not.toBe(manifestFingerprint(changed));
  });
});
