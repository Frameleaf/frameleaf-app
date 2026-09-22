import test from "node:test";
import assert from "node:assert/strict";
import {
  aspectRatio,
  justifiedRows,
  rowHeightFor,
} from "../src/justified-layout.mjs";
import { media } from "../src/media.js";

const landscape = (id) => ({ id, width: 3000, height: 2000 });
const portrait = (id) => ({ id, width: 2000, height: 3000 });
const rowWidth = (row, gap) =>
  row.items.reduce((sum, tile) => sum + tile.width, 0) +
  gap * (row.items.length - 1);

test("aspect ratio falls back to 3:2 and clamps extreme dimensions", () => {
  assert.equal(aspectRatio({ width: 3000, height: 2000 }), 1.5);
  assert.equal(aspectRatio({}), 1.5);
  assert.equal(aspectRatio({ width: "x", height: 10 }), 1.5);
  assert.equal(aspectRatio({ width: 0, height: 10 }), 1.5);
  assert.equal(aspectRatio({ width: 100, height: 1 }), 6);
  assert.equal(aspectRatio({ width: 1, height: 100 }), 0.25);
  assert.equal(aspectRatio(null), 1.5);
});

test("empty input or a zero-width container produces no rows", () => {
  assert.deepEqual(justifiedRows([], { containerWidth: 900 }), []);
  assert.deepEqual(justifiedRows([landscape("a")], { containerWidth: 0 }), []);
  assert.deepEqual(justifiedRows(null, { containerWidth: 900 }), []);
  assert.deepEqual(
    justifiedRows([landscape("a")], { containerWidth: Number.NaN }),
    [],
  );
});

test("full rows fill the container width exactly and stay near the target height", () => {
  const items = Array.from({ length: 11 }, (_, i) => landscape(String(i)));
  const gap = 4;
  const rows = justifiedRows(items, {
    containerWidth: 1000,
    targetRowHeight: 200,
    gap,
  });
  assert.ok(rows.length >= 3);
  for (const row of rows.slice(0, -1)) {
    assert.equal(rowWidth(row, gap), 1000, "row fills the width");
    assert.equal(row.width, 1000);
    assert.ok(row.height >= 150 && row.height <= 300, `height ${row.height}`);
    for (const tile of row.items) assert.equal(tile.height, row.height);
  }
  const placed = rows.flatMap((row) => row.items.map((tile) => tile.item.id));
  assert.deepEqual(
    placed,
    items.map((item) => item.id),
    "order is preserved and nothing is dropped",
  );
});

test("the last row is never stretched beyond maxRowHeight", () => {
  const rows = justifiedRows([landscape("only")], {
    containerWidth: 1200,
    targetRowHeight: 200,
    maxRowHeight: 260,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].height, 200, "keeps the target height instead of filling");
  assert.equal(rows[0].items[0].width, 300);
  assert.ok(rows[0].width < 1200);

  const nearlyFull = justifiedRows(
    [landscape("a"), landscape("b"), landscape("c")],
    { containerWidth: 1000, targetRowHeight: 200, maxRowHeight: 260, gap: 0 },
  );
  assert.equal(nearlyFull.length, 1);
  assert.equal(nearlyFull[0].height, 222, "stretches when within max");
  assert.equal(rowWidth(nearlyFull[0], 0), 1000);
});

test("wide panoramas shrink to fit instead of overflowing", () => {
  const rows = justifiedRows(
    [{ id: "pano", width: 12000, height: 3000 }, landscape("b")],
    { containerWidth: 600, targetRowHeight: 200, gap: 0 },
  );
  assert.equal(rows[0].items.length, 1);
  assert.equal(rows[0].items[0].item.id, "pano");
  assert.equal(rows[0].items[0].width, 600);
  assert.equal(rows[0].height, 150);
});

test("mixed orientations keep proportions and respect the gap", () => {
  const gap = 8;
  const items = [portrait("p1"), landscape("l1"), portrait("p2"), landscape("l2"), landscape("l3"), portrait("p3")];
  const rows = justifiedRows(items, { containerWidth: 800, targetRowHeight: 180, gap });
  for (const row of rows.slice(0, -1)) assert.equal(rowWidth(row, gap), 800);
  for (const row of rows)
    for (const tile of row.items) {
      const ratio = tile.width / tile.height;
      const expected = aspectRatio(tile.item);
      assert.ok(Math.abs(ratio - expected) < 0.05, `${tile.item.id} ${ratio}`);
    }
});

test("invalid options fall back to defaults and input is not mutated", () => {
  const items = media.slice(0, 6).map((asset) => ({ ...asset }));
  const snapshot = JSON.stringify(items);
  const rows = justifiedRows(items, {
    containerWidth: 900,
    targetRowHeight: "tall",
    gap: -3,
    maxRowHeight: 0,
  });
  assert.ok(rows.length > 0);
  assert.equal(JSON.stringify(items), snapshot);
  assert.ok(rows.every((row) => row.height >= 1));
});

test("row height suggestion scales with the container width", () => {
  assert.equal(rowHeightFor(0), 120);
  assert.ok(rowHeightFor(360) < rowHeightFor(1400));
  assert.ok(rowHeightFor(3000) <= 260);
  assert.ok(rowHeightFor(200) >= 120);
});
