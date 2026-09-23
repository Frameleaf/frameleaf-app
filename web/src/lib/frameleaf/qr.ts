// Dependency-free QR code encoder: byte mode, error correction L or M,
// versions 1-10 with automatic version selection, standard masking with
// penalty evaluation. Returns a boolean matrix (rows of modules, true = dark).
//
// Ported from design/frameleaf/template/src/qr.mjs (design evidence) for the
// production shared-link QR code. Pure and framework-free by design so it can
// run client-side with no dependency on the network or the SDK.

export const MIN_VERSION = 1;
export const MAX_VERSION = 10;
export const ECC_LEVELS = ['L', 'M'] as const;
export type EccLevel = (typeof ECC_LEVELS)[number];

export interface QrSymbol {
  version: number;
  size: number;
  ecc: EccLevel;
  mask: number;
  modules: boolean[][];
}

// Format-information bits per level (ISO/IEC 18004 table 12).
const FORMAT_BITS: Record<EccLevel, number> = { L: 1, M: 0 };
// Error-correction codewords per block, indexed by version (index 0 unused).
const ECC_CODEWORDS_PER_BLOCK: Record<EccLevel, number[]> = {
  L: [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18],
  M: [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26],
};
// Number of error-correction blocks, indexed by version.
const NUM_BLOCKS: Record<EccLevel, number[]> = {
  L: [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4],
  M: [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5],
};
const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

function assertVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version < MIN_VERSION || version > MAX_VERSION) {
    throw new RangeError(`Version must be between ${MIN_VERSION} and ${MAX_VERSION}`);
  }
}
function assertEcc(ecc: string): asserts ecc is EccLevel {
  if (!(ECC_LEVELS as readonly string[]).includes(ecc)) {
    throw new RangeError('Error correction must be L or M');
  }
}

export function qrSize(version: number): number {
  assertVersion(version);
  return version * 4 + 17;
}

function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) {
      result -= 36;
    }
  }
  return result;
}

export function dataCodewords(version: number, ecc: EccLevel): number {
  assertVersion(version);
  assertEcc(ecc);
  return Math.floor(rawDataModules(version) / 8) - ECC_CODEWORDS_PER_BLOCK[ecc][version] * NUM_BLOCKS[ecc][version];
}

/** Maximum number of bytes that fit in byte mode for a version and level. */
export function byteCapacity(version: number, ecc: EccLevel): number {
  const header = 4 + (version < 10 ? 8 : 16);
  return Math.floor((dataCodewords(version, ecc) * 8 - header) / 8);
}

function alignmentPositions(version: number): number[] {
  if (version === 1) {
    return [];
  }
  const size = qrSize(version);
  const numAlign = Math.floor(version / 7) + 2;
  const step = Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) {
    result.splice(1, 0, pos);
  }
  return result;
}

// Galois field GF(2^8) arithmetic with the QR reducing polynomial 0x11D.
export function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x1_1d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function reedSolomonDivisor(degree: number): number[] {
  const result = Array.from({ length: degree }, () => 0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < result.length) {
        result[j] ^= result[j + 1];
      }
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

/** Reed-Solomon remainder (error-correction codewords) for a data block. */
export function reedSolomonRemainder(data: number[], degree: number): number[] {
  const divisor = reedSolomonDivisor(degree);
  const result = divisor.map(() => 0);
  for (const byte of data) {
    const factor = byte ^ (result.shift() as number);
    result.push(0);
    for (const [i, coefficient] of divisor.entries()) {
      result[i] ^= gfMultiply(coefficient, factor);
    }
  }
  return result;
}

function appendBits(bits: number[], value: number, length: number): void {
  for (let i = length - 1; i >= 0; i--) {
    bits.push((value >>> i) & 1);
  }
}

function buildCodewords(bytes: number[], version: number, ecc: EccLevel): number[] {
  const bits: number[] = [];
  appendBits(bits, 0b0100, 4);
  appendBits(bits, bytes.length, version < 10 ? 8 : 16);
  for (const byte of bytes) {
    appendBits(bits, byte, 8);
  }
  const capacity = dataCodewords(version, ecc) * 8;
  appendBits(bits, 0, Math.min(4, capacity - bits.length));
  appendBits(bits, 0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) {
    appendBits(bits, pad, 8);
  }
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) {
      byte = (byte << 1) | bits[i + j];
    }
    data.push(byte);
  }
  return data;
}

function addEccAndInterleave(data: number[], version: number, ecc: EccLevel): number[] {
  const numBlocks = NUM_BLOCKS[ecc][version];
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecc][version];
  const rawCodewords = Math.floor(rawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const length = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
    const block = data.slice(k, k + length);
    k += length;
    const eccWords = reedSolomonRemainder(block, blockEccLen);
    if (i < numShortBlocks) {
      block.push(0);
    }
    blocks.push(block.concat(eccWords));
  }
  const result: number[] = [];
  for (let i = 0; i < blocks[0].length; i++) {
    for (const [j, block] of blocks.entries()) {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) {
        result.push(block[i]);
      }
    }
  }
  return result;
}

const getBit = (value: number, index: number): boolean => ((value >>> index) & 1) !== 0;

class Matrix {
  size: number;
  modules: boolean[][];
  isFunction: boolean[][];

  constructor(size: number) {
    this.size = size;
    this.modules = Array.from({ length: size }, () => Array.from({ length: size }, () => false));
    this.isFunction = Array.from({ length: size }, () => Array.from({ length: size }, () => false));
  }
  setFunction(x: number, y: number, dark: boolean): void {
    this.modules[y][x] = dark;
    this.isFunction[y][x] = true;
  }
  drawFinder(x: number, y: number): void {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) {
          this.setFunction(xx, yy, distance !== 2 && distance !== 4);
        }
      }
    }
  }
  drawAlignment(x: number, y: number): void {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        this.setFunction(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }
  drawFormatBits(ecc: EccLevel, mask: number): void {
    const data = (FORMAT_BITS[ecc] << 3) | mask;
    let remainder = data;
    for (let i = 0; i < 10; i++) {
      remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x5_37);
    }
    const bits = ((data << 10) | remainder) ^ 0x54_12;
    for (let i = 0; i <= 5; i++) {
      this.setFunction(8, i, getBit(bits, i));
    }
    this.setFunction(8, 7, getBit(bits, 6));
    this.setFunction(8, 8, getBit(bits, 7));
    this.setFunction(7, 8, getBit(bits, 8));
    for (let i = 9; i < 15; i++) {
      this.setFunction(14 - i, 8, getBit(bits, i));
    }
    for (let i = 0; i < 8; i++) {
      this.setFunction(this.size - 1 - i, 8, getBit(bits, i));
    }
    for (let i = 8; i < 15; i++) {
      this.setFunction(8, this.size - 15 + i, getBit(bits, i));
    }
    this.setFunction(8, this.size - 8, true);
  }
  drawVersion(version: number): void {
    if (version < 7) {
      return;
    }
    let remainder = version;
    for (let i = 0; i < 12; i++) {
      remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f_25);
    }
    const bits = (version << 12) | remainder;
    for (let i = 0; i < 18; i++) {
      const dark = getBit(bits, i);
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.setFunction(a, b, dark);
      this.setFunction(b, a, dark);
    }
  }
  drawFunctionPatterns(version: number, ecc: EccLevel): void {
    for (let i = 0; i < this.size; i++) {
      this.setFunction(6, i, i % 2 === 0);
      this.setFunction(i, 6, i % 2 === 0);
    }
    this.drawFinder(3, 3);
    this.drawFinder(this.size - 4, 3);
    this.drawFinder(3, this.size - 4);
    const positions = alignmentPositions(version);
    const count = positions.length;
    for (let i = 0; i < count; i++) {
      for (let j = 0; j < count; j++) {
        const corner = (i === 0 && j === 0) || (i === 0 && j === count - 1) || (i === count - 1 && j === 0);
        if (!corner) {
          this.drawAlignment(positions[i], positions[j]);
        }
      }
    }
    this.drawFormatBits(ecc, 0);
    this.drawVersion(version);
  }
  drawCodewords(data: number[]): void {
    let i = 0;
    const total = data.length * 8;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) {
        right = 5;
      }
      for (let vertical = 0; vertical < this.size; vertical++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? this.size - 1 - vertical : vertical;
          if (!this.isFunction[y][x] && i < total) {
            this.modules[y][x] = getBit(data[i >>> 3], 7 - (i & 7));
            i++;
          }
        }
      }
    }
  }
  applyMask(mask: number): void {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        let invert: boolean;
        switch (mask) {
          case 0: {
            invert = (x + y) % 2 === 0;
            break;
          }
          case 1: {
            invert = y % 2 === 0;
            break;
          }
          case 2: {
            invert = x % 3 === 0;
            break;
          }
          case 3: {
            invert = (x + y) % 3 === 0;
            break;
          }
          case 4: {
            invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
            break;
          }
          case 5: {
            invert = ((x * y) % 2) + ((x * y) % 3) === 0;
            break;
          }
          case 6: {
            invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
            break;
          }
          default: {
            invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
          }
        }
        if (!this.isFunction[y][x] && invert) {
          this.modules[y][x] = !this.modules[y][x];
        }
      }
    }
  }
  finderPenaltyAddHistory(runLength: number, history: number[]): void {
    if (history[0] === 0) {
      runLength += this.size;
    }
    history.pop();
    history.unshift(runLength);
  }
  finderPenaltyCountPatterns(history: number[]): number {
    const n = history[1];
    const core = n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n;
    return (
      (core && history[0] >= n * 4 && history[6] >= n ? 1 : 0) +
      (core && history[6] >= n * 4 && history[0] >= n ? 1 : 0)
    );
  }
  finderPenaltyTerminate(runColor: boolean, runLength: number, history: number[]): number {
    if (runColor) {
      this.finderPenaltyAddHistory(runLength, history);
      runLength = 0;
    }
    runLength += this.size;
    this.finderPenaltyAddHistory(runLength, history);
    return this.finderPenaltyCountPatterns(history);
  }
  penaltyScore(): number {
    let result = 0;
    const { size, modules } = this;
    for (let y = 0; y < size; y++) {
      let runColor = false;
      let runX = 0;
      const history = [0, 0, 0, 0, 0, 0, 0];
      for (let x = 0; x < size; x++) {
        if (modules[y][x] === runColor) {
          runX++;
          if (runX === 5) {
            result += PENALTY_N1;
          } else if (runX > 5) {
            result++;
          }
        } else {
          this.finderPenaltyAddHistory(runX, history);
          if (!runColor) {
            result += this.finderPenaltyCountPatterns(history) * PENALTY_N3;
          }
          runColor = modules[y][x];
          runX = 1;
        }
      }
      result += this.finderPenaltyTerminate(runColor, runX, history) * PENALTY_N3;
    }
    for (let x = 0; x < size; x++) {
      let runColor = false;
      let runY = 0;
      const history = [0, 0, 0, 0, 0, 0, 0];
      for (let y = 0; y < size; y++) {
        if (modules[y][x] === runColor) {
          runY++;
          if (runY === 5) {
            result += PENALTY_N1;
          } else if (runY > 5) {
            result++;
          }
        } else {
          this.finderPenaltyAddHistory(runY, history);
          if (!runColor) {
            result += this.finderPenaltyCountPatterns(history) * PENALTY_N3;
          }
          runColor = modules[y][x];
          runY = 1;
        }
      }
      result += this.finderPenaltyTerminate(runColor, runY, history) * PENALTY_N3;
    }
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const color = modules[y][x];
        if (color === modules[y][x + 1] && color === modules[y + 1][x] && color === modules[y + 1][x + 1]) {
          result += PENALTY_N2;
        }
      }
    }
    let dark = 0;
    for (const row of modules) {
      for (const cell of row) {
        if (cell) {
          dark++;
        }
      }
    }
    const total = size * size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    return result + k * PENALTY_N4;
  }
}

/** Smallest version (1-10) whose byte capacity holds the text, or null. */
export function selectVersion(byteLength: number, ecc: EccLevel, minVersion: number = MIN_VERSION): number | null {
  assertEcc(ecc);
  for (let version = minVersion; version <= MAX_VERSION; version++) {
    if (byteLength <= byteCapacity(version, ecc)) {
      return version;
    }
  }
  return null;
}

/** Encode text as a QR symbol. */
export function encodeQr(text: string, options: { ecc?: EccLevel; minVersion?: number } = {}): QrSymbol {
  const { ecc = 'M', minVersion = MIN_VERSION } = options;
  if (typeof text !== 'string') {
    throw new TypeError('Text must be a string');
  }
  assertEcc(ecc);
  assertVersion(minVersion);
  const bytes = Array.from(new TextEncoder().encode(text));
  const version = selectVersion(bytes.length, ecc, minVersion);
  if (version === null) {
    throw new RangeError(
      `Text is too long for a version ${MAX_VERSION} QR code (${bytes.length} bytes, limit ${byteCapacity(MAX_VERSION, ecc)})`,
    );
  }
  const codewords = addEccAndInterleave(buildCodewords(bytes, version, ecc), version, ecc);
  const matrix = new Matrix(qrSize(version));
  matrix.drawFunctionPatterns(version, ecc);
  matrix.drawCodewords(codewords);
  let mask = 0;
  let best = Infinity;
  for (let candidate = 0; candidate < 8; candidate++) {
    matrix.applyMask(candidate);
    matrix.drawFormatBits(ecc, candidate);
    const penalty = matrix.penaltyScore();
    if (penalty < best) {
      best = penalty;
      mask = candidate;
    }
    matrix.applyMask(candidate);
  }
  matrix.applyMask(mask);
  matrix.drawFormatBits(ecc, mask);
  return {
    version,
    size: matrix.size,
    ecc,
    mask,
    modules: matrix.modules.map((row) => row.slice()),
  };
}

/** SVG path data for the dark modules, offset by a quiet zone in modules. */
export function qrPath(modules: boolean[][], quiet: number = 4): string {
  const parts: string[] = [];
  for (const [y, row] of modules.entries()) {
    for (const [x, dark] of row.entries()) {
      if (dark) {
        parts.push(`M${x + quiet} ${y + quiet}h1v1h-1z`);
      }
    }
  }
  return parts.join('');
}
