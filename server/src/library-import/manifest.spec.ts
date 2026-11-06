import { describe, expect, it } from 'vitest';
import {
  importsLocked,
  manifestFingerprint,
  parseImportManifest,
  storedVisibility,
} from 'src/library-import/manifest.js';

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
  it('keeps a Locked archived item archived, and refuses archived without Locked', () => {
    const value = manifest();
    Object.assign(value.assets[0], { visibility: 'locked', archived: true });
    const [asset] = parseImportManifest(value).assets;
    expect(storedVisibility(asset)).toBe('archive');
    expect(storedVisibility({ visibility: 'locked' })).toBe('timeline');
    expect(storedVisibility({ visibility: 'trash' })).toBe('timeline');
    expect(manifestFingerprint(parseImportManifest(manifest()))).toBe(
      manifestFingerprint(
        parseImportManifest({ ...manifest(), assets: manifest().assets.map((a) => ({ ...a, archived: undefined })) }),
      ),
    );
    Object.assign(value.assets[0], { visibility: 'archive' });
    expect(() => parseImportManifest(value)).toThrow('ASSET_ARCHIVED_REQUIRES_LOCKED');
  });
  it('keeps a private item in Trash both trashed and Locked, and refuses Locked outside Trash (FL-1230)', () => {
    const value = manifest();
    Object.assign(value.assets[0], { visibility: 'trash', locked: true });
    const [asset] = parseImportManifest(value).assets;
    expect(storedVisibility(asset)).toBe('timeline');
    expect(importsLocked(asset)).toBe(true);
    expect(importsLocked({ visibility: 'trash' })).toBe(false);
    expect(importsLocked({ visibility: 'locked' })).toBe(true);
    Object.assign(value.assets[0], { visibility: 'timeline' });
    expect(() => parseImportManifest(value)).toThrow('ASSET_LOCKED_REQUIRES_TRASH');
  });
  it('preserves an explicit cleared location for regeneration locks', () => {
    const value = manifest();
    Object.assign(value.assets[0].metadata, { latitude: null, longitude: null });
    expect(parseImportManifest(value).assets[0].metadata).toMatchObject({ latitude: null, longitude: null });
  });
  it.each([
    { latitude: null },
    { longitude: null },
    { latitude: null, longitude: 12 },
    { latitude: 12, longitude: null },
  ])('refuses an incomplete cleared location case %#', (coordinates) => {
    const value = manifest();
    Object.assign(value.assets[0].metadata, coordinates);
    expect(() => parseImportManifest(value)).toThrow();
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

describe('complete physical file ownership', () => {
  const inventory = (version: 1 | 2 | 3) => {
    const value = manifest();
    return {
      ...value,
      version,
      assets: value.assets.map((asset) => ({
        ...asset,
        ...(version > 1 ? { primaryFileId: 'f1' } : {}),
        ...(version === 3
          ? {
              type: 'IMAGE',
              fileModifiedAt: '2020-01-02T03:04:05Z',
              originalFileNames: { f1: 'image.jpg' },
            }
          : {}),
      })),
    };
  };
  describe.each([1, 2, 3] as const)('manifest version %s', (version) => {
    it.each(['original', 'sidecar', 'companion'])('refuses an unreferenced %s', (role) => {
      const value = inventory(version);
      value.files.push({ ...value.files[0], id: 'orphan', path: 'unowned/file', role });
      expect(() => parseImportManifest(value)).toThrow('FILE_OWNER_RELATIONSHIP_REQUIRED');
    });
    it.each(['original', 'sidecar', 'companion'] as const)('refuses to fingerprint an unowned %s', (role) => {
      const value = parseImportManifest(inventory(version));
      value.files.push({ ...value.files[0], id: 'orphan', path: 'unowned/file', role });
      expect(() => manifestFingerprint(value)).toThrow('FILE_OWNER_RELATIONSHIP_REQUIRED');
    });
    it('retains attached sidecars and companions, shared files and unused source users', () => {
      const value = inventory(version);
      value.users.push({ id: 'bob', name: 'Bob' }, { id: 'unused', name: 'Unused' });
      value.files.push(
        { ...value.files[0], id: 'sidecar', path: 'originals/image.xmp', role: 'sidecar' },
        { ...value.files[0], id: 'companion', path: 'originals/clip.mov', role: 'companion' },
      );
      value.assets[0].fileIds.push('sidecar', 'companion');
      value.assets.push({ ...value.assets[0], id: 'bob-photo', ownerId: 'bob' });
      expect(parseImportManifest(value)).toEqual(value);
    });
    it('permits an empty inventory with source users', () => {
      const value = { ...inventory(version), files: [], assets: [], albums: [] };
      expect(parseImportManifest(value)).toEqual(value);
    });
    it('refuses an inventory containing files without any photos', () => {
      const value = { ...inventory(version), assets: [], albums: [] };
      expect(() => parseImportManifest(value)).toThrow('FILE_OWNER_RELATIONSHIP_REQUIRED');
    });
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

describe('sealed photo preparation in manifest version three', () => {
  const prepared = () => {
    const value = manifest();
    return {
      ...value,
      version: 3,
      assets: value.assets.map((asset) => ({
        ...asset,
        primaryFileId: 'f1',
        type: 'IMAGE',
        fileModifiedAt: '2020-01-02T03:04:05.123456Z',
        originalFileNames: { f1: 'Camera original.jpg' },
      })),
    };
  };
  it.each(['2020-06-10T12:30:00', '2020-06-10T12:30:00.123456'])(
    'preserves source wall clock %s without assigning a time zone',
    (localDateTime) => {
      const value = prepared();
      Object.assign(value.assets[0], { localDateTime });
      const parsed = parseImportManifest(value);
      expect(parsed.assets[0]).toHaveProperty('localDateTime', localDateTime);
      expect(parsed.assets[0].metadata.timeZone).toBeUndefined();
      const changed = structuredClone(value);
      Object.assign(changed.assets[0], { localDateTime: '2020-06-10T13:30:00' });
      expect(manifestFingerprint(parsed)).not.toBe(manifestFingerprint(parseImportManifest(changed)));
    },
  );
  it.each([
    '2020-06-10T12:30:00Z',
    '2020-06-10T12:30:00+05:45',
    '2020-02-30T12:30:00',
    '2020-06-10T12:30:00.1234567',
    '2020-06-10 12:30:00',
  ])('refuses an invalid or non-local wall clock %s', (localDateTime) => {
    const value = prepared();
    Object.assign(value.assets[0], { localDateTime });
    expect(() => parseImportManifest(value)).toThrow();
  });
  it('requires one source clock representation instead of silently overriding a named zone', () => {
    const value = prepared();
    Object.assign(value.assets[0], { localDateTime: '2020-06-10T12:30:00' });
    Object.assign(value.assets[0].metadata, { timeZone: 'UTC' });
    expect(() => parseImportManifest(value)).toThrow();
  });
  it('retains the qualified media type, microsecond modified time and original names', () => {
    const value = prepared();
    expect(parseImportManifest(value)).toEqual(value);
    expect(manifestFingerprint(parseImportManifest(value))).toBe(
      manifestFingerprint(parseImportManifest(JSON.parse(JSON.stringify(value)))),
    );
  });
  it.each(['type', 'fileModifiedAt', 'originalFileNames'])('requires sealed %s', (key) => {
    const value = prepared();
    Reflect.deleteProperty(value.assets[0], key);
    expect(() => parseImportManifest(value)).toThrow();
  });
  it.each([
    '',
    '../outside.jpg',
    'dir/photo.jpg',
    String.raw`dir\photo.jpg`,
    '.',
    '..',
    'bad\nname.jpg',
    'bad\0name.jpg',
  ])('refuses unsafe original name %j', (name) => {
    const value = prepared();
    value.assets[0].originalFileNames.f1 = name;
    expect(() => parseImportManifest(value)).toThrow();
  });
  it.each([{}, { missing: 'other.jpg' }, { f1: 'original.jpg', extra: 'other.jpg' }])(
    'requires exactly the original file IDs: %j',
    (names) => {
      const value = prepared();
      Object.assign(value.assets[0], { originalFileNames: names });
      expect(() => parseImportManifest(value)).toThrow();
    },
  );
  it('fingerprints every sealed field and refuses unsupported precision or media types', () => {
    const value = prepared();
    const before = manifestFingerprint(parseImportManifest(value));
    for (const change of [
      { type: 'VIDEO' },
      { fileModifiedAt: '2021-01-02T03:04:05Z' },
      { originalFileNames: { f1: 'changed.jpg' } },
    ]) {
      const changed = structuredClone(value);
      Object.assign(changed.assets[0], change);
      expect(manifestFingerprint(parseImportManifest(changed))).not.toBe(before);
    }
    for (const change of [{ type: 'AUDIO' }, { fileModifiedAt: '2020-01-02T03:04:05.1234567Z' }]) {
      const changed = structuredClone(value);
      Object.assign(changed.assets[0], change);
      expect(() => parseImportManifest(changed)).toThrow();
    }
  });
});
