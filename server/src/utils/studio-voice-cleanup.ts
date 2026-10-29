import { BadRequestException } from '@nestjs/common';
import {
  Rational,
  add,
  compare,
  frameStartTime,
  max,
  rational,
  subtract,
  toApproximateNumber,
  toDecimalString,
} from 'src/utils/rational-time.js';
import {
  StudioResourceKind,
  isStudioIdentifier,
  isStudioUuid,
  parseStudioRestoredMediaId,
  studioReferenceKey,
} from 'src/utils/studio-resources.js';
import { cadenceFromDecimal, projectCadenceOf } from 'src/utils/studio-timing.js';

/**
 * Studio "Clean up voice" (FL-637, approved mock 2026-10-29): the pure half of the job.
 *
 * One audio clip on the main timeline is cleaned at a time. The server reads the clip's source window,
 * with a second of handle on each side so a small trim still has cleaned sound, and keeps the cleaned
 * sound with the project as an audio import. The editor then plays the clip from that import and keeps
 * what it played before under `voiceCleanup.original`, so "Use the original sound" puts it back. The
 * original is never changed, and `voiceCleanup.original.mediaId` stays a graph reference the resource
 * resolver checks like any other.
 */

export const VOICE_CLEANUP_NOISES = ['wind', 'hum', 'background', 'echo'] as const;
export type VoiceCleanupNoise = (typeof VOICE_CLEANUP_NOISES)[number];
export const VOICE_CLEANUP_STRENGTHS = ['light', 'standard', 'strong'] as const;
export type VoiceCleanupStrength = (typeof VOICE_CLEANUP_STRENGTHS)[number];

/** The worker cleans at most ten minutes at once (machine-learning/frameleaf_ml/models/voice_cleanup.py). */
export const VOICE_CLEANUP_MAX_SECONDS = 10 * 60;
/** The analysis reads at most this much of the clip. */
export const VOICE_ANALYSIS_MAX_SECONDS = 60;
/** Cleaned sound kept beyond each edge of the clip, where the source has it. */
export const VOICE_CLEANUP_HANDLE_SECONDS = 1;

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : {};
const safeInteger = (value: unknown, minimum: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;

export type VoiceCleanupClip = {
  clipId: string;
  /** The media the clip played before any clean-up: what is cleaned, always from the original. */
  mediaId: string;
  /** The manifest keys that media can resolve under (an asset, a restored version or an import). */
  sourceKeys: string[];
  /** The clip's source window, in seconds from the source's origin. */
  sourceStart: Rational;
  sourceEnd: Rational;
  label: string;
};

/**
 * The clip a clean-up names: one forwards-playing audio clip on the main timeline with an exact source
 * window. A clip that was cleaned before is cleaned again from its original, never from the cleaned sound.
 */
export const voiceCleanupClipOf = (graph: unknown, clipId: string): VoiceCleanupClip => {
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
  if (clip.type !== 'audio') {
    throw new BadRequestException('Only a clip with sound can be cleaned up');
  }
  if (clip.isReversed === true) {
    throw new BadRequestException('A reversed clip cannot be cleaned up');
  }
  const cleaned = record(record(clip.voiceCleanup).original);
  const played = Object.keys(cleaned).length > 0 ? cleaned : clip;
  const mediaId = played.mediaId;
  if (typeof mediaId !== 'string' || !isStudioIdentifier(mediaId) || clip.generatedId !== undefined) {
    throw new BadRequestException('The clip does not play media this server holds');
  }
  const start = played.sourceStart === undefined ? 0 : played.sourceStart;
  const end = played.sourceEnd;
  if (!safeInteger(start, 0) || !safeInteger(end, 1) || end <= start) {
    throw new BadRequestException('The clip has no exact source window');
  }
  const sourceCadence = clip.sourceFps === undefined ? cadence : cadenceFromDecimal(clip.sourceFps);
  if (!sourceCadence) {
    throw new BadRequestException("The clip's source frame rate has no exact reading");
  }
  return {
    clipId,
    mediaId,
    sourceKeys: sourceKeysOf(mediaId),
    sourceStart: frameStartTime(start, sourceCadence),
    sourceEnd: frameStartTime(end, sourceCadence),
    label: typeof clip.label === 'string' ? clip.label.slice(0, 200) : '',
  };
};

const sourceKeysOf = (mediaId: string): string[] => {
  const key = (kind: StudioResourceKind, id: string) => studioReferenceKey({ kind, id });
  const restoration = parseStudioRestoredMediaId(mediaId);
  if (restoration) {
    return [key(StudioResourceKind.RestoredVersion, restoration)];
  }
  // The editor places a project import by its media id, as it places a library asset.
  return [
    ...(isStudioUuid(mediaId) ? [key(StudioResourceKind.LibraryAsset, mediaId)] : []),
    key(StudioResourceKind.ProjectImport, mediaId),
  ];
};

export type VoiceCleanupWindow = {
  /** Where the cleaned file starts in the source, and how much of it is handle before the clip. */
  start: Rational;
  handleBefore: Rational;
  duration: Rational;
  startSeconds: string;
  durationSeconds: string;
};

/** The source seconds to clean: the clip's window with up to a second of handle on each side. */
export const voiceCleanupWindow = (clip: VoiceCleanupClip): VoiceCleanupWindow => {
  const handle = rational(VOICE_CLEANUP_HANDLE_SECONDS);
  const start = max(rational(0), subtract(clip.sourceStart, handle));
  const end = add(clip.sourceEnd, handle);
  const duration = subtract(end, start);
  if (compare(subtract(clip.sourceEnd, clip.sourceStart), rational(VOICE_CLEANUP_MAX_SECONDS)) > 0) {
    throw new BadRequestException(`A clip longer than ${VOICE_CLEANUP_MAX_SECONDS / 60} minutes cannot be cleaned up`);
  }
  return {
    start,
    handleBefore: subtract(clip.sourceStart, start),
    duration,
    startSeconds: toDecimalString(start, 6),
    durationSeconds: toDecimalString(duration, 6),
  };
};

/** The first stretch of the clip the analysis listens to. */
export const voiceAnalysisWindow = (clip: VoiceCleanupClip) => {
  const length = subtract(clip.sourceEnd, clip.sourceStart);
  const limit = rational(VOICE_ANALYSIS_MAX_SECONDS);
  const duration = compare(length, limit) > 0 ? limit : length;
  return { startSeconds: toDecimalString(clip.sourceStart, 6), durationSeconds: toDecimalString(duration, 6) };
};

/** Seconds, rounded to the millisecond, for the client's frame arithmetic. */
export const voiceSeconds = (value: Rational) => Math.round(toApproximateNumber(value) * 1000) / 1000;

/** The noises in their fixed order, without repeats; at least one is needed to clean. */
export const voiceNoisesOf = (noises: readonly string[]): VoiceCleanupNoise[] =>
  VOICE_CLEANUP_NOISES.filter((noise) => noises.includes(noise));
