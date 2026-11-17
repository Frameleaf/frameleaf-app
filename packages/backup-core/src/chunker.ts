import { derive } from './keys.js';

export interface ChunkerParams {
  min: number;
  /** A power of two. */
  avg: number;
  max: number;
}

export const DEFAULT_CHUNKER: ChunkerParams = { min: 512 * 1024, avg: 2 * 1024 * 1024, max: 8 * 1024 * 1024 };

export function checkChunker({ min, avg, max }: ChunkerParams) {
  const bits = Math.log2(avg);
  if (
    !Number.isInteger(bits) ||
    bits < 8 ||
    bits > 26 ||
    !(min >= 64 && min < avg && avg < max && max <= 64 * 1024 * 1024)
  ) {
    throw new RangeError('Chunk sizes must satisfy 64 <= min < avg < max <= 64 MiB, with avg a power of two');
  }
}

/** 256 values from the repository's cut key: without the key, nobody can predict where files are cut. */
export function gearTable(cutKey: Buffer): Uint32Array {
  const bytes = derive(cutKey, Buffer.alloc(0), 'gear', 1024);
  return Uint32Array.from({ length: 256 }, (_, index) => bytes.readUInt32LE(index * 4));
}

const topBits = (count: number) => (0xff_ff_ff_ff << (32 - count)) >>> 0;

/**
 * FastCDC with normalised chunking: a stricter test before the average size and a looser one after it,
 * which keeps sizes close to the average. Returns how many bytes of `data` form the next chunk, or -1
 * when more data is needed to decide.
 */
export function cutPoint(
  data: Uint8Array,
  length: number,
  last: boolean,
  params: ChunkerParams,
  gear: Uint32Array,
): number {
  const { min, avg, max } = params;
  if (length <= min) {
    return last ? length : -1;
  }
  const bits = Math.log2(avg);
  const strict = topBits(bits + 2);
  const loose = topBits(bits - 2);
  const end = Math.min(length, max);
  let hash = 0;
  for (let index = min; index < end; index++) {
    hash = ((hash << 1) + gear[data[index]!]!) >>> 0;
    if ((hash & (index < avg ? strict : loose)) === 0) {
      return index + 1;
    }
  }
  return end === max || last ? end : -1;
}

/** Cuts a stream into chunks. The same bytes under the same key always give the same chunks. */
export async function* chunkStream(
  source: AsyncIterable<Uint8Array>,
  params: ChunkerParams,
  gear: Uint32Array,
): AsyncGenerator<Buffer> {
  let held: Uint8Array[] = [];
  let size = 0;
  const drain = function* (last: boolean) {
    const data = held.length === 1 ? (held[0] as Buffer) : Buffer.concat(held, size);
    let offset = 0;
    while (offset < data.length) {
      const rest = data.subarray(offset);
      const cut = cutPoint(rest, rest.length, last, params, gear);
      if (cut < 0) {
        break;
      }
      yield rest.subarray(0, cut);
      offset += cut;
    }
    held = offset < data.length ? [data.subarray(offset)] : [];
    size = data.length - offset;
  };
  for await (const part of source) {
    if (part.byteLength === 0) {
      continue;
    }
    // Copied: a source may hand over the same buffer again with new bytes in it.
    held.push(Buffer.from(part));
    size += part.byteLength;
    // Deciding a cut never needs more than `max` bytes, so wait until that much is in hand.
    if (size >= params.max) {
      yield* drain(false);
    }
  }
  if (size > 0) {
    yield* drain(true);
  }
}
