import { BadRequestException } from '@nestjs/common';
import { Rational, isRational } from 'src/utils/rational-time.js';
import { isStudioIdentifier, isStudioUuid } from 'src/utils/studio-resources.js';
import { projectCadenceOf } from 'src/utils/studio-timing.js';

type RecordValue = Record<string, unknown>;
type RelinkedGraph = RecordValue & { timeline: RecordValue & { items: unknown[] } };
const record = (value: unknown): RecordValue =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : {};
const refuse = (): never => {
  throw new BadRequestException(
    'Source conform requires one unlinked reversed video clip at unity speed and matching cadence with explicit source-frame bounds',
  );
};

/** Only the main timeline's unique item is admitted; nested compositions need their own adapter. */
export const reverseClipOf = (graph: unknown, clipId: string) => {
  const root = record(graph);
  const timeline = record(root.timeline);
  const items = Array.isArray(timeline.items) ? timeline.items : [];
  const matches = items.filter((item) => record(item).id === clipId);
  const clip = record(matches[0]);
  const assetId = clip.mediaId ?? clip.assetId;
  const start = clip.sourceStart;
  const end = clip.sourceEnd;
  const duration = clip.sourceDuration;
  if (
    !isStudioIdentifier(clipId) ||
    matches.length !== 1 ||
    clip.type !== 'video' ||
    !isStudioUuid(assetId) ||
    (clip.assetId !== undefined && clip.assetId !== assetId) ||
    clip.generatedId !== undefined ||
    clip.restorationId !== undefined ||
    clip.compositionId !== undefined ||
    clip.linkedGroupId !== undefined ||
    clip.isReversed !== true ||
    typeof start !== 'number' ||
    !Number.isSafeInteger(start) ||
    start < 0 ||
    typeof end !== 'number' ||
    !Number.isSafeInteger(end) ||
    end <= start ||
    typeof duration !== 'number' ||
    !Number.isSafeInteger(duration) ||
    duration < end ||
    typeof clip.sourceFps !== 'number' ||
    !Number.isFinite(clip.sourceFps) ||
    clip.sourceFps <= 0 ||
    typeof clip.from !== 'number' ||
    !Number.isSafeInteger(clip.from) ||
    clip.from < 0 ||
    typeof clip.durationInFrames !== 'number' ||
    !Number.isSafeInteger(clip.durationInFrames) ||
    clip.durationInFrames <= 0 ||
    (clip.speed !== undefined && (typeof clip.speed !== 'number' || !Number.isFinite(clip.speed) || clip.speed <= 0))
  ) {
    return refuse();
  }
  return { root, timeline, items, clip, assetId, start, end, duration };
};

export type ReverseClipSource = { frames: number; frameRate: Rational };

/** Source frames remain integers: no guessed duration, changed cadence, or rounded trim boundary. */
export const checkReverseClipSource = (graph: unknown, clipId: string, source: ReverseClipSource) => {
  const selected = reverseClipOf(graph, clipId);
  const cadence = projectCadenceOf(selected.root.metadata);
  if (
    !cadence ||
    !isRational(source.frameRate) ||
    source.frameRate.num <= 0 ||
    !Number.isSafeInteger(source.frames) ||
    source.frames <= 0 ||
    source.frames !== selected.duration ||
    ((selected.clip.speed as number | undefined) ?? 1) !== 1 ||
    cadence.num !== source.frameRate.num ||
    cadence.den !== source.frameRate.den ||
    Math.abs(source.frameRate.num / source.frameRate.den - (selected.clip.sourceFps as number)) > 1e-9
  ) {
    return refuse();
  }
  if (selected.clip.durationInFrames !== selected.end - selected.start) {
    return refuse();
  }
  return selected;
};

/** No pathname or playback URL is stored. Delivery must resolve generatedId through its trusted declaration. */
export const relinkReverseClip = (
  graph: unknown,
  clipId: string,
  source: ReverseClipSource,
  generatedId: string,
): RelinkedGraph => {
  if (!isStudioIdentifier(generatedId)) {
    return refuse();
  }
  const selected = checkReverseClipSource(graph, clipId, source);
  const next = { ...selected.clip };
  for (const key of Object.keys(next)) {
    if (
      ['mediaId', 'assetId', 'src', 'audioSrc', 'thumbnailUrl', 'waveformData'].includes(key) ||
      key.startsWith('reverseConform')
    ) {
      delete next[key];
    }
  }
  const start = source.frames - selected.end;
  Object.assign(next, {
    generatedId,
    isReversed: false,
    sourceStart: start,
    sourceEnd: source.frames - selected.start,
    trimStart: start,
    offset: start,
    trimEnd: selected.start,
  });
  return {
    ...selected.root,
    timeline: { ...selected.timeline, items: selected.items.map((item) => (item === selected.clip ? next : item)) },
  };
};
