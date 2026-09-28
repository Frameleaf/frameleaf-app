import { createHash } from 'node:crypto';
import { MediaOperationKind } from 'src/enum.js';
import {
  PRESERVATION_FORMAT,
  PRESERVATION_INDEX_ENTRY,
  PRESERVATION_SCHEMA_VERSION,
  PRESERVATION_SUPPORT,
  PreservationAlbum,
  PreservationEntrySchema,
  PreservationLibraryState,
  PreservationManifestSchema,
  PreservationPackageError,
  PreservationSidecar,
  PreservationSidecarSchema,
  checkPreservationEntry,
  compareWithLibrary,
  describePreservationScope,
  fieldsToRestore,
  isOriginalEntryFor,
  manualDescription,
  matchesDigest,
  orderPreservationAlbums,
  parsePreservationSnapshot,
  preservationArchiveCode,
  preservationDerivedId,
  preservationDocumentLimit,
  preservationEntryNames,
  preservationFileName,
  preservationJson,
  restorableRating,
  restoredAlbumParent,
  sanitizeDecisions,
  splitDescription,
  verificationStatus,
} from 'src/utils/preservation.js';

const sourceId = '11111111-1111-4111-8111-111111111111';
const sha1 = 'a'.repeat(40);
const sha256 = 'b'.repeat(64);

const sidecarOf = (overrides: Partial<PreservationSidecar> = {}): PreservationSidecar => ({
  schemaVersion: PRESERVATION_SCHEMA_VERSION,
  sourceAssetId: sourceId,
  originalFileName: 'lake.jpg',
  type: 'IMAGE',
  checksum: { sha1, sha256 },
  dates: {
    fileCreatedAt: '2024-06-01T10:00:00.000Z',
    fileModifiedAt: '2024-06-01T10:00:00.000Z',
    localDateTime: '2024-06-01T12:00:00.000Z',
    dateTimeOriginal: '2024-06-01T10:00:00.000Z',
    timeZone: 'Europe/Rome',
  },
  isFavorite: false,
  visibility: 'timeline',
  lock: null,
  location: null,
  description: null,
  rating: null,
  camera: null,
  tags: [],
  albums: [],
  faces: [],
  livePhotoVideoId: null,
  stack: null,
  edits: { isEdited: false, recipe: [] },
  documents: [],
  moments: { manual: [], generated: [] },
  provenance: {},
  ...overrides,
});

const libraryOf = (overrides: Partial<PreservationLibraryState> = {}): PreservationLibraryState => ({
  dateTimeOriginal: null,
  description: null,
  latitude: null,
  longitude: null,
  rating: null,
  isFavorite: false,
  visibility: 'timeline',
  locked: false,
  editRecipe: [],
  ...overrides,
});

const manifestOf = (overrides: Record<string, unknown> = {}) => ({
  format: PRESERVATION_FORMAT,
  schemaVersion: PRESERVATION_SCHEMA_VERSION,
  packageId: '0195e2a0-0000-7000-8000-000000000001',
  name: 'Italy 2024',
  createdAt: '2026-09-23T10:00:00.000Z',
  producer: { product: 'frameleaf', version: '3.0.0' },
  scope: { description: 'Whole library', includeLocked: false, includeMetadata: true },
  counts: { selected: 3, exported: 2, failed: 1, skipped: 0, locked: 0, bytes: 10 },
  complete: false,
  files: { [PRESERVATION_INDEX_ENTRY]: { sha256, bytes: 10 } },
  support: { ...PRESERVATION_SUPPORT },
  ...overrides,
});

describe('entry names', () => {
  it('names an original and its sidecar by id, keeping only a plain extension', () => {
    expect(preservationEntryNames(sourceId, 'Lake Como.JPG')).toEqual({
      original: `originals/${sourceId}.jpg`,
      metadata: `metadata/${sourceId}.json`,
    });
    expect(preservationEntryNames(sourceId, 'no-extension').original).toBe(`originals/${sourceId}`);
    expect(preservationEntryNames(sourceId, 'evil.../../x').original).toBe(`originals/${sourceId}`);
  });

  it('accepts only the original path that belongs to the identity', () => {
    expect(isOriginalEntryFor(`originals/${sourceId}.heic`, sourceId)).toBe(true);
    expect(isOriginalEntryFor(`originals/${sourceId}`, sourceId)).toBe(true);
    expect(isOriginalEntryFor(`originals/${sourceId}.../x`, sourceId)).toBe(false);
    expect(isOriginalEntryFor('originals/22222222-2222-4222-8222-222222222222.jpg', sourceId)).toBe(false);
  });

  it('gives the download the package name, never an id or a path', () => {
    expect(preservationFileName('Italy 2024 / all')).toBe('Italy-2024-all.frameleaf-preservation.zip');
    expect(preservationFileName('////')).toBe('library.frameleaf-preservation.zip');
  });

  it('bounds the documents it reads into memory and streams the rest', () => {
    expect(preservationDocumentLimit('manifest.json')).toBe(1024 * 1024);
    expect(preservationDocumentLimit(`metadata/${sourceId}.json`)).toBe(4 * 1024 * 1024);
    expect(preservationDocumentLimit(`originals/${sourceId}.jpg`)).toBeNull();
  });
});

describe(preservationDerivedId.name, () => {
  it('is stable for a namespace, different across namespaces, and shaped as a version-4 UUID', () => {
    const first = preservationDerivedId('owner:album:package:album-1');
    expect(preservationDerivedId('owner:album:package:album-1')).toBe(first);
    expect(preservationDerivedId('owner:album:package:album-2')).not.toBe(first);
    expect(first).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
  });
});

describe('manifest', () => {
  it('accepts a well-formed manifest', () => {
    expect(PreservationManifestSchema.safeParse(manifestOf()).success).toBe(true);
  });

  it('refuses another format, counts that do not add up and a completeness that lies', () => {
    expect(PreservationManifestSchema.safeParse(manifestOf({ format: 'zip' })).success).toBe(false);
    expect(
      PreservationManifestSchema.safeParse(
        manifestOf({ counts: { selected: 9, exported: 2, failed: 1, skipped: 0, locked: 0, bytes: 10 } }),
      ).success,
    ).toBe(false);
    expect(PreservationManifestSchema.safeParse(manifestOf({ complete: true })).success).toBe(false);
    expect(
      PreservationManifestSchema.safeParse(
        manifestOf({ counts: { selected: 2, exported: 2, failed: 0, skipped: 0, locked: 0, bytes: 10 } }),
      ).success,
    ).toBe(false);
  });

  it('accepts an incomplete package with no failed copy when an original was skipped (FL-74)', () => {
    expect(
      PreservationManifestSchema.safeParse(
        manifestOf({ counts: { selected: 3, exported: 2, failed: 0, skipped: 1, locked: 0, bytes: 10 } }),
      ).success,
    ).toBe(true);
  });

  it('refuses a manifest that does not digest its index', () => {
    expect(PreservationManifestSchema.safeParse(manifestOf({ files: {} })).success).toBe(false);
  });

  it('matches a document only against its own digest and size', () => {
    const bytes = Buffer.from('{"a":1}');
    const digest = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
    expect(matchesDigest(bytes, digest)).toBe(true);
    expect(matchesDigest(Buffer.from('{"a":2}'), digest)).toBe(false);
    expect(matchesDigest(bytes, undefined)).toBe(false);
  });
});

describe('index entries', () => {
  const line = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      sourceAssetId: sourceId,
      originalFileName: 'lake.jpg',
      type: 'IMAGE',
      locked: false,
      original: { path: `originals/${sourceId}.jpg`, sha1, sha256, bytes: 5 },
      metadata: { path: `metadata/${sourceId}.json`, sha256, bytes: 5 },
      ...overrides,
    });

  it('accepts a line whose paths belong to its identity', () => {
    expect(checkPreservationEntry(line()).ok).toBe(true);
  });

  it('refuses traversal, a path of another identity and unknown fields', () => {
    expect(checkPreservationEntry(line({ original: { path: '../etc/passwd', sha1, sha256, bytes: 5 } })).ok).toBe(
      false,
    );
    expect(
      checkPreservationEntry(
        line({ metadata: { path: 'metadata/22222222-2222-4222-8222-222222222222.json', sha256, bytes: 5 } }),
      ).ok,
    ).toBe(false);
    expect(checkPreservationEntry(line({ owner: 'somebody else' })).ok).toBe(false);
    expect(checkPreservationEntry('not json').ok).toBe(false);
    const badSha1 = line({ original: { path: `originals/${sourceId}.jpg`, sha1: 'x', sha256, bytes: 5 } });
    expect(PreservationEntrySchema.safeParse(JSON.parse(badSha1)).success).toBe(false);
  });
});

describe('sidecars', () => {
  it('round-trips through the written form', () => {
    const sidecar = sidecarOf({ tags: ['Travel/Italy'], lock: { reason: 'marked', lockedAt: null } });
    const parsed = PreservationSidecarSchema.parse(JSON.parse(preservationJson(sidecar).toString('utf8')));
    expect(parsed).toEqual(sidecar);
  });

  it('refuses a sidecar with fields it does not know', () => {
    expect(PreservationSidecarSchema.safeParse({ ...sidecarOf(), extra: true }).success).toBe(false);
  });
});

describe(orderPreservationAlbums.name, () => {
  const album = (id: string, overrides: Partial<PreservationAlbum> = {}): PreservationAlbum => ({
    id,
    name: id,
    description: '',
    kind: 'album',
    parentId: null,
    icon: null,
    order: null,
    ...overrides,
  });
  const collection = '33333333-3333-4333-8333-333333333333';
  const child = '44444444-4444-4444-8444-444444444444';

  it('creates every parent before its children', () => {
    const ordered = orderPreservationAlbums([
      album(child, { parentId: collection }),
      album(collection, { kind: 'collection' }),
    ]);
    expect(ordered.map((item) => item.id)).toEqual([collection, child]);
  });

  it('refuses cycles, missing parents and duplicates', () => {
    const cycle = [album(child, { parentId: collection }), album(collection, { parentId: child })];
    expect(() => orderPreservationAlbums(cycle)).toThrow(PreservationPackageError);
    expect(() => orderPreservationAlbums([album(child, { parentId: collection })])).toThrow(PreservationPackageError);
    expect(() => orderPreservationAlbums([album(child), album(child)])).toThrow(PreservationPackageError);
  });

  it('nests an album only in a top-level collection, one level deep', () => {
    const top = album(collection, { kind: 'collection' });
    const byId = new Map([[collection, top]]);
    expect(restoredAlbumParent(album(child, { parentId: collection }), byId)).toBe(collection);
    expect(restoredAlbumParent(album(child, { kind: 'collection', parentId: collection }), byId)).toBeNull();
    const notACollection = new Map([[collection, album(collection)]]);
    expect(restoredAlbumParent(album(child, { parentId: collection }), notACollection)).toBeNull();
  });
});

describe('descriptions', () => {
  it('separates the owner’s paragraphs from generated ones', () => {
    expect(splitDescription('Our first trip.\n\nAI description: A lake below mountains.')).toEqual({
      manual: 'Our first trip.',
      generated: ['A lake below mountains.'],
    });
    expect(splitDescription(null)).toEqual({ manual: null, generated: [] });
  });

  it('restores only a description the owner wrote', () => {
    expect(manualDescription(sidecarOf({ description: { text: 'Mine', source: 'manual', model: null } }))).toBe('Mine');
    const generated = sidecarOf({ description: { text: 'Model text', source: 'generated', model: 'x' } });
    expect(manualDescription(generated)).toBeNull();
  });

  it('never treats a rating of zero as a rating', () => {
    expect(restorableRating(0)).toBeNull();
    expect(restorableRating(4)).toBe(4);
  });
});

describe(compareWithLibrary.name, () => {
  it('fills what the library lacks and asks about what differs', () => {
    const comparison = compareWithLibrary(
      sidecarOf({
        description: { text: 'Mine', source: 'manual', model: null },
        location: { latitude: 45.9, longitude: 9.2, city: null, state: null, country: null },
        rating: 4,
      }),
      libraryOf({ description: 'Something else', rating: null }),
      { restoreEditRecipes: true },
    );
    expect(comparison.fills).toEqual(expect.arrayContaining(['date', 'location', 'rating']));
    expect(comparison.conflicts).toEqual([{ field: 'description', archived: 'Mine', current: 'Something else' }]);
  });

  it('ignores generated paragraphs on both sides', () => {
    const comparison = compareWithLibrary(
      sidecarOf({ description: { text: 'Mine', source: 'manual', model: null } }),
      libraryOf({ description: 'Mine\n\nAI description: generated text' }),
      { restoreEditRecipes: true },
    );
    expect(comparison.conflicts).toEqual([]);
    expect(comparison.fills).not.toContain('description');
  });

  it('adds a favourite and a lock but never removes either', () => {
    const options = { restoreEditRecipes: true };
    expect(compareWithLibrary(sidecarOf({ isFavorite: true }), libraryOf(), options).fills).toContain('favorite');
    const unfavourite = compareWithLibrary(sidecarOf({ isFavorite: false }), libraryOf({ isFavorite: true }), options);
    expect(unfavourite.fills).not.toContain('favorite');

    const locked = sidecarOf({ lock: { reason: 'detected', lockedAt: null } });
    expect(compareWithLibrary(locked, libraryOf(), { restoreEditRecipes: true }).lock).toBe(true);
    expect(compareWithLibrary(locked, libraryOf({ locked: true }), { restoreEditRecipes: true }).lock).toBe(false);
    expect(compareWithLibrary(sidecarOf(), libraryOf({ locked: true }), { restoreEditRecipes: true }).lock).toBe(false);
  });

  it('treats the same instant written two ways as the same date', () => {
    const comparison = compareWithLibrary(sidecarOf(), libraryOf({ dateTimeOriginal: '2024-06-01T12:00:00+02:00' }), {
      restoreEditRecipes: true,
    });
    expect(comparison.conflicts).toEqual([]);
    expect(comparison.fills).not.toContain('date');
  });

  it('asks about edit recipes only when they are being restored', () => {
    const edited = sidecarOf({ edits: { isEdited: true, recipe: [{ action: 'rotate', parameters: { angle: 90 } }] } });
    const library = libraryOf({ editRecipe: [{ action: 'crop', parameters: { x: 0, y: 0, width: 10, height: 10 } }] });
    const conflicts = compareWithLibrary(edited, library, { restoreEditRecipes: true }).conflicts;
    expect(conflicts.map((item) => item.field)).toEqual(['editRecipe']);
    expect(compareWithLibrary(edited, library, { restoreEditRecipes: false }).conflicts).toEqual([]);
  });
});

describe(fieldsToRestore.name, () => {
  it('restores everything to a new original', () => {
    const fields = fieldsToRestore({
      created: true,
      comparison: null,
      decisions: {},
      conflictDefault: 'keep',
      restoreEditRecipes: false,
    });
    expect(fields.has('description')).toBe(true);
    expect(fields.has('editRecipe')).toBe(false);
  });

  it('fills an existing original and replaces only what the owner chose, or the default', () => {
    const comparison = {
      fills: ['rating' as const],
      conflicts: [
        { field: 'description' as const, archived: 'a', current: 'b' },
        { field: 'location' as const, archived: '1, 2', current: '3, 4' },
      ],
      lock: false,
    };
    const keep = fieldsToRestore({
      created: false,
      comparison,
      decisions: { description: 'replace' },
      conflictDefault: 'keep',
      restoreEditRecipes: true,
    });
    expect([...keep].sort()).toEqual(['description', 'rating']);

    const replace = fieldsToRestore({
      created: false,
      comparison,
      decisions: { description: 'keep' },
      conflictDefault: 'replace',
      restoreEditRecipes: true,
    });
    expect([...replace].sort()).toEqual(['location', 'rating']);
  });

  it('keeps only known fields and choices from a client', () => {
    expect(sanitizeDecisions({ description: 'replace', owner: 'replace', rating: 'maybe' })).toEqual({
      description: 'replace',
    });
    expect(sanitizeDecisions(null)).toEqual({});
  });
});

describe(parsePreservationSnapshot.name, () => {
  const packageId = '0195e2a0-0000-7000-8000-000000000001';
  const restoreId = '0195e2a0-0000-7000-8000-000000000002';

  it('reads each kind', () => {
    const snapshot = parsePreservationSnapshot(MediaOperationKind.PreservationExport, { packageId, elevated: true });
    expect(snapshot).toMatchObject({
      kind: 'preservation-export',
      elevated: true,
    });
    expect(parsePreservationSnapshot(MediaOperationKind.PreservationRestore, { packageId, restoreId })).toMatchObject({
      kind: 'preservation-restore',
      restoreId,
    });
  });

  it('refuses a snapshot without its subject and a kind that is not preservation', () => {
    const verify = MediaOperationKind.PreservationVerify;
    expect(() => parsePreservationSnapshot(verify, {})).toThrow(PreservationPackageError);
    expect(() => parsePreservationSnapshot(MediaOperationKind.PreservationReview, { packageId })).toThrow(
      PreservationPackageError,
    );
    expect(() => parsePreservationSnapshot(MediaOperationKind.Bulk, { packageId })).toThrow(PreservationPackageError);
  });
});

describe('small rules', () => {
  it('renames archive refusals for a package', () => {
    expect(preservationArchiveCode('bundle_zip64')).toBe('package_zip64');
    expect(preservationArchiveCode('original_missing')).toBe('original_missing');
  });

  it('calls a package verified only when nothing is missing, changed or unexplained', () => {
    expect(verificationStatus({ missing: 0, changed: 0, unexpected: 0, documentsChanged: 0 })).toBe('verified');
    expect(verificationStatus({ missing: 1, changed: 0, unexpected: 0, documentsChanged: 0 })).toBe('problems');
    expect(verificationStatus({ missing: 0, changed: 0, unexpected: 2, documentsChanged: 0 })).toBe('problems');
  });

  it('describes a scope without naming anything in it', () => {
    expect(describePreservationScope({ filter: {} })).toBe('Whole library');
    expect(describePreservationScope({ assetIds: ['a', 'b'] })).toBe('2 chosen items');
    expect(describePreservationScope({ filter: { isFavorite: { eq: true }, takenAt: { gte: 'x' } } })).toBe(
      'Library items matching: isFavorite, takenAt',
    );
  });
});
