/** Native subtitle segments survive the persisted root and composition item contracts. */
import type { ProjectTimeline } from '@/types/project';
import type { SubtitleSegmentItem } from '@/types/timeline';

const native: SubtitleSegmentItem = {
  id: 'owned-subtitle',
  trackId: 'owned-captions',
  from: 30,
  durationInFrames: 60,
  label: 'Owned subtitles',
  type: 'subtitle',
  color: '#ffffff',
  sourceLabel: 'captions.srt',
  source: {
    type: 'subtitle-import',
    fileName: 'captions.srt',
    format: 'srt',
    importedAt: 1,
  },
  cues: [{ id: 'cue-1', startSeconds: 0, endSeconds: 1, text: 'Saved words' }],
};
export const persisted: ProjectTimeline['items'][number] = native;
export const compositionItem: NonNullable<
  ProjectTimeline['compositions']
>[number]['items'][number] = native;
declare const saved: Extract<
  ProjectTimeline['items'][number],
  { type: 'subtitle' }
>;
export const rehydrated: SubtitleSegmentItem = saved;

const { source: _source, ...withoutSource } = native;
// @ts-expect-error Persisted subtitles require their real source metadata.
export const missingSource: ProjectTimeline['items'][number] = withoutSource;
const { cues: _cues, ...withoutCues } = native;
// @ts-expect-error Persisted subtitles require their cue list.
export const missingCues: ProjectTimeline['items'][number] = withoutCues;
const { color: _color, ...withoutColor } = native;
// @ts-expect-error Persisted subtitles require their text color.
export const missingColor: ProjectTimeline['items'][number] = withoutColor;
export const wrongTiming: ProjectTimeline['items'][number] = {
  ...native,
  // @ts-expect-error Cue times remain numeric seconds.
  cues: [{ id: 'cue-1', startSeconds: '0', endSeconds: 1, text: 'Words' }],
};
export const wrongSource: ProjectTimeline['items'][number] = {
  ...native,
  source: {
    // @ts-expect-error Foreign subtitle origins are refused by the native source union.
    type: 'foreign-subtitles',
  },
};
export const foreignKind: ProjectTimeline['items'][number] = {
  ...native,
  // @ts-expect-error Persisted item discriminators stay closed.
  type: 'foreign-subtitle',
};
