/**
 * Building a Studio project graph on the server (docs/docs/developer/studio-graph-protocol-v1.md, schema
 * studio/graph-schema-v1.json). Shared by Make a movie (FL-561) and the import from other editors
 * (FL-1541): ids, frame maths, the fitted transform, tracks, how long a transition the handles allow,
 * and the project envelope in normal form.
 *
 * Pure: no database, no Nest.
 */
import { createHash } from 'node:crypto';

export type StudioCanvas = { width: number; height: number };
export type StudioFrameRate = { num: number; den: number };
export type StudioGraphItem = Record<string, unknown> & {
  id: string;
  from: number;
  durationInFrames: number;
  type: string;
};

const round3 = (value: number) => Math.round(value * 1000) / 1000;

/** Text to an id in the UUID version 4 layout (protocol 4.1). */
export const studioGraphUuid = (text: string): string => {
  const bytes = createHash('sha256').update(text, 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** A run of ids drawn from `seed` and a counter, so the same input gives the same graph. */
export const studioGraphIds = (seed: string) => {
  let counter = 0;
  return () => studioGraphUuid(`${seed}:${counter++}`);
};

/** The project rate as a float: exactly `num / den` (protocol 2.2). */
export const studioFps = (rate: StudioFrameRate) => rate.num / rate.den;

/** Seconds to the nearest frame at `fps` (protocol 3.3: halves towards positive infinity). */
export const secondsToFrames = (seconds: number, fps: number) => Math.floor(seconds * fps + 0.5);
/** Protocol 12.2.4: timeline frames to source frames. */
export const timelineToSource = (frames: number, fps: number, sourceFps: number) =>
  Math.floor((frames / fps) * sourceFps + 0.5);
/** Protocol 12.2.4: source frames to timeline frames. */
export const sourceToTimeline = (frames: number, sourceFps: number, fps: number) =>
  Math.floor((frames / sourceFps) * fps);

/** The fitted transform of a still or video on the canvas (protocol 12.6.3, scale 1). */
export const fittedTransform = (canvas: StudioCanvas, width: number, height: number) => {
  const fit = Math.min(canvas.width / width, canvas.height / height);
  return { x: 0, y: 0, width: width * fit, height: height * fit, rotation: 0 };
};

export const studioTrack = (id: string, name: string, kind: 'video' | 'audio', order: number) => ({
  id,
  name,
  kind,
  height: 100,
  locked: false,
  visible: true,
  muted: false,
  solo: false,
  order,
  syncLock: true,
  volume: 0,
  items: [] as never[],
});

/**
 * The longest transition, up to `maxFrames`, that the two clips' handles allow (protocol 12.2.6).
 * `alignment` is the share of the transition before the cut, drawn from the right clip's head.
 */
export const transitionFramesFor = (
  left: StudioGraphItem,
  right: StudioGraphItem,
  fps: number,
  maxFrames: number,
  alignment = 0.5,
): number => {
  const hasSource = (item: StudioGraphItem) => item.type === 'video' || item.type === 'audio';
  const tail = (item: StudioGraphItem) =>
    hasSource(item)
      ? sourceToTimeline((item.sourceDuration as number) - (item.sourceEnd as number), item.sourceFps as number, fps)
      : Infinity;
  const head = (item: StudioGraphItem) =>
    hasSource(item) ? sourceToTimeline(item.sourceStart as number, item.sourceFps as number, fps) : Infinity;
  const limit = Math.min(left.durationInFrames, right.durationInFrames) - 1;
  for (let frames = Math.min(maxFrames, limit); frames >= 2; frames--) {
    const before = Math.floor(frames * alignment);
    if (frames - before <= tail(left) && before <= head(right)) {
      return frames;
    }
  }
  return 0;
};

export type StudioProjectGraphOptions = {
  id: string;
  name: string;
  /** Milliseconds; the project's own timestamps. */
  now: number;
  canvas: StudioCanvas;
  rate: StudioFrameRate;
  lengthFrames: number;
  tracks: ReturnType<typeof studioTrack>[];
  items: StudioGraphItem[];
  markers?: unknown[];
  transitions?: unknown[];
  keyframes?: unknown[];
  compositions?: unknown[];
};

/** The project envelope in normal form (protocol 2.6): optional lists only when not empty. */
export const studioProjectGraph = (options: StudioProjectGraphOptions) => {
  const fps = studioFps(options.rate);
  const present = (key: string, list?: unknown[]) => (list && list.length > 0 ? { [key]: list } : {});
  return {
    id: options.id,
    name: options.name,
    description: '',
    createdAt: options.now,
    updatedAt: options.now,
    duration: round3(options.lengthFrames / fps),
    schemaVersion: 15,
    metadata: {
      width: options.canvas.width,
      height: options.canvas.height,
      fps,
      frameRate: { num: options.rate.num, den: options.rate.den },
    },
    timeline: {
      tracks: options.tracks,
      items: options.items,
      masterBusDb: 0,
      masterBusMuted: false,
      currentFrame: 0,
      zoomLevel: 1,
      scrollPosition: 0,
      ...present('markers', options.markers),
      ...present('transitions', options.transitions),
      ...present('keyframes', options.keyframes),
      ...present('compositions', options.compositions),
    },
  };
};
