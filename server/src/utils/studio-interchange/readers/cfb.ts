/**
 * A read-only Microsoft Compound File Binary reader (MS-CFB), the container AAF files use (FL-1552).
 * The whole file is in memory; every chain is followed with a visited set and every size is checked,
 * so a corrupt or hostile file is refused instead of looping or reading past the end.
 */
import { InterchangeReadError } from 'src/utils/studio-interchange/readers/common.js';

const SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const END_OF_CHAIN = 0xff_ff_ff_fe;
const FREE = 0xff_ff_ff_ff;
const NO_STREAM = 0xff_ff_ff_ff;
const MAX_ENTRIES = 1_000_000;

export type CfbEntry = {
  id: number;
  name: string;
  /** 1 storage, 2 stream, 5 root. */
  type: number;
  /** The class of an AAF object, as a GUID string. */
  clsid: string;
  left: number;
  right: number;
  child: number;
  start: number;
  size: number;
};

const corrupt = (detail: string) => new InterchangeReadError('malformed', `This AAF file is damaged (${detail})`);

/** A GUID as stored (first three fields little-endian) to its usual string form. */
export const guidString = (bytes: Buffer) => {
  const hex = (buffer: Buffer) => buffer.toString('hex');
  return [
    hex(Buffer.from(bytes.subarray(0, 4)).reverse()),
    hex(Buffer.from(bytes.subarray(4, 6)).reverse()),
    hex(Buffer.from(bytes.subarray(6, 8)).reverse()),
    hex(bytes.subarray(8, 10)),
    hex(bytes.subarray(10, 16)),
  ].join('-');
};

export class CompoundFile {
  private readonly sectorSize: number;
  private readonly miniSectorSize: number;
  private readonly miniCutoff: number;
  private readonly fat: Uint32Array;
  private readonly miniFat: Uint32Array;
  private readonly miniStream: Buffer;
  readonly entries: CfbEntry[];

  constructor(private readonly bytes: Buffer) {
    if (bytes.length < 512 || !bytes.subarray(0, 8).equals(SIGNATURE)) {
      throw new InterchangeReadError('unsupported', 'This is not an AAF file');
    }
    const sectorShift = bytes.readUInt16LE(0x1e);
    const miniShift = bytes.readUInt16LE(0x20);
    if (![9, 12].includes(sectorShift) || miniShift !== 6) {
      throw corrupt('sector size');
    }
    this.sectorSize = 1 << sectorShift;
    this.miniSectorSize = 1 << miniShift;
    this.miniCutoff = bytes.readUInt32LE(0x38);
    const fatSectors = bytes.readUInt32LE(0x2c);
    const firstDirectory = bytes.readUInt32LE(0x30);
    const firstMiniFat = bytes.readUInt32LE(0x3c);
    const miniFatSectors = bytes.readUInt32LE(0x40);
    let difatSector = bytes.readUInt32LE(0x44);
    const sectorCount = Math.floor(bytes.length / this.sectorSize);
    if (fatSectors > sectorCount) {
      throw corrupt('allocation table');
    }

    // The allocation table's own sectors: 109 in the header, the rest in a chain of DIFAT sectors.
    const fatIds: number[] = [];
    for (let index = 0; index < 109 && fatIds.length < fatSectors; index++) {
      fatIds.push(bytes.readUInt32LE(0x4c + index * 4));
    }
    const seenDifat = new Set<number>();
    const perDifat = this.sectorSize / 4 - 1;
    while (fatIds.length < fatSectors && difatSector !== END_OF_CHAIN && difatSector !== FREE) {
      if (seenDifat.has(difatSector) || difatSector >= sectorCount) {
        throw corrupt('allocation chain');
      }
      seenDifat.add(difatSector);
      const offset = this.offsetOf(difatSector);
      for (let index = 0; index < perDifat && fatIds.length < fatSectors; index++) {
        fatIds.push(bytes.readUInt32LE(offset + index * 4));
      }
      difatSector = bytes.readUInt32LE(offset + perDifat * 4);
    }
    const perSector = this.sectorSize / 4;
    this.fat = new Uint32Array(fatIds.length * perSector);
    for (const [index, id] of fatIds.entries()) {
      if (id >= sectorCount) {
        throw corrupt('allocation table sector');
      }
      const offset = this.offsetOf(id);
      for (let entry = 0; entry < perSector; entry++) {
        this.fat[index * perSector + entry] = bytes.readUInt32LE(offset + entry * 4);
      }
    }

    const directory = this.readChain(firstDirectory);
    const count = Math.min(Math.floor(directory.length / 128), MAX_ENTRIES);
    this.entries = [];
    for (let id = 0; id < count; id++) {
      const at = id * 128;
      const nameLength = Math.min(64, directory.readUInt16LE(at + 64));
      this.entries.push({
        id,
        name: directory.subarray(at, at + Math.max(0, nameLength - 2)).toString('utf16le'),
        type: directory[at + 66],
        left: directory.readUInt32LE(at + 68),
        right: directory.readUInt32LE(at + 72),
        child: directory.readUInt32LE(at + 76),
        clsid: guidString(directory.subarray(at + 80, at + 96)),
        start: directory.readUInt32LE(at + 116),
        // Version 3 files keep only the low 32 bits.
        size: sectorShift === 9 ? directory.readUInt32LE(at + 120) : Number(directory.readBigUInt64LE(at + 120)),
      });
    }
    const root = this.entries[0];
    if (root?.type !== 5) {
      throw corrupt('root');
    }
    const miniFatBytes = miniFatSectors > 0 ? this.readChain(firstMiniFat) : Buffer.alloc(0);
    this.miniFat = new Uint32Array(Math.floor(miniFatBytes.length / 4));
    for (let index = 0; index < this.miniFat.length; index++) {
      this.miniFat[index] = miniFatBytes.readUInt32LE(index * 4);
    }
    this.miniStream = root.start === END_OF_CHAIN ? Buffer.alloc(0) : this.readChain(root.start, root.size);
  }

  get root() {
    return this.entries[0];
  }

  private offsetOf(sector: number) {
    return (sector + 1) * this.sectorSize;
  }

  private readChain(start: number, size?: number) {
    const parts: Buffer[] = [];
    const seen = new Set<number>();
    let sector = start;
    let total = 0;
    while (sector !== END_OF_CHAIN && sector !== FREE) {
      if (
        seen.has(sector) ||
        sector >= this.fat.length ||
        this.offsetOf(sector) + this.sectorSize > this.bytes.length
      ) {
        throw corrupt('sector chain');
      }
      seen.add(sector);
      parts.push(this.bytes.subarray(this.offsetOf(sector), this.offsetOf(sector) + this.sectorSize));
      total += this.sectorSize;
      if (size !== undefined && total >= size) {
        break;
      }
      sector = this.fat[sector];
    }
    const joined = Buffer.concat(parts);
    if (size !== undefined && joined.length < size) {
      throw corrupt('short stream');
    }
    return size === undefined ? joined : joined.subarray(0, size);
  }

  private readMiniChain(start: number, size: number) {
    const out = Buffer.alloc(size);
    const seen = new Set<number>();
    let sector = start;
    let written = 0;
    while (written < size) {
      const offset = sector * this.miniSectorSize;
      if (
        sector === END_OF_CHAIN ||
        seen.has(sector) ||
        sector >= this.miniFat.length ||
        offset + this.miniSectorSize > this.miniStream.length
      ) {
        throw corrupt('mini sector chain');
      }
      seen.add(sector);
      written += this.miniStream.copy(out, written, offset, offset + Math.min(this.miniSectorSize, size - written));
      sector = this.miniFat[sector];
    }
    return out;
  }

  /** A stream's bytes. */
  read(entry: CfbEntry): Buffer {
    if (entry.type !== 2) {
      throw corrupt('not a stream');
    }
    if (entry.size === 0) {
      return Buffer.alloc(0);
    }
    if (entry.size > this.bytes.length * 2) {
      throw corrupt('stream size');
    }
    return entry.size < this.miniCutoff
      ? this.readMiniChain(entry.start, entry.size)
      : this.readChain(entry.start, entry.size);
  }

  /** The entries directly inside a storage, by name. */
  children(storage: CfbEntry): Map<string, CfbEntry> {
    const found = new Map<string, CfbEntry>();
    const pending = [storage.child];
    const seen = new Set<number>();
    while (pending.length > 0) {
      const id = pending.pop()!;
      if (id === NO_STREAM || seen.has(id)) {
        continue;
      }
      const entry = this.entries[id];
      if (!entry) {
        throw corrupt('directory tree');
      }
      seen.add(id);
      found.set(entry.name, entry);
      pending.push(entry.left, entry.right);
    }
    return found;
  }
}
