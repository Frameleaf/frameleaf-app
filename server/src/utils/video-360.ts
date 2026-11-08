import { getFilenameExtension } from 'src/utils/file.js';

/**
 * FL-968: 360° video from dual-lens cameras.
 *
 * The values below are stored in `asset_exif.projectionType`, a free-form string that the API exposes as
 * a plain string (never an enum), so adding one here does not change any response schema.
 *
 * - `EQUIRECTANGULAR` is what equirectangular files already carry (GSpherical XMP or an `sv3d` box).
 * - `DUAL_FISHEYE` is a raw recording from a two-lens camera (Insta360 `.insv`, DJI Osmo 360 `.osv`):
 *   two fisheye circles, either side by side in one picture or as two square video tracks.
 * - `EQUIANGULAR_CUBEMAP` is a GoPro MAX `.360` recording: two video tracks, each holding three cube
 *   faces (left, front, right / down, back, up) with a narrow blending band at the front face's seams.
 *
 * The original is never changed: the playback copy and the thumbnails are stitched to equirectangular
 * with ffmpeg's `v360` filter, so the viewer shows them exactly like any other equirectangular video.
 */
export const VideoProjection = {
  Equirectangular: 'EQUIRECTANGULAR',
  DualFisheye: 'DUAL_FISHEYE',
  EquiangularCubemap: 'EQUIANGULAR_CUBEMAP',
} as const;

type StitchedProjection = typeof VideoProjection.DualFisheye | typeof VideoProjection.EquiangularCubemap;

/** True for the raw 360° layouts that only play as 360° once a stitched copy exists. */
export const isStitchedVideoProjection = (
  projectionType: string | null | undefined,
): projectionType is StitchedProjection =>
  projectionType === VideoProjection.DualFisheye || projectionType === VideoProjection.EquiangularCubemap;

export interface Video360Stream {
  index: number;
  width: number;
  height: number;
}

export interface Video360Signals {
  fileName: string;
  videoStreams: Video360Stream[];
  /** Data tracks; GoPro writes its GPMF telemetry as handler `GoPro MET`, codec tag `gpmd`. */
  dataStreams?: Array<{ handlerName?: string | null; codecTag?: string | null }>;
  /** The projection an `sv3d` box declares, as ffprobe reports it (`equirectangular`, `cubemap`, ...). */
  containerProjection?: string | null;
}

/** Raw dual-fisheye containers. Exports from the cameras' own apps are `.mp4` and already equirectangular. */
const DUAL_FISHEYE_EXTENSIONS = new Set(['.insv', '.osv']);
const GOPRO_360_EXTENSION = '.360';

/** Playback copies of 360° video stay at most 3840×1920 ("4K 360") unless the target is Original. */
export const STITCHED_PLAYBACK_MAX_HEIGHT = 1920;

/**
 * Per-lens field of view for dual-fisheye cameras, in degrees. These are approximations from the
 * published lens specs and common ffmpeg calibrations, not per-unit calibration (which the cameras keep
 * in their own trailers); a wrong value shows as a visible seam, never as a broken video.
 */
const DUAL_FISHEYE_LENS_FOV: Array<{ pattern: RegExp; fov: number }> = [
  { pattern: /osmo\s*360/i, fov: 190 },
  { pattern: /one\s*x2?\b/i, fov: 193 },
  { pattern: /\bx[345]\b|one\s*rs|1-inch/i, fov: 200 },
];
const DEFAULT_DUAL_FISHEYE_FOV = 195;

const near = (value: number, expected: number) => Math.abs(value - expected) <= Math.max(2, expected * 0.01);

const byIndex = (streams: Video360Stream[]) => [...streams].sort((a, b) => a.index - b.index);

const usable = (streams: Video360Stream[]) =>
  streams.filter(
    ({ index, width, height }) =>
      Number.isSafeInteger(index) &&
      index >= 0 &&
      Number.isSafeInteger(width) &&
      width > 0 &&
      Number.isSafeInteger(height) &&
      height > 0,
  );

type DualFisheyeLayout = { layout: 'side-by-side' | 'two-streams'; streams: Video360Stream[]; diameter: number };

/** One picture with two circles side by side (2:1), or two square pictures of the same size. */
const getDualFisheyeLayout = (videoStreams: Video360Stream[]): DualFisheyeLayout | null => {
  const streams = byIndex(usable(videoStreams));
  const squares = streams.filter(({ width, height }) => width === height);
  if (squares.length === 2 && squares[0].width === squares[1].width) {
    return { layout: 'two-streams', streams: squares, diameter: squares[0].height };
  }
  const [primary] = streams;
  if (primary && near(primary.width, primary.height * 2)) {
    return { layout: 'side-by-side', streams: [primary], diameter: primary.height };
  }
  return null;
};

type CubemapLayout = { streams: [Video360Stream, Video360Stream]; face: number; overlap: number };

/**
 * GoPro MAX: two tracks of the same size, each three faces wide plus a blending band (4096×1344 holds
 * 3×1344 faces and 2×32 px of overlap at the front face's seams).
 */
const getCubemapLayout = (videoStreams: Video360Stream[]): CubemapLayout | null => {
  const streams = byIndex(usable(videoStreams));
  if (streams.length !== 2) {
    return null;
  }
  const [first, second] = streams;
  if (first.width !== second.width || first.height !== second.height) {
    return null;
  }
  const face = first.height;
  const spare = first.width - face * 3;
  if (spare < 0 || spare % 2 !== 0 || spare > face / 4) {
    return null;
  }
  return { streams: [first, second], face, overlap: spare / 2 };
};

const hasGoProTelemetry = (signals: Video360Signals) =>
  (signals.dataStreams ?? []).some(
    ({ handlerName, codecTag }) => codecTag === 'gpmd' || /gopro\s+met/i.test(handlerName ?? ''),
  );

/**
 * Works out the projection of a video the file itself does not label. Detection is conservative: the
 * extension (or GoPro's telemetry track) says which family it is, and the stream geometry must match
 * that family's layout, so a flat recording in the same container (Insta360's single-lens modes, a GoPro
 * HERO-mode clip) stays an ordinary video.
 */
export const detectVideoProjection = (signals: Video360Signals): string | null => {
  const extension = getFilenameExtension(signals.fileName).toLowerCase();

  if ((extension === GOPRO_360_EXTENSION || hasGoProTelemetry(signals)) && getCubemapLayout(signals.videoStreams)) {
    return VideoProjection.EquiangularCubemap;
  }

  if (DUAL_FISHEYE_EXTENSIONS.has(extension) && getDualFisheyeLayout(signals.videoStreams)) {
    return VideoProjection.DualFisheye;
  }

  if (signals.containerProjection?.toLowerCase() === 'equirectangular') {
    return VideoProjection.Equirectangular;
  }

  return null;
};

export const getDualFisheyeLensFov = (make?: string | null, model?: string | null) => {
  const camera = `${make ?? ''} ${model ?? ''}`;
  return DUAL_FISHEYE_LENS_FOV.find(({ pattern }) => pattern.test(camera))?.fov ?? DEFAULT_DUAL_FISHEYE_FOV;
};

export type VideoStitchPlan =
  | {
      projection: typeof VideoProjection.DualFisheye;
      layout: DualFisheyeLayout['layout'];
      streams: Video360Stream[];
      lensFov: number;
      /** Full-resolution equirectangular size of the stitched picture. */
      width: number;
      height: number;
    }
  | {
      projection: typeof VideoProjection.EquiangularCubemap;
      layout: 'two-tracks';
      streams: Video360Stream[];
      face: number;
      overlap: number;
      width: number;
      height: number;
    };

const even = (value: number) => Math.max(2, Math.floor(value / 2) * 2);

/** How a stored 360° layout is stitched, from the original's probed streams; null when they do not fit. */
export const planVideoStitch = ({
  projectionType,
  make,
  model,
  videoStreams,
}: {
  projectionType: string | null | undefined;
  make?: string | null;
  model?: string | null;
  videoStreams: Video360Stream[];
}): VideoStitchPlan | null => {
  if (projectionType === VideoProjection.DualFisheye) {
    const layout = getDualFisheyeLayout(videoStreams);
    if (!layout) {
      return null;
    }
    const height = even(layout.diameter);
    return {
      projection: VideoProjection.DualFisheye,
      layout: layout.layout,
      streams: layout.streams,
      lensFov: getDualFisheyeLensFov(make, model),
      width: height * 2,
      height,
    };
  }

  if (projectionType === VideoProjection.EquiangularCubemap) {
    const layout = getCubemapLayout(videoStreams);
    if (!layout) {
      return null;
    }
    // Four faces around the horizon, two from pole to pole: GoPro's own 5.6K export is 5376×2688.
    const height = even(layout.face * 2);
    return {
      projection: VideoProjection.EquiangularCubemap,
      layout: 'two-tracks',
      streams: layout.streams,
      face: layout.face,
      overlap: layout.overlap,
      width: height * 2,
      height,
    };
  }

  return null;
};

/** The stitched picture's size, at most `maxHeight` tall, always 2:1 and even. */
export const getStitchedSize = (plan: Pick<VideoStitchPlan, 'height'>, maxHeight?: number) => {
  const height = even(maxHeight && maxHeight > 0 ? Math.min(plan.height, maxHeight) : plan.height);
  return { width: height * 2, height };
};

/**
 * The stitch as filter-graph pieces: `prefix` opens a chain on the original's streams, `assemble` joins
 * them into one picture (frame-accurate, so a thumbnail's frame selection can run after it) and
 * `projection` is the `v360` step. {@link toFilterComplex} puts them together with the caller's filters.
 */
export interface VideoStitchGraph {
  prefix: string;
  assemble: string[];
  projection: string;
}

const cubemapTrack = (stream: Video360Stream, face: number, overlap: number, label: string) => {
  if (overlap === 0) {
    return { graph: '', pad: `[0:${stream.index}]` };
  }
  const front = face + overlap;
  const right = stream.width - face;
  return {
    graph:
      `[0:${stream.index}]split=3[${label}a][${label}b][${label}c];` +
      `[${label}a]crop=${face}:${face}:0:0[${label}l];` +
      `[${label}b]crop=${face}:${face}:${front}:0[${label}f];` +
      `[${label}c]crop=${face}:${face}:${right}:0[${label}r];` +
      `[${label}l][${label}f][${label}r]hstack=inputs=3[${label}];`,
    pad: `[${label}]`,
  };
};

/** The ffmpeg filters that turn the original's streams into one equirectangular picture of `size`. */
export const getStitchGraph = (plan: VideoStitchPlan, size: { width: number; height: number }): VideoStitchGraph => {
  const output = `w=${size.width}:h=${size.height}:interp=cubic`;

  if (plan.projection === VideoProjection.DualFisheye) {
    const v360 = `v360=input=dfisheye:output=equirect:ih_fov=${plan.lensFov}:iv_fov=${plan.lensFov}:${output}`;
    if (plan.layout === 'two-streams') {
      const [front, back] = plan.streams;
      return { prefix: `[0:${front.index}][0:${back.index}]`, assemble: ['hstack=inputs=2'], projection: v360 };
    }
    return { prefix: `[0:${plan.streams[0].index}]`, assemble: [], projection: v360 };
  }

  // ffmpeg's `eac` input is YouTube's layout (left, front, right over down, back, up), which is what the
  // two GoPro tracks form once the blending bands are cropped out and the tracks are stacked.
  const top = cubemapTrack(plan.streams[0], plan.face, plan.overlap, 'gt');
  const bottom = cubemapTrack(plan.streams[1], plan.face, plan.overlap, 'gb');
  return {
    prefix: `${top.graph}${bottom.graph}${top.pad}${bottom.pad}`,
    assemble: ['vstack=inputs=2'],
    projection: `v360=input=eac:output=equirect:${output}`,
  };
};

/** The output pad a stitched command maps. */
export const STITCHED_VIDEO_LABEL = '[stitched]';

/**
 * A complete `-filter_complex` value: the assembled picture, then `chain` (which must include
 * `graph.projection` where the caller wants it), ending in {@link STITCHED_VIDEO_LABEL}.
 */
export const toFilterComplex = (graph: Pick<VideoStitchGraph, 'prefix' | 'assemble'>, chain: string[]) =>
  `${graph.prefix}${[...graph.assemble, ...chain].join(',')}${STITCHED_VIDEO_LABEL}`;

/**
 * The stream an encoder is told about for a stitched command: the original's first track (codec,
 * colours, timing) at the stitched picture's size, upright, since `v360` produces it that way.
 */
export const toStitchedStream = <T extends { index: number; width: number; height: number; rotation: number }>(
  source: T,
  plan: Pick<VideoStitchPlan, 'streams'>,
  size: { width: number; height: number },
): T => ({ ...source, index: plan.streams[0].index, width: size.width, height: size.height, rotation: 0 });
