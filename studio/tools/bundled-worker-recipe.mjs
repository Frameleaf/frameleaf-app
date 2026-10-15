// FL-408: what the bundled machine-learning Studio worker renders for one claim, or why it will not.
//
// Pure functions, no I/O: the claim's immutable graph, settings and snapshot become the engine
// settings, the exact frame range and the checkpoint timing the server will verify. Anything this
// worker cannot render honestly is a `BundledRefusal` with a stable code and a sentence the owner
// can read; nothing is dropped, approximated or rendered differently from what was asked.
import { createHash } from 'node:crypto';

export const BUNDLED_RECIPE = 'frameleaf-bundled-worker-v1';

/** Item types the engine renders that this worker has the inputs for. */
export const SUPPORTED_ITEM_TYPES = new Set(['video', 'audio', 'image', 'text', 'shape', 'subtitle', 'adjustment']);

/** Item types that need media bytes from a claim input (`item.mediaId`). */
export const MEDIA_ITEM_TYPES = new Set(['video', 'audio', 'image']);

/** The pinned engine's headless bitrate presets (headless/lib/render-core.mjs). */
export const VIDEO_BITRATES = Object.freeze({ low: 2_500_000, medium: 5_000_000, high: 10_000_000, ultra: 20_000_000 });

/** The short side of each export resolution; `original` keeps the project canvas. */
export const RESOLUTION_SHORT_SIDE = Object.freeze({ '720p': 720, '1080p': 1080, '1440p': 1440, '2160p': 2160 });

export class BundledRefusal extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BundledRefusal';
    this.code = code;
  }
}

const refuse = (code, message) => {
  throw new BundledRefusal(code, message);
};

const digest = (value) => createHash('sha256').update(value).digest('hex');

/** `num/den` with positive safe integers, or null. */
export const parseRational = (value) => {
  const match = typeof value === 'string' ? /^(\d+)\/(\d+)$/.exec(value) : null;
  if (!match) return null;
  const num = Number(match[1]);
  const den = Number(match[2]);
  return Number.isSafeInteger(num) && Number.isSafeInteger(den) && num > 0 && den > 0 ? { num, den } : null;
};

/** Ticks of `timeBase` that `frames` frames at `cadence` last, when that is a whole number. */
export const frameTicks = (frames, cadence, timeBase) => {
  const numerator = BigInt(frames) * BigInt(cadence.den) * BigInt(timeBase.den);
  const denominator = BigInt(cadence.num) * BigInt(timeBase.num);
  if (numerator % denominator !== 0n) return null;
  const ticks = numerator / denominator;
  return ticks <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(ticks) : null;
};

/** Even output dimensions for a resolution, scaled from the canvas and never upscaled. */
export const outputDimensions = (canvas, resolution) => {
  const even = (value) => Math.max(2, Math.round(value / 2) * 2);
  if (resolution === 'original') return { width: even(canvas.width), height: even(canvas.height) };
  const target = RESOLUTION_SHORT_SIDE[resolution];
  if (!target) refuse('unsupported_resolution', `The bundled Studio worker cannot export at ${resolution}.`);
  const short = Math.min(canvas.width, canvas.height);
  const scale = Math.min(1, target / short);
  return { width: even(canvas.width * scale), height: even(canvas.height * scale) };
};

/** Every timeline (the main one and nested compositions) with its items. */
const timelinesOf = (graph) => [graph.timeline, ...(Array.isArray(graph.timeline?.compositions) ? graph.timeline.compositions : [])];

/** The media ids the graph's items read, and refusals for items this worker cannot render. */
export const graphMedia = (graph, { softwareRenderer }) => {
  const mediaIds = new Set();
  for (const timeline of timelinesOf(graph)) {
    for (const item of timeline?.items ?? []) {
      if (!SUPPORTED_ITEM_TYPES.has(item.type)) {
        refuse(
          'unsupported_item',
          `The bundled Studio worker cannot render ${item.type ?? 'unknown'} clips yet; remove them or export with a dedicated render worker.`,
        );
      }
      if (item.generatedId || item.src || item.audioSrc) {
        refuse('unsupported_source', 'A clip reads media from outside the library; the bundled Studio worker renders library media only.');
      }
      if (MEDIA_ITEM_TYPES.has(item.type)) {
        if (typeof item.mediaId !== 'string' || item.mediaId.length === 0) {
          refuse('missing_media', `A ${item.type} clip names no library media.`);
        }
        mediaIds.add(item.mediaId);
      }
      if (softwareRenderer && Array.isArray(item.effects) && item.effects.some((effect) => effect?.enabled !== false)) {
        refuse(
          'effects_need_gpu',
          'This project uses effects, and the bundled Studio worker has no GPU. Give the machine-learning container a GPU, or remove the effects.',
        );
      }
    }
  }
  return mediaIds;
};

/** The exact frame range rendered: the declared range, or the whole timeline. */
export const frameRange = (graph, range) => {
  let end = 0;
  for (const item of graph.timeline.items) {
    if (!Number.isSafeInteger(item.from) || !Number.isSafeInteger(item.durationInFrames) || item.durationInFrames <= 0) {
      refuse('invalid_graph', 'A clip has invalid frame bounds.');
    }
    end = Math.max(end, item.from + item.durationInFrames);
  }
  if (end <= 0) refuse('empty_timeline', 'The project timeline is empty.');
  if (range === undefined || range === null) return { inPoint: 0, outPoint: end };
  const { inPoint, outPoint } = range;
  if (!Number.isSafeInteger(inPoint) || !Number.isSafeInteger(outPoint) || inPoint < 0 || outPoint <= inPoint || outPoint > end) {
    refuse('invalid_range', 'The export range is outside the timeline.');
  }
  return { inPoint, outPoint };
};

/**
 * The render recipe for one claim. Throws `BundledRefusal` for anything this worker cannot render.
 * `softwareRenderer` is what its conformance check reported for the renderer it will use.
 */
export const bundledRecipe = (claim, { softwareRenderer }) => {
  if (claim.kind !== 'studio_export') refuse('unsupported_kind', 'The bundled Studio worker renders Studio exports only.');
  const graph = claim.snapshot?.studio?.graph;
  if (!graph?.metadata || !Array.isArray(graph.timeline?.items) || !Array.isArray(graph.timeline?.tracks)) {
    refuse('invalid_graph', 'The export has no immutable project graph.');
  }
  if (typeof claim.artifactInputDigest !== 'string' || !/^[a-f0-9]{64}$/.test(claim.artifactInputDigest)) {
    refuse('invalid_claim', 'The claim carries no artifact input digest.');
  }
  const { format, color, resolution, quality = 'high', audio = 'preserve', range, subtitleMode } = claim.settings ?? {};
  if (format !== 'mp4-h264') {
    refuse('unsupported_format', `The bundled Studio worker writes MP4 (H.264) only, not ${format}.`);
  }
  if (color !== 'preserve') refuse('unsupported_color', 'The bundled Studio worker exports SDR only (colour: preserve).');
  const contract = claim.snapshot?.contract;
  if (!contract?.video || contract.video.transfer !== null || contract.video.minBitDepth !== 8) {
    refuse('hdr_unsupported', 'This export keeps an HDR picture; the bundled Studio worker renders 8-bit SDR only.');
  }
  if (contract.image) refuse('unsupported_format', 'Still-image exports need a dedicated render worker.');
  if (subtitleMode === 'sidecar' || subtitleMode === 'embedded' || contract.subtitles || contract.embeddedSubtitles) {
    refuse('subtitles_unsupported', 'Subtitle files are not written by the bundled Studio worker yet; burn subtitles in or turn them off.');
  }
  if (subtitleMode !== undefined && subtitleMode !== 'burn' && subtitleMode !== 'off') {
    refuse('subtitles_unsupported', `Unknown subtitle mode ${subtitleMode}.`);
  }
  if (!Object.hasOwn(VIDEO_BITRATES, quality)) refuse('unsupported_quality', `Unknown export quality ${quality}.`);
  if (audio !== 'preserve' && audio !== 'stereo') refuse('unsupported_audio', `Unknown audio handling ${audio}.`);

  for (const key of ['width', 'height']) {
    if (!Number.isSafeInteger(graph.metadata[key]) || graph.metadata[key] <= 0 || graph.metadata[key] > 16_384) {
      refuse('invalid_graph', 'The project canvas is invalid.');
    }
  }
  const cadence = parseRational(claim.snapshot?.timing?.cadence);
  const timeBase = parseRational(claim.snapshot?.timing?.timeBase);
  if (!cadence || !timeBase) refuse('invalid_timing', 'The export snapshot declares no exact cadence and time base.');

  const mediaIds = graphMedia(graph, { softwareRenderer });
  const bounds = frameRange(graph, range);
  const frames = bounds.outPoint - bounds.inPoint;
  const endTicks = frameTicks(frames, cadence, timeBase);
  if (endTicks === null) refuse('invalid_timing', 'The export range is not a whole number of time-base ticks.');

  const dimensions = outputDimensions(graph.metadata, resolution);
  const settings = {
    mode: 'video',
    codec: 'avc',
    container: 'mp4',
    audioCodec: 'aac',
    quality,
    ...(subtitleMode !== undefined && { subtitleMode }),
    resolution: dimensions,
    fps: cadence.num / cadence.den,
    videoBitrate: VIDEO_BITRATES[quality],
    audioBitrate: 192_000,
  };
  const configDigest = digest(JSON.stringify({ recipe: BUNDLED_RECIPE, settings, audio, range: range ?? null }));
  const historyDigest = digest(JSON.stringify(graph));
  return {
    graph,
    settings,
    audio,
    contractAudio: contract.audio ?? null,
    mediaIds,
    frames,
    bounds,
    timebase: claim.snapshot.timing.timeBase,
    endTicks: String(endTicks),
    configDigest,
    historyDigest,
    chunkKey: digest(`${claim.artifactInputDigest}:${configDigest}:${historyDigest}`),
  };
};

/**
 * How far the audio runs past the picture, against the server's tolerance of one video frame plus
 * one audio frame (1024 samples). Null when either stream has no measured duration.
 */
export const avDrift = (streams, fps) => {
  const video = streams.find((stream) => stream.codec_type === 'video');
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  const videoSeconds = Number(video?.duration);
  const audioSeconds = Number(audio?.duration);
  const sampleRate = Number(audio?.sample_rate);
  if (!Number.isFinite(videoSeconds) || !Number.isFinite(audioSeconds) || !(fps > 0) || !(sampleRate > 0)) return null;
  const tolerance = 1 / fps + 1024 / sampleRate;
  return { videoSeconds, audioSeconds, excess: Math.abs(audioSeconds - videoSeconds) - tolerance };
};

/**
 * Does the encoded result honour what the claim promised? `probe` is ffprobe's stream list. The
 * server checks again before publication; this only refuses to upload something it would reject.
 */
export const outputMismatch = (recipe, streams) => {
  const video = streams.filter((stream) => stream.codec_type === 'video');
  const audio = streams.filter((stream) => stream.codec_type === 'audio');
  if (video.length !== 1 || video[0].codec_name !== 'h264') return 'the result is not one H.264 video stream';
  if (video[0].width !== recipe.settings.resolution.width || video[0].height !== recipe.settings.resolution.height) {
    return `the result is ${video[0].width}×${video[0].height}, not ${recipe.settings.resolution.width}×${recipe.settings.resolution.height}`;
  }
  const expected = recipe.contractAudio;
  if (!expected) return null;
  if (audio.length !== 1) return 'the result has no audio stream';
  if (expected.channels && audio[0].channels !== expected.channels) {
    return `the sources have ${expected.channels}-channel audio and the engine wrote ${audio[0].channels} channels`;
  }
  if (expected.sampleRate && Number(audio[0].sample_rate) !== expected.sampleRate) {
    return `the sources are sampled at ${expected.sampleRate} Hz and the engine wrote ${audio[0].sample_rate} Hz`;
  }
  const drift = avDrift(streams, recipe.settings.fps);
  if (drift && drift.excess > 1e-6) {
    return `its audio (${drift.audioSeconds.toFixed(3)} s) and picture (${drift.videoSeconds.toFixed(3)} s) end more than a frame apart`;
  }
  return null;
};
