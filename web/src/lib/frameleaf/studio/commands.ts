import type { Translations } from 'svelte-i18n';
/**
 * The canonical Studio command vocabulary.
 *
 * Every editor change crosses the typed bridge as a StudioCommandEnvelope. The registry
 * supplies scope, graph/undo flags and worker capabilities; the host supplies handlers.
 * scripts/frameleaf-studio-commands.mjs checks this vocabulary against the published
 * catalogue and generated server mirror.
 *
 * Payloads describe intent, never a serialized graph. Times, durations and rates use
 * exact rationals; opaque graph values travel unread to preserve unknown Freecut fields.
 */
import type { Rational } from './rational-time';

/* ------------------------------------------------------------------ */
/* Identifiers                                                          */
/* ------------------------------------------------------------------ */

/**
 * Sorted by id, in the same order as the published catalogue, so the two files can be read
 * against each other line by line.
 */
export const studioCommandIds = [
  'captions.set',
  'clip.add',
  'clip.delete',
  'clip.group',
  'clip.insert',
  'clip.join',
  'clip.move',
  'clip.overwrite',
  'clip.push',
  'clip.relink',
  'clip.reorder',
  'clip.roll',
  'clip.setAudio',
  'clip.setBlendMode',
  'clip.setCrop',
  'clip.setGrade',
  'clip.setKenBurns',
  'clip.setLink',
  'clip.setMask',
  'clip.setSpeed',
  'clip.setTransform',
  'clip.setTransformParent',
  'clip.setTransition',
  'clip.slide',
  'clip.slip',
  'clip.split',
  'clip.trimEnd',
  'clip.trimStart',
  'clip.ungroup',
  'clip.update',
  'composition.add',
  'composition.setControlOverrides',
  'composition.setPublishedControls',
  'effect.add',
  'effect.remove',
  'effect.reorder',
  'effect.update',
  'history.redo',
  'history.undo',
  'job.cancel',
  'job.enqueueCaptioning',
  'job.enqueueExport',
  'job.enqueueFillerRemoval',
  'job.enqueueInterpolation',
  'job.enqueueMusicGeneration',
  'job.enqueueProxy',
  'job.enqueueRestoration',
  'job.enqueueReverseConform',
  'job.enqueueSceneDetection',
  'job.enqueueSilenceRemoval',
  'job.enqueueTextToSpeech',
  'job.enqueueTranscription',
  'job.enqueueUpscale',
  'keyframe.add',
  'keyframe.remove',
  'keyframe.setEasing',
  'keyframe.update',
  'lottie.update',
  'marker.add',
  'marker.remove',
  'marker.update',
  'media.import',
  'media.relink',
  'media.remove',
  'music.add',
  'preview.release',
  'preview.request',
  'project.applyTemplate',
  'project.exportBundle',
  'project.importBundle',
  'project.rename',
  'project.setMasterAudio',
  'project.setSettings',
  'property.bakeModifier',
  'property.setExpression',
  'property.setModifier',
  'review.add',
  'review.remove',
  'review.update',
  'sequence.add',
  'sequence.duplicate',
  'sequence.remove',
  'sequence.setActive',
  'sequence.setFields',
  'sequence.setSettings',
  'shape.add',
  'shape.setStyle',
  'text.setMotion',
  'title.add',
  'title.setStyle',
  'track.add',
  'track.closeGap',
  'track.remove',
  'track.reorder',
  'track.set',
  'track.setAudio',
  'voiceover.add',
] as const;

export type StudioCommandId = (typeof studioCommandIds)[number];

const commandIdSet: ReadonlySet<string> = new Set<string>(studioCommandIds);

export const isStudioCommandId = (value: unknown): value is StudioCommandId =>
  typeof value === 'string' && commandIdSet.has(value);

/* ------------------------------------------------------------------ */
/* Payloads                                                             */
/* ------------------------------------------------------------------ */

/**
 * An instant on the sequence timeline, in seconds, as an exact rational.
 *
 * It was a float. A float cannot hold 1001/30000, so an in point typed on an NTSC clip, a
 * split, a transition boundary and the frame the encoder is asked for all drifted apart by a
 * little, and the preview, the audio and the encoder each rounded that drift differently. A
 * rational is the same number everywhere, so a boundary the person set is the boundary that
 * gets rendered.
 *
 * Zero is the start of the sequence. A *source* in or out point is expressed the same way and
 * is relative to the source's own origin, which the server's timing map resolves — a container
 * whose first frame is not at timestamp zero is not the editor's problem.
 */
export type StudioTime = Rational;

/** A length on the timeline, in seconds, as an exact rational. Same reasoning as StudioTime. */
export type StudioDuration = Rational;

/**
 * A cadence or a speed multiplier, as an exact rational: 30000/1001 for NTSC, 1/3 for
 * a third-speed clip. The same reasoning as StudioTime — a frame rate that is not exactly the
 * one the source has makes every later boundary wrong — and the published catalogue types
 * these fields `rate`.
 */
export type StudioRate = Rational;
/** How a rate change treats existing content — same moments in seconds, or same frame numbers. */
export type StudioRetimePolicy = 'keep-time' | 'keep-frames';

/**
 * Graph-shaped data the host and the server carry without reading it: effect parameters,
 * masks, keyframe values, EQ stages, Lottie slots. Keeping it opaque is what makes the
 * round trip lossless for fields no Frameleaf release knows about yet.
 */
export type StudioOpaqueValue = Readonly<Record<string, unknown>>;

/** `audioDucking` of a duck-source clip: dB at or below 0, ramps in seconds, optional target tracks. */
export type StudioDucking = {
  duckOthersDb: number;
  attackSec?: number;
  releaseSec?: number;
  targetTrackIds?: string[];
};

/** Crop sides as fractions 0..1 of the source; softness -1..1. */
export type StudioCrop = { left?: number; right?: number; top?: number; bottom?: number; softness?: number };

/** Corner offsets in pixels of a reference box of the given size. */
export type StudioCornerPin = {
  topLeft: [number, number];
  topRight: [number, number];
  bottomRight: [number, number];
  bottomLeft: [number, number];
  referenceWidth: number;
  referenceHeight: number;
};

export type StudioShapeType = 'rectangle' | 'circle' | 'triangle' | 'ellipse' | 'star' | 'polygon' | 'heart' | 'path';

/** A pen-path vertex: position 0..1 of the shape's box, handles relative to the vertex. */
export type StudioPathVertex = {
  position: [number, number];
  inHandle: [number, number];
  outHandle: [number, number];
  tangentMode?: 'corner' | 'smooth' | 'continuous' | 'broken';
};

/** The shape fields of `shape.add` and `shape.setStyle` (graph protocol 17.5); colours are `#rrggbb` or `#rrggbbaa`. */
export type StudioShapeStyle = {
  fillColor?: string;
  fillEnabled?: boolean | null;
  fillType?: 'solid' | 'linear' | null;
  gradientStartColor?: string | null;
  gradientEndColor?: string | null;
  gradientAngle?: number | null;
  strokeColor?: string | null;
  strokeWidth?: number | null;
  strokeEnabled?: boolean | null;
  strokeLineCap?: 'butt' | 'round' | 'square' | null;
  strokeLineJoin?: 'miter' | 'round' | 'bevel' | null;
  strokeMiterLimit?: number | null;
  trimPathStart?: number | null;
  trimPathEnd?: number | null;
  trimPathOffset?: number | null;
  taperStartWidth?: number | null;
  taperEndWidth?: number | null;
  taperStartLength?: number | null;
  taperEndLength?: number | null;
  cornerRadius?: number | null;
  direction?: 'up' | 'down' | 'left' | 'right' | null;
  points?: number | null;
  innerRadius?: number | null;
  pathClosed?: boolean;
  pathVertices?: StudioPathVertex[];
};

export type StudioShapeBox = {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  rotation?: number;
  opacity?: number;
  aspectRatioLocked?: boolean;
};

/** The mask fields of `clip.setMask` (17.1) without the pen path, for a shape made as a mask. */
export type StudioNewShapeMask = { type?: 'clip' | 'alpha'; feather?: number; opacity?: number; invert?: boolean };

export type StudioTitleFontWeight = 'normal' | 'medium' | 'semibold' | 'bold';

/** The title fields of `title.setStyle` (graph protocol 14.3.4); colours are `#rrggbb` or `#rrggbbaa`. */
export type StudioTitleStyle = {
  color?: string;
  fontSize?: number | null;
  /** A family of the engine's font catalogue (`fonts.families` of the parameter catalogue). */
  fontFamily?: string | null;
  fontWeight?: StudioTitleFontWeight | null;
  fontStyle?: 'normal' | 'italic' | null;
  underline?: boolean | null;
  lineHeight?: number | null;
  letterSpacing?: number | null;
  textPadding?: number | null;
  backgroundColor?: string | null;
  backgroundRadius?: number | null;
  textShadow?: { offsetX: number; offsetY: number; blur: number; color: string } | null;
  stroke?: { width: number; color: string } | null;
  /** Only on a title that has a style preset: re-applies the preset at this scale. */
  textStyleScale?: number;
};

export type StudioTitleSpan = {
  text: string;
  fontSize?: number;
  fontFamily?: string;
  fontWeight?: StudioTitleFontWeight;
  fontStyle?: 'normal' | 'italic';
  underline?: boolean;
  color?: string;
  letterSpacing?: number;
};

export type StudioRippleOption = {
  /** When true later clips on the track follow the edit. */
  ripple?: boolean;
};

export interface StudioRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface StudioTransitionIntent {
  type: string;
  duration: StudioDuration;
}

export interface StudioColorWheel {
  x: number;
  y: number;
}

export interface StudioGradeIntent {
  look?: string;
  intensity?: number;
  exposure?: number;
  contrast?: number;
  saturation?: number;
  temperature?: number;
  wheels?: { lift?: StudioColorWheel; gamma?: StudioColorWheel; gain?: StudioColorWheel };
}

export interface StudioTransformIntent {
  x?: number;
  y?: number;
  scale?: number;
  rotation?: number;
  opacity?: number;
}

export interface StudioCaptionLine {
  id?: string;
  start: StudioTime;
  end: StudioTime;
  text: string;
}

/** A marked source range placed by the source monitor. */
export type StudioSourceEdit = {
  trackId: string;
  assetId: string;
  at: StudioTime;
  sourceIn: StudioTime;
  sourceOut: StudioTime;
};

export interface StudioCommandPayloads {
  'captions.set': { captions: StudioCaptionLine[] };
  'clip.add': { trackId: string; assetId: string; at: StudioTime; kind?: string; duration?: StudioDuration };
  'clip.delete': { clipId?: string; clipIds?: string[] } & StudioRippleOption;
  'clip.group': { clipIds: string[]; name?: string };
  'clip.insert': StudioSourceEdit;
  /** Linked selection is captured at submission; legacy envelopes omit it and default to true. */
  'clip.join': { clipIds: string[] };
  'clip.move': { clipId: string; start: StudioTime; trackId?: string; linkedSelectionEnabled?: boolean };
  'clip.overwrite': StudioSourceEdit;
  /** A signed delta: positive pushes later clips right on every track, negative pulls them left. */
  'clip.push': { clipId: string; delta: StudioDuration };
  'clip.relink': { clipId: string; assetId: string };
  'clip.reorder': { trackId: string; clipId: string; index: number };
  'clip.roll': { clipId: string; at: StudioTime };
  'clip.setAudio': {
    clipId: string;
    volume?: number;
    muted?: boolean;
    fadeIn?: StudioDuration;
    fadeOut?: StudioDuration;
    pitchSemitones?: number;
    pitchCents?: number;
    eq?: StudioOpaqueValue | null;
    /** Graph protocol 13.9: this clip turns the other audio down while it sounds. */
    ducking?: StudioDucking | null;
  };
  'clip.setBlendMode': { clipId: string; blendMode: string; opacity?: number };
  /** Graph protocol 17.6. */
  'clip.setCrop': { clipId: string; crop?: StudioCrop | null; cornerPin?: StudioCornerPin | null };
  'clip.setGrade': { clipId: string; grade: StudioGradeIntent | null };
  'clip.setKenBurns': { clipId: string; kenBurns: { from: StudioRect; to: StudioRect } | null };
  'clip.setLink': { clipIds: string[]; linked: boolean };
  'clip.setMask': { clipId: string; mask: StudioOpaqueValue | null };
  'clip.setSpeed': { clipId: string; speed: StudioRate };
  'clip.setTransform': { clipId: string; transform: StudioTransformIntent };
  'clip.setTransformParent': { clipId: string; parentId: string | null };
  'clip.setTransition': { clipId: string; transition: StudioTransitionIntent | null };
  'clip.slide': { clipId: string; delta: StudioDuration };
  'clip.slip': { clipId: string; delta: StudioDuration };
  'clip.split': { at: StudioTime; clipIds?: string[]; linkedSelectionEnabled?: boolean };
  'clip.trimEnd': { clipId: string; end: StudioTime } & StudioRippleOption;
  'clip.trimStart': { clipId: string; start: StudioTime } & StudioRippleOption;
  'clip.ungroup': { groupId: string };
  'clip.update': {
    clipId: string;
    patch: {
      name?: string;
      text?: string;
      style?: string;
      position?: string;
      animation?: string;
      volume?: number;
      muted?: boolean;
      transform?: StudioTransformIntent;
    };
  };
  'composition.add': { name: string; clipIds?: string[]; trackId?: string; at?: StudioTime };
  'composition.setControlOverrides': { compositionClipId: string; overrides: StudioOpaqueValue };
  'composition.setPublishedControls': { compositionId: string; controls: StudioOpaqueValue[] };
  'effect.add': { clipId: string; effect: string; params?: StudioOpaqueValue; index?: number };
  'effect.remove': { clipId: string; effectId: string };
  'effect.reorder': { clipId: string; effectId: string; index: number };
  'effect.update': { clipId: string; effectId: string; params: StudioOpaqueValue };
  'history.redo': { toRevision?: number };
  'history.undo': { toRevision?: number };
  'job.cancel': { jobId: string };
  'job.enqueueCaptioning': {
    sequenceId: string;
    clipIds?: string[];
    sampleCadence?: StudioDuration;
    destinationId: string;
  };
  'job.enqueueExport': {
    sequenceId: string;
    format: string;
    colour: string;
    resolution: string;
    destinationId: string;
    container?: string;
    videoCodec?: string;
    audioFormat?: string;
    subtitles?: string;
    quality?: string;
  };
  'job.enqueueFillerRemoval': { sequenceId: string; clipIds?: string[]; destinationId: string };
  /**
   * Smooth motion for the clip's source, previewed first and saved as a new version. `factor`
   * (2, 4 or 8) is the frames per source frame; without it the host derives it from `targetFps`.
   */
  'job.enqueueInterpolation': { clipId: string; targetFps: StudioRate; destinationId: string; factor?: number };
  'job.enqueueMusicGeneration': {
    prompt: string;
    duration: StudioDuration;
    preset?: string;
    destinationId: string;
  };
  'job.enqueueProxy': { assetIds: string[]; destinationId: string };
  /**
   * A restoration preview of `assetId` (`preview: true`), or the full render of the reviewed
   * `restorationId` (`preview: false`), on an explicit destination.
   */
  'job.enqueueRestoration': {
    mode: string;
    upscale: number;
    preview: boolean;
    destinationId: string;
    assetId?: string;
    restorationId?: string;
    keepGrain?: boolean;
  };
  'job.enqueueReverseConform': { clipId: string; destinationId: string };
  'job.enqueueSceneDetection': {
    assetIds: string[];
    mode: string;
    verifyWithModel?: boolean;
    destinationId: string;
  };
  'job.enqueueSilenceRemoval': {
    sequenceId: string;
    thresholdDb?: number;
    minimumSilence?: StudioDuration;
    destinationId: string;
  };
  'job.enqueueTextToSpeech': { text: string; voice: string; engine?: string; destinationId: string };
  'job.enqueueTranscription': { sequenceId: string; language: string; destinationId: string };
  'job.enqueueUpscale': { clipId: string; factor: number; destinationId: string };
  'keyframe.add': {
    clipId: string;
    property: string;
    at: StudioTime;
    value: StudioOpaqueValue;
    easing?: string;
  };
  'keyframe.remove': { clipId: string; property: string; keyframeIds: string[] };
  'keyframe.setEasing': {
    clipId: string;
    property: string;
    keyframeIds: string[];
    easing: string;
    bezier?: StudioOpaqueValue;
    /** Spring physics for `spring` easing (`tension`, `friction`, `mass`); defaults fill the rest. */
    spring?: StudioOpaqueValue;
  };
  'keyframe.update': {
    clipId: string;
    property: string;
    keyframeId: string;
    at?: StudioTime;
    value?: StudioOpaqueValue;
    /** Position, scale and anchor keyframes: incoming/outgoing velocity handles, or null to clear. */
    temporalEase?: StudioOpaqueValue | null;
    /** Position keyframes: path tangents `{ inTangent, outTangent, continuous? }`, or null to clear. */
    spatial?: StudioOpaqueValue | null;
  };
  'lottie.update': {
    clipId: string;
    colors?: StudioOpaqueValue;
    text?: StudioOpaqueValue;
    slots?: StudioOpaqueValue;
  };
  'marker.add': { at: StudioTime; name?: string; colour?: string };
  'marker.remove': { markerId: string };
  'marker.update': { markerId: string; patch: { name?: string; colour?: string; at?: StudioTime } };
  'media.import': { assetIds: string[] };
  'media.relink': { mediaId: string; assetId: string };
  'media.remove': { mediaIds: string[] };
  'music.add': { musicId: string; at: StudioTime; duration?: StudioDuration; volume?: number };
  /** The engine no longer needs the frame it last asked for; stop paying for it. */
  'preview.release': Record<string, never>;
  /**
   * Ask for one frame of the current revision.
   *
   * `at` is a `StudioTime` — an exact rational — never float seconds: a preview must
   * address the same frame the export does. The viewport is part of the frame's identity, not
   * a hint; the engine reports the size of the surface it will paint into.
   */
  'preview.request': {
    at: StudioTime;
    quality: 'draft' | 'standard' | 'full';
    viewportWidth: number;
    viewportHeight: number;
  };
  'project.applyTemplate': { templateId: string; timing?: StudioRetimePolicy };
  /**
   * `includeMedia`: copy the media the person owns into the bundle. Shared media always travels as a
   * reference and nothing Locked is ever copied. Left out, the host asks in its export dialog.
   */
  'project.exportBundle': { sequenceIds?: string[]; includeMedia?: boolean };
  'project.importBundle': { bundleUploadId: string };
  'project.rename': { name: string };
  'project.setMasterAudio': {
    gainDb?: number;
    muted?: boolean;
    ducking?: boolean;
    gainEnvelope?: Array<{ id: string; at: Rational; gainDb: number }>;
  };
  'project.setSettings': {
    patch: { mode?: 'basic' | 'advanced'; guides?: boolean; loop?: boolean; ducking?: boolean };
  };
  'property.bakeModifier': { clipId: string; property: string; modifierId: string };
  'property.setExpression': { clipId: string; property: string; expression: string | null };
  'property.setModifier': { clipId: string; property: string; modifier: StudioOpaqueValue | null };
  'review.add': { time: StudioTime; text: string };
  'review.remove': { commentId: string };
  'review.update': { commentId: string; patch: { text?: string; resolved?: boolean } };
  'sequence.add': { name: string; fps?: StudioRate; width?: number; height?: number };
  'sequence.duplicate': { sequenceId: string; name?: string };
  'sequence.remove': { sequenceId: string };
  'sequence.setActive': { sequenceId: string };
  'sequence.setFields': { name?: string; captionLanguage?: string; captionsBurnIn?: boolean };
  'sequence.setSettings': {
    sequenceId: string;
    fps?: StudioRate;
    width?: number;
    height?: number;
    timing?: StudioRetimePolicy;
  };
  /** Graph protocol 17.4. Without `trackId` the shape gets a new layer above every video track. */
  'shape.add': {
    shapeType: StudioShapeType;
    at: StudioTime;
    duration?: StudioDuration;
    trackId?: string;
    style?: StudioShapeStyle;
    transform?: StudioShapeBox;
    mask?: StudioNewShapeMask;
  };
  /** Graph protocol 17.5. A field left out is unchanged; `null` removes an optional field. */
  'shape.setStyle': { clipId: string; style: StudioShapeStyle };
  'text.setMotion': { clipId: string; motion: StudioOpaqueValue | null };
  'title.add': {
    at: StudioTime;
    text: string;
    duration?: StudioDuration;
    style?: string;
    position?: string;
    animation?: string;
  };
  /** Graph protocol 14.3.4. A field left out is unchanged; `null` removes an optional field. */
  'title.setStyle': {
    clipId: string;
    style: StudioTitleStyle;
    spans?: StudioTitleSpan[] | null;
    spanLayout?: 'stack' | 'inline' | null;
  };
  'track.add': { kind: string; name?: string; index?: number };
  /** With `at`, the gap at that time; without it, every gap on the track. */
  'track.closeGap': { trackId: string; at?: StudioTime };
  'track.remove': { trackId: string };
  'track.reorder': { trackId: string; index: number };
  'track.set': {
    trackId: string;
    /** `gain` is decibels (-60 to +12), as the prototype's track fader; `visible` hides a video track. */
    patch: {
      name?: string;
      muted?: boolean;
      locked?: boolean;
      solo?: boolean;
      visible?: boolean;
      syncLock?: boolean;
      gain?: number;
    };
  };
  'track.setAudio': { trackId: string; gainDb?: number; pan?: number; eq?: StudioOpaqueValue | null };
  'voiceover.add': { at: StudioTime; duration: StudioDuration; uploadId: string };
}

export type StudioCommand = {
  [Id in StudioCommandId]: { id: Id; payload: StudioCommandPayloads[Id] };
}[StudioCommandId];

/* ------------------------------------------------------------------ */
/* Registry                                                             */
/* ------------------------------------------------------------------ */

export type StudioCommandScope =
  | 'clip'
  | 'composition'
  | 'effect'
  | 'history'
  | 'job'
  | 'keyframe'
  | 'media'
  | 'preview'
  | 'project'
  | 'review'
  | 'sequence'
  | 'track';

export interface StudioCommandDefinition {
  id: StudioCommandId;
  scope: StudioCommandScope;
  /** Changes the stored project graph, so it needs a revision and the project lease. */
  mutatesGraph: boolean;
  /** Belongs on the editor's undo stack. Job submissions are not undoable. */
  undoable: boolean;
  /**
   * Requires a worker capability before the command can be accepted. Library browsing and
   * the quick editor stay GPU-free; only these rows depend on a worker.
   */
  requiresCapability?: StudioCapabilityId;
}

export const studioCapabilityIds = [
  'analysisWorker',
  'generationWorker',
  'gpuWorker',
  'renderWorker',
  'restorationWorker',
  'transcriptionWorker',
] as const;
export type StudioCapabilityId = (typeof studioCapabilityIds)[number];

const define = (definition: StudioCommandDefinition): [StudioCommandId, StudioCommandDefinition] => [
  definition.id,
  definition,
];

export const studioCommandRegistry: ReadonlyMap<StudioCommandId, StudioCommandDefinition> = new Map([
  define({
    id: 'captions.set',
    scope: 'sequence',
    mutatesGraph: true,
    undoable: true,
    requiresCapability: 'transcriptionWorker',
  }),
  define({
    id: 'clip.add',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    id: 'clip.delete',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    id: 'clip.group',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    id: 'clip.insert',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    id: 'clip.join',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    id: 'clip.move',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    id: 'clip.overwrite',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    id: 'clip.push',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    id: 'clip.relink',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    id: 'clip.reorder',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    id: 'clip.roll',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    id: 'clip.setAudio',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    id: 'clip.setBlendMode',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    id: 'clip.setCrop',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    id: 'clip.setGrade',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    id: 'clip.setKenBurns',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    id: 'clip.setLink',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    id: 'clip.setMask',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    id: 'clip.setSpeed',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    id: 'clip.setTransform',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    id: 'clip.setTransformParent',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    id: 'clip.setTransition',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    id: 'clip.slide',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    id: 'clip.slip',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    id: 'clip.split',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    id: 'clip.trimEnd',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    id: 'clip.trimStart',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    id: 'clip.ungroup',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    id: 'clip.update',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    id: 'composition.add',
    scope: 'composition',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    id: 'composition.setControlOverrides',
    scope: 'composition',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    id: 'composition.setPublishedControls',
    scope: 'composition',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    id: 'effect.add',
    scope: 'effect',
    mutatesGraph: true,
    undoable: true,
    requiresCapability: 'gpuWorker',
  }),
  define({
    id: 'effect.remove',
    scope: 'effect',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    id: 'effect.reorder',
    scope: 'effect',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    id: 'effect.update',
    scope: 'effect',
    mutatesGraph: true,
    undoable: true,
    requiresCapability: 'gpuWorker',
  }),
  define({
    id: 'history.redo',
    scope: 'history',
    mutatesGraph: true,
    undoable: false,
  }),
  define({
    id: 'history.undo',
    scope: 'history',
    mutatesGraph: true,
    undoable: false,
  }),
  define({
    id: 'job.cancel',
    scope: 'job',
    mutatesGraph: false,
    undoable: false,
  }),
  define({
    id: 'job.enqueueCaptioning',
    scope: 'job',
    mutatesGraph: false,
    undoable: false,
    requiresCapability: 'analysisWorker',
  }),
  define({
    id: 'job.enqueueExport',
    scope: 'job',
    mutatesGraph: false,
    undoable: false,
    requiresCapability: 'renderWorker',
  }),
  define({
    id: 'job.enqueueFillerRemoval',
    scope: 'job',
    mutatesGraph: false,
    undoable: false,
    requiresCapability: 'analysisWorker',
  }),
  define({
    id: 'job.enqueueInterpolation',
    scope: 'job',
    mutatesGraph: false,
    undoable: false,
    requiresCapability: 'restorationWorker',
  }),
  define({
    id: 'job.enqueueMusicGeneration',
    scope: 'job',
    mutatesGraph: false,
    undoable: false,
    requiresCapability: 'generationWorker',
  }),
  define({
    id: 'job.enqueueProxy',
    scope: 'job',
    mutatesGraph: false,
    undoable: false,
    requiresCapability: 'renderWorker',
  }),
  define({
    id: 'job.enqueueRestoration',
    scope: 'job',
    mutatesGraph: false,
    undoable: false,
    requiresCapability: 'restorationWorker',
  }),
  define({
    id: 'job.enqueueReverseConform',
    scope: 'job',
    mutatesGraph: false,
    undoable: false,
    requiresCapability: 'renderWorker',
  }),
  define({
    id: 'job.enqueueSceneDetection',
    scope: 'job',
    mutatesGraph: false,
    undoable: false,
    requiresCapability: 'analysisWorker',
  }),
  define({
    id: 'job.enqueueSilenceRemoval',
    scope: 'job',
    mutatesGraph: false,
    undoable: false,
    requiresCapability: 'analysisWorker',
  }),
  define({
    id: 'job.enqueueTextToSpeech',
    scope: 'job',
    mutatesGraph: false,
    undoable: false,
    requiresCapability: 'generationWorker',
  }),
  define({
    id: 'job.enqueueTranscription',
    scope: 'job',
    mutatesGraph: false,
    undoable: false,
    requiresCapability: 'transcriptionWorker',
  }),
  define({
    id: 'job.enqueueUpscale',
    scope: 'job',
    mutatesGraph: false,
    undoable: false,
    requiresCapability: 'restorationWorker',
  }),
  define({
    id: 'keyframe.add',
    scope: 'keyframe',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    id: 'keyframe.remove',
    scope: 'keyframe',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    id: 'keyframe.setEasing',
    scope: 'keyframe',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    id: 'keyframe.update',
    scope: 'keyframe',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    id: 'lottie.update',
    scope: 'media',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    id: 'marker.add',
    scope: 'sequence',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    id: 'marker.remove',
    scope: 'sequence',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    id: 'marker.update',
    scope: 'sequence',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    id: 'media.import',
    scope: 'media',
    mutatesGraph: true,
    undoable: false,
  }),
  define({
    id: 'media.relink',
    scope: 'media',
    mutatesGraph: true,
    undoable: false,
  }),
  define({
    id: 'media.remove',
    scope: 'media',
    mutatesGraph: true,
    undoable: false,
  }),
  define({
    id: 'music.add',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    id: 'preview.release',
    scope: 'preview',
    mutatesGraph: false,
    undoable: false,
  }),
  define({
    /**
     * Not a graph change and not undoable: asking to look at a frame changes nothing about the
     * project. It needs the GPU worker, and it is accepted in a read-only review session
     * because reviewing without a picture is not reviewing.
     */
    id: 'preview.request',
    scope: 'preview',
    mutatesGraph: false,
    undoable: false,
    requiresCapability: 'gpuWorker',
  }),
  define({
    id: 'project.applyTemplate',
    scope: 'project',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    id: 'project.exportBundle',
    scope: 'project',
    mutatesGraph: false,
    undoable: false,
  }),
  define({
    id: 'project.importBundle',
    scope: 'project',
    mutatesGraph: true,
    undoable: false,
  }),
  define({
    id: 'project.rename',
    scope: 'project',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    id: 'project.setMasterAudio',
    scope: 'project',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    id: 'project.setSettings',
    scope: 'project',
    mutatesGraph: true,
    undoable: false,
  }),
  define({
    id: 'property.bakeModifier',
    scope: 'keyframe',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    id: 'property.setExpression',
    scope: 'keyframe',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    id: 'property.setModifier',
    scope: 'keyframe',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    /**
     * Not a graph change, for all three review rows: the server stores comments beside the graph,
     * against the revision the reviewer was looking at. A reviewer holds no lease and may be a
     * revision behind, and neither may stop them commenting. Not undoable either: a comment is
     * a shared record other people may already have read, removed explicitly, not by undo.
     */
    id: 'review.add',
    scope: 'review',
    mutatesGraph: false,
    undoable: false,
  }),
  define({
    id: 'review.remove',
    scope: 'review',
    mutatesGraph: false,
    undoable: false,
  }),
  define({
    id: 'review.update',
    scope: 'review',
    mutatesGraph: false,
    undoable: false,
  }),
  define({
    id: 'sequence.add',
    scope: 'sequence',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    id: 'sequence.duplicate',
    scope: 'sequence',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    id: 'sequence.remove',
    scope: 'sequence',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    // The active sequence is stored on the project, so switching it is a graph change even
    // though it is not on the undo stack.
    id: 'sequence.setActive',
    scope: 'sequence',
    mutatesGraph: true,
    undoable: false,
  }),
  define({
    id: 'sequence.setFields',
    scope: 'sequence',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    id: 'sequence.setSettings',
    scope: 'sequence',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    id: 'shape.add',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    id: 'shape.setStyle',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    id: 'text.setMotion',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    id: 'title.add',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    id: 'title.setStyle',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    id: 'track.add',
    scope: 'track',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    id: 'track.closeGap',
    scope: 'track',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    id: 'track.remove',
    scope: 'track',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    id: 'track.reorder',
    scope: 'track',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    id: 'track.set',
    scope: 'track',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    id: 'track.setAudio',
    scope: 'track',
    mutatesGraph: true,
    undoable: true,
  }),
  define({
    id: 'voiceover.add',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
  }),
]);

export const studioCommandDefinition = (id: StudioCommandId): StudioCommandDefinition => {
  const definition = studioCommandRegistry.get(id);
  if (!definition) {
    // The registry is keyed by the same union the ids come from; a miss is a programming
    // error rather than an input the editor can produce.
    throw new TypeError(`Unknown Studio command: ${id}`);
  }
  return definition;
};

/** Command handlers are supplied by the host; the vocabulary itself implements none. */
export const isStudioCommandImplemented = (id: StudioCommandId): boolean => {
  studioCommandDefinition(id);
  return false;
};

/* ------------------------------------------------------------------ */
/* Envelopes and results                                                */
/* ------------------------------------------------------------------ */

export interface StudioCommandEnvelope<Id extends StudioCommandId = StudioCommandId> {
  id: Id;
  payload: StudioCommandPayloads[Id];
  /** The project revision the editor believed it was editing. */
  revision: number;
  /** Stable per attempt, so a retry after a dropped response cannot apply twice. */
  idempotencyKey: string;
  /** Epoch milliseconds, for ordering within a batch and for diagnostics. */
  issuedAt: number;
}

export type StudioCommandRejectionReason =
  | 'invalid'
  | 'unknown-command'
  | 'not-implemented'
  | 'stale-revision'
  | 'forbidden'
  | 'lease-lost'
  | 'offline'
  | 'capability-missing'
  | 'failed';

export type StudioCommandResult =
  | { status: 'accepted'; idempotencyKey: string; revision: number }
  | {
      status: 'rejected';
      idempotencyKey: string;
      reason: StudioCommandRejectionReason;
      /** i18n key describing the rejection to a person. */
      messageKey: Translations;
      /** Populated for `stale-revision` so the editor can reconcile. */
      revision?: number;
    };

const rejectionMessageKeys: Record<StudioCommandRejectionReason, Translations> = {
  invalid: 'frameleaf_studio_command_invalid',
  'unknown-command': 'frameleaf_studio_command_invalid',
  'not-implemented': 'frameleaf_studio_command_not_implemented',
  'stale-revision': 'frameleaf_studio_command_stale',
  forbidden: 'frameleaf_studio_forbidden_body',
  'lease-lost': 'frameleaf_studio_command_lease_lost',
  offline: 'frameleaf_studio_offline_body',
  'capability-missing': 'frameleaf_studio_unavailable_body',
  failed: 'frameleaf_studio_command_failed',
};

export const studioCommandRejection = (
  idempotencyKey: string,
  reason: StudioCommandRejectionReason,
  revision?: number,
): StudioCommandResult => ({
  status: 'rejected',
  idempotencyKey,
  reason,
  messageKey: rejectionMessageKeys[reason],
  ...(revision !== undefined && { revision }),
});

/**
 * Shape check for an envelope arriving from the engine. It deliberately does not validate
 * payload semantics (a clip id that exists, a time inside the sequence): those belong to
 * the story that implements the command, where the graph is in hand. This is the boundary
 * guard that stops a malformed or unknown message from ever reaching a service.
 */
export const isStudioCommandEnvelope = (value: unknown): value is StudioCommandEnvelope => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    isStudioCommandId(candidate.id) &&
    !!candidate.payload &&
    typeof candidate.payload === 'object' &&
    typeof candidate.revision === 'number' &&
    Number.isSafeInteger(candidate.revision) &&
    candidate.revision >= 0 &&
    typeof candidate.idempotencyKey === 'string' &&
    candidate.idempotencyKey.length > 0 &&
    candidate.idempotencyKey.length <= 128 &&
    typeof candidate.issuedAt === 'number' &&
    Number.isFinite(candidate.issuedAt)
  );
};

const randomKey = () =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export const createStudioCommandEnvelope = <Id extends StudioCommandId>(
  id: Id,
  payload: StudioCommandPayloads[Id],
  revision: number,
  options: { idempotencyKey?: string; issuedAt?: number } = {},
): StudioCommandEnvelope<Id> => ({
  id,
  payload,
  revision,
  idempotencyKey: options.idempotencyKey ?? randomKey(),
  issuedAt: options.issuedAt ?? Date.now(),
});
