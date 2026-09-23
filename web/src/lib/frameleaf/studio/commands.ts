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
 * The list is modelled on the prototype's project model,
 * `design/frameleaf/template/src/studio-project.mjs`, which the September 22, 2026
 * revision names as the interaction contract for the host. Each registry row records the
 * prototype function it came from so the production implementation can be read against
 * its specification. The prototype is design evidence: the production graph stays
 * Freecut's, so `payload` shapes here describe *intent* (which clip, which track, which
 * time), never a serialized graph.
 *
 * FL-88 defines and validates the vocabulary and routes it; it does not implement the
 * editing semantics. Every row whose `owner` is not FL-88 is a typed extension point: the
 * bridge accepts the envelope, validates it and returns a `not-implemented` rejection
 * until that story lands. Nothing here silently no-ops.
 */

/* ------------------------------------------------------------------ */
/* Identifiers                                                          */
/* ------------------------------------------------------------------ */

export const studioCommandIds = [
  // Clips
  'clip.add',
  'clip.move',
  'clip.trimStart',
  'clip.trimEnd',
  'clip.split',
  'clip.delete',
  'clip.update',
  'clip.reorder',
  'clip.setSpeed',
  'clip.setTransition',
  'clip.setKenBurns',
  'clip.setGrade',
  // Tracks
  'track.set',
  // Authored clips
  'title.add',
  'music.add',
  'voiceover.add',
  // Sequence
  'captions.set',
  'sequence.setFields',
  'sequence.setActive',
  // Review
  'review.add',
  'review.update',
  'review.remove',
  // Project
  'project.rename',
  'project.setSettings',
  // Jobs
  'job.enqueueExport',
  'job.enqueueRestoration',
] as const;

export type StudioCommandId = (typeof studioCommandIds)[number];

const commandIdSet: ReadonlySet<string> = new Set<string>(studioCommandIds);

export const isStudioCommandId = (value: unknown): value is StudioCommandId =>
  typeof value === 'string' && commandIdSet.has(value);

/* ------------------------------------------------------------------ */
/* Payloads                                                             */
/* ------------------------------------------------------------------ */

/** Seconds on the sequence timeline. Rational timing extensions stay in the graph. */
export type StudioTime = number;

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
  durationSeconds: number;
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

export interface StudioCaptionLine {
  id?: string;
  start: StudioTime;
  end: StudioTime;
  text: string;
}

export interface StudioCommandPayloads {
  'clip.add': { trackId: string; assetId: string; at: StudioTime; kind?: string; durationSeconds?: number };
  'clip.move': { clipId: string; start: StudioTime; trackId?: string };
  'clip.trimStart': { clipId: string; start: StudioTime } & StudioRippleOption;
  'clip.trimEnd': { clipId: string; end: StudioTime } & StudioRippleOption;
  'clip.split': { at: StudioTime; clipIds?: string[] };
  'clip.delete': { clipId: string } & StudioRippleOption;
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
      transform?: { x?: number; y?: number; scale?: number; rotation?: number; opacity?: number };
    };
  };
  'clip.reorder': { trackId: string; clipId: string; index: number };
  'clip.setSpeed': { clipId: string; speed: number };
  'clip.setTransition': { clipId: string; transition: StudioTransitionIntent | null };
  'clip.setKenBurns': { clipId: string; kenBurns: { from: StudioRect; to: StudioRect } | null };
  'clip.setGrade': { clipId: string; grade: StudioGradeIntent | null };
  'track.set': { trackId: string; patch: { name?: string; muted?: boolean; locked?: boolean; solo?: boolean; gain?: number } };
  'title.add': { at: StudioTime; text: string; durationSeconds?: number; style?: string; position?: string; animation?: string };
  'music.add': { musicId: string; at: StudioTime; durationSeconds?: number; volume?: number };
  'voiceover.add': { at: StudioTime; durationSeconds: number; uploadId: string };
  'captions.set': { captions: StudioCaptionLine[] };
  'sequence.setFields': { name?: string; captionLanguage?: string; captionsBurnIn?: boolean };
  'sequence.setActive': { sequenceId: string };
  'review.add': { time: StudioTime; text: string };
  'review.update': { commentId: string; patch: { text?: string; resolved?: boolean } };
  'review.remove': { commentId: string };
  'project.rename': { name: string };
  'project.setSettings': { patch: { mode?: 'basic' | 'advanced'; guides?: boolean; loop?: boolean; ducking?: boolean } };
  'job.enqueueExport': {
    sequenceId: string;
    format: string;
    colour: string;
    resolution: string;
    destinationId: string;
  };
  'job.enqueueRestoration': {
    mode: string;
    upscale: number;
    preview: boolean;
    destinationId: string;
  };
}

export type StudioCommand = {
  [Id in StudioCommandId]: { id: Id; payload: StudioCommandPayloads[Id] };
}[StudioCommandId];

/* ------------------------------------------------------------------ */
/* Registry                                                             */
/* ------------------------------------------------------------------ */

export type StudioCommandScope = 'clip' | 'track' | 'sequence' | 'project' | 'review' | 'job';

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
  /** The function in `design/frameleaf/template/src/studio-project.mjs` that specifies it. */
  prototypeSource: string;
}

export const studioCapabilityIds = ['gpuWorker', 'renderWorker', 'restorationWorker', 'transcriptionWorker'] as const;
export type StudioCapabilityId = (typeof studioCapabilityIds)[number];

const define = (definition: StudioCommandDefinition): [StudioCommandId, StudioCommandDefinition] => [
  definition.id,
  definition,
];

export const studioCommandRegistry: ReadonlyMap<StudioCommandId, StudioCommandDefinition> = new Map([
  define({ id: 'clip.add', scope: 'clip', mutatesGraph: true, undoable: true, owner: 'FL-94', prototypeSource: 'addClip' }),
  define({ id: 'clip.move', scope: 'clip', mutatesGraph: true, undoable: true, owner: 'FL-94', prototypeSource: 'moveClip' }),
  define({
    id: 'clip.trimStart',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-94',
    prototypeSource: 'trimClipStart',
  }),
  define({
    id: 'clip.trimEnd',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-94',
    prototypeSource: 'trimClipEnd',
  }),
  define({ id: 'clip.split', scope: 'clip', mutatesGraph: true, undoable: true, owner: 'FL-94', prototypeSource: 'splitClipAt' }),
  define({ id: 'clip.delete', scope: 'clip', mutatesGraph: true, undoable: true, owner: 'FL-94', prototypeSource: 'deleteClip' }),
  define({ id: 'clip.update', scope: 'clip', mutatesGraph: true, undoable: true, owner: 'FL-94', prototypeSource: 'updateClip' }),
  define({ id: 'clip.reorder', scope: 'clip', mutatesGraph: true, undoable: true, owner: 'FL-94', prototypeSource: 'reorder' }),
  define({ id: 'clip.setSpeed', scope: 'clip', mutatesGraph: true, undoable: true, owner: 'FL-94', prototypeSource: 'setSpeed' }),
  define({
    id: 'clip.setTransition',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-94',
    prototypeSource: 'setTransition',
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
    id: 'clip.setGrade',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-98',
    prototypeSource: 'normalizeGrade via updateClip',
  }),
  define({ id: 'track.set', scope: 'track', mutatesGraph: true, undoable: true, owner: 'FL-94', prototypeSource: 'setTrack' }),
  define({ id: 'title.add', scope: 'clip', mutatesGraph: true, undoable: true, owner: 'FL-94', prototypeSource: 'addTitle' }),
  define({ id: 'music.add', scope: 'clip', mutatesGraph: true, undoable: true, owner: 'FL-94', prototypeSource: 'addMusic' }),
  define({
    id: 'voiceover.add',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-94',
    prototypeSource: 'addVoiceover',
  }),
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
    id: 'sequence.setFields',
    scope: 'sequence',
    mutatesGraph: true,
    undoable: true,
    owner: 'FL-94',
    prototypeSource: 'setSequenceFields',
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
    id: 'review.add',
    scope: 'review',
    mutatesGraph: true,
    undoable: false,
    owner: 'FL-94',
    prototypeSource: 'addReviewComment',
  }),
  define({
    id: 'review.update',
    scope: 'review',
    mutatesGraph: true,
    undoable: false,
    owner: 'FL-94',
    prototypeSource: 'updateReviewComment',
  }),
  define({
    id: 'review.remove',
    scope: 'review',
    mutatesGraph: true,
    undoable: false,
    owner: 'FL-94',
    prototypeSource: 'removeReviewComment',
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
    id: 'project.setSettings',
    scope: 'project',
    mutatesGraph: true,
    undoable: false,
    owner: 'FL-94',
    prototypeSource: 'setSettings',
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
    id: 'job.enqueueRestoration',
    scope: 'job',
    mutatesGraph: false,
    undoable: false,
    requiresCapability: 'restorationWorker',
    owner: 'FL-110',
    prototypeSource: 'estimateRender via RestorePanel',
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
      messageKey: string;
      /** Populated for `stale-revision` so the editor can reconcile. */
      revision?: number;
    };

const rejectionMessageKeys: Record<StudioCommandRejectionReason, string> = {
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
  ...(revision === undefined ? {} : { revision }),
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
    Number.isInteger(candidate.revision) &&
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
