export interface SubtitleCue {
  id: string;
  startSeconds: number;
  endSeconds: number;
  text: string;
}
export interface TrackState {
  id: string;
  isGroup?: boolean;
  parentTrackId?: string;
  locked?: boolean;
  muted?: boolean;
  visible?: boolean;
  solo?: boolean;
  order?: number;
}
export interface SidecarInput {
  tracks: readonly TrackState[];
  items: readonly unknown[];
  fps: number;
  frameRate?: { num: number; den: number };
  inPoint?: number | null;
  outPoint?: number | null;
}
export interface SidecarPlan {
  version: 1;
  required: true;
  cadence: { num: number; den: number };
  inPoint: number;
  outPoint: number;
  cueCount: number;
  zeroCue: boolean;
  content: string;
  byteLength: number;
  cues: SubtitleCue[];
}
export class SidecarRefusal extends Error {
  constructor(message: string);
}
export function resolveEffectiveTrackStates<T extends TrackState>(
  tracks: readonly T[],
): T[];
export function isTranscriptSubtitleItem(item: unknown): boolean;
export function buildTranscriptSubtitleCues(composition: {
  tracks: readonly { visible?: boolean; items?: readonly unknown[] }[];
  fps: number;
  durationInFrames?: number;
}): SubtitleCue[];
export function trimSubtitleCues<T extends SubtitleCue>(
  cues: readonly T[],
  trimStartSeconds: number,
  trimmedDurationSeconds: number,
): T[];
export function serializeSrt(cues: readonly SubtitleCue[]): string;
export function serializeVtt(cues: readonly SubtitleCue[]): string;
export function prepareSidecarPlan(input: SidecarInput): SidecarPlan;
