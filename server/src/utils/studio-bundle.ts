/**
 * Portable Studio project bundles (FL-91, `STU-204`).
 *
 * Pure functions only: no database, no Nest, no request. A bundle is a ZIP file with three kinds
 * of entry and nothing else:
 *
 *   manifest.json   what the bundle contains, with a SHA-256 for every other entry
 *   project.json    the stored envelope `{ schemaVersion, engine, engineRevision, graph }`,
 *                   serialized with {@link canonicalJson} so its digest is the revision digest
 *   media/...       optional copies of sources the exporting account was allowed to read
 *
 * Three rules shape everything here:
 *
 * - **The graph is opaque.** `project.json` is stored and returned byte for byte, so a field this
 *   version has never heard of survives export and import. The only edit an import makes is
 *   relinking source ids, at the exact keys FL-90's reference walker recognises and nowhere else.
 * - **The manifest is the root of trust inside the bundle.** Every other entry is digested there,
 *   and the import verifies each digest before believing an entry. The bundle file's own SHA-256
 *   is recorded on upload so the whole thing has one name.
 * - **Archive limits are enforced before any bytes are inflated.** Entry names are checked for
 *   traversal, entry counts, declared sizes and compression ratios are capped, ZIP64 and
 *   encryption are refused, and inflation stops at the declared size. A bundle that lies about
 *   itself is refused, never half-imported.
 */

import { createHash } from 'node:crypto';
import { createInflateRaw, inflateRawSync } from 'node:zlib';
import { MediaOperationDestination, MediaOperationKind } from 'src/enum.js';
import { compareCodeUnits } from 'src/utils/compare.js';
import {
  StudioProjectEnvelope,
  canonicalJson,
  checkStudioEnvelope,
  studioEnvelopeDigest,
} from 'src/utils/studio-project.js';
import {
  STUDIO_MAX_GRAPH_BYTES,
  StudioResourceKind,
  extractStudioResourceReferences,
  isStudioResourceKind,
  studioReferenceKey,
} from 'src/utils/studio-resources.js';

/* ------------------------------------------------------------------ */
/* Constants                                                            */
/* ------------------------------------------------------------------ */

export const STUDIO_BUNDLE_FORMAT = 'frameleaf-studio-bundle';
/** The manifest shape version. Bumping it is a migration, never a silent reinterpretation. */
export const STUDIO_BUNDLE_SCHEMA_VERSION = 1;

export const STUDIO_BUNDLE_MANIFEST_ENTRY = 'manifest.json';
export const STUDIO_BUNDLE_PROJECT_ENTRY = 'project.json';
export const STUDIO_BUNDLE_MEDIA_PREFIX = 'media/';

/** How long a finished export stays downloadable before the sweep removes the file. */
export const STUDIO_BUNDLE_EXPORT_TTL_HOURS = 72;
/** How long an uploaded bundle is kept for import, and for a re-import with a corrected mapping. */
export const STUDIO_BUNDLE_UPLOAD_TTL_HOURS = 24;

/** The whole file. Below the ZIP64 threshold on purpose: a bundle that needs ZIP64 is refused. */
export const STUDIO_BUNDLE_MAX_BYTES = 4 * 1024 * 1024 * 1024 - 1;
/** Entries in the central directory, including the two JSON documents. */
export const STUDIO_BUNDLE_MAX_ENTRIES = 2048;
/** The largest JSON entry: the graph limit plus room for the envelope and the manifest. */
export const STUDIO_BUNDLE_MAX_JSON_BYTES = STUDIO_MAX_GRAPH_BYTES + 1024 * 1024;
/** Above this size a deflated entry's ratio is checked; small entries compress arbitrarily well. */
export const STUDIO_BUNDLE_RATIO_FLOOR_BYTES = 64 * 1024;
/** Uncompressed-to-compressed ratio above which an entry is treated as a decompression bomb. */
export const STUDIO_BUNDLE_MAX_RATIO = 200;
/**
 * Everything the archive may inflate to, summed over its entries. Entries that share their
 * compressed bytes are refused separately; this caps the honest-looking case.
 */
export const STUDIO_BUNDLE_MAX_UNCOMPRESSED_BYTES = STUDIO_BUNDLE_MAX_BYTES;
/** The central directory is read into memory whole; this bounds that read. */
export const STUDIO_BUNDLE_MAX_DIRECTORY_BYTES = 8 * 1024 * 1024;
/** Longest entry name accepted. */
export const STUDIO_BUNDLE_MAX_NAME_LENGTH = 512;
/** Chunk size for streaming reads out of the archive. */
export const STUDIO_BUNDLE_READ_CHUNK = 4 * 1024 * 1024;

/** The two kinds the bundle runner claims, and nothing else. */
export const STUDIO_BUNDLE_KINDS: readonly MediaOperationKind[] = [
  MediaOperationKind.StudioBundleExport,
  MediaOperationKind.StudioBundleImport,
];

/** Bundles are written and read on this server; there is no remote to choose. */
export const STUDIO_BUNDLE_DESTINATION = MediaOperationDestination.Local;

/**
 * Claims a bundle job may lose to a vanished worker before recovery counts it as a failure.
 *
 * One, because a bundle always restarts from the beginning: there is no cursor to resume from, so a
 * lost claim is simply a failed run. It then gets the one automatic retry every media operation has
 * (owner decision, September 22, 2026; FL-104), exactly like a run that threw, and a bundle job runs
 * at most twice whichever way its first run ended.
 */
export const STUDIO_BUNDLE_MAX_ATTEMPTS = 1;

/** Sources the export may copy into the bundle. Everything else travels as a reference. */
export const STUDIO_BUNDLE_EMBEDDABLE_KINDS: readonly StudioResourceKind[] = [
  StudioResourceKind.LibraryAsset,
  StudioResourceKind.EditedMaster,
];

/* ------------------------------------------------------------------ */
/* Manifest                                                             */
/* ------------------------------------------------------------------ */

export type StudioBundleSourceMode = 'embedded' | 'reference';

export type StudioBundleSource = {
  /** {@link studioReferenceKey} of the reference, the import's mapping key. */
  key: string;
  kind: StudioResourceKind;
  /** The identifier as written in the graph on the exporting server. */
  id: string;
  mode: StudioBundleSourceMode;
  /** Entry name under `media/` for an embedded copy. */
  path: string | null;
  /** SHA-256, hex, of the source file when the exporting server knew it. */
  sha256: string | null;
  bytes: number | null;
  fileName: string | null;
  contentType: string | null;
};

export type StudioBundleFileDigest = { sha256: string; bytes: number };

export type StudioBundleManifest = {
  format: typeof STUDIO_BUNDLE_FORMAT;
  schemaVersion: typeof STUDIO_BUNDLE_SCHEMA_VERSION;
  createdAt: string;
  producer: { product: 'frameleaf'; version: string };
  project: {
    name: string;
    /** The revision the bundle was made from. */
    revision: number;
    /** {@link studioEnvelopeDigest} of `project.json`. */
    digest: string;
    /** The project id on the exporting server, for lineage; never reused on import. */
    sourceProjectId: string;
  };
  engine: { engine: string; engineRevision: string };
  /** Every entry except the manifest itself, by entry name. */
  files: Record<string, StudioBundleFileDigest>;
  sources: StudioBundleSource[];
};

export type StudioBundleManifestCheck = { ok: true; manifest: StudioBundleManifest } | { ok: false; detail: string };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const sha256Hex = /^[\da-f]{64}$/;
const identifier = /^[\w-]{1,128}$/;

const checkFiles = (value: unknown): Record<string, StudioBundleFileDigest> | string => {
  if (!isPlainObject(value)) {
    return 'files must be an object';
  }
  const files: Record<string, StudioBundleFileDigest> = {};
  for (const [name, entry] of Object.entries(value)) {
    const problem = zipEntryNameProblem(name);
    if (problem) {
      return `files: ${problem}`;
    }
    if (!isPlainObject(entry) || typeof entry.sha256 !== 'string' || !sha256Hex.test(entry.sha256)) {
      return `files[${name}]: sha256 must be 64 hex characters`;
    }
    if (typeof entry.bytes !== 'number' || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
      return `files[${name}]: bytes must be a non-negative integer`;
    }
    files[name] = { sha256: entry.sha256, bytes: entry.bytes };
  }
  return files;
};

const checkSources = (value: unknown, files: Record<string, StudioBundleFileDigest>): StudioBundleSource[] | string => {
  if (!Array.isArray(value)) {
    return 'sources must be an array';
  }
  if (value.length > STUDIO_BUNDLE_MAX_ENTRIES) {
    return `sources: more than ${STUDIO_BUNDLE_MAX_ENTRIES} entries`;
  }
  const sources: StudioBundleSource[] = [];
  const keys = new Set<string>();
  const paths = new Set<string>();
  for (const [index, raw] of value.entries()) {
    if (!isPlainObject(raw)) {
      return `sources[${index}]: not an object`;
    }
    if (!isStudioResourceKind(raw.kind)) {
      return `sources[${index}]: unknown kind`;
    }
    if (typeof raw.id !== 'string' || !identifier.test(raw.id)) {
      return `sources[${index}]: id is not an identifier`;
    }
    const mode: StudioBundleSourceMode | null =
      raw.mode === 'embedded' ? 'embedded' : raw.mode === 'reference' ? 'reference' : null;
    if (!mode) {
      return `sources[${index}]: mode must be embedded or reference`;
    }
    const key = studioReferenceKey({ kind: raw.kind, id: raw.id });
    if (typeof raw.key !== 'string' || raw.key !== key) {
      return `sources[${index}]: key does not match kind and id`;
    }
    if (keys.has(key)) {
      return `sources[${index}]: duplicate source ${key}`;
    }
    keys.add(key);

    let path: string | null = null;
    if (mode === 'embedded') {
      if (typeof raw.path !== 'string' || !raw.path.startsWith(STUDIO_BUNDLE_MEDIA_PREFIX)) {
        return `sources[${index}]: an embedded source names an entry under ${STUDIO_BUNDLE_MEDIA_PREFIX}`;
      }
      if (!files[raw.path]) {
        return `sources[${index}]: ${raw.path} is not listed in files`;
      }
      if (paths.has(raw.path)) {
        return `sources[${index}]: ${raw.path} belongs to two sources`;
      }
      paths.add(raw.path);
      path = raw.path;
    } else if (raw.path !== undefined && raw.path !== null) {
      return `sources[${index}]: a reference carries no path`;
    }

    const sha256 = raw.sha256 ?? null;
    if (sha256 !== null && (typeof sha256 !== 'string' || !sha256Hex.test(sha256))) {
      return `sources[${index}]: sha256 must be 64 hex characters or null`;
    }
    const bytes = raw.bytes ?? null;
    if (bytes !== null && (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0)) {
      return `sources[${index}]: bytes must be a non-negative integer or null`;
    }

    sources.push({
      key,
      kind: raw.kind,
      id: raw.id,
      mode,
      path,
      sha256,
      bytes,
      fileName: typeof raw.fileName === 'string' ? raw.fileName.slice(0, 255) : null,
      contentType: typeof raw.contentType === 'string' ? raw.contentType.slice(0, 120) : null,
    });
  }
  return sources;
};

/**
 * Validate a parsed `manifest.json`. Strict about the fields the import relies on (format, version,
 * digests, source keys) and lenient about descriptive text, which is truncated rather than refused.
 */
export const checkStudioBundleManifest = (value: unknown): StudioBundleManifestCheck => {
  if (!isPlainObject(value)) {
    return { ok: false, detail: 'The manifest must be a JSON object' };
  }
  if (value.format !== STUDIO_BUNDLE_FORMAT) {
    return { ok: false, detail: `This is not a ${STUDIO_BUNDLE_FORMAT} file` };
  }
  if (value.schemaVersion !== STUDIO_BUNDLE_SCHEMA_VERSION) {
    return { ok: false, detail: `Unsupported bundle schemaVersion: ${String(value.schemaVersion)}` };
  }
  if (typeof value.createdAt !== 'string' || Number.isNaN(Date.parse(value.createdAt))) {
    return { ok: false, detail: 'createdAt must be an ISO date' };
  }
  if (
    !isPlainObject(value.producer) ||
    value.producer.product !== 'frameleaf' ||
    typeof value.producer.version !== 'string'
  ) {
    return { ok: false, detail: 'producer must name the product and its version' };
  }

  const project = value.project;
  if (
    !isPlainObject(project) ||
    typeof project.name !== 'string' ||
    project.name.trim().length === 0 ||
    typeof project.revision !== 'number' ||
    !Number.isSafeInteger(project.revision) ||
    project.revision < 1 ||
    typeof project.digest !== 'string' ||
    !sha256Hex.test(project.digest) ||
    typeof project.sourceProjectId !== 'string' ||
    project.sourceProjectId.length === 0
  ) {
    return { ok: false, detail: 'project must carry a name, a revision, a digest and the source project id' };
  }

  const engine = value.engine;
  if (
    !isPlainObject(engine) ||
    typeof engine.engine !== 'string' ||
    typeof engine.engineRevision !== 'string' ||
    engine.engineRevision.length === 0
  ) {
    return { ok: false, detail: 'engine must name the engine and its revision' };
  }

  const files = checkFiles(value.files);
  if (typeof files === 'string') {
    return { ok: false, detail: files };
  }
  if (!files[STUDIO_BUNDLE_PROJECT_ENTRY]) {
    return { ok: false, detail: `files must list ${STUDIO_BUNDLE_PROJECT_ENTRY}` };
  }
  if (files[STUDIO_BUNDLE_MANIFEST_ENTRY]) {
    return { ok: false, detail: 'The manifest cannot digest itself' };
  }
  for (const name of Object.keys(files)) {
    if (name !== STUDIO_BUNDLE_PROJECT_ENTRY && !name.startsWith(STUDIO_BUNDLE_MEDIA_PREFIX)) {
      return { ok: false, detail: `Unexpected entry ${name}` };
    }
  }

  const sources = checkSources(value.sources, files);
  if (typeof sources === 'string') {
    return { ok: false, detail: sources };
  }
  const embeddedPaths = new Set(sources.filter((source) => source.path).map((source) => source.path));
  for (const name of Object.keys(files)) {
    if (name.startsWith(STUDIO_BUNDLE_MEDIA_PREFIX) && !embeddedPaths.has(name)) {
      return { ok: false, detail: `${name} belongs to no source` };
    }
  }

  return {
    ok: true,
    manifest: {
      format: STUDIO_BUNDLE_FORMAT,
      schemaVersion: STUDIO_BUNDLE_SCHEMA_VERSION,
      createdAt: value.createdAt,
      producer: { product: 'frameleaf', version: value.producer.version.slice(0, 64) },
      project: {
        name: project.name.trim().slice(0, 200),
        revision: project.revision,
        digest: project.digest,
        sourceProjectId: project.sourceProjectId.slice(0, 128),
      },
      engine: { engine: engine.engine.slice(0, 64), engineRevision: engine.engineRevision.slice(0, 200) },
      files,
      sources,
    },
  };
};

/** Serialize an envelope for `project.json`: canonical, so its SHA-256 is the revision digest. */
export const serializeStudioBundleProject = (envelope: StudioProjectEnvelope): Buffer =>
  Buffer.from(canonicalJson(envelope), 'utf8');

export const sha256Of = (buffer: Buffer): string => createHash('sha256').update(buffer).digest('hex');

/**
 * Parse and verify `project.json` against the manifest: the entry digest, the envelope shape and
 * the revision digest all have to agree before the document is believed.
 */
export const checkStudioBundleProject = (
  manifest: StudioBundleManifest,
  bytes: Buffer,
): { ok: true; envelope: StudioProjectEnvelope; graphBytes: number } | { ok: false; detail: string } => {
  const expected = manifest.files[STUDIO_BUNDLE_PROJECT_ENTRY];
  if (bytes.length !== expected.bytes || sha256Of(bytes) !== expected.sha256) {
    return { ok: false, detail: `${STUDIO_BUNDLE_PROJECT_ENTRY} does not match its digest in the manifest` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { ok: false, detail: `${STUDIO_BUNDLE_PROJECT_ENTRY} is not JSON` };
  }

  const checked = checkStudioEnvelope(parsed);
  if (!checked.ok) {
    return { ok: false, detail: checked.detail };
  }
  if (studioEnvelopeDigest(checked.envelope) !== manifest.project.digest) {
    return { ok: false, detail: 'The project document does not match the digest the manifest names' };
  }
  return { ok: true, envelope: checked.envelope, graphBytes: checked.graphBytes };
};

/* ------------------------------------------------------------------ */
/* Entry names                                                          */
/* ------------------------------------------------------------------ */

/** Why an entry name is refused, or null when it is a plain relative path. */
export const zipEntryNameProblem = (name: string): string | null => {
  if (name.length === 0 || name.length > STUDIO_BUNDLE_MAX_NAME_LENGTH) {
    return 'entry name length';
  }
  if (name.includes('\0')) {
    return 'entry name contains NUL';
  }
  if (name.includes('\\')) {
    return `entry name uses backslashes: ${name.slice(0, 80)}`;
  }
  if (name.startsWith('/') || /^[a-z]:/i.test(name)) {
    return `absolute entry name: ${name.slice(0, 80)}`;
  }
  if (name.endsWith('/')) {
    return `directory entry: ${name.slice(0, 80)}`;
  }
  const segments = name.split('/');
  if (segments.some((segment) => ['', '.', '..'].includes(segment))) {
    return `entry name traverses: ${name.slice(0, 80)}`;
  }
  return null;
};

const plainExtension = /^\.[\dA-Za-z]{1,10}$/;

/** The `media/` entry name for an embedded copy: stable, unique per key, and free of path tricks. */
export const bundleMediaEntryName = (source: Pick<StudioBundleSource, 'kind' | 'id' | 'fileName'>): string => {
  const extension = source.fileName?.includes('.') ? source.fileName.slice(source.fileName.lastIndexOf('.')) : '';
  // Only a plain `.ext` survives: anything with a separator, a second dot or nothing after the dot
  // is dropped rather than cleaned into something that merely looks like an extension.
  return `${STUDIO_BUNDLE_MEDIA_PREFIX}${source.kind}-${source.id}${plainExtension.test(extension) ? extension : ''}`;
};

/** The download name for an exported bundle: the project's own name, sanitized, never the id. */
export const studioBundleFileName = (projectName: string): string => {
  const body =
    projectName
      .normalize('NFKD')
      .replaceAll(/[̀-ͯ]/g, '')
      .replaceAll(/[^\w\s-]+/g, '')
      .trim()
      .replaceAll(/[\s_]+/g, '-')
      .replaceAll(/-+/g, '-')
      .slice(0, 80)
      .replaceAll(/^-|-$/g, '') || 'studio-project';
  return `${body}.frameleaf-studio.zip`;
};

/* ------------------------------------------------------------------ */
/* ZIP reading                                                          */
/* ------------------------------------------------------------------ */

/** Random access to the archive bytes; the service backs it with positional file reads. */
export interface ZipByteSource {
  size: number;
  /** Read exactly `length` bytes at `position`, or fewer only at the end of the file. */
  read(position: number, length: number): Promise<Buffer>;
}

export type ZipCompression = 'store' | 'deflate';

export type ZipEntry = {
  name: string;
  compression: ZipCompression;
  compressedSize: number;
  uncompressedSize: number;
  crc32: number;
  /** Offset of the local file header. The data offset is resolved when the entry is read. */
  localHeaderOffset: number;
  /**
   * Where the next entry's local header (or the central directory) begins. An entry's data must
   * end before it: the local header's own name and extra lengths are only known when the entry is
   * read, so this is checked then.
   */
  dataLimit: number;
};

export type ZipDirectory = {
  entries: ZipEntry[];
  byName: Map<string, ZipEntry>;
};

export class StudioBundleArchiveError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const EOCD_SIGNATURE = 0x06_05_4b_50;
const CENTRAL_SIGNATURE = 0x02_01_4b_50;
const LOCAL_SIGNATURE = 0x04_03_4b_50;
const EOCD_MIN = 22;
const EOCD_MAX_COMMENT = 0xff_ff;
const CENTRAL_MIN = 46;
const LOCAL_MIN = 30;
const ZIP64_MARKER_16 = 0xff_ff;
const ZIP64_MARKER_32 = 0xff_ff_ff_ff;
const FLAG_ENCRYPTED = 0x00_01;
const FLAG_STRONG_ENCRYPTION = 0x00_40;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

// A function declaration, not an arrow: TypeScript only treats a `never`-returning call as an
// assertion when the callee is declared with an explicit return type it can see at the call site.
function refuse(code: string, message: string): never {
  throw new StudioBundleArchiveError(code, message);
}

const inflateEntry = (raw: Buffer, entry: ZipEntry): Buffer => {
  try {
    return inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.uncompressedSize) });
  } catch {
    return refuse('bundle_corrupt', `${entry.name.slice(0, 80)} could not be inflated within its declared size`);
  }
};

/**
 * The limits one kind of archive is read under. Studio bundles use {@link STUDIO_BUNDLE_ZIP_LIMITS};
 * preservation packages (FL-74) reuse the same reader with their own, larger limits and ZIP64.
 */
export type ZipReadLimits = {
  /** The whole file. */
  maxBytes: number;
  /** Entries in the central directory. */
  maxEntries: number;
  /** The central directory is read into memory whole; this bounds that read. */
  maxDirectoryBytes: number;
  /** Everything the archive may inflate to, summed over its entries. */
  maxUncompressedBytes: number;
  /**
   * The most an entry of this name may declare, for entries that are read into memory (JSON
   * documents), or null for entries that are only ever streamed.
   */
  documentLimit: (name: string) => number | null;
  /**
   * Whether ZIP64 records are read. A Studio bundle never needs them and refuses them; a
   * preservation package of a large library does.
   */
  allowZip64: boolean;
};

/** The Studio bundle limits, exactly as FL-91 shipped them: no ZIP64, 4 GiB, 2048 entries. */
export const STUDIO_BUNDLE_ZIP_LIMITS: ZipReadLimits = Object.freeze({
  maxBytes: STUDIO_BUNDLE_MAX_BYTES,
  maxEntries: STUDIO_BUNDLE_MAX_ENTRIES,
  maxDirectoryBytes: STUDIO_BUNDLE_MAX_DIRECTORY_BYTES,
  maxUncompressedBytes: STUDIO_BUNDLE_MAX_UNCOMPRESSED_BYTES,
  documentLimit: (name: string) =>
    name === STUDIO_BUNDLE_MANIFEST_ENTRY || name === STUDIO_BUNDLE_PROJECT_ENTRY ? STUDIO_BUNDLE_MAX_JSON_BYTES : null,
  allowZip64: false,
});

const ZIP64_LOCATOR_SIGNATURE = 0x07_06_4b_50;
const ZIP64_EOCD_SIGNATURE = 0x06_06_4b_50;
const ZIP64_LOCATOR_LENGTH = 20;
const ZIP64_EOCD_MIN = 56;
const ZIP64_EXTRA_ID = 0x00_01;

/** A 64-bit little-endian value as a number, refused when it cannot be one exactly. */
const readUInt64 = (buffer: Buffer, offset: number, what: string): number => {
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    refuse('bundle_too_large', `${what} is larger than this server can address`);
  }
  return Number(value);
};

/**
 * The ZIP64 end-of-central-directory record, found through the locator that must sit immediately
 * before the ordinary record. Only a single-disk archive is accepted.
 */
const readZip64End = async (
  source: ZipByteSource,
  eocdPosition: number,
): Promise<{ entryCount: number; directorySize: number; directoryOffset: number }> => {
  if (eocdPosition < ZIP64_LOCATOR_LENGTH) {
    refuse('bundle_corrupt', 'The ZIP64 locator is missing');
  }
  const locator = await source.read(eocdPosition - ZIP64_LOCATOR_LENGTH, ZIP64_LOCATOR_LENGTH);
  if (locator.length < ZIP64_LOCATOR_LENGTH || locator.readUInt32LE(0) !== ZIP64_LOCATOR_SIGNATURE) {
    refuse('bundle_corrupt', 'The ZIP64 locator is missing');
  }
  if (locator.readUInt32LE(4) !== 0 || locator.readUInt32LE(16) > 1) {
    refuse('bundle_spanned', 'Archives split across several files are not accepted');
  }
  const recordOffset = readUInt64(locator, 8, 'The ZIP64 record offset');
  if (recordOffset + ZIP64_EOCD_MIN > eocdPosition - ZIP64_LOCATOR_LENGTH) {
    refuse('bundle_corrupt', 'The ZIP64 record lies outside the file');
  }
  const record = await source.read(recordOffset, ZIP64_EOCD_MIN);
  if (record.length < ZIP64_EOCD_MIN || record.readUInt32LE(0) !== ZIP64_EOCD_SIGNATURE) {
    refuse('bundle_corrupt', 'The ZIP64 record is malformed');
  }
  if (record.readUInt32LE(16) !== 0 || record.readUInt32LE(20) !== 0) {
    refuse('bundle_spanned', 'Archives split across several files are not accepted');
  }
  const entriesOnDisk = readUInt64(record, 24, 'The entry count');
  const entryCount = readUInt64(record, 32, 'The entry count');
  if (entriesOnDisk !== entryCount) {
    refuse('bundle_spanned', 'Archives split across several files are not accepted');
  }
  return {
    entryCount,
    directorySize: readUInt64(record, 40, 'The central directory'),
    directoryOffset: readUInt64(record, 48, 'The central directory offset'),
  };
};

/**
 * The real sizes and offset of an entry whose central record carries ZIP64 markers, from its
 * ZIP64 extended-information extra field. Values appear in the fixed order the format defines and
 * only for the fields that were marked.
 */
const readZip64Extra = (
  extra: Buffer,
  marked: { uncompressed: boolean; compressed: boolean; offset: boolean },
  name: string,
): { uncompressedSize?: number; compressedSize?: number; localHeaderOffset?: number } => {
  let cursor = 0;
  while (cursor + 4 <= extra.length) {
    const id = extra.readUInt16LE(cursor);
    const length = extra.readUInt16LE(cursor + 2);
    const start = cursor + 4;
    if (start + length > extra.length) {
      break;
    }
    if (id === ZIP64_EXTRA_ID) {
      const values: { uncompressedSize?: number; compressedSize?: number; localHeaderOffset?: number } = {};
      let field = start;
      const next = (what: string) => {
        if (field + 8 > start + length) {
          refuse('bundle_corrupt', `${name.slice(0, 80)} has a short ZIP64 field`);
        }
        const value = readUInt64(extra, field, what);
        field += 8;
        return value;
      };
      if (marked.uncompressed) {
        values.uncompressedSize = next(`${name.slice(0, 80)}'s size`);
      }
      if (marked.compressed) {
        values.compressedSize = next(`${name.slice(0, 80)}'s compressed size`);
      }
      if (marked.offset) {
        values.localHeaderOffset = next(`${name.slice(0, 80)}'s offset`);
      }
      return values;
    }
    cursor = start + length;
  }
  return refuse('bundle_corrupt', `${name.slice(0, 80)} is marked ZIP64 but has no ZIP64 field`);
};

/**
 * Locate and parse the central directory. Refuses encryption, unknown compression methods, bad
 * entry names, too many entries, oversized declared sizes, split archives and suspicious
 * compression ratios, all from the directory alone, before a single entry is inflated. ZIP64 is
 * refused unless `limits` allows it; the Studio bundle limits never do.
 */
export const readZipDirectory = async (
  source: ZipByteSource,
  limits: ZipReadLimits = STUDIO_BUNDLE_ZIP_LIMITS,
): Promise<ZipDirectory> => {
  if (source.size < EOCD_MIN) {
    refuse('bundle_not_zip', 'The file is too small to be a ZIP archive');
  }
  if (source.size > limits.maxBytes) {
    refuse('bundle_too_large', `The file is larger than ${limits.maxBytes} bytes`);
  }

  const tailLength = Math.min(source.size, EOCD_MIN + EOCD_MAX_COMMENT);
  const tailStart = source.size - tailLength;
  const tail = await source.read(tailStart, tailLength);
  let eocd = -1;
  for (let offset = tail.length - EOCD_MIN; offset >= 0; offset--) {
    if (tail.readUInt32LE(offset) === EOCD_SIGNATURE) {
      eocd = offset;
      break;
    }
  }
  if (eocd === -1) {
    refuse('bundle_not_zip', 'No end-of-central-directory record was found');
  }

  let entryCount = tail.readUInt16LE(eocd + 10);
  let directorySize = tail.readUInt32LE(eocd + 12);
  let directoryOffset = tail.readUInt32LE(eocd + 16);
  const diskNumber = tail.readUInt16LE(eocd + 4);
  const directoryDisk = tail.readUInt16LE(eocd + 6);
  const zip64 =
    entryCount === ZIP64_MARKER_16 || directorySize === ZIP64_MARKER_32 || directoryOffset === ZIP64_MARKER_32;
  if (zip64) {
    if (!limits.allowZip64) {
      refuse('bundle_zip64', 'ZIP64 archives are not accepted as bundles');
    }
    ({ entryCount, directorySize, directoryOffset } = await readZip64End(source, tailStart + eocd));
  } else if (diskNumber !== 0 || directoryDisk !== 0 || tail.readUInt16LE(eocd + 8) !== entryCount) {
    refuse('bundle_spanned', 'Archives split across several files are not accepted');
  }
  if (entryCount > limits.maxEntries) {
    refuse('bundle_too_many_entries', `The archive declares ${entryCount} entries; the limit is ${limits.maxEntries}`);
  }
  if (directoryOffset + directorySize > source.size || directorySize < entryCount * CENTRAL_MIN) {
    refuse('bundle_corrupt', 'The central directory lies outside the file');
  }
  if (directorySize > limits.maxDirectoryBytes) {
    refuse('bundle_too_large', 'The central directory is larger than any bundle needs');
  }

  const directory = await source.read(directoryOffset, directorySize);
  const entries: ZipEntry[] = [];
  const byName = new Map<string, ZipEntry>();
  let cursor = 0;

  for (let index = 0; index < entryCount; index++) {
    if (cursor + CENTRAL_MIN > directory.length || directory.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      refuse('bundle_corrupt', `Central directory entry ${index} is malformed`);
    }
    const flags = directory.readUInt16LE(cursor + 8);
    const method = directory.readUInt16LE(cursor + 10);
    const crc32 = directory.readUInt32LE(cursor + 16);
    let compressedSize = directory.readUInt32LE(cursor + 20);
    let uncompressedSize = directory.readUInt32LE(cursor + 24);
    const nameLength = directory.readUInt16LE(cursor + 28);
    const extraLength = directory.readUInt16LE(cursor + 30);
    const commentLength = directory.readUInt16LE(cursor + 32);
    const startDisk = directory.readUInt16LE(cursor + 34);
    let localHeaderOffset = directory.readUInt32LE(cursor + 42);

    if (cursor + CENTRAL_MIN + nameLength + extraLength + commentLength > directory.length) {
      refuse('bundle_corrupt', `Central directory entry ${index} overruns the directory`);
    }
    const nameEnd = cursor + CENTRAL_MIN + nameLength;
    const name = directory.subarray(cursor + CENTRAL_MIN, nameEnd).toString('utf8');
    const extra = directory.subarray(nameEnd, nameEnd + extraLength);
    cursor += CENTRAL_MIN + nameLength + extraLength + commentLength;

    if (flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) {
      refuse('bundle_encrypted', `${name.slice(0, 80)} is encrypted`);
    }
    const marked = {
      uncompressed: uncompressedSize === ZIP64_MARKER_32,
      compressed: compressedSize === ZIP64_MARKER_32,
      offset: localHeaderOffset === ZIP64_MARKER_32,
    };
    if (marked.uncompressed || marked.compressed || marked.offset) {
      if (!limits.allowZip64) {
        refuse('bundle_zip64', 'ZIP64 archives are not accepted as bundles');
      }
      const values = readZip64Extra(extra, marked, name);
      uncompressedSize = values.uncompressedSize ?? uncompressedSize;
      compressedSize = values.compressedSize ?? compressedSize;
      localHeaderOffset = values.localHeaderOffset ?? localHeaderOffset;
    }
    if (startDisk !== 0 && !(limits.allowZip64 && startDisk === ZIP64_MARKER_16)) {
      refuse('bundle_spanned', 'Archives split across several files are not accepted');
    }
    if (method !== METHOD_STORE && method !== METHOD_DEFLATE) {
      refuse('bundle_compression', `${name.slice(0, 80)} uses compression method ${method}`);
    }
    const nameProblem = zipEntryNameProblem(name);
    if (nameProblem) {
      refuse('bundle_entry_name', nameProblem);
    }
    if (byName.has(name)) {
      refuse('bundle_entry_name', `duplicate entry ${name.slice(0, 80)}`);
    }
    if (localHeaderOffset + LOCAL_MIN + compressedSize > directoryOffset) {
      refuse('bundle_corrupt', `${name.slice(0, 80)} points outside the file's data`);
    }
    if (method === METHOD_STORE && compressedSize !== uncompressedSize) {
      refuse('bundle_corrupt', `${name.slice(0, 80)} is stored but declares two different sizes`);
    }
    if (
      method === METHOD_DEFLATE &&
      uncompressedSize > STUDIO_BUNDLE_RATIO_FLOOR_BYTES &&
      uncompressedSize > compressedSize * STUDIO_BUNDLE_MAX_RATIO
    ) {
      refuse('bundle_ratio', `${name.slice(0, 80)} inflates more than ${STUDIO_BUNDLE_MAX_RATIO} times`);
    }
    const documentLimit = limits.documentLimit(name);
    if (documentLimit !== null && uncompressedSize > documentLimit) {
      refuse('bundle_too_large', `${name} declares ${uncompressedSize} bytes; the limit is ${documentLimit}`);
    }

    const entry: ZipEntry = {
      name,
      compression: method === METHOD_STORE ? 'store' : 'deflate',
      compressedSize,
      uncompressedSize,
      crc32,
      localHeaderOffset,
      dataLimit: directoryOffset,
    };
    entries.push(entry);
    byName.set(name, entry);
  }

  // Declared totals and overlaps, from the directory alone. Two entries that point into the same
  // compressed bytes are how a small file claims to hold far more than it does, so every entry's
  // data must end before the next one's header begins.
  const declared = entries.reduce((total, entry) => total + entry.uncompressedSize, 0);
  if (declared > limits.maxUncompressedBytes) {
    refuse('bundle_too_large', `The archive declares ${declared} bytes once inflated`);
  }
  const ordered = [...entries].sort((a, b) => a.localHeaderOffset - b.localHeaderOffset);
  for (let index = 1; index < ordered.length; index++) {
    const previous = ordered[index - 1];
    if (previous.localHeaderOffset + LOCAL_MIN + previous.compressedSize > ordered[index].localHeaderOffset) {
      refuse('bundle_overlap', `${ordered[index].name.slice(0, 80)} overlaps the entry before it`);
    }
    previous.dataLimit = ordered[index].localHeaderOffset;
  }

  return { entries, byName };
};

/** Resolve where an entry's bytes start, from its local header. */
export const zipEntryDataOffset = async (source: ZipByteSource, entry: ZipEntry): Promise<number> => {
  const header = await source.read(entry.localHeaderOffset, LOCAL_MIN);
  if (header.length < LOCAL_MIN || header.readUInt32LE(0) !== LOCAL_SIGNATURE) {
    refuse('bundle_corrupt', `${entry.name.slice(0, 80)} has no local file header`);
  }
  const nameLength = header.readUInt16LE(26);
  const extraLength = header.readUInt16LE(28);
  const start = entry.localHeaderOffset + LOCAL_MIN + nameLength + extraLength;
  if (start + entry.compressedSize > source.size) {
    refuse('bundle_corrupt', `${entry.name.slice(0, 80)} runs past the end of the file`);
  }
  if (start + entry.compressedSize > entry.dataLimit) {
    refuse('bundle_overlap', `${entry.name.slice(0, 80)} runs into the entry after it`);
  }
  return start;
};

/**
 * Read one small entry into memory. Inflation is capped at the declared size, so a directory that
 * lied about an entry cannot make this allocate more than it promised. `maxBytes` defaults to the
 * Studio bundle's JSON limit; a preservation package (FL-74) passes its own document limit.
 */
export const readZipEntry = async (
  source: ZipByteSource,
  entry: ZipEntry,
  maxBytes: number = STUDIO_BUNDLE_MAX_JSON_BYTES,
): Promise<Buffer> => {
  if (entry.uncompressedSize > maxBytes || entry.compressedSize > maxBytes) {
    refuse('bundle_too_large', `${entry.name.slice(0, 80)} is too large to read into memory`);
  }
  const start = await zipEntryDataOffset(source, entry);
  const raw = await source.read(start, entry.compressedSize);
  if (raw.length !== entry.compressedSize) {
    refuse('bundle_corrupt', `${entry.name.slice(0, 80)} is truncated`);
  }

  const bytes = entry.compression === 'store' ? raw : inflateEntry(raw, entry);
  if (bytes.length !== entry.uncompressedSize) {
    refuse('bundle_corrupt', `${entry.name.slice(0, 80)} inflated to a different size than declared`);
  }
  return bytes;
};

/**
 * Digest one entry of any size without holding it in memory: compressed bytes are read in chunks,
 * inflated as a stream when needed, hashed and counted. Stops the moment the output exceeds the
 * declared size. Returns the SHA-256 and the byte count actually produced.
 *
 * `onData` receives every produced chunk, in order, after it has been counted against the declared
 * size, so a caller can copy the entry out while it is verified (FL-74). A copy is only trustworthy
 * once this resolves: the digest is known at the end, not before.
 */
export const digestZipEntry = async (
  source: ZipByteSource,
  entry: ZipEntry,
  options: {
    chunkSize?: number;
    onProgress?: (bytes: number) => void | Promise<void>;
    onData?: (chunk: Buffer) => void | Promise<void>;
  } = {},
): Promise<{ sha256: string; bytes: number }> => {
  const chunkSize = options.chunkSize ?? STUDIO_BUNDLE_READ_CHUNK;
  const start = await zipEntryDataOffset(source, entry);
  const hash = createHash('sha256');
  let produced = 0;

  const consume = async (chunk: Buffer) => {
    produced += chunk.length;
    if (produced > entry.uncompressedSize) {
      refuse('bundle_corrupt', `${entry.name.slice(0, 80)} inflates past its declared size`);
    }
    hash.update(chunk);
    await options.onData?.(chunk);
    await options.onProgress?.(produced);
  };

  if (entry.compression === 'store') {
    for (let position = 0; position < entry.compressedSize; position += chunkSize) {
      const length = Math.min(chunkSize, entry.compressedSize - position);
      const chunk = await source.read(start + position, length);
      if (chunk.length !== length) {
        refuse('bundle_corrupt', `${entry.name.slice(0, 80)} is truncated`);
      }
      await consume(chunk);
    }
  } else {
    // Counted and hashed as the inflater produces output, synchronously, so a lying entry is caught
    // within one zlib chunk of its declared size instead of after a whole input chunk has inflated.
    const inflate = createInflateRaw();
    // Held in an object: the callbacks below set it, and a plain `let` would stay narrowed to null.
    const state: { failure: StudioBundleArchiveError | null } = { failure: null };
    // Output waiting to be handed to `onData`, which may be asynchronous; drained after every write.
    const pending: Buffer[] = [];
    const drain = async () => {
      while (pending.length > 0 && !state.failure) {
        await options.onData?.(pending.shift()!);
      }
    };
    inflate.on('data', (chunk: Buffer) => {
      if (state.failure) {
        return;
      }
      produced += chunk.length;
      if (produced > entry.uncompressedSize) {
        state.failure = new StudioBundleArchiveError(
          'bundle_corrupt',
          `${entry.name.slice(0, 80)} inflates past its declared size`,
        );
        inflate.destroy();
        return;
      }
      hash.update(chunk);
      if (options.onData) {
        pending.push(chunk);
      }
    });
    const ended = new Promise<void>((resolve) => {
      inflate.once('end', () => resolve());
      inflate.once('close', () => resolve());
      inflate.once('error', (error: Error) => {
        state.failure ??= new StudioBundleArchiveError(
          'bundle_corrupt',
          `${entry.name.slice(0, 80)} could not be inflated: ${error.message.slice(0, 80)}`,
        );
        resolve();
      });
    });

    const write = (chunk: Buffer) =>
      new Promise<void>((resolve) => {
        const flushed = inflate.write(chunk, () => resolve());
        if (!flushed) {
          // The write callback still fires once the chunk is consumed, or on error/destroy.
          inflate.once('drain', () => resolve());
        }
      });

    for (let position = 0; position < entry.compressedSize && !state.failure; position += chunkSize) {
      const length = Math.min(chunkSize, entry.compressedSize - position);
      const chunk = await source.read(start + position, length);
      if (chunk.length !== length) {
        inflate.destroy();
        refuse('bundle_corrupt', `${entry.name.slice(0, 80)} is truncated`);
      }
      await write(chunk);
      await drain();
      if (!state.failure) {
        await options.onProgress?.(produced);
      }
    }
    if (!state.failure) {
      inflate.end();
    }
    await ended;
    await drain();
    if (state.failure) {
      throw state.failure;
    }
    await options.onProgress?.(produced);
  }

  if (produced !== entry.uncompressedSize) {
    refuse(
      'bundle_corrupt',
      `${entry.name.slice(0, 80)} produced ${produced} bytes, not the declared ${entry.uncompressedSize}`,
    );
  }
  return { sha256: hash.digest('hex'), bytes: produced };
};

/* ------------------------------------------------------------------ */
/* Relinking                                                            */
/* ------------------------------------------------------------------ */

/**
 * A source key to the identifier it should carry on this server. Keys are
 * {@link studioReferenceKey} values (`library-asset:<id>`), so a library asset and an edited
 * master with the same id are two different mappings.
 */
export type StudioRelinkMapping = ReadonlyMap<string, string>;

export type StudioRelinkResult = {
  graph: unknown;
  /** How many id fields were rewritten. */
  replaced: number;
  /** Keys the mapping named that the graph never referenced. */
  unused: string[];
};

const libraryIdKeys = ['assetId', 'mediaId'] as const;

/**
 * Rewrite source ids inside an opaque graph, and nothing else.
 *
 * The keys touched are exactly the ones FL-90's reference walker reads for library assets
 * (`assetId`, `mediaId`), edited masters (`editedMasterOf`) and explicit `$resource` declarations
 * of those two kinds. Every other value, including fields no Frameleaf release knows about, is
 * copied through untouched. The input is never mutated.
 */
export const relinkStudioGraph = (graph: unknown, mapping: StudioRelinkMapping): StudioRelinkResult => {
  const used = new Set<string>();
  let replaced = 0;

  const mapId = (kind: StudioResourceKind, value: unknown): unknown => {
    if (typeof value !== 'string') {
      return value;
    }
    const key = studioReferenceKey({ kind, id: value });
    const next = mapping.get(key);
    if (next === undefined || next === value) {
      return value;
    }
    used.add(key);
    replaced += 1;
    return next;
  };

  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      return node.map((item) => walk(item));
    }
    if (!isPlainObject(node)) {
      return node;
    }

    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if ((libraryIdKeys as readonly string[]).includes(key)) {
        out[key] = mapId(StudioResourceKind.LibraryAsset, value);
      } else if (key === 'editedMasterOf') {
        out[key] = mapId(StudioResourceKind.EditedMaster, value);
      } else if (key === '$resource' && isPlainObject(value) && isStudioResourceKind(value.kind)) {
        if (value.kind === StudioResourceKind.LibraryAsset || value.kind === StudioResourceKind.EditedMaster) {
          out[key] = { ...value, id: mapId(value.kind, value.id) };
        } else if (value.kind === StudioResourceKind.Audio && value.source === 'asset') {
          // An audio stream taken from a library video is that video: it relinks with it.
          out[key] = { ...value, id: mapId(StudioResourceKind.LibraryAsset, value.id) };
        } else {
          // Like FL-90's walker, nothing inside another kind's declaration is an asset id.
          out[key] = { ...value };
        }
      } else {
        out[key] = walk(value);
      }
    }
    return out;
  };

  const result = walk(graph);
  const unused = mapping
    .keys()
    .filter((key) => !used.has(key))
    .toArray()
    .sort();
  return { graph: result, replaced, unused };
};

/**
 * The media sources a graph names, as bundle source keys, sorted and unique.
 *
 * Library assets and edited masters are the only sources a bundle carries: they are the person's
 * own media, which another server cannot know about. Presets, bundled fonts, catalogue music and
 * the other deployment resources resolve by name on any Frameleaf server, and project imports and
 * generated intermediates are re-created by the engine, so none of them needs relinking. An audio
 * stream declared from a library video is recorded under that video's key.
 */
export type StudioBundleSourceKey = { key: string; kind: StudioResourceKind; id: string };

export const studioBundleSourceKeys = (graph: unknown): StudioBundleSourceKey[] => {
  const found = new Map<string, StudioBundleSourceKey>();
  for (const reference of extractStudioResourceReferences(graph).references) {
    const kind =
      reference.kind === StudioResourceKind.Audio && reference.source === 'asset'
        ? StudioResourceKind.LibraryAsset
        : reference.kind;
    if (!(STUDIO_BUNDLE_EMBEDDABLE_KINDS as readonly StudioResourceKind[]).includes(kind)) {
      continue;
    }
    const key = studioReferenceKey({ kind, id: reference.id });
    if (!found.has(key)) {
      found.set(key, { key, kind, id: reference.id });
    }
  }
  return found
    .values()
    .toArray()
    .sort((a, b) => compareCodeUnits(a.key, b.key));
};

/**
 * A library checksum as the SHA-256 hex a manifest records, or null. This server stores SHA-256
 * for new uploads and SHA-1 for older ones; only a 32-byte digest is a SHA-256, and a SHA-1 is
 * never passed off as one.
 */
export const studioChecksumSha256 = (checksum: Buffer | string | null | undefined): string | null => {
  if (!checksum) {
    return null;
  }
  const bytes = typeof checksum === 'string' ? Buffer.from(checksum, 'base64') : checksum;
  return bytes.length === 32 ? bytes.toString('hex') : null;
};

export type StudioBundleManifestInput = {
  createdAt: Date;
  producerVersion: string;
  name: string;
  revision: number;
  digest: string;
  sourceProjectId: string;
  engineRevision: string;
  engine: string;
  project: Buffer;
  sources: StudioBundleSource[];
  /** Digest of every embedded copy, by entry name. */
  media: Record<string, StudioBundleFileDigest>;
};

/** Assemble the manifest the export writes. Checked with {@link checkStudioBundleManifest} before use. */
export const buildStudioBundleManifest = (input: StudioBundleManifestInput): StudioBundleManifest => ({
  format: STUDIO_BUNDLE_FORMAT,
  schemaVersion: STUDIO_BUNDLE_SCHEMA_VERSION,
  createdAt: input.createdAt.toISOString(),
  producer: { product: 'frameleaf', version: input.producerVersion.slice(0, 64) },
  project: {
    name: input.name.slice(0, 200),
    revision: input.revision,
    digest: input.digest,
    sourceProjectId: input.sourceProjectId,
  },
  engine: { engine: input.engine, engineRevision: input.engineRevision },
  files: {
    [STUDIO_BUNDLE_PROJECT_ENTRY]: { sha256: sha256Of(input.project), bytes: input.project.length },
    ...input.media,
  },
  sources: input.sources,
});

/**
 * How one bundle source will land on this server, before anything is imported.
 *
 * `mapped` names an asset the importer chose (or accepted as a suggestion); `kept` means the
 * original id already resolves for the importer, which is the case for a bundle re-imported on the
 * server that made it; `missing` is everything else and is reported, never guessed at.
 */
export type StudioBundleSourcePlan =
  | { key: string; outcome: 'mapped'; assetId: string }
  | { key: string; outcome: 'kept' }
  | { key: string; outcome: 'missing' };

export const planStudioBundleRelink = (
  sources: readonly Pick<StudioBundleSource, 'key' | 'id'>[],
  options: {
    /** Explicit choices, by source key. An asset id equal to the source id means "keep". */
    mapping: Readonly<Record<string, string>>;
    /** Source keys whose original id resolves for the importer through FL-90. */
    resolvable: ReadonlySet<string>;
  },
): StudioBundleSourcePlan[] =>
  sources.map((source) => {
    const chosen = options.mapping[source.key];
    if (chosen && chosen !== source.id) {
      return { key: source.key, outcome: 'mapped', assetId: chosen };
    }
    if (options.resolvable.has(source.key)) {
      return { key: source.key, outcome: 'kept' };
    }
    return { key: source.key, outcome: 'missing' };
  });

/* ------------------------------------------------------------------ */
/* Operation snapshots and results                                      */
/* ------------------------------------------------------------------ */

/** What the export runner is bound to. Written once at submit; the runner never widens it. */
export type StudioBundleExportSnapshot = {
  kind: 'studio-bundle-export';
  projectId: string;
  revision: number;
  /** Digest of the revision at submit; the runner refuses to write a different document. */
  digest: string;
  includeMedia: boolean;
  /**
   * Sources the submitting session was allowed to copy: resolved through FL-90 for that session
   * and owned by it. The runner never embeds anything outside this list, even though it can read
   * more (a background task reaches Locked media; a download must not).
   */
  embed: Array<{ key: string; kind: StudioResourceKind; id: string }>;
  /**
   * Reserved for exporting a subset of sequences. Choosing sequences inside the graph is the
   * engine's job, so until the editor is part of the build this is always null.
   */
  sequenceIds: string[] | null;
  /** The client's idempotency key, so a repeated submit answers with the first job. */
  requestKey: string | null;
};

export type StudioBundleImportSnapshot = {
  kind: 'studio-bundle-import';
  uploadId: string;
  /** SHA-256 of the uploaded file at registration; the runner re-verifies it before reading. */
  digest: string;
  name: string | null;
  /** Source key to the asset the importer chose; verified for access at submit and again at run. */
  mapping: Record<string, string>;
  requestKey: string | null;
};

export type StudioBundleExportResult = {
  path: string;
  fileName: string;
  sizeBytes: number;
  /** SHA-256 of the finished file. */
  digest: string;
  expiresAt: string;
  embedded: number;
  referenced: number;
  /** Set by the sweep once the file is gone. The row stays for lineage. */
  expiredAt?: string;
};

export type StudioBundleMissingSource = {
  key: string;
  kind: StudioResourceKind;
  id: string;
  fileName: string | null;
  /** The bundle carries a copy this release cannot yet adopt into the library (FL-105). */
  embedded: boolean;
};

export type StudioBundleImportResult = {
  projectId: string | null;
  /** Sources rewritten to an asset of the importer's, by checksum or by explicit mapping. */
  relinked: number;
  /** Sources whose original id already resolved for the importer. */
  kept: number;
  missing: StudioBundleMissingSource[];
  /** Embedded copies whose digests were verified. */
  embeddedVerified: number;
};

const asObject = (value: unknown): Record<string, unknown> => (isPlainObject(value) ? value : {});

export const parseBundleExportSnapshot = (value: unknown): StudioBundleExportSnapshot => {
  const raw = asObject(value);
  if (
    raw.kind !== 'studio-bundle-export' ||
    typeof raw.projectId !== 'string' ||
    typeof raw.revision !== 'number' ||
    typeof raw.digest !== 'string'
  ) {
    throw new StudioBundleArchiveError('bundle_snapshot_invalid', 'The export snapshot is not one this server wrote');
  }
  const embed = Array.isArray(raw.embed)
    ? raw.embed
        .filter(isPlainObject)
        .filter(
          (entry) => typeof entry.key === 'string' && isStudioResourceKind(entry.kind) && typeof entry.id === 'string',
        )
        .map((entry) => ({ key: entry.key as string, kind: entry.kind as StudioResourceKind, id: entry.id as string }))
    : [];
  return {
    kind: 'studio-bundle-export',
    projectId: raw.projectId,
    revision: raw.revision,
    digest: raw.digest,
    includeMedia: raw.includeMedia === true,
    embed,
    sequenceIds: Array.isArray(raw.sequenceIds) ? raw.sequenceIds.filter((id) => typeof id === 'string') : null,
    requestKey: typeof raw.requestKey === 'string' ? raw.requestKey : null,
  };
};

export const parseBundleImportSnapshot = (value: unknown): StudioBundleImportSnapshot => {
  const raw = asObject(value);
  if (raw.kind !== 'studio-bundle-import' || typeof raw.uploadId !== 'string' || typeof raw.digest !== 'string') {
    throw new StudioBundleArchiveError('bundle_snapshot_invalid', 'The import snapshot is not one this server wrote');
  }
  const mapping: Record<string, string> = {};
  for (const [key, id] of Object.entries(asObject(raw.mapping))) {
    if (typeof id === 'string') {
      mapping[key] = id;
    }
  }
  return {
    kind: 'studio-bundle-import',
    uploadId: raw.uploadId,
    digest: raw.digest,
    name: typeof raw.name === 'string' && raw.name.trim().length > 0 ? raw.name.trim().slice(0, 200) : null,
    mapping,
    requestKey: typeof raw.requestKey === 'string' ? raw.requestKey : null,
  };
};

export const parseBundleExportResult = (value: unknown): StudioBundleExportResult | null => {
  const raw = asObject(value);
  if (typeof raw.path !== 'string' || typeof raw.digest !== 'string' || typeof raw.expiresAt !== 'string') {
    return null;
  }
  return {
    path: raw.path,
    fileName: typeof raw.fileName === 'string' ? raw.fileName : studioBundleFileName(''),
    sizeBytes: typeof raw.sizeBytes === 'number' ? raw.sizeBytes : 0,
    digest: raw.digest,
    expiresAt: raw.expiresAt,
    embedded: typeof raw.embedded === 'number' ? raw.embedded : 0,
    referenced: typeof raw.referenced === 'number' ? raw.referenced : 0,
    ...(typeof raw.expiredAt === 'string' && { expiredAt: raw.expiredAt }),
  };
};

export const parseBundleImportResult = (value: unknown): StudioBundleImportResult => {
  const raw = asObject(value);
  return {
    projectId: typeof raw.projectId === 'string' ? raw.projectId : null,
    relinked: typeof raw.relinked === 'number' ? raw.relinked : 0,
    kept: typeof raw.kept === 'number' ? raw.kept : 0,
    missing: Array.isArray(raw.missing)
      ? raw.missing
          .filter(isPlainObject)
          .filter(
            (entry) =>
              typeof entry.key === 'string' && isStudioResourceKind(entry.kind) && typeof entry.id === 'string',
          )
          .map((entry) => ({
            key: entry.key as string,
            kind: entry.kind as StudioResourceKind,
            id: entry.id as string,
            fileName: typeof entry.fileName === 'string' ? entry.fileName : null,
            embedded: entry.embedded === true,
          }))
      : [],
    embeddedVerified: typeof raw.embeddedVerified === 'number' ? raw.embeddedVerified : 0,
  };
};

/** Whether a finished export can still be downloaded at `now`. */
export const isBundleExportDownloadable = (result: StudioBundleExportResult | null, now = new Date()): boolean =>
  !!result && !result.expiredAt && Date.parse(result.expiresAt) > now.getTime();
