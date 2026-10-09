/** Real host source intents cross the canonical API without payload casts or widening. */
import {
  createStudioCommandEnvelope,
  type StudioRippleOption,
  type StudioSourceEdit,
  type StudioCommandEnvelope,
} from '@frameleaf/host/commands';
import type { CanonicalEnvelope } from '../src/canonical-commands';

const source = {
  trackId: 'video',
  assetId: 'asset',
  at: { num: 0, den: 1 },
  sourceIn: { num: 0, den: 1 },
  sourceOut: { num: 2, den: 1 },
};
const insert = createStudioCommandEnvelope('clip.insert', source, 3);
const overwrite = createStudioCommandEnvelope('clip.overwrite', source, 3);
export const canonicalInsert: CanonicalEnvelope = insert;
export const canonicalOverwrite: CanonicalEnvelope = overwrite;
declare const hostBatch: readonly StudioCommandEnvelope[];
export const canonicalBatch: readonly CanonicalEnvelope[] = hostBatch;

const { trackId: _trackId, ...withoutTrackid } = source;
// @ts-expect-error Source edits require trackId.
export const missingTrackid: StudioSourceEdit = withoutTrackid;

const { assetId: _assetId, ...withoutAssetid } = source;
// @ts-expect-error Source edits require assetId.
export const missingAssetid: StudioSourceEdit = withoutAssetid;

const { at: _at, ...withoutAt } = source;
// @ts-expect-error Source edits require at.
export const missingAt: StudioSourceEdit = withoutAt;

const { sourceIn: _sourceIn, ...withoutSourcein } = source;
// @ts-expect-error Source edits require sourceIn.
export const missingSourcein: StudioSourceEdit = withoutSourcein;

const { sourceOut: _sourceOut, ...withoutSourceout } = source;
// @ts-expect-error Source edits require sourceOut.
export const missingSourceout: StudioSourceEdit = withoutSourceout;

export const wrongSourceTime: StudioSourceEdit = {
  ...source,
  // @ts-expect-error Source edit times remain rational values.
  sourceIn: '0',
};

const rippleDelete = createStudioCommandEnvelope(
  'clip.delete',
  { clipId: 'clip', ripple: true },
  3,
);
const nonRippleTrim = createStudioCommandEnvelope(
  'clip.trimEnd',
  { clipId: 'clip', end: { num: 1, den: 1 }, ripple: false },
  3,
);
const defaultTrim = createStudioCommandEnvelope(
  'clip.trimStart',
  { clipId: 'clip', start: { num: 0, den: 1 } },
  3,
);
export const canonicalRipple: readonly CanonicalEnvelope[] = [
  rippleDelete,
  nonRippleTrim,
  defaultTrim,
];
export const optionalRipple: StudioRippleOption = {};
// @ts-expect-error Ripple is an optional boolean, not a string.
export const wrongRipple: StudioRippleOption = { ripple: 'true' };
// @ts-expect-error Ripple is an optional boolean, not null.
export const nullRipple: StudioRippleOption = { ripple: null };
