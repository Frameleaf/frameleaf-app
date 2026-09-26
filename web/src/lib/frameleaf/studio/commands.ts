import type { Translations } from 'svelte-i18n';
/**
 * The canonical Studio command vocabulary (FL-88 host boundary, FL-92 contract).
 *
 * The React editor never mutates a project directly and never calls the API. Every
 * change it wants leaves the engine as a `StudioCommandEnvelope` on the typed bridge the
 * Svelte host owns, which is the single place authorization, revision checking and
 * idempotency can be enforced. This module is the vocabulary half of that bridge: the
 * identifiers, their payload shapes and a registry that says, per command, whether it
 * mutates the graph, whether it is undoable, whether it needs the project lease and which
 * later story owns its semantics.
 *
 * FL-92 published the complete catalogue: the file is generated-adjacent, not free-form.
 * `studio/frameleaf-studio-commands.json` is the single source, `scripts/frameleaf-studio-commands.mjs`
 * writes it together with the server mirror (`server/src/utils/studio-commands.generated.ts`)
 * and the native contract (`mobile/lib/frameleaf/studio_commands.g.dart`), and the same
 * script fails CI when the ids, scopes, flags, capabilities, owners or prototype sources
 * here drift from it. Add a command there first, then mirror the row and its payload type
 * here; a row that exists in only one of the two is a build failure, not a surprise at
 * runtime.
 *
 * The catalogue is complete in two directions:
 *
 * - every mutating function of the prototype's project model,
 *   `design/frameleaf/template/src/studio-project.mjs`, which the September 22, 2026
 *   revision names as the interaction contract, has an id here; and
 * - every row of `studio/freecut-feature-manifest.json` is either reachable through a
 *   command or listed in the catalogue's `nonCommandRows` with a reason and an owner.
 *
 * The prototype is design evidence: the production graph stays Freecut's, so `payload`
 * shapes describe *intent* (which clip, which track, which time), never a serialized
 * graph. Every instant, length and cadence is an exact rational from FL-93's
 * `rational-time.ts` (`StudioTime`, `StudioDuration`, `StudioRate`), never a float: the
 * catalogue types those fields `time`, `duration` and `rate`, and they travel as a reduced
 * `{ num, den }` pair through the server mirror and the native contract. Where a payload
 * carries graph-shaped data it is typed `StudioOpaqueValue` and travels unread, so an
 * unknown Freecut field, a null, an array or a rational timing extension survives the
 * round trip through web, server and native.
 *
 * FL-88 defines and validates the vocabulary and routes it; it does not implement the
 * editing semantics. Every row whose `owner` is not FL-88 is a typed extension point: the
 * bridge accepts the envelope, validates it and returns a `not-implemented` rejection
 * until that story lands. Nothing here silently no-ops.
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
  'clip.move',
  'clip.overwrite',
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
  'text.setMotion',
  'title.add',
  'track.add',
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
 * An instant on the sequence timeline, in seconds, as an exact rational (FL-93).
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
 * A cadence or a speed multiplier, as an exact rational (FL-93): 30000/1001 for NTSC, 1/3 for
 * a third-speed clip. The same reasoning as StudioTime — a frame rate that is not exactly the
 * one the source has makes every later boundary wrong — and the published catalogue types
 * these fields `rate`.
 */
export type StudioRate = Rational;

/**
 * Graph-shaped data the host and the server carry without reading it: effect parameters,
 * masks, keyframe values, EQ stages, Lottie slots. Keeping it opaque is what makes the
 * round trip lossless for fields no Frameleaf release knows about yet.
 */
export type StudioOpaqueValue = Readonly<Record<string, unknown>>;

export interface StudioRippleOption {
  /** When true later clips on the track follow the edit. */
  ripple?: boolean;
}

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
export interface StudioSourceEdit {
  trackId: string;
  assetId: string;
  at: StudioTime;
  sourceIn: StudioTime;
  sourceOut: StudioTime;
}

export interface StudioCommandPayloads {
  'captions.set': { captions: StudioCaptionLine[] };
  'clip.add': { trackId: string; assetId: string; at: StudioTime; kind?: string; duration?: StudioDuration };
  'clip.delete': { clipId?: string; clipIds?: string[] } & StudioRippleOption;
  'clip.group': { clipIds: string[]; name?: string };
  'clip.insert': StudioSourceEdit;
  'clip.move': { clipId: string; start: StudioTime; trackId?: string };
  'clip.overwrite': StudioSourceEdit;
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
  };
  'clip.setBlendMode': { clipId: string; blendMode: string; opacity?: number };
  'clip.setCrop': { clipId: string; crop?: StudioOpaqueValue | null; cornerPin?: StudioOpaqueValue | null };
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
  'clip.split': { at: StudioTime; clipIds?: string[] };
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
  'job.enqueueInterpolation': { clipId: string; targetFps: StudioRate; destinationId: string };
  'job.enqueueMusicGeneration': {
    prompt: string;
    duration: StudioDuration;
    preset?: string;
    destinationId: string;
  };
  'job.enqueueProxy': { assetIds: string[]; destinationId: string };
  'job.enqueueRestoration': {
    mode: string;
    upscale: number;
    preview: boolean;
    destinationId: string;
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
  };
  'keyframe.update': {
    clipId: string;
    property: string;
    keyframeId: string;
    at?: StudioTime;
    value?: StudioOpaqueValue;
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
   * Ask for one frame of the current revision (FL-96).
   *
   * `at` is a `StudioTime` — FL-93's exact rational — never float seconds: a preview must
   * address the same frame the export does. The viewport is part of the frame's identity, not
   * a hint; the engine reports the size of the surface it will paint into.
   */
  'preview.request': {
    at: StudioTime;
    quality: 'draft' | 'standard' | 'full';
    viewportWidth: number;
    viewportHeight: number;
  };
  'project.applyTemplate': { templateId: string };
  /**
   * `includeMedia`: copy the media the person owns into the bundle. Shared media always travels as a
   * reference and nothing Locked is ever copied. Left out, the host asks in its export dialog.
   */
  'project.exportBundle': { sequenceIds?: string[]; includeMedia?: boolean };
  'project.importBundle': { bundleUploadId: string };
  'project.rename': { name: string };
  'project.setMasterAudio': { gainDb?: number; muted?: boolean; ducking?: boolean };
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
  'sequence.setSettings': { sequenceId: string; fps?: StudioRate; width?: number; height?: number };
  'text.setMotion': { clipId: string; motion: StudioOpaqueValue | null };
  'title.add': {
    at: StudioTime;
    text: string;
    duration?: StudioDuration;
    style?: string;
    position?: string;
    animation?: string;
  };
  'track.add': { kind: string; name?: string; index?: number };
  'track.remove': { trackId: string };
  'track.reorder': { trackId: string; index: number };
  'track.set': {
    trackId: string;
    patch: { name?: string; muted?: boolean; locked?: boolean; solo?: boolean; gain?: number };
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
  /** The Jira story that owns the semantics. FL-88 owns routing only. */
  owner: string;
  /**
   * How the command is specified: the function in
   * `design/frameleaf/template/src/studio-project.mjs` it comes from, or, for a command
   * the prototype has no counterpart for, the pinned Freecut feature it adapts.
   */
  prototypeSource: string;
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
    owner: 'FL-94',
    prototypeSource: 'setCaptions',
  }),
  define({
    id: 'clip.add',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-94',
    prototypeSource: 'addClip',
  }),
  define({
    id: 'clip.delete',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-94',
    prototypeSource: 'deleteClip',
  }),
  define({
    id: 'clip.group',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-100',
    prototypeSource: 'beyond the prototype: Freecut groups and null controllers',
  }),
  define({
    id: 'clip.insert',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-94',
    prototypeSource: 'addClip (source monitor insert edit)',
  }),
  define({
    id: 'clip.move',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-94',
    prototypeSource: 'moveClip',
  }),
  define({
    id: 'clip.overwrite',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-94',
    prototypeSource: 'addClip (source monitor overwrite edit)',
  }),
  define({
    id: 'clip.reorder',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-94',
    prototypeSource: 'reorder',
  }),
  define({
    id: 'clip.roll',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-94',
    prototypeSource: 'trimClipEnd with trimClipStart (rolling edit)',
  }),
  define({
    id: 'clip.setAudio',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-103',
    prototypeSource: 'updateClip (volume and mute)',
  }),
  define({
    id: 'clip.setBlendMode',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-99',
    prototypeSource: 'beyond the prototype: Freecut BlendMode union',
  }),
  define({
    id: 'clip.setCrop',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-98',
    prototypeSource: 'beyond the prototype: Freecut crop and corner-pin gizmos',
  }),
  define({
    id: 'clip.setGrade',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-98',
    prototypeSource: 'normalizeGrade via updateClip',
  }),
  define({
    id: 'clip.setKenBurns',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-94',
    prototypeSource: 'setKenBurns',
  }),
  define({
    id: 'clip.setLink',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-94',
    prototypeSource: 'beyond the prototype: linkId groups in the prototype clip model',
  }),
  define({
    id: 'clip.setMask',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-99',
    prototypeSource: 'beyond the prototype: Freecut clip masks and pen paths',
  }),
  define({
    id: 'clip.setSpeed',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-94',
    prototypeSource: 'setSpeed',
  }),
  define({
    id: 'clip.setTransform',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-94',
    prototypeSource: 'updateClip (transform patch)',
  }),
  define({
    id: 'clip.setTransformParent',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-100',
    prototypeSource: 'beyond the prototype: Freecut transform parenting',
  }),
  define({
    id: 'clip.setTransition',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-94',
    prototypeSource: 'setTransition',
  }),
  define({
    id: 'clip.slide',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-94',
    prototypeSource: 'moveClip (slide edit)',
  }),
  define({
    id: 'clip.slip',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-94',
    prototypeSource: 'updateClip (slip edit on the source in and out points)',
  }),
  define({
    id: 'clip.split',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-94',
    prototypeSource: 'splitClipAt',
  }),
  define({
    id: 'clip.trimEnd',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-94',
    prototypeSource: 'trimClipEnd',
  }),
  define({
    id: 'clip.trimStart',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-94',
    prototypeSource: 'trimClipStart',
  }),
  define({
    id: 'clip.ungroup',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-100',
    prototypeSource: 'beyond the prototype: Freecut groups and null controllers',
  }),
  define({
    id: 'clip.update',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-94',
    prototypeSource: 'updateClip',
  }),
  define({
    id: 'composition.add',
    scope: 'composition',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-100',
    prototypeSource: 'beyond the prototype: Freecut compound clips and nested compositions',
  }),
  define({
    id: 'composition.setControlOverrides',
    scope: 'composition',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-100',
    prototypeSource: 'beyond the prototype: Freecut composition instance overrides',
  }),
  define({
    id: 'composition.setPublishedControls',
    scope: 'composition',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-100',
    prototypeSource: 'beyond the prototype: Freecut published composition controls',
  }),
  define({
    id: 'effect.add',
    scope: 'effect',
    mutatesGraph: true,
    undoable: true,
    requiresCapability: 'gpuWorker',
    owner: 'FL-99',
    prototypeSource: 'beyond the prototype: Freecut GPU effect catalogue',
  }),
  define({
    id: 'effect.remove',
    scope: 'effect',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-99',
    prototypeSource: 'beyond the prototype: Freecut GPU effect catalogue',
  }),
  define({
    id: 'effect.reorder',
    scope: 'effect',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-99',
    prototypeSource: 'beyond the prototype: Freecut effect stack order',
  }),
  define({
    id: 'effect.update',
    scope: 'effect',
    mutatesGraph: true,
    undoable: true,
    requiresCapability: 'gpuWorker',
    owner: 'FL-99',
    prototypeSource: 'beyond the prototype: Freecut GPU effect parameters',
  }),
  define({
    id: 'history.redo',
    scope: 'history',
    mutatesGraph: true,
    undoable: false,
    owner: 'FL-94',
    prototypeSource: 'redo',
  }),
  define({
    id: 'history.undo',
    scope: 'history',
    mutatesGraph: true,
    undoable: false,
    owner: 'FL-94',
    prototypeSource: 'undo (over the commit history)',
  }),
  define({
    id: 'job.cancel',
    scope: 'job',
    mutatesGraph: false,
    undoable: false,
    owner: 'FL-104',
    prototypeSource: 'beyond the prototype: durable job cancellation',
  }),
  define({
    id: 'job.enqueueCaptioning',
    scope: 'job',
    mutatesGraph: false,
    undoable: false,
    requiresCapability: 'analysisWorker',
    owner: 'FL-111',
    prototypeSource: 'beyond the prototype: local vision-language captioning',
  }),
  define({
    id: 'job.enqueueExport',
    scope: 'job',
    mutatesGraph: false,
    undoable: false,
    requiresCapability: 'renderWorker',
    owner: 'FL-104',
    prototypeSource: 'estimateRender via ExportDialog',
  }),
  define({
    id: 'job.enqueueFillerRemoval',
    scope: 'job',
    mutatesGraph: false,
    undoable: false,
    requiresCapability: 'analysisWorker',
    owner: 'FL-103',
    prototypeSource: 'beyond the prototype: filler-word removal with review',
  }),
  define({
    id: 'job.enqueueInterpolation',
    scope: 'job',
    mutatesGraph: false,
    undoable: false,
    requiresCapability: 'restorationWorker',
    owner: 'FL-111',
    prototypeSource: 'beyond the prototype: RIFE frame interpolation',
  }),
  define({
    id: 'job.enqueueMusicGeneration',
    scope: 'job',
    mutatesGraph: false,
    undoable: false,
    requiresCapability: 'generationWorker',
    owner: 'FL-111',
    prototypeSource: 'beyond the prototype: local MusicGen generation',
  }),
  define({
    id: 'job.enqueueProxy',
    scope: 'job',
    mutatesGraph: false,
    undoable: false,
    requiresCapability: 'renderWorker',
    owner: 'FL-105',
    prototypeSource: 'beyond the prototype: proxy and waveform generation',
  }),
  define({
    id: 'job.enqueueRestoration',
    scope: 'job',
    mutatesGraph: false,
    undoable: false,
    requiresCapability: 'restorationWorker',
    owner: 'FL-110',
    prototypeSource: 'estimateRender via RestorePanel',
  }),
  define({
    id: 'job.enqueueReverseConform',
    scope: 'job',
    mutatesGraph: false,
    undoable: false,
    requiresCapability: 'renderWorker',
    owner: 'FL-111',
    prototypeSource: 'beyond the prototype: reversed media conforming',
  }),
  define({
    id: 'job.enqueueSceneDetection',
    scope: 'job',
    mutatesGraph: false,
    undoable: false,
    requiresCapability: 'analysisWorker',
    owner: 'FL-111',
    prototypeSource: 'beyond the prototype: histogram and adaptive scene detection',
  }),
  define({
    id: 'job.enqueueSilenceRemoval',
    scope: 'job',
    mutatesGraph: false,
    undoable: false,
    requiresCapability: 'analysisWorker',
    owner: 'FL-103',
    prototypeSource: 'beyond the prototype: silence removal with review',
  }),
  define({
    id: 'job.enqueueTextToSpeech',
    scope: 'job',
    mutatesGraph: false,
    undoable: false,
    requiresCapability: 'generationWorker',
    owner: 'FL-111',
    prototypeSource: 'beyond the prototype: local text-to-speech voiceovers',
  }),
  define({
    id: 'job.enqueueTranscription',
    scope: 'job',
    mutatesGraph: false,
    undoable: false,
    requiresCapability: 'transcriptionWorker',
    owner: 'FL-111',
    prototypeSource: 'sampleCaptions (simulated transcription in the prototype)',
  }),
  define({
    id: 'job.enqueueUpscale',
    scope: 'job',
    mutatesGraph: false,
    undoable: false,
    requiresCapability: 'restorationWorker',
    owner: 'FL-111',
    prototypeSource: 'beyond the prototype: Anime4K upscaling',
  }),
  define({
    id: 'keyframe.add',
    scope: 'keyframe',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-100',
    prototypeSource: 'beyond the prototype: Freecut keyframe model',
  }),
  define({
    id: 'keyframe.remove',
    scope: 'keyframe',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-100',
    prototypeSource: 'beyond the prototype: Freecut keyframe model',
  }),
  define({
    id: 'keyframe.setEasing',
    scope: 'keyframe',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-100',
    prototypeSource: 'beyond the prototype: Freecut easing presets and tangents',
  }),
  define({
    id: 'keyframe.update',
    scope: 'keyframe',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-100',
    prototypeSource: 'beyond the prototype: Freecut graph editor and dopesheet',
  }),
  define({
    id: 'lottie.update',
    scope: 'media',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-105',
    prototypeSource: 'beyond the prototype: Lottie colour, text and slot editing',
  }),
  define({
    id: 'marker.add',
    scope: 'sequence',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-94',
    prototypeSource: 'beyond the prototype: sequence markers',
  }),
  define({
    id: 'marker.remove',
    scope: 'sequence',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-94',
    prototypeSource: 'beyond the prototype: sequence markers',
  }),
  define({
    id: 'marker.update',
    scope: 'sequence',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-94',
    prototypeSource: 'beyond the prototype: sequence markers',
  }),
  define({
    id: 'media.import',
    scope: 'media',
    mutatesGraph: true,
    undoable: false,
    owner: 'FL-105',
    prototypeSource: 'beyond the prototype: project media bin',
  }),
  define({
    id: 'media.relink',
    scope: 'media',
    mutatesGraph: true,
    undoable: false,
    owner: 'FL-105',
    prototypeSource: 'beyond the prototype: media relinking',
  }),
  define({
    id: 'media.remove',
    scope: 'media',
    mutatesGraph: true,
    undoable: false,
    owner: 'FL-105',
    prototypeSource: 'beyond the prototype: project media bin',
  }),
  define({
    id: 'music.add',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-94',
    prototypeSource: 'addMusic',
  }),
  define({
    id: 'preview.release',
    scope: 'preview',
    mutatesGraph: false,
    undoable: false,
    owner: 'FL-96',
    prototypeSource: 'Studio.jsx preview monitor',
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
    owner: 'FL-96',
    prototypeSource: 'Studio.jsx preview monitor',
  }),
  define({
    id: 'project.applyTemplate',
    scope: 'project',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-94',
    prototypeSource: 'beyond the prototype: project templates',
  }),
  define({
    id: 'project.exportBundle',
    scope: 'project',
    mutatesGraph: false,
    undoable: false,
    owner: 'FL-91',
    prototypeSource: 'beyond the prototype: portable project bundles',
  }),
  define({
    id: 'project.importBundle',
    scope: 'project',
    mutatesGraph: true,
    undoable: false,
    owner: 'FL-91',
    prototypeSource: 'beyond the prototype: portable project bundles',
  }),
  define({
    id: 'project.rename',
    scope: 'project',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-94',
    prototypeSource: 'renameProject',
  }),
  define({
    id: 'project.setMasterAudio',
    scope: 'project',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-103',
    prototypeSource: 'beyond the prototype: project master bus',
  }),
  define({
    id: 'project.setSettings',
    scope: 'project',
    mutatesGraph: true,
    undoable: false,
    owner: 'FL-94',
    prototypeSource: 'setSettings',
  }),
  define({
    id: 'property.bakeModifier',
    scope: 'keyframe',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-100',
    prototypeSource: 'beyond the prototype: procedural motion modifiers',
  }),
  define({
    id: 'property.setExpression',
    scope: 'keyframe',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-100',
    prototypeSource: 'beyond the prototype: property expressions',
  }),
  define({
    id: 'property.setModifier',
    scope: 'keyframe',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-100',
    prototypeSource: 'beyond the prototype: procedural motion modifiers',
  }),
  define({
    /**
     * Not a graph change, for all three review rows: FL-89 stores comments beside the graph,
     * against the revision the reviewer was looking at. A reviewer holds no lease and may be a
     * revision behind, and neither may stop them commenting. Not undoable either: a comment is
     * a shared record other people may already have read, removed explicitly, not by undo.
     */
    id: 'review.add',
    scope: 'review',
    mutatesGraph: false,
    undoable: false,
    owner: 'FL-94',
    prototypeSource: 'addReviewComment',
  }),
  define({
    id: 'review.remove',
    scope: 'review',
    mutatesGraph: false,
    undoable: false,
    owner: 'FL-94',
    prototypeSource: 'removeReviewComment',
  }),
  define({
    id: 'review.update',
    scope: 'review',
    mutatesGraph: false,
    undoable: false,
    owner: 'FL-94',
    prototypeSource: 'updateReviewComment',
  }),
  define({
    id: 'sequence.add',
    scope: 'sequence',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-94',
    prototypeSource: 'beyond the prototype: the prototype ships two fixed sequences',
  }),
  define({
    id: 'sequence.duplicate',
    scope: 'sequence',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-94',
    prototypeSource: 'beyond the prototype: the prototype ships two fixed sequences',
  }),
  define({
    id: 'sequence.remove',
    scope: 'sequence',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-94',
    prototypeSource: 'beyond the prototype: the prototype ships two fixed sequences',
  }),
  define({
    // The active sequence is stored on the project, so switching it is a graph change even
    // though it is not on the undo stack.
    id: 'sequence.setActive',
    scope: 'sequence',
    mutatesGraph: true,
    undoable: false,
    owner: 'FL-94',
    prototypeSource: 'setActiveSequence',
  }),
  define({
    id: 'sequence.setFields',
    scope: 'sequence',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-94',
    prototypeSource: 'setSequenceFields',
  }),
  define({
    id: 'sequence.setSettings',
    scope: 'sequence',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-94',
    prototypeSource: 'beyond the prototype: canvas and frame rate are fixed there',
  }),
  define({
    id: 'text.setMotion',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-100',
    prototypeSource: 'beyond the prototype: per-character motion text',
  }),
  define({
    id: 'title.add',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-94',
    prototypeSource: 'addTitle',
  }),
  define({
    id: 'track.add',
    scope: 'track',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-94',
    prototypeSource: 'beyond the prototype: its six track kinds are fixed',
  }),
  define({
    id: 'track.remove',
    scope: 'track',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-94',
    prototypeSource: 'beyond the prototype: its six track kinds are fixed',
  }),
  define({
    id: 'track.reorder',
    scope: 'track',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-94',
    prototypeSource: 'beyond the prototype: its track order is fixed',
  }),
  define({
    id: 'track.set',
    scope: 'track',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-94',
    prototypeSource: 'setTrack',
  }),
  define({
    id: 'track.setAudio',
    scope: 'track',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-103',
    prototypeSource: 'setTrack (gain only in the prototype)',
  }),
  define({
    id: 'voiceover.add',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-94',
    prototypeSource: 'addVoiceover',
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

/**
 * Commands FL-88 itself applies end to end. It owns routing, not editing semantics, so
 * this is currently empty by design: every row belongs to a later story and is a typed
 * extension point. The bridge uses it to catch a registry that claims ownership without a
 * handler, which would otherwise look like a silent no-op.
 */
export const isStudioCommandImplemented = (id: StudioCommandId): boolean =>
  studioCommandDefinition(id).owner === 'FL-88';

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
