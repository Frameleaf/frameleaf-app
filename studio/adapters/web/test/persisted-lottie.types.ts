/** Compile-time contracts for the native persisted Lottie item, not a renderer substitute. */
import type { ProjectTimeline } from '@/types/project';
import type { LottieItem } from '@/types/timeline';

const native: LottieItem = {
  id: 'owned-lottie',
  trackId: 'owned-vector',
  type: 'lottie',
  label: 'Owned',
  from: 0,
  durationInFrames: 60,
  mediaId: 'owned-media',
  src: 'blob:owned',
  frameRate: 30,
  totalFrames: 60,
  loop: true,
  reversed: false,
  loopMode: 'loop',
  segmentStart: 0,
  segmentEnd: 59,
  animationId: 'owned-animation',
  themeId: 'owned-theme',
  colorOverrides: { c0: '#00ff00' },
  textOverrides: { '0': 'B' },
  slotOverrides: { opacity: 50, scale: [50, 100] },
};
export const persisted: ProjectTimeline['items'][number] = native;
const { src: _ephemeralSource, ...withoutSource } = native;
export const sourceResolvedAfterReload: ProjectTimeline['items'][number] =
  withoutSource;

export const foreignKind: ProjectTimeline['items'][number] = {
  ...native,
  // @ts-expect-error A foreign discriminator is not a persisted item.
  type: 'foreign-lottie',
};
export const wrongTiming: ProjectTimeline['items'][number] = {
  ...native,
  // @ts-expect-error Timing is numeric, not an unchecked string.
  totalFrames: '60',
};
export const wrongSlot: ProjectTimeline['items'][number] = {
  ...native,
  // @ts-expect-error Value slots are scalar or a two-component vector only.
  slotOverrides: { scale: [1, 2, 3] },
};
const { frameRate: _requiredCadence, ...withoutCadence } = native;
// @ts-expect-error Persisted Lottie items retain the required source cadence.
export const missingTiming: ProjectTimeline['items'][number] = withoutCadence;
