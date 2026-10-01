/** Node contract check of the fixture's actual inline readback, not a renderer/browser proof. */
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";

const source = await readFile(new URL("./admitted-host.browser.mjs", import.meta.url), "utf8");
const start = source.indexOf("result = await frame.evaluate(async (expected) => {");
assert.ok(start >= 0);
const end = source.indexOf("}, x);", start);
assert.ok(end > start);
// Do not import the executable runner: its normal auth/admission entrypoint must stay intact.
const callback = source.slice(start + "result = await frame.evaluate(".length, end + 1);
const refusalStart = source.indexOf("assert.ok(\n      result.maxDelta <= 1", end);
assert.ok(refusalStart > end);
const refusalEnd = source.indexOf("\n    );", refusalStart);
const refusal = source.slice(refusalStart, refusalEnd + 7);

async function readback(width, height, wrongEdge = false) {
  const backing = new Uint8ClampedArray(Math.max(1, width * height * 4)).fill(240);
  const p = (width - 128) / 2;
  if (Number.isInteger(p) && p >= 0 && height === 96 + 2 * p) {
    for (let y = 0; y < 96; y++)
      backing.fill(0, ((y + p) * width + p) * 4, ((y + p) * width + p + 128) * 4);
    if (wrongEdge) backing[((95 + p) * width + p + 127) * 4] = 2;
  }
  const copies = [];
  const canvas = {
    width,
    height,
    checkVisibility: () => true,
    toDataURL: () => "data:image/png;base64,cmF3LXBhZGRlZA==",
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 256, height: 192 }),
  };
  const viewport = {
    checkVisibility: () => true,
    querySelectorAll: () => [canvas],
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 256, height: 192 }),
  };
  class Canvas {
    constructor(w, h) {
      this.width = w;
      this.height = h;
      this.data = new Uint8ClampedArray(w * h * 4);
    }
    getContext() {
      const target = this;
      return {
        fillRect() {}, // Expected test bytes are independently all-zero; this does not simulate an engine.
        drawImage(input, ...rect) {
          const [sx, sy, sw, sh, dx, dy, dw, dh] =
            rect.length === 2
              ? [0, 0, input.width, input.height, rect[0], rect[1], input.width, input.height]
              : rect;
          assert.equal(sw, dw, "no horizontal scaling");
          assert.equal(sh, dh, "no vertical scaling");
          copies.push(rect);
          for (let y = 0; y < sh; y++)
            for (let x = 0; x < sw; x++)
              for (let c = 0; c < 4; c++) {
                const at = ((dy + y) * target.width + dx + x) * 4 + c;
                if (at < target.data.length)
                  target.data[at] = input.data[((sy + y) * input.width + sx + x) * 4 + c];
              }
        },
        getImageData: () => ({ data: target.data }),
      };
    }
    async convertToBlob() {
      return { unitContractBytes: this.data };
    }
  }
  class Image {
    constructor() {
      this.width = width;
      this.height = height;
      this.data = backing;
    }
    async decode() {}
  }
  class FileReader {
    readAsDataURL() {
      this.result = "data:image/png;base64,bWFwcGVk";
      queueMicrotask(() => this.onload());
    }
  }
  const fn = runInNewContext(`(${callback})`, {
    document: { querySelectorAll: () => [viewport] },
    window: { devicePixelRatio: 1 },
    Image,
    OffscreenCanvas: Canvas,
    FileReader,
    crypto: webcrypto,
  });
  return { result: JSON.parse(JSON.stringify(await fn(0))), copies };
}

test("actual readback refuses zero/negative/odd/asymmetric/oversize padding", async () => {
  for (const [width, height] of [
    [128, 96],
    [126, 94],
    [131, 99],
    [132, 102],
    [642, 610],
  ]) {
    const { result } = await readback(width, height);
    assert.match(result.error, /padding|mapping/);
    assert.equal(
      result.rawPng,
      "data:image/png;base64,cmF3LXBhZGRlZA==",
      "raw evidence survives refusal",
    );
  }
});
test("actual readback maps every authored pixel 1:1 and retains full padded evidence", async () => {
  const { result, copies } = await readback(136, 104);
  assert.equal(result.maxDelta, 0);
  assert.deepEqual(result.mapping.sourceRect, { x: 4, y: 4, width: 128, height: 96 });
  assert.deepEqual(result.mapping.destinationRect, { x: 0, y: 0, width: 128, height: 96 });
  assert.deepEqual(copies[1], [4, 4, 128, 96, 0, 0, 128, 96]);
  assert.equal(result.rawPng, "data:image/png;base64,cmF3LXBhZGRlZA==");
  assert.notEqual(result.rawDigest, result.digest);
});
test("wrong final content-edge pixel is refused by the unchanged actual delta1 guard", async () => {
  const { result } = await readback(136, 104, true);
  assert.equal(result.maxDelta, 2, "last content pixel remains in the comparison");
  assert.throws(
    () => runInNewContext(refusal, { assert, result, label: "wrong content edge" }),
    /independent actual preview pixel delta 2/,
  );
});
