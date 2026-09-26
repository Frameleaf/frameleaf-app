/**
 * Preservation packages (FL-74, `IMP-006`): the portable format and the rules around it.
 *
 * Pure functions only: no database, no Nest, no file system. A package is a directory — or a ZIP of
 * one — with this layout and nothing else:
 *
 *   manifest.json            format, package id, counts, restoration support and a SHA-256 for
 *                            every index document below
 *   assets.jsonl             one line per original: its paths, byte counts, SHA-1 and SHA-256, and
 *                            the digest of its metadata sidecar
 *   albums.json              the owner's albums and collections the originals belong to
 *   people.json              the named people whose faces appear in them
 *   tags.json                the tags applied to them
 *   originals/<id>.<ext>     independent copies of the original bytes
 *   metadata/<id>.json       one sidecar per original: dates, place, description and where it came
 *                            from, rating, favourite, archive, the Locked record, tags, albums,
 *                            faces, Live Photo and stack links, the edit recipe, document
 *                            corrections, moment notes and generated-metadata provenance
 *
 * The manifest is the root of trust inside the package, as in a Studio bundle (FL-91): it digests
 * the index documents, the index digests every original and sidecar, and nothing is believed before
 * its digest is checked. Checksums detect damage and inconsistent copies; they do not authenticate a
 * package against deliberate rewriting, which is why a package is only ever restored into the
 * account of the person who asked for it, never over an existing original, and never as anything
 * but that person's own media.
 *
 * Two rules decide what a restoration does with each part (see {@link PRESERVATION_SUPPORT}):
 *
 * - **Manual metadata is restored; generated metadata is provenance.** A description the owner
 *   wrote comes back as their description. A generated one, model scores and generated moment
 *   captions come back only as a record of what was there, never as if the owner had written them.
 * - **An existing original wins.** Bytes the library already holds are matched, not copied again;
 *   a field the library already has a different value for is a conflict the owner decides.
 */

import { createHash } from 'node:crypto';
import z from 'zod';
import { MediaOperationDestination, MediaOperationKind } from 'src/enum.js';
import { ZipReadLimits, zipEntryNameProblem } from 'src/utils/studio-bundle.js';
import { canonicalJson } from 'src/utils/studio-project.js';

/* ------------------------------------------------------------------ */
/* Constants                                                            */
/* ------------------------------------------------------------------ */

export const PRESERVATION_FORMAT = 'frameleaf-preservation-package';
/** The manifest and sidecar shape version. Bumping it is a migration, never a reinterpretation. */
export const PRESERVATION_SCHEMA_VERSION = 1;

export const PRESERVATION_MANIFEST_ENTRY = 'manifest.json';
export const PRESERVATION_INDEX_ENTRY = 'assets.jsonl';
export const PRESERVATION_ALBUMS_ENTRY = 'albums.json';
export const PRESERVATION_PEOPLE_ENTRY = 'people.json';
export const PRESERVATION_TAGS_ENTRY = 'tags.json';
export const PRESERVATION_ORIGINALS_PREFIX = 'originals/';
export const PRESERVATION_METADATA_PREFIX = 'metadata/';

/** The documents the manifest digests. */
export const PRESERVATION_DOCUMENTS = [
  PRESERVATION_INDEX_ENTRY,
  PRESERVATION_ALBUMS_ENTRY,
  PRESERVATION_PEOPLE_ENTRY,
  PRESERVATION_TAGS_ENTRY,
] as const;
export type PreservationDocument = (typeof PRESERVATION_DOCUMENTS)[number];

/**
 * Originals in one package. A larger library is preserved as several packages, chosen by date or
 * album, so that one package stays a size a person can move, verify and restore.
 */
export const PRESERVATION_MAX_ITEMS = 100_000;
export const PRESERVATION_MAX_MANIFEST_BYTES = 1024 * 1024;
/** Albums, people and tags documents. */
export const PRESERVATION_MAX_COLLECTION_BYTES = 32 * 1024 * 1024;
export const PRESERVATION_MAX_SIDECAR_BYTES = 4 * 1024 * 1024;
/** The index is streamed line by line; this bounds one line, not the file. */
export const PRESERVATION_MAX_INDEX_LINE_BYTES = 64 * 1024;
export const PRESERVATION_MAX_INDEX_BYTES = 256 * 1024 * 1024;
/** The largest package this server will read. */
export const PRESERVATION_MAX_PACKAGE_BYTES = 16 * 1024 ** 4;
/** The largest package accepted through the browser. Bigger ones are named by path by an administrator. */
export const PRESERVATION_UPLOAD_MAX_BYTES = 64 * 1024 ** 3;
/** How long an uploaded package is kept for verification and restoration. */
export const PRESERVATION_UPLOAD_TTL_HOURS = 72;
/** Automatic attempts at one item: the first, and the one retry every operation gets. */
export const PRESERVATION_ITEM_ATTEMPTS = 2;

/** The kinds the preservation worker claims, and nothing else. */
export const PRESERVATION_KINDS: readonly MediaOperationKind[] = [
  MediaOperationKind.PreservationExport,
  MediaOperationKind.PreservationVerify,
  MediaOperationKind.PreservationReview,
  MediaOperationKind.PreservationRestore,
];

/** Packages are written and read on this server; there is no remote to choose. */
export const PRESERVATION_DESTINATION = MediaOperationDestination.Local;

export const isPreservationKind = (kind: string): kind is MediaOperationKind =>
  (PRESERVATION_KINDS as readonly string[]).includes(kind);

const COLLECTION_DOCUMENTS: ReadonlySet<string> = new Set([
  PRESERVATION_ALBUMS_ENTRY,
  PRESERVATION_PEOPLE_ENTRY,
  PRESERVATION_TAGS_ENTRY,
]);

/** How large a document entry may be, or null for entries that are only streamed. */
export const preservationDocumentLimit = (name: string): number | null => {
  if (name === PRESERVATION_MANIFEST_ENTRY) {
    return PRESERVATION_MAX_MANIFEST_BYTES;
  }
  if (COLLECTION_DOCUMENTS.has(name)) {
    return PRESERVATION_MAX_COLLECTION_BYTES;
  }
  if (name === PRESERVATION_INDEX_ENTRY) {
    return PRESERVATION_MAX_INDEX_BYTES;
  }
  if (name.startsWith(PRESERVATION_METADATA_PREFIX)) {
    return PRESERVATION_MAX_SIDECAR_BYTES;
  }
  return null;
};

/** The FL-91 archive reader, with a package's limits: ZIP64 allowed, one entry per original and sidecar. */
export const PRESERVATION_ZIP_LIMITS: ZipReadLimits = Object.freeze({
  maxBytes: PRESERVATION_MAX_PACKAGE_BYTES,
  maxEntries: PRESERVATION_MAX_ITEMS * 2 + 16,
  maxDirectoryBytes: 64 * 1024 * 1024,
  maxUncompressedBytes: PRESERVATION_MAX_PACKAGE_BYTES,
  documentLimit: preservationDocumentLimit,
  allowZip64: true,
});

/* ------------------------------------------------------------------ */
/* Errors                                                               */
/* ------------------------------------------------------------------ */

/** A package that cannot be believed, with a stable code the client translates. */
export class PreservationPackageError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** The archive reader's `bundle_*` codes, renamed for a package so the client says the right thing. */
export const preservationArchiveCode = (code: string): string =>
  code.startsWith('bundle_') ? `package_${code.slice('bundle_'.length)}` : code;

/* ------------------------------------------------------------------ */
/* Identity                                                             */
/* ------------------------------------------------------------------ */

/**
 * A stable UUID derived from a namespace. Albums and people a restoration creates get ids from the
 * package identity and their id in the package, so restoring the same package again — or retrying —
 * finds them instead of creating more. Shaped as a version-4 UUID so every id validator accepts it.
 */
export const preservationDerivedId = (namespace: string): string => {
  const bytes = createHash('sha256').update(`frameleaf-preservation:${namespace}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const plainExtension = /^\.[\da-z]{1,12}$/;

/** The entry names of one original and its sidecar: named by id, never by the original's name. */
export const preservationEntryNames = (sourceAssetId: string, originalFileName: string) => {
  const dot = originalFileName.lastIndexOf('.');
  const extension = dot > 0 ? originalFileName.slice(dot).toLowerCase() : '';
  return {
    original: `${PRESERVATION_ORIGINALS_PREFIX}${sourceAssetId}${plainExtension.test(extension) ? extension : ''}`,
    metadata: `${PRESERVATION_METADATA_PREFIX}${sourceAssetId}.json`,
  };
};

/** True when `path` is where the original of `sourceAssetId` may live. */
export const isOriginalEntryFor = (path: string, sourceAssetId: string): boolean => {
  const base = `${PRESERVATION_ORIGINALS_PREFIX}${sourceAssetId}`;
  return path === base || (path.startsWith(`${base}.`) && plainExtension.test(path.slice(base.length)));
};

/** The download name of a package: its own name, sanitized, never an id or a path. */
export const preservationFileName = (name: string): string => {
  const body =
    name
      .normalize('NFKD')
      .replaceAll(/[̀-ͯ]/g, '')
      .replaceAll(/[^\w\s-]+/g, '')
      .trim()
      .replaceAll(/[\s_]+/g, '-')
      .replaceAll(/-+/g, '-')
      .slice(0, 80)
      .replaceAll(/^-|-$/g, '') || 'library';
  return `${body}.frameleaf-preservation.zip`;
};

/* ------------------------------------------------------------------ */
/* Documents                                                            */
/* ------------------------------------------------------------------ */

const sha1Hex = z.string().regex(/^[\da-f]{40}$/);
const sha256Hex = z.string().regex(/^[\da-f]{64}$/);
const isoDate = z
  .string()
  .max(64)
  .refine((value) => !Number.isNaN(Date.parse(value)), 'not a date');
const entryName = z
  .string()
  .max(512)
  .refine((value) => zipEntryNameProblem(value) === null, 'not a plain relative entry name');
const shortText = z.string().max(1024);

const FileDigestSchema = z.object({ sha256: sha256Hex, bytes: z.int().nonnegative() }).strict();
export type PreservationFileDigest = z.infer<typeof FileDigestSchema>;

/** What a restoration does with one kind of information, as the package and the product state it. */
export const PRESERVATION_SUPPORT_LEVELS = [
  'restored',
  'restored-when-empty',
  'provenance-only',
  'not-included',
] as const;
export type PreservationSupportLevel = (typeof PRESERVATION_SUPPORT_LEVELS)[number];

export const PRESERVATION_SUPPORT_CATEGORIES = [
  'originals',
  'dates',
  'places',
  'descriptions',
  'ratings',
  'favorites',
  'archive',
  'locked',
  'albums',
  'tags',
  'people',
  'editRecipes',
  'livePhotos',
  'stacks',
  'documentCorrections',
  'momentNotes',
  'generatedDescriptions',
  'generatedMoments',
  'cameraDetails',
  'sharing',
  'pets',
  'studioProjects',
  'memories',
] as const;
export type PreservationSupportCategory = (typeof PRESERVATION_SUPPORT_CATEGORIES)[number];

/**
 * The truth about restoration, category by category. The client shows this list before an export
 * and before a restore, so nobody reads "download complete" as "everything comes back".
 *
 * - `restored`: comes back as it was. For an original the library already holds, a different value
 *   is a conflict the owner decides; nothing is overwritten by default.
 * - `restored-when-empty`: comes back only where the library has no value of its own.
 * - `provenance-only`: kept with the restored item as a record, never applied as the owner's data.
 * - `not-included`: not in a package at all.
 */
export const PRESERVATION_SUPPORT: Readonly<Record<PreservationSupportCategory, PreservationSupportLevel>> =
  Object.freeze({
    originals: 'restored',
    dates: 'restored',
    places: 'restored',
    descriptions: 'restored',
    ratings: 'restored',
    favorites: 'restored',
    archive: 'restored',
    locked: 'restored',
    albums: 'restored',
    tags: 'restored',
    people: 'restored',
    editRecipes: 'restored',
    livePhotos: 'restored',
    stacks: 'restored',
    documentCorrections: 'restored-when-empty',
    momentNotes: 'restored-when-empty',
    generatedDescriptions: 'provenance-only',
    generatedMoments: 'provenance-only',
    cameraDetails: 'provenance-only',
    sharing: 'not-included',
    pets: 'not-included',
    studioProjects: 'not-included',
    memories: 'not-included',
  });

export const PreservationManifestSchema = z
  .object({
    format: z.literal(PRESERVATION_FORMAT),
    schemaVersion: z.literal(PRESERVATION_SCHEMA_VERSION),
    /** The package's own identity. Albums and people restored from it derive their ids from it. */
    packageId: z.uuid(),
    /** What the owner called it. */
    name: z.string().min(1).max(200),
    createdAt: isoDate,
    producer: z.object({ product: z.literal('frameleaf'), version: z.string().max(64) }).strict(),
    scope: z
      .object({
        description: z.string().max(2048),
        includeLocked: z.boolean(),
        includeMetadata: z.boolean(),
      })
      .strict(),
    counts: z
      .object({
        selected: z.int().nonnegative(),
        exported: z.int().nonnegative(),
        failed: z.int().nonnegative(),
        skipped: z.int().nonnegative(),
        locked: z.int().nonnegative(),
        bytes: z.int().nonnegative(),
      })
      .strict(),
    complete: z.boolean(),
    files: z.partialRecord(z.enum(PRESERVATION_DOCUMENTS), FileDigestSchema),
    support: z.partialRecord(z.enum(PRESERVATION_SUPPORT_CATEGORIES), z.enum(PRESERVATION_SUPPORT_LEVELS)),
  })
  .strict()
  .refine((manifest) => PRESERVATION_INDEX_ENTRY in manifest.files, 'the index must be digested')
  .refine((manifest) => manifest.counts.exported <= PRESERVATION_MAX_ITEMS, 'too many originals for one package')
  .refine(
    (manifest) =>
      manifest.counts.selected === manifest.counts.exported + manifest.counts.failed + manifest.counts.skipped,
    'counts do not add up',
  )
  // A package with a failed copy is never complete. One without may still be incomplete: an original
  // skipped because it was unavailable is missing too (FL-74), while a Locked item left out on
  // purpose is not — so an incomplete package with no failures must at least have skipped something.
  .refine(
    (manifest) =>
      manifest.complete ? manifest.counts.failed === 0 : manifest.counts.failed > 0 || manifest.counts.skipped > 0,
    'completeness does not match the counts',
  );
export type PreservationManifest = z.infer<typeof PreservationManifestSchema>;

const AssetTypeLiteral = z.enum(['IMAGE', 'VIDEO', 'AUDIO', 'OTHER']);

/** One line of `assets.jsonl`. */
export const PreservationEntrySchema = z
  .object({
    sourceAssetId: z.uuid(),
    originalFileName: z.string().min(1).max(1024),
    type: AssetTypeLiteral,
    locked: z.boolean(),
    original: z.object({ path: entryName, sha1: sha1Hex, sha256: sha256Hex, bytes: z.int().nonnegative() }).strict(),
    metadata: z.object({ path: entryName, sha256: sha256Hex, bytes: z.int().nonnegative() }).strict().nullable(),
  })
  .strict()
  .refine(
    (entry) => isOriginalEntryFor(entry.original.path, entry.sourceAssetId),
    'original path and identity disagree',
  )
  .refine(
    (entry) => !entry.metadata || entry.metadata.path === preservationEntryNames(entry.sourceAssetId, '').metadata,
    'sidecar path and identity disagree',
  );
export type PreservationEntry = z.infer<typeof PreservationEntrySchema>;

export const PreservationAlbumSchema = z
  .object({
    id: z.uuid(),
    name: z.string().max(1024),
    description: z.string().max(65_536),
    kind: z.enum(['album', 'collection']),
    parentId: z.uuid().nullable(),
    icon: z.string().max(256).nullable(),
    order: z.enum(['asc', 'desc']).nullable(),
  })
  .strict();
export type PreservationAlbum = z.infer<typeof PreservationAlbumSchema>;
export const PreservationAlbumsSchema = z.array(PreservationAlbumSchema).max(100_000);

export const PreservationPersonSchema = z
  .object({
    id: z.uuid(),
    name: z.string().max(1024),
    birthDate: z.string().max(32).nullable(),
    isHidden: z.boolean(),
    isFavorite: z.boolean(),
    color: z.string().max(32).nullable(),
  })
  .strict();
export type PreservationPerson = z.infer<typeof PreservationPersonSchema>;
export const PreservationPeopleSchema = z.array(PreservationPersonSchema).max(100_000);

export const PreservationTagSchema = z
  .object({ value: z.string().min(1).max(1024), color: z.string().max(32).nullable() })
  .strict();
export type PreservationTag = z.infer<typeof PreservationTagSchema>;
export const PreservationTagsSchema = z.array(PreservationTagSchema).max(100_000);

const RegionSchema = z
  .object({
    x1: z.number(),
    y1: z.number(),
    x2: z.number(),
    y2: z.number(),
    x3: z.number(),
    y3: z.number(),
    x4: z.number(),
    y4: z.number(),
  })
  .strict();

/** The per-original sidecar, `metadata/<id>.json`. */
export const PreservationSidecarSchema = z
  .object({
    schemaVersion: z.literal(PRESERVATION_SCHEMA_VERSION),
    sourceAssetId: z.uuid(),
    originalFileName: z.string().min(1).max(1024),
    type: AssetTypeLiteral,
    checksum: z.object({ sha1: sha1Hex, sha256: sha256Hex }).strict(),
    dates: z
      .object({
        fileCreatedAt: isoDate,
        fileModifiedAt: isoDate,
        localDateTime: isoDate.nullable(),
        dateTimeOriginal: isoDate.nullable(),
        timeZone: z.string().max(64).nullable(),
      })
      .strict(),
    isFavorite: z.boolean(),
    visibility: z.enum(['timeline', 'archive', 'hidden']),
    lock: z
      .object({ reason: z.enum(['marked', 'detected', 'immich-locked-folder']), lockedAt: isoDate.nullable() })
      .strict()
      .nullable(),
    location: z
      .object({
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        city: shortText.nullable(),
        state: shortText.nullable(),
        country: shortText.nullable(),
      })
      .strict()
      .nullable(),
    description: z
      .object({
        text: z.string().max(65_536),
        source: z.enum(['manual', 'generated']),
        model: z.string().max(256).nullable(),
      })
      .strict()
      .nullable(),
    rating: z.int().min(-1).max(5).nullable(),
    camera: z.record(z.string().max(64), z.union([shortText, z.number(), z.null()])).nullable(),
    tags: z.array(z.string().min(1).max(1024)).max(1000),
    albums: z.array(z.uuid()).max(10_000),
    faces: z
      .array(
        z
          .object({
            personId: z.uuid(),
            imageWidth: z.int().positive(),
            imageHeight: z.int().positive(),
            x1: z.number(),
            y1: z.number(),
            x2: z.number(),
            y2: z.number(),
            sourceType: z.enum(['machine-learning', 'exif', 'manual']),
          })
          .strict(),
      )
      .max(1000),
    livePhotoVideoId: z.uuid().nullable(),
    stack: z.object({ id: z.uuid(), primaryAssetId: z.uuid() }).strict().nullable(),
    edits: z
      .object({
        isEdited: z.boolean(),
        recipe: z
          .array(z.object({ action: z.string().max(64), parameters: z.record(z.string(), z.unknown()) }).strict())
          .max(100),
      })
      .strict(),
    documents: z
      .array(
        z
          .object({
            key: z.string().min(1).max(256),
            action: z.enum(['confirm', 'correct', 'dismiss']),
            value: z.string().max(10_000).nullable(),
            region: RegionSchema.nullable(),
          })
          .strict(),
      )
      .max(2000),
    moments: z
      .object({
        manual: z
          .array(
            z
              .object({
                timestampMs: z.int().nonnegative(),
                endMs: z.int().nonnegative().nullable(),
                caption: z.string().max(10_000).nullable(),
                transcript: z.string().max(100_000).nullable(),
              })
              .strict(),
          )
          .max(2000),
        generated: z
          .array(
            z
              .object({
                timestampMs: z.int().nonnegative(),
                endMs: z.int().nonnegative().nullable(),
                caption: z.string().max(10_000).nullable(),
                provenance: z.record(z.string(), z.unknown()).nullable(),
              })
              .strict(),
          )
          .max(2000),
      })
      .strict(),
    /** Generated-metadata provenance: what produced what, kept as a record only. */
    provenance: z.record(z.string(), z.unknown()),
  })
  .strict();
export type PreservationSidecar = z.infer<typeof PreservationSidecarSchema>;

export type PreservationDocumentCheck<T> = { ok: true; value: T } | { ok: false; detail: string };

/** Parse and validate one JSON document. Never throws: the caller decides what a bad document means. */
export const checkPreservationJson = <T>(schema: z.ZodType<T>, bytes: Buffer): PreservationDocumentCheck<T> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { ok: false, detail: 'not JSON' };
  }
  const checked = schema.safeParse(parsed);
  if (!checked.success) {
    const issue = checked.error.issues[0];
    return {
      ok: false,
      detail: `${issue?.path.join('.') || 'document'}: ${issue?.message ?? 'invalid'}`.slice(0, 200),
    };
  }
  return { ok: true, value: checked.data };
};

/** One index line, validated. */
export const checkPreservationEntry = (line: string): PreservationDocumentCheck<PreservationEntry> =>
  checkPreservationJson(PreservationEntrySchema, Buffer.from(line, 'utf8'));

/** A document's bytes are what the manifest says they are. */
export const matchesDigest = (bytes: Buffer, expected: PreservationFileDigest | undefined): boolean =>
  !!expected && bytes.length === expected.bytes && createHash('sha256').update(bytes).digest('hex') === expected.sha256;

/**
 * Whether the manifest's document digests (index, albums, people, tags) are the ones a review recorded.
 * A package read from a server folder can be rewritten in place between review and apply; what was
 * reviewed is what may be applied (FL-74). A review that recorded nothing never matches.
 */
export const sameReviewedDocuments = (reviewed: unknown, current: PreservationManifest['files']): boolean => {
  if (!reviewed || typeof reviewed !== 'object' || Array.isArray(reviewed)) {
    return false;
  }
  const recorded = reviewed as Record<string, { sha256?: unknown; bytes?: unknown } | undefined>;
  const names = new Set([...Object.keys(recorded), ...Object.keys(current)]);
  for (const name of names) {
    const was = recorded[name];
    const now = current[name as PreservationDocument];
    if (!was || !now || was.sha256 !== now.sha256 || was.bytes !== now.bytes) {
      return false;
    }
  }
  return true;
};

/** Serialize a document the way the export writes it, so its digest is reproducible. */
export const preservationJson = (value: unknown): Buffer =>
  Buffer.from(`${JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? String(item) : item), 2)}\n`);

/**
 * Albums in an order that creates every parent before its children. Refuses duplicate ids, missing
 * parents and cycles: a package that lies about its hierarchy is refused, never half-applied.
 */
export const orderPreservationAlbums = (albums: readonly PreservationAlbum[]): PreservationAlbum[] => {
  const byId = new Map(albums.map((album) => [album.id, album]));
  if (byId.size !== albums.length) {
    throw new PreservationPackageError('package_albums_invalid', 'The package lists an album twice');
  }
  const ordered: PreservationAlbum[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();
  const visit = (album: PreservationAlbum) => {
    if (done.has(album.id)) {
      return;
    }
    if (visiting.has(album.id)) {
      throw new PreservationPackageError('package_albums_invalid', 'The album hierarchy contains a cycle');
    }
    visiting.add(album.id);
    if (album.parentId) {
      const parent = byId.get(album.parentId);
      if (!parent) {
        throw new PreservationPackageError(
          'package_albums_invalid',
          'An album names a parent the package does not list',
        );
      }
      visit(parent);
    }
    visiting.delete(album.id);
    done.add(album.id);
    ordered.push(album);
  };
  for (const album of albums) {
    visit(album);
  }
  return ordered;
};

/**
 * Where a restored album may hang: collections stay at the top level and an album nests only in a
 * collection, one level deep (the product's vocabulary). A parent that breaks the rule is dropped
 * and the album is restored at the top level rather than refused.
 */
export const restoredAlbumParent = (
  album: PreservationAlbum,
  byId: ReadonlyMap<string, PreservationAlbum>,
): string | null => {
  if (album.kind !== 'album' || !album.parentId) {
    return null;
  }
  const parent = byId.get(album.parentId);
  return parent && parent.kind === 'collection' && !parent.parentId ? parent.id : null;
};

/* ------------------------------------------------------------------ */
/* Scope                                                                */
/* ------------------------------------------------------------------ */

/**
 * A short, human description of what an export selected, stored with the package and written into
 * its manifest. It names the kinds of condition, never an asset or album name.
 */
export const describePreservationScope = (scope: {
  assetIds?: readonly string[];
  filter?: Record<string, unknown>;
}): string => {
  if (scope.assetIds) {
    return `${scope.assetIds.length} chosen items`;
  }
  const keys = Object.keys(scope.filter ?? {}).filter(
    (key) => (scope.filter as Record<string, unknown>)[key] !== undefined,
  );
  return keys.length === 0 ? 'Whole library' : `Library items matching: ${keys.sort().join(', ')}`;
};

/* ------------------------------------------------------------------ */
/* Review: the package against the library                             */
/* ------------------------------------------------------------------ */

export const PRESERVATION_CONFLICT_FIELDS = [
  'date',
  'description',
  'location',
  'rating',
  'favorite',
  'archive',
  'editRecipe',
] as const;
export type PreservationConflictField = (typeof PRESERVATION_CONFLICT_FIELDS)[number];
export type PreservationDecision = 'keep' | 'replace';

export type PreservationConflict = {
  field: PreservationConflictField;
  /** The package's value, as text for the review. */
  archived: string | null;
  /** The library's value, as text for the review. */
  current: string | null;
};

/** What the library holds for an original the package also has. */
export type PreservationLibraryState = {
  dateTimeOriginal: string | null;
  description: string | null;
  latitude: number | null;
  longitude: number | null;
  rating: number | null;
  isFavorite: boolean;
  visibility: string;
  locked: boolean;
  editRecipe: Array<{ action: string; parameters: unknown }>;
};

export type PreservationComparison = {
  /** Both have a value and they differ: the owner decides. */
  conflicts: PreservationConflict[];
  /** Only the package has a value: restored without asking. */
  fills: PreservationConflictField[];
  /** The package says Locked and the library does not: always restored, never undone. */
  lock: boolean;
};

const sameInstant = (a: string, b: string) => Date.parse(a) === Date.parse(b);
const sameCoordinate = (a: number, b: number) => Math.abs(a - b) < 1e-6;
const recipeText = (recipe: ReadonlyArray<{ action: string; parameters: unknown }>) =>
  canonicalJson(recipe.map(({ action, parameters }) => ({ action, parameters })));
const describeRecipe = (recipe: ReadonlyArray<{ action: string }>) =>
  recipe.length === 0 ? null : recipe.map(({ action }) => action).join(', ');

/** How enrichment marks the paragraph it appends to a description (`image-enrichment.service.ts`). */
export const GENERATED_DESCRIPTION_MARK = 'AI description:';

/**
 * Split a stored description into what the owner wrote and what enrichment appended. Enrichment
 * adds its text as a separate paragraph that starts with {@link GENERATED_DESCRIPTION_MARK}; every
 * other paragraph is the owner's.
 */
export const splitDescription = (
  description: string | null | undefined,
): { manual: string | null; generated: string[] } => {
  const manual: string[] = [];
  const generated: string[] = [];
  for (const part of (description ?? '').split(/\n{2,}/)) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed.startsWith(GENERATED_DESCRIPTION_MARK)) {
      generated.push(trimmed.slice(GENERATED_DESCRIPTION_MARK.length).trim());
    } else {
      manual.push(trimmed);
    }
  }
  return { manual: manual.length > 0 ? manual.join('\n\n') : null, generated };
};

/** The description a package may restore: only one the owner wrote. A generated one is provenance. */
export const manualDescription = (sidecar: PreservationSidecar): string | null =>
  sidecar.description?.source === 'manual' && sidecar.description.text.trim() ? sidecar.description.text : null;

/** A rating the API accepts: 0 was never a rating, it means none. */
export const restorableRating = (rating: number | null): number | null => (rating === 0 ? null : rating);

/**
 * Compare a package's metadata with an original the library already holds.
 *
 * Nothing the library has is ever removed: a favourite is added, never cleared; a lock is added,
 * never lifted; a field the library leaves empty is filled. Where both have a value and they differ
 * the owner decides, and the default is to keep the library's.
 */
export const compareWithLibrary = (
  sidecar: PreservationSidecar,
  library: PreservationLibraryState,
  options: { restoreEditRecipes: boolean },
): PreservationComparison => {
  const conflicts: PreservationConflict[] = [];
  const fills: PreservationConflictField[] = [];
  const consider = (
    field: PreservationConflictField,
    archived: string | null,
    current: string | null,
    same: boolean,
  ) => {
    if (archived === null || same) {
      return;
    }
    if (current === null) {
      fills.push(field);
    } else {
      conflicts.push({ field, archived, current });
    }
  };

  const date = sidecar.dates.dateTimeOriginal;
  consider(
    'date',
    date,
    library.dateTimeOriginal,
    !!date && !!library.dateTimeOriginal && sameInstant(date, library.dateTimeOriginal),
  );

  const description = manualDescription(sidecar);
  // Only the owner's own paragraphs are compared: a generated paragraph is neither side's to restore.
  const currentDescription = splitDescription(library.description).manual;
  consider('description', description, currentDescription, description === currentDescription);

  const location = sidecar.location;
  const currentLocation =
    library.latitude === null || library.longitude === null ? null : `${library.latitude}, ${library.longitude}`;
  consider(
    'location',
    location ? `${location.latitude}, ${location.longitude}` : null,
    currentLocation,
    !!location &&
      library.latitude !== null &&
      library.longitude !== null &&
      sameCoordinate(location.latitude, library.latitude) &&
      sameCoordinate(location.longitude, library.longitude),
  );

  const rating = restorableRating(sidecar.rating);
  const currentRating = restorableRating(library.rating);
  consider(
    'rating',
    rating === null ? null : String(rating),
    currentRating === null ? null : String(currentRating),
    rating === currentRating,
  );

  if (sidecar.isFavorite && !library.isFavorite) {
    fills.push('favorite');
  }

  // Archive is a place in the library, not a value one of them lacks: a difference is always the owner's call.
  if (
    (sidecar.visibility === 'archive' || sidecar.visibility === 'timeline') &&
    (library.visibility === 'archive' || library.visibility === 'timeline') &&
    sidecar.visibility !== library.visibility
  ) {
    conflicts.push({ field: 'archive', archived: sidecar.visibility, current: library.visibility });
  }

  if (options.restoreEditRecipes && sidecar.edits.recipe.length > 0) {
    consider(
      'editRecipe',
      describeRecipe(sidecar.edits.recipe),
      describeRecipe(library.editRecipe),
      recipeText(sidecar.edits.recipe) === recipeText(library.editRecipe),
    );
  }

  return { conflicts, fills, lock: !!sidecar.lock && !library.locked };
};

/**
 * The fields a restore writes for one original. A new original gets everything the package can
 * restore. An existing one gets its fills, and each conflict the owner resolved as `replace` — or,
 * where they chose nothing, the restoration's default.
 */
export const fieldsToRestore = (options: {
  created: boolean;
  comparison: PreservationComparison | null;
  decisions: Partial<Record<PreservationConflictField, PreservationDecision>>;
  conflictDefault: PreservationDecision;
  restoreEditRecipes: boolean;
}): Set<PreservationConflictField> => {
  if (options.created) {
    const all = new Set<PreservationConflictField>(PRESERVATION_CONFLICT_FIELDS);
    if (!options.restoreEditRecipes) {
      all.delete('editRecipe');
    }
    return all;
  }

  const fields = new Set<PreservationConflictField>(options.comparison?.fills);
  for (const conflict of options.comparison?.conflicts ?? []) {
    if ((options.decisions[conflict.field] ?? options.conflictDefault) === 'replace') {
      fields.add(conflict.field);
    }
  }
  if (!options.restoreEditRecipes) {
    fields.delete('editRecipe');
  }
  return fields;
};

/** Only known fields and the two decisions: anything else a client sends is dropped. */
export const sanitizeDecisions = (value: unknown): Partial<Record<PreservationConflictField, PreservationDecision>> => {
  const decisions: Partial<Record<PreservationConflictField, PreservationDecision>> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return decisions;
  }
  for (const field of PRESERVATION_CONFLICT_FIELDS) {
    const decision = (value as Record<string, unknown>)[field];
    if (decision === 'keep' || decision === 'replace') {
      decisions[field] = decision;
    }
  }
  return decisions;
};

/* ------------------------------------------------------------------ */
/* Job snapshots                                                        */
/* ------------------------------------------------------------------ */

export type PreservationExportSnapshot = {
  kind: 'preservation-export';
  packageId: string;
  requestKey: string | null;
  /** The submitting session was unlocked, which is what allowed Locked items into the selection. */
  elevated: boolean;
};

export type PreservationVerifySnapshot = { kind: 'preservation-verify'; packageId: string };

export type PreservationRestoreSnapshot = {
  kind: 'preservation-review' | 'preservation-restore';
  restoreId: string;
  packageId: string;
  requestKey: string | null;
};

export type PreservationSnapshot =
  PreservationExportSnapshot | PreservationVerifySnapshot | PreservationRestoreSnapshot;

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const uuidPattern = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

/** A job's snapshot, read back defensively: the column is data, not a contract. */
export const parsePreservationSnapshot = (kind: string, value: unknown): PreservationSnapshot => {
  const snapshot = asRecord(value);
  const packageId =
    typeof snapshot.packageId === 'string' && uuidPattern.test(snapshot.packageId) ? snapshot.packageId : '';
  const requestKey = typeof snapshot.requestKey === 'string' ? snapshot.requestKey : null;
  if (!packageId) {
    throw new PreservationPackageError('package_unavailable', 'The job does not name a package');
  }
  switch (kind) {
    case MediaOperationKind.PreservationExport: {
      return { kind: 'preservation-export', packageId, requestKey, elevated: snapshot.elevated === true };
    }
    case MediaOperationKind.PreservationVerify: {
      return { kind: 'preservation-verify', packageId };
    }
    case MediaOperationKind.PreservationReview:
    case MediaOperationKind.PreservationRestore: {
      const restoreId =
        typeof snapshot.restoreId === 'string' && uuidPattern.test(snapshot.restoreId) ? snapshot.restoreId : '';
      if (!restoreId) {
        throw new PreservationPackageError('restore_unavailable', 'The job does not name a restoration');
      }
      return {
        kind: kind === MediaOperationKind.PreservationReview ? 'preservation-review' : 'preservation-restore',
        restoreId,
        packageId,
        requestKey,
      };
    }
    default: {
      throw new PreservationPackageError('package_unavailable', `Not a preservation job: ${kind}`);
    }
  }
};

/** The verification outcome recorded on a package. */
export type PreservationVerification = {
  status: 'verified' | 'problems' | 'unreadable';
  reasonKey: string | null;
  checked: number;
  ok: number;
  missing: number;
  changed: number;
  unexpected: number;
  documentsChanged: string[];
  operationId: string;
  finishedAt: string;
};

export const verificationStatus = (counts: {
  missing: number;
  changed: number;
  unexpected: number;
  documentsChanged: number;
}): PreservationVerification['status'] =>
  counts.missing + counts.changed + counts.unexpected + counts.documentsChanged === 0 ? 'verified' : 'problems';

/** Progress as a whole percentage below 100 until the job has really finished. */
export const preservationProgress = (done: number, total: number): number =>
  total > 0 ? Math.min(99, Math.floor((done / total) * 100)) : 0;
