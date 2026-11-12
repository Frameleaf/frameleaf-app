import { Readable } from 'node:stream';

/**
 * The tar reader for Google Takeout `.tgz` exports in a server folder.
 *
 * Tar has no directory, so entries are read in order from one stream: each entry is yielded with a
 * `body()` to read it, and whatever the caller leaves unread is skipped before the next entry. It
 * reads POSIX ustar, pax (`path`, `size`, `mtime`) and GNU long names and base-256 sizes, which is
 * what Takeout and the common tar tools write. Links are yielded as refused; every other kind but
 * regular files is skipped. Names are returned as they are and never used as filesystem paths;
 * `takeoutEntryPath` decides what they mean.
 */

export class TakeoutTarError extends Error {}

export type TakeoutTarEntry = {
  name: string;
  size: number;
  modifiedAt: Date;
  /** Refused before reading: the entry is a hard or symbolic link. */
  refused?: 'link';
  /** The entry's bytes; read it before asking for the next entry, or not at all. */
  body: () => Readable;
};

const BLOCK = 512;
/** pax headers and GNU long names larger than this are not names. */
const META_MAX_BYTES = 1024 * 1024;
const READ_MAX_BYTES = 1024 * 1024;
/** pax extended and global headers, GNU long name and long link name. */
const META_TYPES = new Set(['x', 'g', 'L', 'K']);

/** Pulls exact byte counts from a stream of chunks. */
class ByteReader {
  private pending: Buffer | undefined;

  constructor(private source: AsyncIterator<Buffer>) {}

  /** The next bytes, at most `max`; empty only at the end of the stream. */
  async some(max: number): Promise<Buffer> {
    while (!this.pending?.length) {
      const next = await this.source.next();
      if (next.done) {
        return Buffer.alloc(0);
      }
      this.pending = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
    }
    const chunk = this.pending.subarray(0, max);
    this.pending = this.pending.subarray(chunk.length);
    return chunk;
  }

  /** Exactly `length` bytes, or fewer only at the end of the stream. */
  async take(length: number): Promise<Buffer> {
    const parts: Buffer[] = [];
    let got = 0;
    while (got < length) {
      const chunk = await this.some(length - got);
      if (chunk.length === 0) break;
      parts.push(chunk);
      got += chunk.length;
    }
    return parts.length === 1 ? parts[0] : Buffer.concat(parts, got);
  }

  async skip(length: number) {
    while (length > 0) {
      const chunk = await this.some(Math.min(length, READ_MAX_BYTES));
      if (chunk.length === 0) {
        throw new TakeoutTarError('The archive ends in the middle of an entry');
      }
      length -= chunk.length;
    }
  }
}

const text = (header: Buffer, offset: number, length: number) => {
  const field = header.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString('utf8');
};

/** An octal field, or GNU base-256 when its high bit is set. */
const numeric = (header: Buffer, offset: number, length: number): number => {
  if (header[offset] & 0x80) {
    if (header[offset] !== 0x80) {
      throw new TakeoutTarError('The archive declares a negative or oversized number');
    }
    let value = 0;
    for (let index = offset + 1; index < offset + length; index++) {
      value = value * 256 + header[index];
    }
    if (!Number.isSafeInteger(value)) {
      throw new TakeoutTarError('The archive declares an oversized number');
    }
    return value;
  }
  const digits = header
    .toString('latin1', offset, offset + length)
    .replaceAll('\0', ' ')
    .trim();
  if (digits === '') {
    return 0;
  }
  if (!/^[0-7]+$/u.test(digits)) {
    throw new TakeoutTarError('The archive is damaged or is not a tar archive');
  }
  return Number.parseInt(digits, 8);
};

const checksumMatches = (header: Buffer) => {
  let sum = 0;
  for (let index = 0; index < BLOCK; index++) {
    sum += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  return sum === numeric(header, 148, 8);
};

/** pax records are `<length> <key>=<value>\n`. */
const parsePax = (data: Buffer) => {
  const records = new Map<string, string>();
  let position = 0;
  while (position < data.length) {
    const space = data.indexOf(0x20, position);
    const length = space === -1 ? NaN : Number(data.toString('latin1', position, space));
    if (!Number.isSafeInteger(length) || length <= space - position || position + length > data.length) {
      throw new TakeoutTarError('The archive has a damaged extended header');
    }
    const record = data.toString('utf8', space + 1, position + length - 1);
    const equals = record.indexOf('=');
    if (equals > 0) {
      records.set(record.slice(0, equals), record.slice(equals + 1));
    }
    position += length;
  }
  return records;
};

const paxSize = (value: string) => {
  const size = /^\d+$/u.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(size)) {
    throw new TakeoutTarError('The archive declares an invalid size');
  }
  return size;
};

const padding = (size: number) => (BLOCK - (size % BLOCK)) % BLOCK;

/** Every entry of a tar stream, in order. Throws `TakeoutTarError` for a damaged or truncated archive. */
export async function* readTakeoutTar(input: AsyncIterable<Buffer>): AsyncGenerator<TakeoutTarEntry> {
  const iterator = input[Symbol.asyncIterator]();
  const bytes = new ByteReader(iterator);
  let pax = new Map<string, string>();
  let longName: string | undefined;
  try {
    for (;;) {
      const header = await bytes.take(BLOCK);
      // Two zero blocks end the archive; an archive cut right after its last entry is accepted too.
      if (header.length === 0 || header.every((byte) => byte === 0)) {
        return;
      }
      if (header.length < BLOCK || !checksumMatches(header)) {
        throw new TakeoutTarError('The archive is damaged or is not a tar archive');
      }
      const type = String.fromCodePoint(header[156] || 0x30);
      const headerSize = numeric(header, 124, 12);

      if (META_TYPES.has(type)) {
        if (headerSize > META_MAX_BYTES) {
          throw new TakeoutTarError('The archive has an oversized extended header');
        }
        const data = await bytes.take(headerSize);
        if (data.length < headerSize) {
          throw new TakeoutTarError('The archive ends in the middle of an entry');
        }
        await bytes.skip(padding(headerSize));
        if (type === 'x') {
          pax = parsePax(data);
        } else if (type === 'L') {
          longName = text(data, 0, data.length);
        }
        continue;
      }

      const size = pax.has('size') ? paxSize(pax.get('size')!) : headerSize;
      const ustarPrefix = header.toString('latin1', 257, 263) === 'ustar\0' ? text(header, 345, 155) : '';
      const name =
        pax.get('path') ?? longName ?? (ustarPrefix ? `${ustarPrefix}/${text(header, 0, 100)}` : text(header, 0, 100));
      const mtime = Number(pax.get('mtime') ?? numeric(header, 136, 12));
      pax = new Map();
      longName = undefined;

      const regular = type === '0' || type === '7';
      const link = type === '1' || type === '2';
      let left = size;
      if (regular || link) {
        const body = () =>
          Readable.from(
            (async function* () {
              while (left > 0) {
                const chunk = await bytes.some(Math.min(left, READ_MAX_BYTES));
                if (chunk.length === 0) {
                  throw new TakeoutTarError('The archive ends in the middle of an entry');
                }
                left -= chunk.length;
                yield chunk;
              }
            })(),
          );
        yield {
          name,
          size: link ? 0 : size,
          modifiedAt: new Date(Number.isFinite(mtime) ? mtime * 1000 : 0),
          refused: link ? 'link' : undefined,
          body,
        };
      }
      // Whatever the caller did not read, and the padding to the next header.
      await bytes.skip(left + padding(size));
    }
  } finally {
    await iterator.return?.();
  }
}
