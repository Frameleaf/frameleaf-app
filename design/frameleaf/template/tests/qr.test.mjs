import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_VERSION,
  byteCapacity,
  encodeQr,
  gfMultiply,
  qrPath,
  qrSize,
  reedSolomonRemainder,
  selectVersion,
} from "../src/qr.mjs";

const FINDER = [
  "1111111",
  "1000001",
  "1011101",
  "1011101",
  "1011101",
  "1000001",
  "1111111",
];
const finderAt = (modules, left, top) =>
  FINDER.every((row, dy) =>
    [...row].every((cell, dx) => modules[top + dy][left + dx] === (cell === "1")),
  );
const bit = (modules, x, y) => (modules[y][x] ? 1 : 0);
const readFormat = (modules) => {
  let value = 0;
  const set = (index, x, y) => {
    value |= bit(modules, x, y) << index;
  };
  for (let i = 0; i <= 5; i++) set(i, 8, i);
  set(6, 8, 7);
  set(7, 8, 8);
  set(8, 7, 8);
  for (let i = 9; i < 15; i++) set(i, 14 - i, 8);
  return value;
};
const bchFormat = (data) => {
  let remainder = data;
  for (let i = 0; i < 10; i++)
    remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  return ((data << 10) | remainder) ^ 0x5412;
};

test("encodes a share URL to a square matrix with finder patterns in three corners", () => {
  const { modules, size, version, ecc } = encodeQr("http://a.test/s/abc");
  assert.equal(ecc, "M");
  assert.equal(version, 2);
  assert.equal(size, qrSize(version));
  assert.equal(modules.length, size);
  assert.ok(modules.every((row) => row.length === size));
  assert.ok(modules.every((row) => row.every((cell) => typeof cell === "boolean")));
  assert.ok(finderAt(modules, 0, 0), "top-left finder");
  assert.ok(finderAt(modules, size - 7, 0), "top-right finder");
  assert.ok(finderAt(modules, 0, size - 7), "bottom-left finder");
  for (let i = 0; i < 8; i++) {
    assert.equal(modules[7][i], false, "top-left separator row");
    assert.equal(modules[i][7], false, "top-left separator column");
    assert.equal(modules[7][size - 1 - i], false, "top-right separator row");
    assert.equal(modules[size - 1 - i][7], false, "bottom-left separator column");
  }
});

test("output is deterministic and independent between calls", () => {
  const first = encodeQr("http://a.test/s/abc");
  const second = encodeQr("http://a.test/s/abc");
  assert.deepEqual(first, second);
  first.modules[0][0] = !first.modules[0][0];
  assert.notDeepEqual(first.modules, encodeQr("http://a.test/s/abc").modules);
});

test("rejects strings too long for version 10 and reports capacity", () => {
  const limitL = byteCapacity(MAX_VERSION, "L");
  const limitM = byteCapacity(MAX_VERSION, "M");
  assert.equal(limitL, 271);
  assert.equal(limitM, 213);
  assert.equal(encodeQr("x".repeat(limitL), { ecc: "L" }).version, 10);
  assert.throws(() => encodeQr("x".repeat(limitL + 1), { ecc: "L" }), RangeError);
  assert.throws(() => encodeQr("x".repeat(limitM + 1), { ecc: "M" }), RangeError);
  assert.throws(() => encodeQr(42), TypeError);
  assert.throws(() => encodeQr("abc", { ecc: "Q" }), RangeError);
});

test("selects the smallest version that fits the byte length", () => {
  assert.equal(byteCapacity(1, "L"), 17);
  assert.equal(byteCapacity(1, "M"), 14);
  assert.equal(selectVersion(17, "L"), 1);
  assert.equal(selectVersion(18, "L"), 2);
  assert.equal(selectVersion(14, "M"), 1);
  assert.equal(selectVersion(15, "M"), 2);
  assert.equal(selectVersion(1000, "L"), null);
  assert.equal(encodeQr("café", { ecc: "L" }).version, 1);
  assert.equal(encodeQr("a".repeat(18), { ecc: "L", minVersion: 4 }).version, 4);
  const large = encodeQr("https://frameleaf.test/share/" + "k".repeat(150), {
    ecc: "L",
  });
  assert.ok(large.version >= 7);
  assert.equal(large.size, large.version * 4 + 17);
});

test("format information encodes the chosen level and mask with a valid BCH code", () => {
  for (const ecc of ["L", "M"]) {
    const { modules, mask } = encodeQr("Frameleaf shared link", { ecc });
    assert.ok(mask >= 0 && mask < 8);
    const value = readFormat(modules);
    const data = ((value ^ 0x5412) >>> 10) & 0x1f;
    assert.equal(data & 7, mask);
    assert.equal(data >>> 3, ecc === "L" ? 1 : 0);
    assert.equal(value, bchFormat(data));
  }
  assert.equal(bchFormat(0), 0x5412);
});

test("timing patterns alternate and the dark module is set", () => {
  const { modules, size } = encodeQr("timing");
  for (let i = 8; i < size - 8; i++) {
    assert.equal(modules[6][i], i % 2 === 0);
    assert.equal(modules[i][6], i % 2 === 0);
  }
  assert.equal(modules[size - 8][8], true);
});

test("Reed–Solomon codewords vanish at the generator roots", () => {
  const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
  const ecc = reedSolomonRemainder(data, 10);
  assert.deepEqual(ecc, [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  const codeword = [...data, ...ecc];
  let root = 1;
  for (let j = 0; j < 10; j++) {
    let acc = 0;
    for (const byte of codeword) acc = gfMultiply(acc, root) ^ byte;
    assert.equal(acc, 0, `root alpha^${j}`);
    root = gfMultiply(root, 2);
  }
});

test("qrPath emits one square per dark module inside the quiet zone", () => {
  const { modules } = encodeQr("path");
  const dark = modules.flat().filter(Boolean).length;
  const path = qrPath(modules, 4);
  assert.equal((path.match(/h1v1h-1z/g) || []).length, dark);
  assert.ok(path.startsWith("M"));
  assert.ok(path.includes("M4 4h1v1h-1z"), "top-left finder offset by quiet zone");
});
