import { BadRequestException } from '@nestjs/common';
import {
  Rational,
  add,
  compare,
  divide,
  frameStartTime,
  min,
  multiply,
  rational,
  roundToInteger,
  toDecimalString,
} from 'src/utils/rational-time.js';
import {
  StudioResourceKind,
  isStudioIdentifier,
  isStudioUuid,
  parseStudioRestoredMediaId,
  studioReferenceKey,
} from 'src/utils/studio-resources.js';
import { cadenceFromDecimal, projectCadenceOf, speedOf } from 'src/utils/studio-timing.js';

/**
 * Studio captions (protocol section 15.1, owner decision 2026-10-09: Whisper on the server).
 *
 * The pure half of a transcription job: which clip, which window of its source, and how the worker's
 * segment and word times (seconds from the start of that window) become exact rational seconds on the
 * main sequence that `captions.set` (section 15) applies unchanged.
 */

/** Whisper reads at most this much of one clip; the worker refuses longer audio too. */
export const TRANSCRIPTION_MAX_SECONDS = 4 * 60 * 60;
/** A cue longer than this many characters, or seconds, is split at word boundaries. */
export const CUE_MAX_CHARACTERS = 84;
export const CUE_MAX_SECONDS = 7;
/** captions.set admits at most 4 MiB of cues; this many short ones stays far below it. */
export const TRANSCRIPTION_MAX_CUES = 20_000;

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : {};
const safeInteger = (value: unknown, minimum: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;

export type TranscriptionClip = {
  clipId: string;
  type: 'video' | 'audio';
  /** The manifest key of the media the clip plays (`library-asset:<id>`, ...). */
  sourceKey: string;
  /** Project cadence. */
  cadence: Rational;
  from: number;
  durationInFrames: number;
  /** Where the clip's window starts in its source, in seconds from the source's origin. */
  sourceStart: Rational;
  /** The clip's speed factor, exactly. */
  speed: Rational;
};

/**
 * The clip a transcription names: one main-timeline video or audio item of the stored graph, playing
 * forwards from library media, a restored version, a project import or a generated intermediate.
 * Anything else is refused with a reason a client can show.
 */
export const transcriptionClipOf = (graph: unknown, clipId: string): TranscriptionClip => {
  const root = record(graph);
  const cadence = projectCadenceOf(root.metadata);
  if (!cadence) {
    throw new BadRequestException('The project frame rate has no exact reading');
  }
  const items = Array.isArray(record(root.timeline).items) ? (record(root.timeline).items as unknown[]) : [];
  const matches = isStudioIdentifier(clipId) ? items.filter((item) => record(item).id === clipId) : [];
  if (matches.length !== 1) {
    throw new BadRequestException('The clip is not on the main timeline of this revision');
  }
  const clip = record(matches[0]);
  if (clip.type !== 'video' && clip.type !== 'audio') {
    throw new BadRequestException('Only a video or audio clip can be transcribed');
  }
  if (clip.isReversed === true) {
    throw new BadRequestException('A reversed clip cannot be transcribed');
  }
  if (!safeInteger(clip.from, 0) || !safeInteger(clip.durationInFrames, 1)) {
    throw new BadRequestException('The clip has no exact place on the timeline');
  }
  const sourceStart = clip.sourceStart === undefined ? 0 : clip.sourceStart;
  if (!safeInteger(sourceStart, 0)) {
    throw new BadRequestException('The clip has no exact source window');
  }
  const sourceCadence = clip.sourceFps === undefined ? cadence : cadenceFromDecimal(clip.sourceFps);
  if (!sourceCadence) {
    throw new BadRequestException("The clip's source frame rate has no exact reading");
  }
  const sourceKey = sourceKeyOf(clip);
  if (!sourceKey) {
    throw new BadRequestException('The clip does not play media this server holds');
  }
  return {
    clipId,
    type: clip.type,
    sourceKey,
    cadence,
    from: clip.from,
    durationInFrames: clip.durationInFrames,
    sourceStart: frameStartTime(sourceStart, sourceCadence),
    speed: speedOf(clip.speed),
  };
};

const sourceKeyOf = (clip: RecordValue): string | null => {
  const key = (kind: StudioResourceKind, id: string) => studioReferenceKey({ kind, id });
  if (typeof clip.generatedId === 'string' && isStudioIdentifier(clip.generatedId)) {
    return key(StudioResourceKind.GeneratedIntermediate, clip.generatedId);
  }
  const media = clip.mediaId ?? clip.assetId;
  if (typeof media === 'string') {
    const restoration = parseStudioRestoredMediaId(media);
    if (restoration) {
      return key(StudioResourceKind.RestoredVersion, restoration);
    }
    if (isStudioUuid(media)) {
      return key(StudioResourceKind.LibraryAsset, media);
    }
  }
  for (const field of ['importId', 'uploadId']) {
    const id = clip[field];
    if (typeof id === 'string' && isStudioIdentifier(id)) {
      return key(StudioResourceKind.ProjectImport, id);
    }
  }
  return null;
};

/** The source seconds the clip shows: from its source start, for its timeline length at its speed. */
export const transcriptionWindow = (clip: TranscriptionClip) => {
  const duration = multiply(frameStartTime(clip.durationInFrames, clip.cadence), clip.speed);
  if (compare(duration, rational(TRANSCRIPTION_MAX_SECONDS)) > 0) {
    throw new BadRequestException(`A clip longer than ${TRANSCRIPTION_MAX_SECONDS / 3600} hours cannot be transcribed`);
  }
  return {
    start: clip.sourceStart,
    duration,
    /** ffmpeg arguments, to the microsecond. */
    startSeconds: toDecimalString(clip.sourceStart, 6),
    durationSeconds: toDecimalString(duration, 6),
  };
};

/**
 * A request's language as Whisper names it: `auto` is detection (null); a BCP 47 tag is its primary
 * language subtag, with the few places Whisper's codes differ from the registry's.
 */
export const whisperLanguageOf = (tag: string): string | null => {
  if (tag === 'auto') {
    return null;
  }
  const subtags = tag.toLowerCase().split('-');
  if (!/^[a-z]{2,3}$/.test(subtags[0]) || subtags.some((part) => !/^[\da-z]{1,8}$/.test(part))) {
    throw new BadRequestException('The language must be a BCP 47 tag or auto');
  }
  const [primary] = subtags;
  if (primary === 'zh' && subtags.includes('yue')) {
    return 'yue';
  }
  const renamed: Record<string, string> = { iw: 'he', jv: 'jw', nb: 'no' };
  return renamed[primary] ?? primary;
};

export type TranscriptCue = { start: Rational; end: Rational; text: string };
export type TranscriptWord = { start: Rational; end: Rational; text: string; cue: number };
type WorkerWord = { start: number; end: number; text: string };
type WorkerSegment = { start: number; end: number; text: string; words: WorkerWord[] };

/** Control characters captions.set refuses (section 15); tabs and line breaks become spaces. */

const cleanText = (text: string) =>
  text
    // eslint-disable-next-line no-control-regex
    .replaceAll(/[\u{0}-\u{1F}\u{7F}]+/gu, ' ')
    .replaceAll(/ {2,}/g, ' ')
    .trim();

/** Split a segment into readable cues at word boundaries; a segment without words stays whole. */
export const cueTextsOf = (
  segment: WorkerSegment,
): Array<{ start: number; end: number; text: string; words: WorkerWord[] }> => {
  const text = cleanText(segment.text);
  if (
    segment.words.length === 0 ||
    (text.length <= CUE_MAX_CHARACTERS && segment.end - segment.start <= CUE_MAX_SECONDS)
  ) {
    return [{ start: segment.start, end: segment.end, text, words: segment.words }];
  }
  const groups: WorkerWord[][] = [];
  let current: WorkerWord[] = [];
  const joined = (words: WorkerWord[]) => cleanText(words.map((word) => word.text).join(''));
  for (const word of segment.words) {
    const candidate = [...current, word];
    if (
      current.length > 0 &&
      (joined(candidate).length > CUE_MAX_CHARACTERS || word.end - current[0].start > CUE_MAX_SECONDS)
    ) {
      groups.push(current);
      current = [word];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) {
    groups.push(current);
  }
  return groups.map((words) => ({ start: words[0].start, end: words.at(-1)!.end, text: joined(words), words }));
};

/** The frame a time falls on as section 3.3 rounds it (nearest, halves up). */
const frameOf = (time: Rational, cadence: Rational) => roundToInteger(multiply(time, cadence), 'nearest');

/**
 * Map the worker's segments onto the sequence. `t` seconds into the window is
 * `clipStart + t / speed`; cues are clamped to the clip, any cue shorter than one frame once rounded is
 * stretched to one frame where the clip leaves room, and cues that fall outside the clip are dropped.
 * Words keep the index of the cue they belong to.
 */
export const mapTranscript = (
  clip: TranscriptionClip,
  segments: WorkerSegment[],
): { cues: TranscriptCue[]; words: TranscriptWord[] } => {
  const clipStart = frameStartTime(clip.from, clip.cadence);
  const clipEnd = frameStartTime(clip.from + clip.durationInFrames, clip.cadence);
  const onSequence = (seconds: number) =>
    min(add(clipStart, divide(rational(Math.max(0, Math.round(seconds * 1000)), 1000), clip.speed)), clipEnd);
  const cues: TranscriptCue[] = [];
  const words: TranscriptWord[] = [];
  for (const segment of segments) {
    for (const part of cueTextsOf(segment)) {
      if (!part.text || cues.length >= TRANSCRIPTION_MAX_CUES) {
        continue;
      }
      const start = onSequence(part.start);
      let end = onSequence(Math.max(part.start, part.end));
      if (frameOf(end, clip.cadence) - frameOf(start, clip.cadence) < 1) {
        end = frameStartTime(frameOf(start, clip.cadence) + 1, clip.cadence);
        if (compare(end, clipEnd) > 0) {
          continue;
        }
      }
      const index = cues.length;
      cues.push({ start, end, text: part.text });
      for (const word of part.words) {
        const text = cleanText(word.text);
        const wordStart = onSequence(word.start);
        if (text && compare(wordStart, clipEnd) < 0) {
          words.push({ start: wordStart, end: onSequence(Math.max(word.start, word.end)), text, cue: index });
        }
      }
    }
  }
  return { cues, words };
};
