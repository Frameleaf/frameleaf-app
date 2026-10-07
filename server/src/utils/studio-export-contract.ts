/**
 * What a Studio export promises before it renders, and the check that its result kept the promise
 * (FL-93 / `VID-102`, FL-102 / `VID-104`).
 *
 * At submit the server reads the stored graph and what the library knows about each source, and
 * writes two things into the render job's snapshot, which is what the worker receives:
 *
 * - **Timing.** The declared project cadence, the output cadence decision (`passthrough` for a
 *   single source the edit does not retime, otherwise a recorded `convert` onto the declared
 *   cadence), the output tick grid chunks are planned on, and every video source's timing map:
 *   time base, origin, variable-rate flag and track timescale.
 * - **Contract.** The bit depth and transfer the chosen format and colour promise, and the audio
 *   the result must carry: the widest source layout at the highest source rate, or a stereo
 *   downmix only when the export asked for one.
 *
 * Publication probes the worker's file and refuses it when it does not honour the contract.
 */
import z from 'zod';
import type { StudioSourceMediaFacts } from 'src/repositories/studio-export.repository.js';
import type { AudioStreamInfo, VideoPacketInfo, VideoStreamInfo } from 'src/types.js';
import { ColorMatrix, ColorPrimaries, ColorTransfer } from 'src/enum.js';
import { parseSourcePixelLayout } from 'src/utils/media-decode.js';
import {
  AudioChannelPolicy,
  findAudioLayoutMismatch,
  findAvAlignmentMismatch,
  isHdrTransfer,
} from 'src/utils/media-policy.js';
import {
  type Rational,
  coerceRational,
  equals,
  formatRational,
  fromInteger,
  invert,
  multiply,
  rational,
  tryParseRational,
} from 'src/utils/rational-time.js';
import {
  type StudioSourceTiming,
  StudioTimingError,
  outputTimeBase,
  projectCadenceOf,
  timelineFrameTicks,
} from 'src/utils/studio-timing.js';
import {
  OutputCadenceMode,
  VideoTimingMap,
  buildVideoTimingMap,
  resolveOutputCadence,
  timingMapTrackTimescale,
} from 'src/utils/video-timing.js';

export const STUDIO_EXPORT_AUDIO = ['preserve', 'stereo'] as const;
export type StudioExportAudio = (typeof STUDIO_EXPORT_AUDIO)[number];
export type StudioExportRange = { inPoint: number; outPoint: number };

/** Explicit export authority, never a source's content-light values or a preview assumption. */
export const StudioExportMasteringSchema = z
  .object({
    primaries: z.literal('bt2020').describe('Declared BT.2020 mastering display primaries and D65 white point'),
    maxNits: z.number().positive().max(10_000).multipleOf(0.0001).meta({ format: 'double' }),
    minNits: z.number().nonnegative().max(10_000).multipleOf(0.0001).meta({ format: 'double' }),
  })
  .strict()
  .refine((value) => value.maxNits > value.minNits, 'Mastering maximum must exceed its minimum')
  .meta({ id: 'StudioExportMastering' });
export type StudioExportMastering = z.infer<typeof StudioExportMasteringSchema>;
export class StudioExportMasteringError extends Error {}

export type StudioExportTiming = {
  /** The project cadence the graph declares, `num/den`. */
  cadence: string;
  decision: { mode: OutputCadenceMode; cadence: string | null; reason: string };
  /** Seconds per tick of the output grid every chunk boundary is expressed in. */
  timeBase: string;
  sources: StudioSourceTiming[];
};

/** Still output identity is independent of the legacy video contract. */
export const StudioExportImageContractSchema = z
  .object({
    version: z.literal(1),
    format: z.enum(['sdr-jpeg', 'hdr-jpeg', 'hdr-heic']),
    width: z.int().positive().max(16_384),
    height: z.int().positive().max(16_384),
    frame: z.int().nonnegative(),
    dynamicRange: z.enum(['sdr', 'hdr']),
    outputIntent: z.enum(['sdr', 'hdr']),
    referenceWhite: z.literal(203),
    renderer: z.literal('frameleaf-studio-image-v1'),
  })
  .strict()
  .refine(
    (image) =>
      image.width * image.height <= 48_000_000 &&
      image.dynamicRange === (image.format === 'sdr-jpeg' ? 'sdr' : 'hdr') &&
      (image.dynamicRange === 'sdr' || image.outputIntent === 'hdr'),
    'Invalid still output contract',
  );
export type StudioExportImageContract = z.infer<typeof StudioExportImageContractSchema>;
export class StudioExportImageError extends Error {}

export type StudioExportContract = {
  image?: StudioExportImageContract;
  /** Main-timeline frame selection; the output is rebased to zero at this exact cadence. */
  range?: StudioExportRange & { cadence: string };
  video: {
    minBitDepth: 8 | 10;
    transfer: 'smpte2084' | 'arib-std-b67' | null;
    /** Absent only on HLG/SDR or contracts written before explicit PQ mastering existed. */
    mastering?: StudioExportMastering;
  };
  audio: {
    policy: StudioExportAudio;
    channels: number | null;
    channelLayout: string | null;
    sampleRate: number | null;
  } | null;
};

type GraphItem = Record<string, unknown>;

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const timelineOf = (graph: unknown) => asRecord(asRecord(graph).timeline);
const itemsOf = (graph: unknown): GraphItem[] => asArray(timelineOf(graph).items).map((value) => asRecord(value));

/** Validate frame bounds against the stored main timeline, without changing that graph. */
export const resolveStudioExportRange = (graph: unknown, range: StudioExportRange) => {
  const cadence = projectCadenceOf(asRecord(graph).metadata);
  const items = itemsOf(graph);
  if (
    !cadence ||
    !Number.isSafeInteger(range.inPoint) ||
    !Number.isSafeInteger(range.outPoint) ||
    range.inPoint < 0 ||
    range.outPoint <= range.inPoint ||
    items.length === 0 ||
    asArray(timelineOf(graph).compositions).length > 0 ||
    asArray(asRecord(graph).compositions).length > 0
  ) {
    throw new StudioTimingError(
      'Frame ranges require a non-empty main timeline with an exact cadence and no nested compositions.',
    );
  }
  let end = 0;
  for (const item of items) {
    const from = item.from as number;
    const duration = item.durationInFrames as number;
    if (
      !Number.isSafeInteger(from) ||
      from < 0 ||
      !Number.isSafeInteger(duration) ||
      duration <= 0 ||
      !Number.isSafeInteger(from + duration) ||
      item.type === 'composition'
    ) {
      throw new StudioTimingError('The main timeline has no usable integer frame bounds.');
    }
    end = Math.max(end, from + duration);
  }
  if (range.outPoint > end) {
    throw new StudioTimingError(`The end frame ${range.outPoint} exceeds the main timeline's ${end} frames.`);
  }
  return { inPoint: range.inPoint, outPoint: range.outPoint, cadence: formatRational(cadence) };
};

/**
 * True when the edit places one video source and does nothing to its timing: no second picture, no
 * transition, no animation, no nested sequence, played forwards at its own speed. Such an export
 * keeps the source's presentation timestamps, a variable rate included. A trim does not retime.
 */
export const isTimingUnchangedSingleSource = (graph: unknown): boolean => {
  const timeline = timelineOf(graph);
  if (
    asArray(timeline.transitions).length > 0 ||
    asArray(timeline.keyframes).length > 0 ||
    asArray(timeline.compositions).length > 0 ||
    asArray(asRecord(graph).compositions).length > 0
  ) {
    return false;
  }
  const pictures = itemsOf(graph).filter((item) => item.type !== 'audio');
  if (pictures.length !== 1 || pictures[0].type !== 'video') {
    return false;
  }
  const [clip] = pictures;
  const speed = clip.speed === undefined ? 1 : clip.speed;
  return speed === 1 && clip.isReversed !== true;
};

/** Media ids of the audible audio clips: not muted themselves, not on a muted track. */
const audibleMediaIds = (graph: unknown, range?: StudioExportRange): Set<string> => {
  const muted = new Set(
    asArray(timelineOf(graph).tracks)
      .map((value) => asRecord(value))
      .filter((track) => track.muted === true)
      .map((track) => String(track.id)),
  );
  return new Set(
    itemsOf(graph)
      .filter(
        (item) =>
          !range ||
          ((item.from as number) < range.outPoint &&
            (item.from as number) + (item.durationInFrames as number) > range.inPoint),
      )
      .filter((item) => item.type === 'audio' && item.muted !== true && !muted.has(String(item.trackId)))
      .map((item) => String(item.mediaId ?? item.assetId ?? '')),
  );
};

/**
 * A constant-rate source's cadence recovered exactly from what was stored: every packet lasts the
 * same `d` ticks of `1/timeBase`, so the rate is `timeBase / d`. A variable-rate source has none.
 */
const storedCadence = (map: VideoTimingMap): Rational | null => {
  const [duration] = map.keyframeDurationTicks;
  if (map.variableFrameRate || !duration || duration <= 0) {
    return null;
  }
  return invert(multiply(fromInteger(duration), map.timeBase));
};

const sourceTimingOf = (key: string, facts: StudioSourceMediaFacts): VideoTimingMap | null => {
  if (!facts.video || !facts.packets) {
    return null;
  }
  const map = buildVideoTimingMap({ videoStream: { timeBase: facts.video.timeBase }, packets: facts.packets });
  if (!map) {
    throw new StudioTimingError(`Source ${key} has no usable time base.`);
  }
  return { ...map, cadence: map.cadence ?? storedCadence(map) };
};

/**
 * The timing an export declares. Throws {@link StudioTimingError} for a graph with no exact
 * cadence or a video source whose timing was never scanned: rendering either would place its
 * frames on a grid nobody chose.
 */
export const resolveStudioExportTiming = (
  graph: unknown,
  sources: ReadonlyArray<{ key: string; facts: StudioSourceMediaFacts }>,
): StudioExportTiming => {
  const cadence = projectCadenceOf(asRecord(graph).metadata);
  if (!cadence) {
    throw new StudioTimingError('The project has no exact frame rate.');
  }

  const maps: Array<{ key: string; assetId: string; map: VideoTimingMap; facts: StudioSourceMediaFacts }> = [];
  for (const { key, facts } of sources) {
    if (!facts.video) {
      continue;
    }
    const map = sourceTimingOf(key, facts);
    if (!map) {
      throw new StudioTimingError(`The timing of source ${key} has not been read yet.`);
    }
    maps.push({ key, assetId: facts.assetId, map, facts });
  }

  const declared = formatRational(cadence);
  let decision: StudioExportTiming['decision'];
  if (maps.length === 0) {
    decision = {
      mode: OutputCadenceMode.Convert,
      cadence: declared,
      reason: `No video source; frames are rendered on the declared cadence ${declared}.`,
    };
  } else if (maps.length === 1 && isTimingUnchangedSingleSource(graph)) {
    const resolved = resolveOutputCadence({ sources: [maps[0].map] });
    decision = { mode: resolved.mode, cadence: null, reason: resolved.reason };
  } else {
    const resolved = resolveOutputCadence({ sources: maps.map(({ map }) => map), declaredCadence: cadence });
    decision =
      resolved.mode === OutputCadenceMode.Passthrough
        ? {
            mode: OutputCadenceMode.Convert,
            cadence: declared,
            reason: `The edit retimes its source, so it is rendered on the declared cadence ${declared}, which is the source's own.`,
          }
        : { mode: resolved.mode, cadence: declared, reason: resolved.reason };
  }

  const timings: StudioSourceTiming[] = maps.map(({ key, assetId, map, facts }) => ({
    key,
    assetId,
    timeBase: formatRational(map.timeBase),
    originTicks: map.originTicks,
    cadence: map.cadence ? formatRational(map.cadence) : null,
    variableFrameRate: map.variableFrameRate,
    trackTimescale: timingMapTrackTimescale(map),
    audio: facts.audio
      ? {
          sampleRate: facts.audio.sampleRate,
          channels: facts.audio.channels,
          channelLayout: facts.audio.channelLayout,
        }
      : null,
  }));

  return {
    cadence: declared,
    decision,
    timeBase: formatRational(outputTimeBase(decision, timings)),
    sources: timings,
  };
};

/** A manifest entry as {@link studioMediaSources} needs it. */
type MediaEntry = { key: string; kind: string; id: string; source?: string };

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

/**
 * The library assets a manifest reads media from: `ids` for every one (pictures and asset-backed
 * audio), and `pictures`, each placed picture's manifest key, for the timing maps.
 */
export const studioMediaSources = (entries: readonly MediaEntry[]) => {
  const ids = new Set<string>();
  const pictures = new Map<string, string>();
  for (const entry of entries) {
    if (!UUID.test(entry.id)) {
      continue;
    }
    if (entry.kind === 'library-asset' || entry.kind === 'edited-master') {
      ids.add(entry.id);
      if (!pictures.has(entry.id)) {
        pictures.set(entry.id, entry.key);
      }
    } else if (entry.kind === 'audio' && entry.source === 'asset') {
      ids.add(entry.id);
    }
  }
  return { ids: [...ids], pictures };
};

/** The timing a Studio job declares, from its graph, its manifest and what the library knows. */
export const declareStudioTiming = (
  graph: unknown,
  entries: readonly MediaEntry[],
  facts: readonly StudioSourceMediaFacts[],
): StudioExportTiming => {
  const { pictures } = studioMediaSources(entries);
  return resolveStudioExportTiming(
    graph,
    facts
      .filter((fact) => pictures.has(fact.assetId))
      .map((fact) => ({ key: pictures.get(fact.assetId)!, facts: fact })),
  );
};

/* ------------------------------------------------------------------ */
/* Contract                                                             */
/* ------------------------------------------------------------------ */

const TEN_BIT_FORMATS = new Set(['mp4-hevc-main10', 'webm-av1', 'prores-422-hq']);
const FORMAT_CODECS: Readonly<Record<string, string>> = {
  'mp4-hevc-main10': 'hevc',
  'mp4-h264': 'h264',
  'webm-av1': 'av1',
  'prores-422-hq': 'prores',
};
const HDR_TRANSFERS: Readonly<Record<number, 'smpte2084' | 'arib-std-b67'>> = {
  [ColorTransfer.Smpte2084]: 'smpte2084',
  [ColorTransfer.AribStdB67]: 'arib-std-b67',
};

/**
 * The precision and audio an export promises.
 *
 * - An HEVC Main10, AV1 or ProRes export is 10-bit; HDR10 and Dolby Vision are 10-bit PQ. `preserve`
 *   keeps an HDR transfer when every video source shares it.
 * - The audio carries the widest layout any audible source has, at the highest rate any states,
 *   unless a stereo downmix was chosen. With no audible source nothing is promised.
 */
export const buildStudioExportContract = (
  settings: {
    format: string;
    color: string;
    audio?: StudioExportAudio;
    mastering?: StudioExportMastering;
    range?: StudioExportRange;
  },
  graph: unknown,
  sources: readonly StudioSourceMediaFacts[],
): StudioExportContract => {
  const range = settings.range ? resolveStudioExportRange(graph, settings.range) : undefined;
  if (['sdr-jpeg', 'hdr-jpeg', 'hdr-heic'].includes(settings.format)) {
    const metadata = asRecord(asRecord(graph).metadata);
    const outputIntent = asRecord(metadata.colorManagement).workingRange === 'hdr' ? 'hdr' : 'sdr';
    if (settings.color !== 'preserve' || settings.mastering !== undefined)
      throw new StudioExportImageError('Still exports use their explicit SDR/HDR format and document color intent');
    if (range && range.outPoint - range.inPoint !== 1)
      throw new StudioExportImageError('A still export must select exactly one frame');
    if (settings.format !== 'sdr-jpeg' && outputIntent !== 'hdr')
      throw new StudioExportImageError('HDR still export requires an HDR document');
    const image = StudioExportImageContractSchema.safeParse({
      version: 1,
      format: settings.format,
      width: metadata.width,
      height: metadata.height,
      frame: range?.inPoint ?? 0,
      dynamicRange: settings.format === 'sdr-jpeg' ? 'sdr' : 'hdr',
      outputIntent,
      referenceWhite: 203,
      renderer: 'frameleaf-studio-image-v1',
    });
    if (!image.success) throw new StudioExportImageError('This document exceeds the supported still-image dimensions');
    // Older contracts remain unchanged. Still-aware workers must consume the image contract;
    // these neutral legacy fields cannot be interpreted as a video rendering request.
    return { image: image.data, video: { minBitDepth: 8, transfer: null }, audio: null, ...(range && { range }) };
  }
  const hdrRequested = settings.color === 'hdr10' || settings.color === 'dolby-vision';
  const videoTransfers = new Set(
    sources.filter((facts) => facts.video).map((facts) => HDR_TRANSFERS[facts.video!.colorTransfer] ?? null),
  );
  const preservedTransfer =
    settings.color === 'preserve' && videoTransfers.size === 1 ? ([...videoTransfers][0] ?? null) : null;
  const transfer = hdrRequested ? 'smpte2084' : preservedTransfer;
  const minBitDepth = TEN_BIT_FORMATS.has(settings.format) || transfer ? 10 : 8;
  const mastering = StudioExportMasteringSchema.safeParse(settings.mastering);
  if (transfer === 'smpte2084' && !mastering.success) {
    throw new StudioExportMasteringError('PQ export requires an explicit valid BT.2020 mastering display profile');
  }
  if (transfer !== 'smpte2084' && settings.mastering !== undefined) {
    throw new StudioExportMasteringError('A mastering display profile applies only to a PQ export');
  }

  const audible = audibleMediaIds(graph, range);
  const audio = sources.filter((facts) => facts.audio && audible.has(facts.assetId)).map((facts) => facts.audio!);
  const policy = settings.audio ?? 'preserve';
  let expectation: StudioExportContract['audio'] = null;
  if (audio.length > 0) {
    let widest = audio[0];
    for (const stream of audio) {
      if ((stream.channels ?? 0) > (widest.channels ?? 0)) {
        widest = stream;
      }
    }
    const rates = audio.map((stream) => stream.sampleRate ?? 0).filter((rate) => rate > 0);
    const sampleRate = rates.length > 0 ? Math.max(...rates) : null;
    expectation =
      policy === 'stereo'
        ? { policy, channels: 2, channelLayout: 'stereo', sampleRate }
        : { policy, channels: widest.channels, channelLayout: widest.channelLayout, sampleRate };
  }

  return {
    video: { minBitDepth, transfer, ...(mastering.success && { mastering: mastering.data }) },
    audio: expectation,
    ...(range && { range }),
  };
};

/** Exact packet evidence for a rendered range; no seconds-to-frame rounding or nominal VFR rate. */
export const findStudioExportRangeMismatch = (
  range: NonNullable<StudioExportContract['range']>,
  video: VideoStreamInfo,
  packets: VideoPacketInfo | null,
): string | null => {
  const cadence = tryParseRational(range.cadence);
  const timeBase = coerceRational(video.timeBaseRational);
  const frames = range.outPoint - range.inPoint;
  const mismatch =
    'The rendered range does not have the selected frame count and exact presentation span at the declared cadence';
  if (!cadence || !timeBase || cadence.num <= 0 || timeBase.num <= 0 || !Number.isSafeInteger(frames) || frames <= 0) {
    return mismatch;
  }
  let ticks: number | null;
  let frameTicks: number | null;
  try {
    ticks = timelineFrameTicks(frames, cadence, timeBase);
    frameTicks = timelineFrameTicks(1, cadence, timeBase);
  } catch {
    return mismatch;
  }
  const span = packets?.presentation;
  if (
    ticks === null ||
    frameTicks === null ||
    !span ||
    packets?.variableFrameRate !== false ||
    packets.presentationCadenceTicks !== frameTicks ||
    packets.packetCount !== frames ||
    !Number.isSafeInteger(span.startPts) ||
    !Number.isSafeInteger(span.endPts) ||
    span.startPts !== 0 ||
    span.endPts !== ticks ||
    packets.totalDuration !== ticks
  ) {
    return mismatch;
  }
  return null;
};

export const parseStudioExportContract = (value: unknown): StudioExportContract | null => {
  const record = asRecord(value);
  const video = asRecord(record.video);
  if (record.image !== undefined && !StudioExportImageContractSchema.safeParse(record.image).success) return null;
  if (video.minBitDepth !== 8 && video.minBitDepth !== 10) {
    return null;
  }
  if (
    video.mastering !== undefined &&
    (video.transfer !== 'smpte2084' || !StudioExportMasteringSchema.safeParse(video.mastering).success)
  ) {
    return null;
  }
  return value as StudioExportContract;
};

/**
 * Why a rendered export does not honour its contract, or null when it does. `probe` is the
 * production probe of the worker's file; nothing the worker reported about it is consulted.
 */
export const findStudioExportOutputMismatch = (
  contract: StudioExportContract,
  probe: { videoStreams: VideoStreamInfo[]; audioStreams: AudioStreamInfo[]; mastering?: Record<string, unknown>[] },
  format: string,
): string | null => {
  const [video] = probe.videoStreams;
  if (!video) {
    return 'The result has no video stream';
  }
  const codec = Object.hasOwn(FORMAT_CODECS, format) ? FORMAT_CODECS[format] : null;
  if (!codec) {
    return 'The export names an unsupported video format';
  }
  if (video.codecName !== codec) {
    return `The result's video codec is ${video.codecName ?? 'unknown'}, instead of the ${codec} this export promises`;
  }
  const minBitDepth = Math.max(contract.video.minBitDepth, TEN_BIT_FORMATS.has(format) ? 10 : 8);
  if (minBitDepth > 8 && (parseSourcePixelLayout(video.pixelFormat)?.bitDepth ?? 0) < minBitDepth) {
    return `The result is ${video.pixelFormat}, below the ${minBitDepth}-bit this export promises`;
  }
  if (
    contract.video.transfer &&
    (!isHdrTransfer(video) || HDR_TRANSFERS[video.colorTransfer] !== contract.video.transfer)
  ) {
    return `The result is not tagged with the ${contract.video.transfer} transfer this export promises`;
  }
  if (contract.video.transfer) {
    if (video.colorPrimaries !== ColorPrimaries.Bt2020) {
      return 'The result is not tagged with the BT.2020 primaries this HDR export promises';
    }
    if (video.colorMatrix !== ColorMatrix.Bt2020Nc) {
      return 'The result is not tagged with the BT.2020 non-constant-luminance matrix this HDR export promises';
    }
    if (contract.video.mastering) {
      const data = probe.mastering?.find((entry) => entry.side_data_type === 'Mastering display metadata');
      const expected: Record<string, Rational> = {
        red_x: { num: 35_400, den: 50_000 },
        red_y: { num: 14_600, den: 50_000 },
        green_x: { num: 8500, den: 50_000 },
        green_y: { num: 39_850, den: 50_000 },
        blue_x: { num: 6550, den: 50_000 },
        blue_y: { num: 2300, den: 50_000 },
        white_point_x: { num: 15_635, den: 50_000 },
        white_point_y: { num: 16_450, den: 50_000 },
        max_luminance: { num: Math.round(contract.video.mastering.maxNits * 10_000), den: 10_000 },
        min_luminance: { num: Math.round(contract.video.mastering.minNits * 10_000), den: 10_000 },
      };
      if (
        !Object.entries(expected).every(([key, want]) => {
          const actual = tryParseRational(String(data?.[key]));
          return actual && equals(actual, rational(want.num, want.den));
        })
      ) {
        return 'The result does not carry the mastering display profile this PQ export declared';
      }
    }
  }
  const [audio] = probe.audioStreams;
  if (contract.audio) {
    const mismatch = findAudioLayoutMismatch(
      {
        policy: contract.audio.policy === 'stereo' ? AudioChannelPolicy.DownmixStereo : AudioChannelPolicy.Preserve,
        channels: contract.audio.channels,
        channelLayout: contract.audio.channelLayout,
        sampleRate: contract.audio.sampleRate,
      },
      audio,
    );
    if (mismatch) {
      return `The result's audio does not match the export: ${mismatch}`;
    }
  }
  const drift = findAvAlignmentMismatch(video, audio);
  return drift ? `The result's audio and video are misaligned: ${drift}` : null;
};

/** Exact equality of two `num/den` spellings, so a worker's unreduced `2/60000` still matches `1/30000`. */
export const sameTimeBase = (a: string, b: string): boolean => {
  const left = tryParseRational(a);
  const right = tryParseRational(b);
  return !!left && !!right && equals(left, right);
};
