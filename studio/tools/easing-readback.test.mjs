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

async function readback(width, height, wrongEdge = false, visibleStates = [true]) {
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
  const canvases = visibleStates.map((visible, index) => ({
    ...canvas,
    id: `native-${index}`,
    parentElement: null,
    checkVisibility: (options) => {
      if (options) {
        assert.equal(options.visibilityProperty, true);
        assert.equal(options.opacityProperty, true);
      }
      return !options || visible;
    },
    style: { visibility: visible ? "visible" : "hidden", opacity: "1", display: "block" },
  }));
  const viewport = {
    checkVisibility: () => true,
    querySelectorAll: () => canvases,
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 256, height: 192 }),
  };
  for (const canvas of canvases) canvas.parentElement = viewport;
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
    getComputedStyle: (element) =>
      element.style ?? { visibility: "visible", opacity: "1", display: "block" },
    atob,
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

test("actual canvas selector excludes CSS-hidden surfaces and accepts the one visible surface", async () => {
  const { result } = await readback(130, 98, false, [false, true]);
  assert.equal(result.error, undefined);
  assert.equal(result.maxDelta, 0);
  assert.equal(result.nativeCanvases.length, 2);
  assert.equal(result.nativeCanvases[0].defaultVisible, true);
  assert.equal(result.nativeCanvases[0].strictVisible, false);
  assert.equal(result.nativeCanvases[1].strictVisible, true);
});
test("actual canvas cardinality refusal retains every raw image and ancestor diagnostic", async () => {
  for (const states of [
    [false, false],
    [true, true],
  ]) {
    const { result } = await readback(130, 98, false, states);
    assert.match(result.error, /native preview; got[02]/);
    assert.equal(result.nativeCanvases.length, 2);
    for (const canvas of result.nativeCanvases) {
      assert.equal(canvas.rawPng, "data:image/png;base64,cmF3LXBhZGRlZA==");
      assert.match(canvas.rawPngDigest, /^[a-f0-9]{64}$/);
      assert.deepEqual(canvas.backing, { width: 130, height: 98 });
      assert.equal(canvas.computed.visibility, states[canvas.index] ? "visible" : "hidden");
      assert.equal(canvas.ancestors.length, 1);
      assert.equal(canvas.ancestors[0].computed.opacity, "1");
    }
  }
});

// Execute the fixture's actual navigation/readiness flow, without a browser or engine claim.
test("native Position navigation acknowledges 30 then 0 and refuses non-singleton selection", async () => {
  const start = source.indexOf("  const acknowledge = async (frame, index) => {");
  const end = source.indexOf("  const seek = async (frame, n) => {", start);
  assert.ok(start > 0 && end > start);
  async function run(extraSelection = false, wrongReadout = null) {
    let clock = 0;
    let current = 0,
      selected;
    const calls = [];
    const dom = {
      querySelector: () => ({ checkVisibility: () => true, disabled: false }),
      querySelectorAll: (selector) =>
        selector === "button"
          ? [
              {
                checkVisibility: () => true,
                textContent: `00:${String(Math.floor((current + (wrongReadout === "frame" ? 1 : 0)) / 30)).padStart(2, "0")}:${String((current + (wrongReadout === "frame" ? 1 : 0)) % 30).padStart(2, "0")}/00:01:${wrongReadout === "total" ? "28" : "29"}`,
              },
            ]
          : [selected, ...(extraSelection ? ["opacity"] : [])].filter(Boolean).map((id) => ({
              dataset: { motionKeyframeId: id },
              querySelector: () => ({}),
            })),
    };
    const frame = {
      async click(selector) {
        calls.push(selector);
        if (selector.includes("Next Position")) {
          current = 30;
          selected = "k30";
        }
        if (selector.includes("Previous Position")) {
          current = 0;
          selected = "k0";
        }
      },
      async evaluate(fn, arg) {
        if (fn.toString().includes("elementFromPoint"))
          return { contractOnly: "geometry capture is not a browser measurement" };
        if (arg !== undefined) calls.push(`ack:${arg}`);
        return runInNewContext(`(${fn.toString()})(arg)`, { document: dom, arg });
      },
      async waitForFunction(fn) {
        assert.equal(await this.evaluate(fn), true, "actual readiness must hold");
      },
    };
    const select = runInNewContext(
      `(() => { ${source.slice(start, end)}; return selectInline; })()`,
      {
        assert,
        writeFile: async () => {},
        URL,
        browserName: "unit-contract",
        dir: new URL("file:///unit-contract/"),
        Date: { now: () => (clock += 31000) },
        Set,
        setTimeout,
        button: (label) => `button[aria-label=${JSON.stringify(label)}]`,
      },
    );
    await select(frame);
    return calls;
  }
  assert.deepEqual(await run(), [
    '[data-item-id="still"]',
    'button[aria-label="Next Position keyframe"]',
    "ack:00:01:00/00:01:29",
    'button[aria-label="Previous Position keyframe"]',
    "ack:00:00:00/00:01:29",
  ]);
  await assert.rejects(run(true), /actual readiness must hold/);
  await assert.rejects(run(false, "frame"), /native timecode acknowledgement/);
  await assert.rejects(run(false, "total"), /native timecode acknowledgement/);
});

test("actual revision assertion requires exact native CSS Out config and untouched other keys", () => {
  const graph = {
    metadata: { width: 128, height: 96, fps: 30 },
    timeline: {
      tracks: [{ id: "t", items: ["still"] }],
      items: [{ id: "still", label: "Hero rectangle" }],
      keyframes: [
        {
          itemId: "still",
          animationVersion: 2,
          properties: [
            {
              property: "opacity",
              keyframes: [{ id: "opacity-k0", frame: 0, value: 1, easing: "linear" }],
            },
          ],
          vectorProperties: [
            {
              property: "position",
              keyframes: [
                { id: "k0", frame: 0, value: { x: -24, y: 0 }, easing: "linear" },
                { id: "k30", frame: 30, value: { x: 24, y: 0 }, easing: "linear" },
              ],
            },
          ],
        },
      ],
    },
  };
  const start = source.indexOf("  const assertEasing = (stored, easing) => {");
  const end = source.indexOf("  const readRevision =", start);
  assert.ok(start >= 0 && end > start);
  const check = runInNewContext(`(() => { ${source.slice(start, end)}; return assertEasing; })()`, {
    assert: {
      ...assert,
      deepEqual: (a, b) =>
        assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b))),
    },
    graph,
  });
  const stored = structuredClone(graph);
  const key = stored.timeline.keyframes[0].vectorProperties[0].keyframes[0];
  key.easing = "cubic-bezier";
  key.easingConfig = { type: "cubic-bezier", bezier: { x1: 0, y1: 0, x2: 0.58, y2: 1 } };
  check(stored, "cubic-bezier");
  for (const mutate of [
    (x) => {
      x.timeline.keyframes[0].vectorProperties[0].keyframes[0].easingConfig.bezier.x2 = 0.355;
    },
    (x) => {
      x.timeline.keyframes[0].vectorProperties[0].keyframes[0].easing = "ease-out";
    },
    (x) => {
      x.timeline.keyframes[0].vectorProperties[0].keyframes[1].easingConfig = key.easingConfig;
    },
    (x) => {
      x.timeline.keyframes[0].properties[0].keyframes[0].value = 0.5;
    },
  ]) {
    const wrong = structuredClone(stored);
    mutate(wrong);
    assert.throws(() => check(wrong, "cubic-bezier"));
  }
});
