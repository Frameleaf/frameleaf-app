/** Internal bounded ZIP reader; no server aliases or vector parser imports. */
import { inflateRawSync } from 'node:zlib';

export const STUDIO_BUNDLE_RATIO_FLOOR_BYTES = 64 * 1024;
export const STUDIO_BUNDLE_MAX_RATIO = 200;
export const STUDIO_BUNDLE_MAX_NAME_LENGTH = 512;

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

/** Random access to the archive bytes; the service backs it with positional file reads. */
export interface ZipByteSource {
  size: number;
  /** Read exactly `length` bytes at `position`, or fewer only at the end of the file. */
  read(position: number, length: number): Promise<Buffer>;
}

export type ZipCompression = 'store' | 'deflate';

export type ZipEntry = {
  /** Central flags are retained for local-header agreement. */
  flags?: number;
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
export function refuse(code: string, message: string): never {
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
  /** Closed vector archives require exact UTF-8 paths and an unambiguous terminal directory. */
  strictPaths?: boolean;
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
export const readZipDirectory = async (source: ZipByteSource, limits: ZipReadLimits): Promise<ZipDirectory> => {
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
    if (
      tail.readUInt32LE(offset) === EOCD_SIGNATURE &&
      (!limits.strictPaths || offset + EOCD_MIN + tail.readUInt16LE(offset + 20) === tail.length)
    ) {
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
  if (limits.strictPaths && directoryOffset + directorySize !== tailStart + eocd) {
    refuse('bundle_corrupt', 'The central directory does not end at its terminal record');
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
    let name: string;
    try {
      name = limits.strictPaths
        ? new TextDecoder('utf-8', { fatal: true }).decode(directory.subarray(cursor + CENTRAL_MIN, nameEnd))
        : directory.subarray(cursor + CENTRAL_MIN, nameEnd).toString('utf8');
    } catch {
      return refuse('bundle_corrupt', 'The entry name is not valid UTF-8');
    }
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
      flags,
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
  const localName = await source.read(entry.localHeaderOffset + LOCAL_MIN, nameLength);
  const method = entry.compression === 'store' ? METHOD_STORE : METHOD_DEFLATE;
  if (
    header.readUInt16LE(6) !== (entry.flags ?? 0) ||
    header.readUInt16LE(8) !== method ||
    !localName.equals(Buffer.from(entry.name, 'utf8'))
  ) {
    refuse('bundle_corrupt', `${entry.name.slice(0, 80)} local and central headers disagree`);
  }
  // Streaming ZIPs use a descriptor; non-streaming sizes/CRC must agree before inflation.
  if (
    !((entry.flags ?? 0) & 8) &&
    (header.readUInt32LE(14) !== entry.crc32 ||
      (header.readUInt32LE(18) !== 0xff_ff_ff_ff && header.readUInt32LE(18) !== entry.compressedSize) ||
      (header.readUInt32LE(22) !== 0xff_ff_ff_ff && header.readUInt32LE(22) !== entry.uncompressedSize))
  ) {
    refuse('bundle_corrupt', `${entry.name.slice(0, 80)} local and central sizes disagree`);
  }
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
export const readZipEntry = async (source: ZipByteSource, entry: ZipEntry, maxBytes: number): Promise<Buffer> => {
  if (entry.uncompressedSize > maxBytes || entry.compressedSize > maxBytes) {
    refuse('bundle_too_large', `${entry.name.slice(0, 80)} is too large to read into memory`);
  }
  const start = await zipEntryDataOffset(source, entry);
  const raw = await source.read(start, entry.compressedSize);
  if (raw.length !== entry.compressedSize) {
    refuse('bundle_corrupt', `${entry.name.slice(0, 80)} is truncated`);
  }

  const bytes = entry.compression === 'store' ? raw : inflateEntry(raw, entry);
  try {
    if (bytes.length !== entry.uncompressedSize) {
      refuse('bundle_corrupt', `${entry.name.slice(0, 80)} inflated to a different size than declared`);
    }
    let crc = 0xff_ff_ff_ff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xed_b8_83_20 : 0);
    }
    if ((crc ^ 0xff_ff_ff_ff) >>> 0 !== entry.crc32) {
      refuse('bundle_corrupt', `${entry.name.slice(0, 80)} CRC does not match`);
    }
    return bytes;
  } catch (error) {
    if (bytes !== raw) bytes.fill(0);
    throw error;
  }
};
