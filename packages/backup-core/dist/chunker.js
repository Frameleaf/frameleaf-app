import { derive } from './keys.js';
export const DEFAULT_CHUNKER = { min: 512 * 1024, avg: 2 * 1024 * 1024, max: 8 * 1024 * 1024 };
export function checkChunker({ min, avg, max }) {
    const bits = Math.log2(avg);
    if (!Number.isInteger(bits) ||
        bits < 8 ||
        bits > 26 ||
        !(min >= 64 && min < avg && avg < max && max <= 64 * 1024 * 1024)) {
        throw new RangeError('Chunk sizes must satisfy 64 <= min < avg < max <= 64 MiB, with avg a power of two');
    }
}
export function gearTable(cutKey) {
    const bytes = derive(cutKey, Buffer.alloc(0), 'gear', 1024);
    return Uint32Array.from({ length: 256 }, (_, index) => bytes.readUInt32LE(index * 4));
}
const topBits = (count) => (0xff_ff_ff_ff << (32 - count)) >>> 0;
export function cutPoint(data, length, last, params, gear) {
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
        hash = ((hash << 1) + gear[data[index]]) >>> 0;
        if ((hash & (index < avg ? strict : loose)) === 0) {
            return index + 1;
        }
    }
    return end === max || last ? end : -1;
}
export async function* chunkStream(source, params, gear) {
    let held = [];
    let size = 0;
    const drain = function* (last) {
        const data = held.length === 1 ? held[0] : Buffer.concat(held, size);
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
        held.push(Buffer.from(part));
        size += part.byteLength;
        if (size >= params.max) {
            yield* drain(false);
        }
    }
    if (size > 0) {
        yield* drain(true);
    }
}
