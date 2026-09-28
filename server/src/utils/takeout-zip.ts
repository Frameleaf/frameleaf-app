/**
 * The ZIP reader for Google Takeout archives (FL-65).
 *
 * Takeout splits an export into independent ZIP files of 2 to 50 GB, so unlike the Studio bundle
 * reader this one accepts ZIP64. Everything is decided from the central directory before a byte of
 * any entry is read: the entry list, the declared sizes, where each entry's data may lie, and which
 * entries are refused (encrypted, a link, an unknown compression method, a spanned archive). Entry
 * names are returned as they are and are never used as filesystem paths; `takeoutEntryPath` decides
 * what they mean.
 */

export interface TakeoutZipSource {
  size: number;
  read: (position: number, length: number) => Promise<Buffer>;
}

export type TakeoutZipEntry = {
  name: string;
  compression: 'store' | 'deflate';
  compressedSize: number;
  uncompressedSize: number;
  crc32: number;
  localHeaderOffset: number;
  /** Where the next entry's header (or the directory) begins; this entry's data must end before it. */
  dataLimit: number;
  modifiedAt: Date;
  /** Refused before reading: the entry is encrypted, a link, or uses an unsupported method. */
  refused?: 'encrypted' | 'link' | 'compression';
};

export class TakeoutZipError extends Error {}

const EOCD_SIGNATURE = 0x06_05_4b_50;
const EOCD_MIN = 22;
const ZIP64_LOCATOR_SIGNATURE = 0x07_06_4b_50;
const ZIP64_LOCATOR_SIZE = 20;
const ZIP64_EOCD_SIGNATURE = 0x06_06_4b_50;
const ZIP64_EOCD_MIN = 56;
const CENTRAL_SIGNATURE = 0x02_01_4b_50;
const CENTRAL_MIN = 46;
const LOCAL_SIGNATURE = 0x04_03_4b_50;
const LOCAL_MIN = 30;
const MARKER_16 = 0xff_ff;
const MARKER_32 = 0xff_ff_ff_ff;
const ZIP64_EXTRA = 0x00_01;
const FLAG_ENCRYPTED = 0x1;
const FLAG_STRONG_ENCRYPTION = 0x40;
const FLAG_UTF8 = 0x8_00;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const S_IFMT = 0o17_0000;
const S_IFLNK = 0o12_0000;
const HOST_UNIX = 3;

/**
 * A central directory larger than this is not a Takeout archive; Takeout parts hold a few hundred
 * thousand entries at most.
 */
export const TAKEOUT_ZIP_MAX_DIRECTORY_BYTES = 256 * 1024 * 1024;
/** Uncompressed-to-compressed ratio above which a deflated entry is treated as a decompression bomb. */
export const TAKEOUT_ZIP_MAX_RATIO = 1000;
/** Entries at or below this size are never judged by their ratio. */
export const TAKEOUT_ZIP_RATIO_FLOOR_BYTES = 1024 * 1024;

const refuse = (message: string): never => {
  throw new TakeoutZipError(message);
};

/** A 64-bit little-endian value that must fit a JavaScript number exactly. */
const readSafe64 = (buffer: Buffer, offset: number) => {
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    refuse('The archive declares a size larger than any file can be');
  }
  return Number(value);
};

/** MS-DOS date and time fields, as local time the archiver recorded. Invalid values read as the epoch. */
export const zipDosDate = (date: number, time: number): Date => {
  const year = ((date >> 9) & 0x7f) + 1980;
  const month = ((date >> 5) & 0x0f) - 1;
  const day = date & 0x1f;
  const hours = (time >> 11) & 0x1f;
  const minutes = (time >> 5) & 0x3f;
  const seconds = (time & 0x1f) * 2;
  if (month < 0 || month > 11 || day < 1) {
    return new Date(0);
  }
  return new Date(year, month, day, hours, minutes, seconds);
};

/** Names flagged UTF-8 are decoded as such; others are read as UTF-8 when valid, Latin-1 otherwise. */
const decodeName = (bytes: Buffer, flags: number) => {
  if (flags & FLAG_UTF8) {
    return bytes.toString('utf8');
  }
  const text = bytes.toString('utf8');
  return text.includes('�') ? bytes.toString('latin1') : text;
};

/**
 * The central directory's location, from the end of the file: the end-of-central-directory record,
 * and the ZIP64 record when the classic fields are saturated.
 */
const locateDirectory = async (source: TakeoutZipSource) => {
  if (source.size < EOCD_MIN) {
    refuse('This file is too small to be a ZIP archive');
  }
  const tailLength = Math.min(source.size, EOCD_MIN + 0xff_ff + ZIP64_LOCATOR_SIZE);
  const tailStart = source.size - tailLength;
  const tail = await source.read(tailStart, tailLength);
  let eocd = -1;
  for (let index = tail.length - EOCD_MIN; index >= 0; index--) {
    const commentLength = index + 22 <= tail.length ? tail.readUInt16LE(index + 20) : 0;
    if (tail.readUInt32LE(index) === EOCD_SIGNATURE && index + EOCD_MIN + commentLength <= tail.length) {
      eocd = index;
      break;
    }
  }
  if (eocd === -1) {
    refuse('This file is not a ZIP archive, or it is incomplete');
  }

  const disk = tail.readUInt16LE(eocd + 4);
  const directoryDisk = tail.readUInt16LE(eocd + 6);
  let entryCount = tail.readUInt16LE(eocd + 10);
  let directorySize = tail.readUInt32LE(eocd + 12);
  let directoryOffset = tail.readUInt32LE(eocd + 16);

  const saturated = entryCount === MARKER_16 || directorySize === MARKER_32 || directoryOffset === MARKER_32;
  const locatorAt = eocd - ZIP64_LOCATOR_SIZE;
  if (locatorAt >= 0 && tail.readUInt32LE(locatorAt) === ZIP64_LOCATOR_SIGNATURE) {
    if (tail.readUInt32LE(locatorAt + 16) > 1) {
      refuse('Spanned archives are not supported; use the separate ZIP files Google Takeout creates');
    }
    const recordOffset = readSafe64(tail, locatorAt + 8);
    const record = await source.read(recordOffset, ZIP64_EOCD_MIN);
    if (record.length < ZIP64_EOCD_MIN || record.readUInt32LE(0) !== ZIP64_EOCD_SIGNATURE) {
      refuse('The archive’s ZIP64 directory record is missing');
    }
    if (record.readUInt32LE(16) !== 0 || record.readUInt32LE(20) !== 0) {
      refuse('Spanned archives are not supported; use the separate ZIP files Google Takeout creates');
    }
    entryCount = readSafe64(record, 32);
    directorySize = readSafe64(record, 40);
    directoryOffset = readSafe64(record, 48);
  } else if (saturated) {
    refuse('The archive’s ZIP64 directory record is missing');
  } else if (disk !== 0 || directoryDisk !== 0) {
    refuse('Spanned archives are not supported; use the separate ZIP files Google Takeout creates');
  }

  if (directoryOffset + directorySize > source.size || directorySize < entryCount * CENTRAL_MIN) {
    refuse('The archive’s directory lies outside the file; the upload may be incomplete');
  }
  if (directorySize > TAKEOUT_ZIP_MAX_DIRECTORY_BYTES) {
    refuse('The archive’s directory is larger than a Takeout archive needs');
  }

  return { entryCount, directorySize, directoryOffset };
};

/** The ZIP64 extra field's values, in the order the specification gives them, for saturated fields only. */
const readZip64Extra = (
  extra: Buffer,
  saturated: { uncompressed: boolean; compressed: boolean; offset: boolean },
): { uncompressed?: number; compressed?: number; offset?: number } => {
  let cursor = 0;
  while (cursor + 4 <= extra.length) {
    const id = extra.readUInt16LE(cursor);
    const size = extra.readUInt16LE(cursor + 2);
    const start = cursor + 4;
    if (start + size > extra.length) {
      break;
    }
    if (id === ZIP64_EXTRA) {
      const values: { uncompressed?: number; compressed?: number; offset?: number } = {};
      let field = start;
      const next = () => {
        if (field + 8 > start + size) {
          refuse('An archive entry’s ZIP64 sizes are truncated');
        }
        const value = readSafe64(extra, field);
        field += 8;
        return value;
      };
      if (saturated.uncompressed) {
        values.uncompressed = next();
      }
      if (saturated.compressed) {
        values.compressed = next();
      }
      if (saturated.offset) {
        values.offset = next();
      }
      return values;
    }
    cursor = start + size;
  }
  return {};
};

/**
 * Parse the central directory. Refuses an archive that is spanned, truncated, or whose entries claim
 * data outside the file or overlapping each other. Individual entries that cannot be read safely are
 * returned with `refused` set rather than failing the whole archive, so one encrypted file does not
 * stop an export from importing and is still reported.
 */
export const readTakeoutZipDirectory = async (source: TakeoutZipSource): Promise<TakeoutZipEntry[]> => {
  const { entryCount, directorySize, directoryOffset } = await locateDirectory(source);
  const directory = await source.read(directoryOffset, directorySize);
  if (directory.length !== directorySize) {
    refuse('The archive’s directory is truncated');
  }

  const entries: TakeoutZipEntry[] = [];
  let cursor = 0;
  for (let index = 0; index < entryCount; index++) {
    if (cursor + CENTRAL_MIN > directory.length || directory.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      refuse(`The archive’s directory entry ${index} is malformed`);
    }
    const madeBy = directory.readUInt16LE(cursor + 4);
    const flags = directory.readUInt16LE(cursor + 8);
    const method = directory.readUInt16LE(cursor + 10);
    const time = directory.readUInt16LE(cursor + 12);
    const date = directory.readUInt16LE(cursor + 14);
    const crc32 = directory.readUInt32LE(cursor + 16);
    let compressedSize = directory.readUInt32LE(cursor + 20);
    let uncompressedSize = directory.readUInt32LE(cursor + 24);
    const nameLength = directory.readUInt16LE(cursor + 28);
    const extraLength = directory.readUInt16LE(cursor + 30);
    const commentLength = directory.readUInt16LE(cursor + 32);
    const diskStart = directory.readUInt16LE(cursor + 34);
    const externalAttributes = directory.readUInt32LE(cursor + 38);
    let localHeaderOffset = directory.readUInt32LE(cursor + 42);

    const end = cursor + CENTRAL_MIN + nameLength + extraLength + commentLength;
    if (end > directory.length) {
      refuse(`The archive’s directory entry ${index} overruns the directory`);
    }
    const name = decodeName(directory.subarray(cursor + CENTRAL_MIN, cursor + CENTRAL_MIN + nameLength), flags);
    const extraStart = cursor + CENTRAL_MIN + nameLength;
    const extra = directory.subarray(extraStart, extraStart + extraLength);
    cursor = end;

    const zip64 = readZip64Extra(extra, {
      uncompressed: uncompressedSize === MARKER_32,
      compressed: compressedSize === MARKER_32,
      offset: localHeaderOffset === MARKER_32,
    });
    uncompressedSize = zip64.uncompressed ?? uncompressedSize;
    compressedSize = zip64.compressed ?? compressedSize;
    localHeaderOffset = zip64.offset ?? localHeaderOffset;
    if ([uncompressedSize, compressedSize, localHeaderOffset].includes(MARKER_32)) {
      refuse(`${name.slice(0, 80)} declares ZIP64 sizes it does not carry`);
    }
    if (diskStart !== 0 && diskStart !== MARKER_16) {
      refuse('Spanned archives are not supported; use the separate ZIP files Google Takeout creates');
    }

    let refused: TakeoutZipEntry['refused'];
    if (flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) {
      refused = 'encrypted';
    } else if (madeBy >> 8 === HOST_UNIX && ((externalAttributes >>> 16) & S_IFMT) === S_IFLNK) {
      refused = 'link';
    } else if (method !== METHOD_STORE && method !== METHOD_DEFLATE) {
      refused = 'compression';
    }

    if (localHeaderOffset + LOCAL_MIN + compressedSize > directoryOffset) {
      refuse(`${name.slice(0, 80)} points outside the archive’s data`);
    }
    if (!refused && method === METHOD_STORE && compressedSize !== uncompressedSize) {
      refuse(`${name.slice(0, 80)} is stored but declares two different sizes`);
    }
    if (
      !refused &&
      method === METHOD_DEFLATE &&
      uncompressedSize > TAKEOUT_ZIP_RATIO_FLOOR_BYTES &&
      uncompressedSize > compressedSize * TAKEOUT_ZIP_MAX_RATIO
    ) {
      refuse(`${name.slice(0, 80)} inflates more than ${TAKEOUT_ZIP_MAX_RATIO} times`);
    }

    entries.push({
      name,
      compression: method === METHOD_DEFLATE ? 'deflate' : 'store',
      compressedSize,
      uncompressedSize,
      crc32,
      localHeaderOffset,
      dataLimit: directoryOffset,
      modifiedAt: zipDosDate(date, time),
      ...(refused && { refused }),
    });
  }

  // Two entries that share compressed bytes are how a small file claims to hold far more than it
  // does, so every entry's data must end before the next one's header begins.
  const ordered = [...entries].sort((a, b) => a.localHeaderOffset - b.localHeaderOffset);
  for (let index = 1; index < ordered.length; index++) {
    const previous = ordered[index - 1];
    if (previous.localHeaderOffset + LOCAL_MIN + previous.compressedSize > ordered[index].localHeaderOffset) {
      refuse(`${ordered[index].name.slice(0, 80)} overlaps the entry before it`);
    }
    previous.dataLimit = ordered[index].localHeaderOffset;
  }

  return entries;
};

/** Where an entry's compressed bytes start, from its local header, checked against the file. */
export const takeoutZipDataOffset = async (source: TakeoutZipSource, entry: TakeoutZipEntry): Promise<number> => {
  const header = await source.read(entry.localHeaderOffset, LOCAL_MIN);
  if (header.length < LOCAL_MIN || header.readUInt32LE(0) !== LOCAL_SIGNATURE) {
    refuse(`${entry.name.slice(0, 80)} has no local file header`);
  }
  const start = entry.localHeaderOffset + LOCAL_MIN + header.readUInt16LE(26) + header.readUInt16LE(28);
  if (start + entry.compressedSize > source.size) {
    refuse(`${entry.name.slice(0, 80)} runs past the end of the archive`);
  }
  // The local header's own name and extra field count too: data that reaches into the next entry
  // would let two entries share compressed bytes.
  if (start + entry.compressedSize > entry.dataLimit) {
    refuse(`${entry.name.slice(0, 80)} runs into the entry after it`);
  }
  return start;
};
