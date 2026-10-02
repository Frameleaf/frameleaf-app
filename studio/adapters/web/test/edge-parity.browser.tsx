/**
 * The DOM player and the rendered preview canvas side by side, on the existing SDR image render
 * and presentation paths (FL-100). No editor mode overrides, no alternate expected renderer.
 */
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { HeadlessPlayer, type PlayerRef } from "@/runtime/player";
import { MainComposition } from "@/runtime/composition-runtime/compositions/main-composition";
import { renderItem } from "@/features/export/utils/canvas-item-renderer/render-item";
import { renderItemWithEffects } from "@/features/export/utils/frame-render-tasks";
import { GpuPipelineManager } from "@/features/export/utils/gpu-pipeline-manager";
import {
  CanvasPool,
  TextMeasurementCache,
} from "@/features/export/utils/canvas-pool";
import { LottieExportProvider } from "@/infrastructure/lottie/lottie-frame-provider";
import {
  drawSourceToPreviewDisplayCanvas,
  getPreviewDisplayCanvasBackingSize,
  getPreviewDisplayCanvasStyle,
} from "@/features/preview/utils/preview-display-canvas";
import type { ImageItem, TimelineTrack } from "@/types/timeline";
import type { ItemRenderContext } from "@/features/export/utils/canvas-item-renderer/types";
import "./keyframe-browser.css";

const projectSize = { width: 1280, height: 720, fps: 30 };
// Case inputs only. `x` is the item's authored x. `placement` is how the rendered canvas is put
// on screen: "production" is the engine's own style; "layout-box" is the left/top/width/height
// box the engine used before patch 0046, kept as the counterfactual that a browser snaps to whole
// device pixels.
const query = new URLSearchParams(location.search);
const itemX = Number(query.get("x") ?? 12);
const placement =
  query.get("placement") === "layout-box" ? "layout-box" : "production";
const playerSize = { width: 752, height: 423 };
const root = createRoot(document.getElementById("comparison")!);
let player: PlayerRef | null = null;
let display: HTMLCanvasElement | null = null;
let sourceUrl: string;
let project: OffscreenCanvas;
let pool: CanvasPool;
const gpu = new GpuPipelineManager("sdr");

function EdgeParity({ track }: { track: TimelineTrack }) {
  const viewport = {
    position: "relative" as const,
    width: playerSize.width,
    height: playerSize.height,
    overflow: "hidden",
    background: "#000",
  };
  const backing = getPreviewDisplayCanvasBackingSize(playerSize, projectSize);
  const padX =
    ((backing.width - projectSize.width) / 2) *
    (playerSize.width / projectSize.width);
  const padY =
    ((backing.height - projectSize.height) / 2) *
    (playerSize.height / projectSize.height);
  const box =
    placement === "production"
      ? getPreviewDisplayCanvasStyle(playerSize, projectSize)
      : {
          left: `-${padX}px`,
          top: `-${padY}px`,
          width: `calc(100% + ${padX * 2}px)`,
          height: `calc(100% + ${padY * 2}px)`,
        };
  return (
    <>
      <div id="dom-viewport" style={viewport}>
        <HeadlessPlayer
          ref={(value) => {
            player = value;
          }}
          width={1280}
          height={720}
          layoutSize={playerSize}
          fps={30}
          durationInFrames={60}
          initialFrame={15}
          style={{ width: "100%", height: "100%" }}
        >
          <MainComposition
            {...projectSize}
            tracks={[track]}
            backgroundColor="#000000"
            keyframes={[]}
          />
        </HeadlessPlayer>
      </div>
      <div id="rendered-viewport" style={viewport}>
        <canvas
          ref={(value) => {
            display = value;
          }}
          width={backing.width}
          height={backing.height}
          style={{
            position: "absolute",
            ...box,
          }}
        />
      </div>
    </>
  );
}

function inspectElement(element: Element) {
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return {
    tag: element.tagName,
    id: element.id,
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    style: Object.fromEntries(
      [
        "transform",
        "transform-origin",
        "left",
        "top",
        "width",
        "height",
        "overflow",
        "overflow-x",
        "overflow-y",
        "clip-path",
        "mask-image",
        "filter",
        "opacity",
        "display",
        "visibility",
        "object-fit",
        "image-rendering",
        "will-change",
        "background-color",
      ].map((name) => [name, style.getPropertyValue(name)]),
    ),
  };
}

async function readEdgePixels(canvas: OffscreenCanvas | HTMLCanvasElement) {
  const ctx = canvas.getContext("2d") as
    CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const rows = [0, 1, Math.floor(canvas.height / 2), canvas.height - 1];
  const columns = Array.from({ length: 25 }, (_, index) => index);
  let binary = "";
  for (let start = 0; start < pixels.length; start += 8192) {
    binary += String.fromCharCode(...pixels.subarray(start, start + 8192));
  }
  const blob =
    canvas instanceof OffscreenCanvas
      ? await canvas.convertToBlob({ type: "image/png" })
      : await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob(
            (value) =>
              value
                ? resolve(value)
                : reject(new Error("Canvas PNG encode failed")),
            "image/png",
          ),
        );
  return {
    width: canvas.width,
    height: canvas.height,
    rgbaBase64: btoa(binary),
    pngBase64: btoa(
      String.fromCharCode(...new Uint8Array(await blob.arrayBuffer())),
    ),
    edges: rows.map((y) => ({
      y,
      pixels: columns.map((x) => ({
        x,
        rgba: Array.from(
          pixels.subarray(
            (y * canvas.width + x) * 4,
            (y * canvas.width + x) * 4 + 4,
          ),
        ),
      })),
    })),
  };
}

async function prepareEdgeParity() {
  // This is the opaque PNG input, not an alternate expected renderer.
  const input = new OffscreenCanvas(1280, 720);
  const inputCtx = input.getContext("2d")!;
  inputCtx.fillStyle = "#cc4422";
  inputCtx.fillRect(0, 0, 1280, 720);
  sourceUrl = URL.createObjectURL(
    await input.convertToBlob({ type: "image/png" }),
  );
  const image = new Image();
  image.crossOrigin = "anonymous";
  image.src = sourceUrl;
  await image.decode();
  const item: ImageItem = {
    id: "still",
    type: "image",
    mediaId: "still-input",
    trackId: "v1",
    label: "Host still",
    src: sourceUrl,
    sourceWidth: 1280,
    sourceHeight: 720,
    from: 0,
    durationInFrames: 60,
    transform: {
      x: itemX,
      y: 0,
      width: 1280,
      height: 720,
      rotation: 0,
      opacity: 1,
    },
  };
  const track: TimelineTrack = {
    id: "v1",
    name: "Video 1",
    kind: "video",
    height: 100,
    locked: false,
    syncLock: true,
    visible: true,
    muted: false,
    solo: false,
    volume: 0,
    order: 0,
    items: [item],
  };
  pool = new CanvasPool(1280, 720, 2);
  const rctx: ItemRenderContext = {
    fps: 30,
    canvasSettings: projectSize,
    canvasPool: pool,
    textMeasureCache: new TextMeasurementCache(),
    renderMode: "preview",
    renderItem,
    videoExtractors: new Map(),
    videoElements: new Map(),
    useMediabunny: new Set(),
    mediabunnyDisabledItems: new Set(),
    mediabunnyFailureCountByItem: new Map(),
    imageElements: new Map([
      [item.id, { source: image, width: 1280, height: 720 }],
    ]),
    gifFramesMap: new Map(),
    lottieProvider: new LottieExportProvider(),
    keyframesMap: new Map(),
    adjustmentLayers: [],
    subCompRenderData: new Map(),
  };
  project = new OffscreenCanvas(1280, 720);
  const projectCtx = project.getContext("2d")!;
  // Same normal background fill as createCompositionRenderer.renderFrame.
  projectCtx.fillStyle = "#000000";
  projectCtx.fillRect(0, 0, 1280, 720);
  await renderItemWithEffects(item, 0, false, projectCtx, {
    frame: 15,
    canvasSettings: projectSize,
    maskSettings: projectSize,
    renderMode: "preview",
    activeMasks: [],
    adjustmentLayers: [],
    gpu,
    itemRenderContext: rctx,
    canvasPool: pool,
    getCurrentItem: (value) => value,
    getCurrentKeyframes: () => undefined,
  });
  flushSync(() => root.render(<EdgeParity track={track} />));
  if (!display) throw new Error("Rendered preview canvas not mounted");
  drawSourceToPreviewDisplayCanvas(display.getContext("2d")!, display, project);
  return { input: await readEdgePixels(input), item, track };
}

const prepared = prepareEdgeParity();
const preparation = { status: "pending", error: null as string | null };
void prepared.then(
  () => {
    preparation.status = "fulfilled";
  },
  (error: unknown) => {
    preparation.status = "rejected";
    preparation.error =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
  },
);
Object.assign(window, {
  fl100EdgeParity: {
    prepared,
    preparation,
    ready: () =>
      player?.getCurrentFrame() === 15 &&
      document.querySelectorAll("#dom-viewport img").length === 1 &&
      Array.from(
        document.querySelectorAll<HTMLImageElement>("#dom-viewport img"),
      ).every((image) => image.complete && image.naturalWidth === 1280) &&
      document
        .querySelector("#dom-viewport [data-player-container]")
        ?.getBoundingClientRect().width === 752,
    capture: async () => {
      const seed = await prepared;
      const image = document.querySelector("#dom-viewport img")!;
      const ancestors = [];
      for (let node: Element | null = image; node; node = node.parentElement) {
        ancestors.push(inspectElement(node));
        if (node.id === "dom-viewport") break;
      }
      return {
        seed,
        devicePixelRatio,
        frame: player!.getCurrentFrame(),
        dom: inspectElement(document.getElementById("dom-viewport")!),
        rendered: inspectElement(document.getElementById("rendered-viewport")!),
        imageAncestors: ancestors,
        display: inspectElement(display!),
        project: await readEdgePixels(project),
        displayPixels: await readEdgePixels(display!),
        mapping: {
          projectX: itemX,
          scale: 752 / 1280,
          displayX: (itemX * 752) / 1280,
          placement,
          sourcePadding: (display!.width - 1280) / 2,
        },
      };
    },
    dispose: () => {
      root.unmount();
      pool?.dispose();
      gpu.dispose();
      URL.revokeObjectURL(sourceUrl);
    },
  },
});
