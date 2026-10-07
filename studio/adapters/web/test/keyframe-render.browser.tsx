/** Real prepared-engine Canvas2D and React controls, with independent pixel/pose oracles. */
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { i18n, i18nReady } from "@/i18n";
import { renderItem } from "@/features/export/utils/canvas-item-renderer/render-item";
import { getAnimatedTransform } from "@/features/export/utils/canvas-keyframes";
import { LottieExportProvider } from "@/infrastructure/lottie/lottie-frame-provider";
import { CanvasPool, TextMeasurementCache } from "@/features/export/utils/canvas-pool";
import { bakeMotionModifiersToKeyframes } from "@/features/keyframes/utils/bake-motion";
import { DopesheetEditor } from "@/features/keyframes/components/dopesheet-editor";
import { useAutoKeyframeStore } from "@/features/keyframes/stores/auto-keyframe-store";
import "./keyframe-browser.css";
import type { TimelineItem } from "@/types/timeline";
import type { ItemKeyframes, Keyframe } from "@/types/keyframe";
import type {
  ItemRenderContext,
  SubCompRenderData,
} from "@/features/export/utils/canvas-item-renderer/types";

const width = 128,
  height = 96,
  fps = 30;
const settings = { width, height, fps };
const shape = (id = "shape"): TimelineItem => ({
  id,
  type: "shape",
  label: id,
  trackId: "track",
  from: 0,
  durationInFrames: 60,
  shapeType: "rectangle",
  fillColor: "#ff0000",
  strokeEnabled: false,
  transform: { x: 0, y: 0, width: 16, height: 16, rotation: 0, opacity: 1 },
});
const key = (frame: number, value: number): Keyframe => ({
  id: `k${frame}`,
  frame,
  value,
  easing: "linear",
});
const check = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};
const root = createRoot(document.getElementById("controls")!);
await i18nReady;
await i18n.changeLanguage("en");

async function draw(
  item: TimelineItem,
  frame: number,
  keys?: ItemKeyframes,
  compositions = new Map<string, SubCompRenderData>(),
) {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d")!;
  const keyframesMap = new Map(keys ? [[item.id, keys]] : []);
  const canvasSettings = {
    ...settings,
    getExpressionItem: (id: string) => (id === item.id ? item : undefined),
    getExpressionKeyframes: (id: string) => keyframesMap.get(id),
  };
  const rctx = {
    fps,
    canvasSettings,
    canvasPool: new CanvasPool(width, height, 2),
    textMeasureCache: new TextMeasurementCache(),
    renderMode: "export",
    renderItem,
    videoExtractors: new Map(),
    videoElements: new Map(),
    useMediabunny: new Set(),
    mediabunnyDisabledItems: new Set(),
    mediabunnyFailureCountByItem: new Map(),
    imageElements: new Map(),
    gifFramesMap: new Map(),
    lottieProvider: new LottieExportProvider(),
    keyframesMap,
    adjustmentLayers: [],
    subCompRenderData: compositions,
  } as ItemRenderContext;
  const pose = getAnimatedTransform(item, keys, frame, canvasSettings);
  await renderItem(ctx, item, pose, frame, rctx);
  const pixels = ctx.getImageData(0, 0, width, height).data;
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", pixels))]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
  const blob = await canvas.convertToBlob({ type: "image/png" });
  const png = await new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(blob);
  });
  return { pixels, digest, png, pose };
}
function difference(a: Uint8ClampedArray, b: Uint8ClampedArray) {
  let max = 0,
    sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i]! - b[i]!);
    max = Math.max(max, d);
    sum += d;
  }
  return { max, mean: sum / a.length };
}
function rectangleOracle(x: number, opacity = 1, color = "#ff0000") {
  const canvas = new OffscreenCanvas(width, height),
    ctx = canvas.getContext("2d")!;
  ctx.fillStyle = color;
  ctx.globalAlpha = opacity;
  ctx.fillRect(width / 2 + x - 8, height / 2 - 8, 16, 16);
  return ctx.getImageData(0, 0, width, height).data;
}
const record = (
  name: string,
  frame: number,
  result: Awaited<ReturnType<typeof draw>>,
  extra = {},
) => ({ name, frame, digest: result.digest, png: result.png, pose: result.pose, ...extra });

async function runKeyframeBrowserFixtures(mutation?: string) {
  const results = [];
  const item = shape();
  const keys: ItemKeyframes = {
    itemId: item.id,
    properties: [{ property: "x", keyframes: [key(0, -24), key(24, 24)] }],
    expressions: [
      { type: "expression", targetProperty: "x", source: "value + frame / 2", enabled: true },
    ],
  };
  if (mutation === "no-expression") keys.expressions = [];
  for (const frame of [0, 12, 24]) {
    const actual = await draw(item, frame, keys),
      expectedX = -24 + frame * 2.5;
    check(actual.pose.x === expectedX, `expression + linear keyframe pose at ${frame}`);
    const delta = difference(actual.pixels, rectangleOracle(expectedX));
    check(delta.max === 0, `expression + keyframe pixels at ${frame}: ${JSON.stringify(delta)}`);
    results.push(record("expression-keyframe", frame, actual, { expectedX, delta }));
  }
  const text: TimelineItem = {
    ...shape("text"),
    type: "text",
    text: "II",
    color: "#ffffff",
    fontFamily: "monospace",
    fontSize: 28,
    textAlign: "center",
    verticalAlign: "middle",
    letterSpacing: 12,
    transform: { x: 0, y: 0, width: 100, height: 60, rotation: 0, opacity: 1 },
    textMotion: {
      in: {
        presetId: "fade-up",
        durationFrames: 8,
        staggerFrames: 12,
        intensity: 1,
        unit: "character",
        order: "forward",
        easing: "linear",
        seed: 1,
      },
    },
  };
  const alpha = (pixels: Uint8ClampedArray, first: boolean, axis: "x" | "y") => {
    let sum = 0;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        if ((axis === "x" ? x < width / 2 : y < height / 2) === first)
          sum += pixels[(y * width + x) * 4 + 3]!;
    return sum;
  };
  for (const unit of ["character", "word", "line"] as const) {
    const animated: TimelineItem = {
      ...text,
      text: unit === "word" ? "II II" : unit === "line" ? "II\nII" : "II",
      fontSize: unit === "word" ? 18 : unit === "line" ? 20 : text.fontSize,
      letterSpacing: unit === "word" ? 4 : text.letterSpacing,
      textMotion: { in: { ...text.textMotion!.in!, unit } },
    };
    if (mutation === `${unit}-as-character`) animated.textMotion!.in!.unit = "character";
    const partial = await draw(
        mutation === `no-${unit}-motion` ? { ...animated, textMotion: undefined } : animated,
        8,
      ),
      settled = await draw(animated, 30),
      plain = await draw({ ...animated, textMotion: undefined }, 30);
    const axis = unit === "line" ? "y" : "x";
    const first = alpha(partial.pixels, true, axis),
      second = alpha(partial.pixels, false, axis);
    check(
      first > 0 && second === 0,
      `${unit} stagger must show first unit only: ${first}/${second}`,
    );
    check(
      first === alpha(plain.pixels, true, axis),
      `${unit} stagger must reveal every glyph in the first unit`,
    );
    check(
      alpha(settled.pixels, true, axis) > 0 && alpha(settled.pixels, false, axis) > 0,
      `settled ${unit} motion contains both units`,
    );
    check(
      difference(settled.pixels, plain.pixels).max === 0,
      `settled ${unit} motion matches static text pixels`,
    );
    results.push(
      record(`${unit}-motion`, 8, partial, { firstAlpha: first, secondAlpha: second, axis }),
      record(`${unit}-motion-settled`, 30, settled),
    );
  }

  const inner = shape("inner");
  const wrap = (id: string, compositionId: string): TimelineItem => ({
    ...shape(id),
    type: "composition",
    compositionId,
    compositionWidth: width,
    compositionHeight: height,
    transform: { x: 0, y: 0, width, height, rotation: 0, opacity: 1 },
  });
  const instance = {
    ...wrap("instance", "inner-comp"),
    compositionControlOverrides: { tint: "#00ff00" } as Record<string, string>,
  };
  if (mutation === "no-instance-override") instance.compositionControlOverrides = {};
  const data = (items: TimelineItem[]): SubCompRenderData =>
    ({
      fps,
      durationInFrames: 60,
      keyframesMap: new Map(),
      adjustmentLayers: [],
      sortedTracks: [{ order: 0, visible: true, items }],
    }) as SubCompRenderData;
  const source = {
    ...data([inner]),
    compositionControls: {
      version: 1 as const,
      controls: [
        {
          id: "tint",
          name: "Tint",
          targetItemId: inner.id,
          property: "shape.fillColor" as const,
          kind: "color" as const,
          defaultValue: "#ff0000",
        },
      ],
    },
  };
  const compositions = new Map([
    ["inner-comp", source],
    ["outer-comp", data([instance])],
  ]);
  const nested = await draw(wrap("outer", "outer-comp"), 12, undefined, compositions);
  check(
    difference(nested.pixels, rectangleOracle(0, 1, "#00ff00")).max === 0,
    "nested instance draws overridden green pixels",
  );
  const original = await draw(wrap("unmodified", "inner-comp"), 12, undefined, compositions);
  check(
    difference(original.pixels, rectangleOracle(0)).max === 0 &&
      inner.type === "shape" &&
      inner.fillColor === "#ff0000",
    "shared Compose definition remains red",
  );
  results.push(
    record("nested-compose-override", 12, nested),
    record("compose-source-unmodified", 12, original),
  );

  const moving = {
    ...shape("moving"),
    motionModifiers: [
      {
        id: "sway",
        type: "sway" as const,
        enabled: true,
        amplitude: 1,
        frequency: 5,
        phaseFrames: 0,
        seed: 1,
      },
    ],
  };
  const base = getAnimatedTransform(shape("base"), undefined, 0, settings);
  const baked = bakeMotionModifiersToKeyframes({
    baseTransform: base,
    keyframes: undefined,
    modifiers: moving.motionModifiers,
    durationInFrames: moving.durationInFrames,
    fps,
    frameWidth: width,
    frameHeight: height,
  });
  const bakedKeys: ItemKeyframes = {
    itemId: moving.id,
    properties: baked.properties.map((property) => ({
      property,
      keyframes: baked.keyframes
        .filter((k) => k.property === property)
        .map((k, i) => ({ ...k, id: `b${i}` })),
    })),
  };
  if (mutation === "no-baked-keys") bakedKeys.properties = [];
  for (const frame of new Set(baked.keyframes.map((k) => k.frame))) {
    const procedural = await draw(moving, frame),
      converted = await draw({ ...moving, motionModifiers: [] }, frame, bakedKeys);
    const expectedRotation = 4 * Math.sin((10 * Math.PI * frame) / fps);
    check(
      Math.abs(procedural.pose.rotation - expectedRotation) < 1e-9,
      `independent sway pose at ${frame}`,
    );
    const delta = difference(procedural.pixels, converted.pixels);
    check(
      delta.max <= 1 && delta.mean <= 0.01,
      `baking pixel equivalence at sampled frame ${frame}`,
    );
    results.push(
      record("bake-sampled-equivalence", frame, converted, {
        proceduralDigest: procedural.digest,
        expectedRotation,
        delta,
      }),
    );
  }
  return results;
}

let interpolation: string | undefined;
const commits: unknown[] = [];
const bezierMoves: unknown[] = [];
const selections: string[][] = [];
function mountControls(mode: "dopesheet" | "graph" | "split") {
  flushSync(() =>
    root.render(
      <DopesheetEditor
        itemId="control-item"
        keyframesByProperty={{
          x: [
            {
              ...key(0, 0),
              easing: "cubic-bezier",
              easingConfig: {
                type: "cubic-bezier",
                bezier: { x1: 0.25, y1: 0.25, x2: 0.75, y2: 0.75 },
              },
            },
            key(30, 60),
          ],
        }}
        currentFrame={15}
        totalFrames={60}
        fps={fps}
        width={800}
        height={320}
        visualizationMode={mode}
        selectedKeyframeIds={new Set(["k0"])}
        selectedInterpolation="linear"
        propertyValues={{ x: 30 }}
        onPropertyValueCommit={(property, value, options) =>
          commits.push({ property, value, options })
        }
        interpolationOptions={[
          { value: "linear", label: "Linear" },
          { value: "cubic-bezier", label: "Bezier" },
        ]}
        onBezierHandleMove={(ref, bezier) => bezierMoves.push({ ref, bezier })}
        onSelectionChange={(ids) => selections.push([...ids].sort())}
        onInterpolationChange={(value) => {
          interpolation = value;
        }}
      />,
    ),
  );
}
Object.assign(window, {
  fl100Fixtures: {
    run: runKeyframeBrowserFixtures,
    mountControls,
    getControlState: () => ({
      interpolation,
      commits,
      bezierMoves,
      selections,
      autoKey: useAutoKeyframeStore.getState().isAutoKeyframeEnabled("control-item", "x"),
    }),
  },
});
