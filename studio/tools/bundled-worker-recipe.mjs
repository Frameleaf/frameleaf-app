// FL-408: what the bundled machine-learning Studio worker renders for one claim, or why it will not.
//
// Pure functions, no I/O: the claim's immutable graph, settings and snapshot become the engine
// settings, the exact frame range and the checkpoint timing the server will verify. Anything this
// worker cannot render honestly is a `BundledRefusal` with a stable code and a sentence the owner
// can read; nothing is dropped, approximated or rendered differently from what was asked.
import { createHash } from 'node:crypto';
import { prepareSidecarPlan } from '../runtime/subtitle-sidecar.mjs';
import { TEN_BIT_FORMATS, bundledFormat, formatMismatch } from './bundled-worker-formats.mjs';
import { HDR_MASTER_ENCODER, HDR_MASTER_FORMAT, hdrEvidenceToken } from './bundled-worker-hdr.mjs';
import { ReframeRefusal, reframeGraph, reframeOf } from './bundled-worker-reframe.mjs';

export const BUNDLED_RECIPE = 'frameleaf-bundled-worker-v2';

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
export const outputDimensions = (canvas, resolution, shortSide) => {
  const even = (value) => Math.max(2, Math.round(value / 2) * 2);
  if (resolution === 'original') return { width: even(canvas.width), height: even(canvas.height) };
  const target = shortSide ?? RESOLUTION_SHORT_SIDE[resolution];
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

/** Audio-only exports still composite a picture in the engine; the smallest one keeps that cheap. */
const SOUND_ONLY_PICTURE_SHORT_SIDE = 144;

/** Bitrate of the engine's H.264 master when a second pass encodes the final format. */
export const masterBitrate = ({ width, height }, fps) =>
  Math.min(200_000_000, Math.max(VIDEO_BITRATES.ultra, Math.round(width * height * fps * 0.3)));

const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

/**
 * The caption cues the server sealed, produced again from the immutable graph with the same pure
 * producer the server uses. A mismatch means this worker would write different captions: refuse.
 */
export const sealedCaptions = (graph, range, cadence, seal) => {
  let plan;
  try {
    plan = prepareSidecarPlan({
      tracks: graph.timeline.tracks,
      items: graph.timeline.items,
      fps: graph.metadata.fps ?? cadence.num / cadence.den,
      frameRate: graph.metadata.frameRate,
      ...(range && { inPoint: range.inPoint, outPoint: range.outPoint }),
    });
  } catch (error) {
    refuse('captions_unsupported', `The captions cannot be written as a file or track: ${error.message}.`);
  }
  if (sha256(plan.content) !== seal?.expectedSrtSha256 || String(Buffer.byteLength(plan.content)) !== seal?.sizeInBytes) {
    refuse('captions_changed', 'The captions no longer match the ones sealed when this export was queued; export again.');
  }
  return plan.content;
};

/** FL-107: what an HDR master file is: HEVC Main10 in MP4 (`mp4-hevc-main10`). */
export const HDR_MASTER_TARGET = Object.freeze({
  kind: 'video',
  container: 'mp4',
  muxer: 'mp4',
  extension: '.mp4',
  textTrack: 'mov_text',
  faststart: true,
  codec: 'hevc',
  encoders: [HDR_MASTER_ENCODER],
});

/**
 * FL-107: the HDR master this claim asks for, or null for an SDR export. HDR10 is `hdr10` colour (or
 * `preserve` of PQ sources) with its declared mastering display; HLG is `preserve` of HLG sources.
 * Both are written only as `mp4-hevc-main10`.
 */
export const hdrMasterOf = (format, color, contract) => {
  const transfer = contract?.video?.transfer;
  if (format !== HDR_MASTER_FORMAT || !transfer) return null;
  if (transfer === 'smpte2084' && (color === 'hdr10' || color === 'preserve')) {
    return { transfer: 'pq', mastering: contract.video.mastering ?? null };
  }
  if (transfer === 'arib-std-b67' && color === 'preserve') return { transfer: 'hlg', mastering: null };
  return null;
};

const validMastering = (mastering) =>
  Number.isFinite(mastering?.maxNits) &&
  Number.isFinite(mastering?.minNits) &&
  mastering.minNits >= 0 &&
  mastering.maxNits > mastering.minNits;

/** The format this claim asks for, or why the bundled worker cannot write it. */
const targetFormat = (format) => {
  if (Object.hasOwn(TEN_BIT_FORMATS, format)) {
    refuse(
      'needs_10bit',
      format === HDR_MASTER_FORMAT
        ? `${format} promises a 10-bit picture, and the bundled Studio worker writes 10-bit only as an HDR10 or HLG master. Choose ${TEN_BIT_FORMATS[format]} for an SDR project.`
        : `${format} promises a 10-bit picture and the bundled Studio worker renders 8-bit SDR. Choose ${TEN_BIT_FORMATS[format]}, or use a render worker that verified 10-bit output.`,
    );
  }
  const target = bundledFormat(format);
  if (!target) refuse('unsupported_format', `The bundled Studio worker cannot write ${format ?? 'this format'}.`);
  return { id: format, ...target };
};

/** How the captions travel: burned into the picture, left out, a sealed SRT sibling, or a track. */
const captionsOf = (claim, target, contract) => {
  const { subtitleMode, subtitleSeal, embeddedSubtitleSeal } = claim.settings ?? {};
  if (subtitleMode !== undefined && !['burn', 'off', 'sidecar', 'embedded'].includes(subtitleMode)) {
    refuse('subtitles_unsupported', `Unknown subtitle mode ${subtitleMode}.`);
  }
  if (target.kind === 'audio' && subtitleMode !== undefined && subtitleMode !== 'off') {
    refuse('subtitles_unsupported', 'A sound-only export has no captions; turn them off.');
  }
  if (subtitleMode === 'sidecar') {
    if (!subtitleSeal || contract.embeddedSubtitles) refuse('subtitles_unsupported', 'The caption file has no sealed contents.');
    return { mode: 'sidecar', seal: subtitleSeal };
  }
  if (subtitleMode === 'embedded') {
    if (
      !embeddedSubtitleSeal ||
      contract.subtitles ||
      embeddedSubtitleSeal.container !== target.container ||
      embeddedSubtitleSeal.codec !== target.textTrack
    ) {
      refuse('subtitles_unsupported', `The sealed caption track does not fit ${target.container.toUpperCase()}.`);
    }
    return { mode: 'embedded', seal: embeddedSubtitleSeal };
  }
  if (contract.subtitles || contract.embeddedSubtitles) {
    refuse('subtitles_unsupported', 'The export promises captions it did not ask for.');
  }
  return { mode: subtitleMode };
};

/** FL-563: the sealed framing of a vertical or square export, or null for the project's own shape. */
const shapedFraming = (settings, target) => {
  try {
    const reframe = reframeOf(settings);
    if (reframe && target.kind !== 'video') refuse('reframe_invalid', 'Only a video export has a shape.');
    return reframe;
  } catch (error) {
    if (error instanceof ReframeRefusal) refuse(error.code, error.message);
    throw error;
  }
};

const derivedGraph = (graph, reframe) => {
  try {
    return reframeGraph(graph, reframe).graph;
  } catch (error) {
    if (error instanceof ReframeRefusal) refuse(error.code, error.message);
    throw error;
  }
};

/**
 * The render recipe for one claim. Throws `BundledRefusal` for anything this worker cannot render.
 * `softwareRenderer` is what its conformance check reported for the renderer it will use;
 * `writers` is what its admission measured (format id -> encoder), when known.
 */
export const bundledRecipe = (claim, { softwareRenderer, writers }) => {
  if (claim.kind !== 'studio_export') refuse('unsupported_kind', 'The bundled Studio worker renders Studio exports only.');
  const projectGraph = claim.snapshot?.studio?.graph;
  if (
    !projectGraph?.metadata ||
    !Array.isArray(projectGraph.timeline?.items) ||
    !Array.isArray(projectGraph.timeline?.tracks)
  ) {
    refuse('invalid_graph', 'The export has no immutable project graph.');
  }
  if (typeof claim.artifactInputDigest !== 'string' || !/^[a-f0-9]{64}$/.test(claim.artifactInputDigest)) {
    refuse('invalid_claim', 'The claim carries no artifact input digest.');
  }
  const { format, color, resolution, quality = 'high', audio = 'preserve', range } = claim.settings ?? {};
  const contract = claim.snapshot?.contract;
  if (contract?.image) refuse('unsupported_format', 'Still-image exports need a dedicated render worker.');
  const hdr = hdrMasterOf(format, color, contract);
  if (!hdr && (color === 'hdr10' || color === 'dolby-vision')) {
    refuse(
      'unsupported_color',
      color === 'hdr10'
        ? 'The bundled Studio worker writes HDR10 only as MP4 · HEVC Main10. Choose that format.'
        : 'The bundled Studio worker cannot write Dolby Vision.',
    );
  }
  const target = hdr ? { id: format, ...HDR_MASTER_TARGET } : targetFormat(format);
  if (hdr) {
    if (contract.video.minBitDepth !== 10) refuse('invalid_contract', 'An HDR master promises a 10-bit picture.');
    if (hdr.transfer === 'pq' && !validMastering(hdr.mastering)) {
      refuse('invalid_mastering', 'An HDR10 export needs the mastering display it was graded on.');
    }
  } else {
    if (color !== 'preserve') refuse('unsupported_color', `Unknown colour handling ${color}.`);
    if (!contract?.video || contract.video.transfer !== null || contract.video.minBitDepth !== 8) {
      refuse(
        'hdr_unsupported',
        'This export keeps an HDR picture, which the bundled Studio worker writes only as MP4 · HEVC Main10. Choose that format.',
      );
    }
  }
  if (!Object.hasOwn(VIDEO_BITRATES, quality)) refuse('unsupported_quality', `Unknown export quality ${quality}.`);
  if (audio !== 'preserve' && audio !== 'stereo') refuse('unsupported_audio', `Unknown audio handling ${audio}.`);
  if (target.kind === 'audio' && !contract.audio) {
    refuse('no_audio', 'This project has no sound to export. Add audio, or export a video.');
  }
  const writerKey = hdr ? hdrEvidenceToken(hdr.transfer) : target.id;
  const encoder = writers ? writers[writerKey] : target.encoders[0];
  if (!encoder) {
    refuse(
      'unsupported_format',
      hdr
        ? `This machine-learning container cannot write ${hdr.transfer === 'pq' ? 'HDR10' : 'HLG'} masters; its admission check did not verify them.`
        : `This machine-learning container cannot write ${target.id}; its admission check did not verify it.`,
    );
  }
  const captions = captionsOf(claim, target, contract);
  if (hdr && (captions.mode === 'sidecar' || captions.mode === 'embedded')) {
    refuse('subtitles_unsupported', 'Captions as a file or a track need an SDR video format.');
  }
  if (
    hdr &&
    captions.mode === 'off' &&
    timelinesOf(projectGraph).some((timeline) => (timeline?.items ?? []).some((item) => item.type === 'subtitle'))
  ) {
    refuse('subtitles_unsupported', 'An HDR master draws the project captions into the picture; turn captions on, or remove them.');
  }

  for (const key of ['width', 'height']) {
    if (
      !Number.isSafeInteger(projectGraph.metadata[key]) ||
      projectGraph.metadata[key] <= 0 ||
      projectGraph.metadata[key] > 16_384
    ) {
      refuse('invalid_graph', 'The project canvas is invalid.');
    }
  }
  // FL-563: a vertical or square export renders a graph derived from the project's, never the project.
  const reframe = shapedFraming(claim.settings, target);
  const graph = reframe ? derivedGraph(projectGraph, reframe) : projectGraph;
  const cadence = parseRational(claim.snapshot?.timing?.cadence);
  const timeBase = parseRational(claim.snapshot?.timing?.timeBase);
  if (!cadence || !timeBase) refuse('invalid_timing', 'The export snapshot declares no exact cadence and time base.');

  const mediaIds = graphMedia(graph, { softwareRenderer });
  const bounds = frameRange(graph, range);
  const frames = bounds.outPoint - bounds.inPoint;
  const endTicks = frameTicks(frames, cadence, timeBase);
  if (endTicks === null) refuse('invalid_timing', 'The export range is not a whole number of time-base ticks.');
  // Captions are sealed from the project graph; reframing moves where they are drawn, not their words.
  const captionText = captions.mode === 'sidecar' || captions.mode === 'embedded'
    ? sealedCaptions(projectGraph, range, cadence, captions.mode === 'sidecar' ? captions.seal : captions.seal.source)
    : null;

  // One engine pass writes MP4/H.264 with nothing to add; every other format is a second ffmpeg pass.
  // FL-107: an HDR master is the engine's float route encoded by ffmpeg (`hdr`).
  const pass = hdr
    ? 'hdr'
    : target.id === 'mp4-h264' && captions.mode !== 'embedded'
      ? 'engine'
      : encoder === 'copy'
        ? 'remux'
        : 'encode';
  const fps = cadence.num / cadence.den;
  // A shaped export is rendered at its sealed size: the crop of the frame is scaled to fill it.
  const dimensions =
    target.kind === 'audio'
      ? outputDimensions(graph.metadata, '720p', SOUND_ONLY_PICTURE_SHORT_SIDE)
      : reframe
        ? { ...reframe.output }
        : outputDimensions(graph.metadata, resolution);
  if (hdr && reframe) {
    refuse('hdr_resolution', 'A vertical or square export is written in SDR; choose another format or the original shape.');
  }
  if (hdr && (dimensions.width !== graph.metadata.width || dimensions.height !== graph.metadata.height)) {
    refuse(
      'hdr_resolution',
      `An HDR master is written at the project size (${graph.metadata.width}×${graph.metadata.height}); choose a resolution that does not scale it down.`,
    );
  }
  // The HDR picture comes from the float route; the engine's own encode then only carries the sound.
  const engineDimensions = hdr ? outputDimensions(graph.metadata, '720p', SOUND_ONLY_PICTURE_SHORT_SIDE) : dimensions;
  const settings = {
    mode: 'video',
    codec: 'avc',
    container: 'mp4',
    audioCodec: 'aac',
    quality,
    // Captions in a file or a track are not drawn into the picture; ordinary titles still are.
    ...(captions.mode !== undefined && { subtitleMode: captions.mode === 'burn' ? 'burn' : 'off' }),
    resolution: engineDimensions,
    fps,
    videoBitrate: pass === 'encode' ? masterBitrate(dimensions, fps) : hdr ? VIDEO_BITRATES.low : VIDEO_BITRATES[quality],
    audioBitrate: pass === 'engine' ? 192_000 : 320_000,
  };
  const output = {
    format: target.id,
    encoder,
    pass,
    captions: captions.mode ?? null,
    ...(hdr && { hdr: { transfer: hdr.transfer, mastering: hdr.mastering } }),
    ...(reframe && { shape: reframe.shape }),
  };
  const configDigest = digest(JSON.stringify({ recipe: BUNDLED_RECIPE, settings, output, audio, range: range ?? null }));
  const historyDigest = digest(JSON.stringify(graph));
  return {
    graph,
    settings,
    dimensions,
    hdr: hdr ? { ...hdr, cadence: `${cadence.num}/${cadence.den}` } : null,
    target,
    encoder,
    pass,
    quality,
    captions: { mode: captions.mode ?? null, content: captionText },
    audio,
    contractAudio: contract.audio ?? null,
    mediaIds,
    frames,
    bounds,
    timebase: claim.snapshot.timing.timeBase,
    endTicks: String(endTicks),
    shape: reframe?.shape ?? 'original',
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
 * Does the encoded result honour what the claim promised? `probed` is ffprobe's streams and
 * container (`probeMedia`). The server checks again before publication; this only refuses to
 * upload something it would reject.
 */
export const outputMismatch = (recipe, probed) => {
  const { streams } = probed;
  const expected = recipe.contractAudio;
  const sound = recipe.target.kind === 'audio';
  const mismatch = formatMismatch(recipe.target, probed, {
    ...(!sound && {
      width: (recipe.dimensions ?? recipe.settings.resolution).width,
      height: (recipe.dimensions ?? recipe.settings.resolution).height,
    }),
    audio: !!expected,
    textTrack: recipe.captions.mode === 'embedded',
  });
  if (mismatch) return mismatch;
  if (!expected) return null;
  const [audio] = streams.filter((stream) => stream.codec_type === 'audio');
  const channels = recipe.audio === 'stereo' ? 2 : expected.channels;
  if (channels && audio.channels !== channels) {
    return `the sources have ${channels}-channel audio and the engine wrote ${audio.channels} channels`;
  }
  if (expected.sampleRate && Number(audio.sample_rate) !== expected.sampleRate) {
    return `the sources are sampled at ${expected.sampleRate} Hz and the engine wrote ${audio.sample_rate} Hz`;
  }
  const drift = sound ? null : avDrift(streams, recipe.settings.fps);
  if (drift && drift.excess > 1e-6) {
    return `its audio (${drift.audioSeconds.toFixed(3)} s) and picture (${drift.videoSeconds.toFixed(3)} s) end more than a frame apart`;
  }
  return null;
};
