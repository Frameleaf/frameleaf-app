/**
 * A highlight video of a memory as a Studio project graph (FL-194, `REC-105`).
 *
 * A memory's highlight is not rendered by a renderer of its own. It is an ordinary Studio project
 * whose graph is built here, so it goes through the same resolver, admission, render workers and
 * publication as any Studio export (FL-90, FL-95, FL-106, FL-42). The graph follows the design
 * prototype's project model (`design/frameleaf/template/src/studio-project.mjs`: `sampleProject`,
 * `clipFromAsset`, `audioClipFor`, `createTitleClip`), which is also what the resolver's walker
 * recognises: a sequence of title, video and camera-audio tracks, photos with a Ken Burns move,
 * videos with their own sound on the camera track.
 *
 * Every time is a whole number of seconds, so every boundary is exact at any frame rate.
 *
 * Pure: no database, no Nest.
 */
import { MemoryHighlightAudio } from 'src/enum.js';

export { MemoryHighlightAudio } from 'src/enum.js';

/** The lengths the memory player offers, in seconds, and the one it starts from. */
export const MEMORY_HIGHLIGHT_LENGTHS = [30, 60, 120] as const;
export const MEMORY_HIGHLIGHT_DEFAULT_LENGTH = 60;

/** A photo holds for this long when there is room (the prototype's photos run 4-6 s). */
export const MEMORY_HIGHLIGHT_MAX_SLOT_SECONDS = 5;
/** No item is shorter than this; beyond it, items are dropped evenly rather than rushed. */
export const MEMORY_HIGHLIGHT_MIN_SLOT_SECONDS = 2;

const TITLE_SECONDS = 3;
const FPS = 30;

const DIMENSIONS: Readonly<Record<string, { width: number; height: number }>> = {
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
  '1440p': { width: 2560, height: 1440 },
  '2160p': { width: 3840, height: 2160 },
};

/** The prototype's Ken Burns presets, in the order `sampleProject` uses them. */
const FULL = { x: 0, y: 0, w: 1, h: 1 };
const KEN_BURNS = [
  { from: FULL, to: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } },
  { from: { x: 0.2, y: 0.05, w: 0.8, h: 0.8 }, to: { x: 0, y: 0.05, w: 0.8, h: 0.8 } },
  { from: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 }, to: FULL },
  { from: { x: 0, y: 0.05, w: 0.8, h: 0.8 }, to: { x: 0.2, y: 0.05, w: 0.8, h: 0.8 } },
];

export type MemoryHighlightAsset = {
  id: string;
  /** `AssetType`: `VIDEO` plays, anything else holds as a photo. */
  type: string;
  /** A video's duration in milliseconds, when known. */
  duration: number | null;
};

export type MemoryHighlightOptions = {
  title: string;
  assets: readonly MemoryHighlightAsset[];
  lengthSeconds: number;
  resolution: string;
  audio: MemoryHighlightAudio;
};

/** Seconds from the stored duration in milliseconds, or null when unknown or zero. */
export const assetDurationSeconds = (milliseconds: number | null | undefined): number | null =>
  typeof milliseconds === 'number' && Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds / 1000 : null;

/** `count` indexes spread evenly over `total`, first and last included. */
const evenly = (total: number, count: number): number[] => {
  if (count >= total) {
    return Array.from({ length: total }, (_, index) => index);
  }
  if (count === 1) {
    return [0];
  }
  return Array.from({ length: count }, (_, index) => Math.round((index * (total - 1)) / (count - 1)));
};

export const buildMemoryHighlightGraph = ({
  title,
  assets,
  lengthSeconds,
  resolution,
  audio,
}: MemoryHighlightOptions) => {
  if (assets.length === 0) {
    throw new Error('A highlight needs at least one item');
  }

  const length = Math.max(MEMORY_HIGHLIGHT_MIN_SLOT_SECONDS, Math.floor(lengthSeconds));
  const slot = Math.min(
    MEMORY_HIGHLIGHT_MAX_SLOT_SECONDS,
    Math.max(MEMORY_HIGHLIGHT_MIN_SLOT_SECONDS, Math.floor(length / assets.length)),
  );
  const picked = evenly(assets.length, Math.floor(length / slot)).map((index) => assets[index]);

  const video: Array<Record<string, unknown>> = [];
  const camera: Array<Record<string, unknown>> = [];
  let cursor = 0;
  for (const [index, asset] of picked.entries()) {
    const isVideo = asset.type === 'VIDEO';
    const source = isVideo ? assetDurationSeconds(asset.duration) : null;
    // A video plays from its start for at most its slot; one shorter than a second still gets one.
    const duration = isVideo && source !== null ? Math.max(1, Math.min(slot, Math.floor(source))) : slot;
    const id = `clip-${index + 1}`;
    video.push({
      id,
      kind: isVideo ? 'video' : 'photo',
      assetId: asset.id,
      start: cursor,
      duration,
      in: 0,
      speed: 1,
      sourceDuration: source,
      transitionIn: index === 0 ? null : { type: 'Cross dissolve', duration: 0.5 },
      kenBurns: isVideo ? null : KEN_BURNS[index % KEN_BURNS.length],
      volume: isVideo && audio === MemoryHighlightAudio.Original ? 1 : 0,
      linkId: isVideo ? id : null,
    });
    if (isVideo && audio === MemoryHighlightAudio.Original) {
      camera.push({
        id: `${id}-audio`,
        kind: 'audio',
        assetId: asset.id,
        start: cursor,
        duration,
        in: 0,
        speed: 1,
        sourceDuration: source,
        volume: 1,
        linkId: id,
      });
    }
    cursor += duration;
  }

  const { width, height } = DIMENSIONS[resolution] ?? DIMENSIONS['1080p'];
  return {
    schemaVersion: 1,
    name: title,
    activeSequenceId: 'seq-highlight',
    settings: { mode: 'basic', guides: false, loop: false, ducking: true },
    sequences: [
      {
        id: 'seq-highlight',
        name: title,
        fps: FPS,
        width,
        height,
        tracks: [
          {
            id: 't-title',
            kind: 'title',
            name: 'Titles',
            muted: false,
            clips: [
              {
                id: 'title-main',
                kind: 'title',
                name: title,
                text: title,
                start: 0,
                duration: Math.min(TITLE_SECONDS, cursor),
                style: 'Minimal',
                position: 'bl',
                animation: 'Fade',
              },
            ],
          },
          { id: 't-video', kind: 'video', name: 'Video', muted: false, clips: video },
          {
            id: 't-audio',
            kind: 'audio',
            name: 'Camera',
            muted: audio === MemoryHighlightAudio.Silent,
            clips: camera,
          },
        ],
        captions: [],
        review: [],
      },
    ],
  };
};
