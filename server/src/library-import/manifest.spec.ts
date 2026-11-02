import { describe, expect, it } from 'vitest';
import { manifestFingerprint, parseImportManifest } from 'src/library-import/manifest.js';

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
  it.each([
    '../outside.jpg',
    '/absolute.jpg',
    'a/../b.jpg',
    String.raw`a\b.jpg`,
    'a//b.jpg',
    './photo.jpg',
    'a/./b.jpg',
    'a/\0b.jpg',
    'a/\nb.jpg',
    'a/\tb.jpg',
  ])('refuses unsafe bundle path %s', (path) => {
    const value = manifest();
    value.files[0].path = path;
    expect(() => parseImportManifest(value)).toThrow();
  });
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
    const reversed = Object.fromEntries(Object.entries(parsed).toReversed());
    expect(manifestFingerprint(parsed)).toBe(manifestFingerprint(parseImportManifest(reversed)));
    const reordered = parseImportManifest(value);
    reordered.users = reordered.users.toReversed();
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

describe('explicit primary originals', () => {
  const multipleOriginals = () => {
    const value = manifest();
    value.files.push({ ...value.files[0], id: 'raw', path: 'originals/image.raw' });
    value.assets[0].fileIds.push('raw');
    return value;
  };
  const v2 = () => {
    const value = multipleOriginals();
    return { ...value, version: 2, assets: value.assets.map((asset) => ({ ...asset, primaryFileId: 'raw' })) };
  };
  it('preserves the legacy single-original contract and its fingerprint', () => {
    const value = manifest();
    expect(parseImportManifest(value)).toEqual(value);
    expect(manifestFingerprint(parseImportManifest(value))).toBe(
      'f180dd72c7d61b692591dadee15c97e919a9d31694ef7fd02aa4e3b78cfa921c',
    );
    expect(manifestFingerprint(parseImportManifest(value))).toBe(
      manifestFingerprint(parseImportManifest(JSON.parse(JSON.stringify(value)))),
    );
  });
  it('requires primary evidence rather than choosing the first of several originals', () => {
    expect(() => parseImportManifest(multipleOriginals())).toThrow('PRIMARY_ORIGINAL_REQUIRED');
  });
  it('retains all physical originals with one explicit source primary in version two', () => {
    const parsed = parseImportManifest(v2());
    expect(parsed.version).toBe(2);
    expect(parsed.assets[0]).toMatchObject({ primaryFileId: 'raw', fileIds: ['f1', 'raw'] });
    expect(parsed.files).toHaveLength(2);
  });
  it.each(['unknown', 'sidecar', 'not-attached'])('refuses a primary that is %s', (state) => {
    const value = v2();
    switch (state) {
      case 'unknown': {
        value.assets[0].primaryFileId = 'missing';
        break;
      }
      case 'sidecar': {
        value.files[1].role = 'sidecar';
        break;
      }
      case 'not-attached': {
        value.assets[0].fileIds = ['f1'];
        break;
      }
      // No default
    }
    expect(() => parseImportManifest(value)).toThrow('PRIMARY_ORIGINAL_INVALID');
  });
  it('requires explicit primaries in version two even for one original', () => {
    expect(() => parseImportManifest({ ...manifest(), version: 2 })).toThrow();
  });
  it('pins primary selection in the durable manifest identity', () => {
    const value = v2();
    const original = manifestFingerprint(parseImportManifest(value));
    value.assets[0].primaryFileId = 'f1';
    expect(manifestFingerprint(parseImportManifest(value))).not.toBe(original);
  });
});
