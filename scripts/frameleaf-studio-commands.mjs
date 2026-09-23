#!/usr/bin/env node

/**
 * The canonical Studio command catalogue and its generated contracts (FL-92, `STU-205`).
 *
 * One table in this file is the source of truth for the Studio command vocabulary. From it
 * this script writes two checked-in artifacts, so web and server cannot drift:
 *
 *   studio/frameleaf-studio-commands.json          the published catalogue
 *   server/src/utils/studio-commands.generated.ts  the server envelope mirror
 *
 * `--check` (the default, and what CI runs) regenerates everything in memory and fails when
 * a checked-in file differs, when the TypeScript vocabulary in
 * `web/src/lib/frameleaf/studio/commands.ts` drifts from the table, when a mutating command
 * in the prototype's project model has no command id, or when a row of the pinned Freecut
 * feature manifest is neither mapped to a command nor declared as a non-command row.
 *
 * What this script does NOT do: implement a command. Every row names the story that owns
 * its semantics; until that story lands the bridge answers `not-implemented`.
 *
 * Sources:
 *   - `design/frameleaf/template/src/studio-project.mjs` — the prototype's project model,
 *     the interaction contract named by the September 22, 2026 revision.
 *   - `studio/freecut-feature-manifest.json` — the 210 pinned Freecut feature rows.
 *   - `docs/docs/developer/frameleaf-plan/freecut-issue-map.json` — the delivery plan id
 *     for each of those rows; `deliveryPlanIds` is computed from it, never hand-written.
 */

import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

export const SCHEMA_VERSION = 1;
export const ENGINE = 'freecut';
export const ENGINE_REVISION = '4d62e8082c5eb387a96275bcbd323d28f6e41a62';

export const GENERATOR = 'scripts/frameleaf-studio-commands.mjs';
export const CATALOGUE_PATH = 'studio/frameleaf-studio-commands.json';
export const SERVER_MIRROR_PATH = 'server/src/utils/studio-commands.generated.ts';
export const NATIVE_CONTRACT_PATH = 'mobile/lib/frameleaf/studio_commands.g.dart';
export const MANIFEST_PATH = 'studio/freecut-feature-manifest.json';
export const ISSUE_MAP_PATH = 'docs/docs/developer/frameleaf-plan/freecut-issue-map.json';
export const PROTOTYPE_PATH = 'design/frameleaf/template/src/studio-project.mjs';
export const WEB_VOCABULARY_PATH = 'web/src/lib/frameleaf/studio/commands.ts';

/** Scopes a command may act on. Ordered for the generated enums. */
/**
 * The only commands allowed to carry no payload: signals that change nothing in the project.
 * Listed by name so a new command cannot become payload-less by accident.
 */
export const EMPTY_PAYLOAD_COMMANDS = ['preview.release'];

export const SCOPES = [
  'clip',
  'composition',
  'effect',
  'history',
  'job',
  'keyframe',
  'media',
  'preview',
  'project',
  'review',
  'sequence',
  'track',
];

/**
 * Worker capabilities a command may require. Library browsing and the quick editor stay
 * GPU-free; only these rows depend on a worker being admitted.
 */
export const CAPABILITIES = [
  'analysisWorker',
  'generationWorker',
  'gpuWorker',
  'renderWorker',
  'restorationWorker',
  'transcriptionWorker',
];

/**
 * Payload field types. A `?` suffix on a field marks it optional.
 *
 * `time`, `duration` and `rate` are exact rationals, never floats (FL-93 / `VID-102`): an
 * instant on the timeline, a length, and a cadence or speed multiplier. They travel as a
 * reduced `{ num, den }` pair of integers, which is the only representation in which an
 * NTSC boundary the person set is the boundary the encoder is asked for. The web side
 * types them `StudioTime`, `StudioDuration` and `StudioRate` over `Rational`; the native
 * contract spells the same pair with named integer fields.
 *
 * `object` and `object[]` are deliberately opaque: a payload carries *intent*, and any
 * graph-shaped value inside it round-trips unread so an unknown Freecut field, a null, an
 * array or a rational timing extension survives web, server and native.
 */
export const FIELD_TYPES = [
  'boolean',
  'duration',
  'number',
  'object',
  'object[]',
  'rate',
  'string',
  'string[]',
  'time',
];

const manifestRange = (prefix, ids) => ids.map((id) => `${prefix}${id}`);

const EFFECT_ROWS = manifestRange('effect.gpu-', [
  'gaussian-blur',
  'box-blur',
  'motion-blur',
  'radial-blur',
  'zoom-blur',
  'brightness',
  'contrast',
  'exposure',
  'hue-shift',
  'invert',
  'levels',
  'saturation',
  'temperature',
  'grayscale',
  'sepia',
  'curves',
  'color-wheels',
  'secondary-qualifier',
  'power-window',
  'vibrance',
  'gradient-map',
  'pixelate',
  'rgb-split',
  'twirl',
  'wave',
  'trigger-wave',
  'bulge',
  'kaleidoscope',
  'mirror',
  'fluted-glass',
  'ripple-glass',
  'glass-mosaic',
  'blocks',
  'droste',
  'chroma-key',
  'lut',
  'vignette',
  'grain',
  'sharpen',
  'posterize',
  'glow',
  'edge-detect',
  'scanlines',
  'color-glitch',
  'block-glitch',
  'crt',
  'halftone',
  'dither',
  'ascii',
  'threshold',
  'vhs',
  'ink',
  'pixel-sort',
  'pixel-sort-hq',
]);

const TRANSITION_ROWS = manifestRange('transition.', [
  'chromatic',
  'clockWipe',
  'additiveDissolve',
  'blurDissolve',
  'dipToColorDissolve',
  'nonAdditiveDissolve',
  'smoothCut',
  'dissolve',
  'fade',
  'filmGateSlip',
  'flip',
  'glitch',
  'iris',
  'lensWarpZoom',
  'lightLeakBurn',
  'liquidDistort',
  'pixelate',
  'radialBlur',
  'slide',
  'sparkles',
  'wipe',
]);

const BLEND_ROWS = manifestRange('blend.', [
  'normal',
  'dissolve',
  'darken',
  'multiply',
  'color-burn',
  'linear-burn',
  'lighten',
  'screen',
  'color-dodge',
  'linear-dodge',
  'overlay',
  'soft-light',
  'hard-light',
  'vivid-light',
  'linear-light',
  'pin-light',
  'hard-mix',
  'difference',
  'exclusion',
  'subtract',
  'divide',
  'hue',
  'saturation',
  'color',
  'luminosity',
]);

/**
 * The catalogue. One row per command.
 *
 * - `prototypeFunctions` names the exported functions of the prototype project model this
 *   command is specified by; `prototypeSource` is the human sentence the TypeScript
 *   registry repeats. A command with no prototype counterpart says so in `prototypeSource`
 *   and keeps `prototypeFunctions` empty.
 * - `manifestIds` names the pinned Freecut feature rows this command is the way to reach.
 *   An empty list means the command is a Frameleaf addition with no upstream row (project
 *   review, restoration, effect stack order): the check reports them rather than inventing
 *   a mapping.
 * - `owner` is the story that owns the *semantics*. FL-92 owns this vocabulary only.
 */
export const catalogue = [
  {
    id: 'captions.set',
    scope: 'sequence',
    mutatesGraph: true,
    undoable: true,
    capability: 'transcriptionWorker',
    owner: 'FL-94',
    prototypeFunctions: ['setCaptions'],
    prototypeSource: 'setCaptions',
    manifestIds: ['readme.local-ai-analysis.1'],
    payload: { captions: 'object[]' },
    description: 'Replace the sequence caption list with a validated, time-ordered set.',
  },
  {
    id: 'clip.add',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    prototypeFunctions: ['addClip'],
    prototypeSource: 'addClip',
    manifestIds: ['command.addItem', 'readme.timeline-editing.1'],
    payload: {
      trackId: 'string',
      assetId: 'string',
      at: 'time',
      kind: 'string?',
      duration: 'duration?',
    },
    description: 'Place library media on a track at a time, linking its camera audio.',
  },
  {
    id: 'clip.delete',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    prototypeFunctions: ['deleteClip'],
    prototypeSource: 'deleteClip',
    manifestIds: ['command.removeItems', 'readme.timeline-editing.5'],
    payload: { clipId: 'string?', clipIds: 'string[]?', ripple: 'boolean?' },
    description: 'Remove one clip or a selection with its linked clips, optionally closing the gap.',
  },
  {
    id: 'clip.group',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-100',
    prototypeFunctions: [],
    prototypeSource: 'beyond the prototype: Freecut groups and null controllers',
    manifestIds: ['extra.compose'],
    payload: { clipIds: 'string[]', name: 'string?' },
    description: 'Group selected clips so transforms and keyframes apply to them together.',
  },
  {
    id: 'clip.insert',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    prototypeFunctions: ['addClip'],
    prototypeSource: 'addClip (source monitor insert edit)',
    manifestIds: ['readme.timeline-editing.7', 'readme.local-ai-analysis.4'],
    payload: {
      trackId: 'string',
      assetId: 'string',
      at: 'time',
      sourceIn: 'time',
      sourceOut: 'time',
    },
    description: 'Insert a marked source range at the playhead, rippling later clips right.',
  },
  {
    id: 'clip.move',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    prototypeFunctions: ['moveClip'],
    prototypeSource: 'moveClip',
    manifestIds: ['command.moveItem'],
    payload: { clipId: 'string', start: 'time', trackId: 'string?' },
    description: 'Move a clip and its linked clips to another time, and optionally another track.',
  },
  {
    id: 'clip.overwrite',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    prototypeFunctions: ['addClip'],
    prototypeSource: 'addClip (source monitor overwrite edit)',
    manifestIds: ['readme.timeline-editing.7'],
    payload: {
      trackId: 'string',
      assetId: 'string',
      at: 'time',
      sourceIn: 'time',
      sourceOut: 'time',
    },
    description: 'Overwrite the track at the playhead with a marked source range.',
  },
  {
    id: 'clip.reorder',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    prototypeFunctions: ['reorder'],
    prototypeSource: 'reorder',
    manifestIds: ['readme.timeline-editing.5'],
    payload: { trackId: 'string', clipId: 'string', index: 'number' },
    description: 'Move a clip to another index on its track; the track re-flows contiguously.',
  },
  {
    id: 'clip.roll',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    prototypeFunctions: ['trimClipEnd', 'trimClipStart'],
    prototypeSource: 'trimClipEnd with trimClipStart (rolling edit)',
    manifestIds: ['readme.timeline-editing.3', 'readme.preview-playback.4'],
    payload: { clipId: 'string', at: 'time' },
    description: 'Move the cut between two adjacent clips without changing the sequence length.',
  },
  {
    id: 'clip.setAudio',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-103',
    prototypeFunctions: ['updateClip'],
    prototypeSource: 'updateClip (volume and mute)',
    manifestIds: ['readme.audio.1', 'readme.audio.2', 'readme.audio.3'],
    payload: {
      clipId: 'string',
      volume: 'number?',
      muted: 'boolean?',
      fadeIn: 'duration?',
      fadeOut: 'duration?',
      pitchSemitones: 'number?',
      pitchCents: 'number?',
      eq: 'object?',
    },
    description: 'Set clip volume, mute, fades, pitch shift and the clip EQ stage.',
  },
  {
    id: 'clip.setBlendMode',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-99',
    prototypeFunctions: [],
    prototypeSource: 'beyond the prototype: Freecut BlendMode union',
    manifestIds: ['readme.effects-masks-compositing.6', ...BLEND_ROWS],
    payload: { clipId: 'string', blendMode: 'string', opacity: 'number?' },
    description: 'Set the clip blend mode and compositing opacity.',
  },
  {
    id: 'clip.setCrop',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-98',
    prototypeFunctions: [],
    prototypeSource: 'beyond the prototype: Freecut crop and corner-pin gizmos',
    manifestIds: ['readme.preview-playback.1'],
    payload: { clipId: 'string', crop: 'object?', cornerPin: 'object?' },
    description: 'Set the crop rectangle and corner-pin quad edited with the preview gizmos.',
  },
  {
    id: 'clip.setGrade',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-98',
    prototypeFunctions: ['updateClip'],
    prototypeSource: 'normalizeGrade via updateClip',
    manifestIds: ['extra.color-workspace'],
    payload: { clipId: 'string', grade: 'object?' },
    description: 'Set the colour grade: look, intensity, primaries and the three colour wheels.',
  },
  {
    id: 'clip.setKenBurns',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    prototypeFunctions: ['setKenBurns'],
    prototypeSource: 'setKenBurns',
    manifestIds: ['readme.keyframe-animation.6'],
    payload: { clipId: 'string', kenBurns: 'object?' },
    description: 'Set the from and to rectangles of a still clip, or clear the move.',
  },
  {
    id: 'clip.setLink',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    prototypeFunctions: [],
    prototypeSource: 'beyond the prototype: linkId groups in the prototype clip model',
    manifestIds: ['readme.timeline-editing.3'],
    payload: { clipIds: 'string[]', linked: 'boolean' },
    description: 'Link or unlink audio and video clips so later edits move them together.',
  },
  {
    id: 'clip.setMask',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-99',
    prototypeFunctions: [],
    prototypeSource: 'beyond the prototype: Freecut clip masks and pen paths',
    manifestIds: ['readme.effects-masks-compositing.7'],
    payload: { clipId: 'string', mask: 'object?' },
    description: 'Set or clear the clip mask, including pen path geometry.',
  },
  {
    id: 'clip.setSpeed',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    prototypeFunctions: ['setSpeed'],
    prototypeSource: 'setSpeed',
    manifestIds: ['readme.timeline-editing.3'],
    payload: { clipId: 'string', speed: 'rate' },
    description: 'Rate-stretch a bounded clip and its linked clips to a new speed.',
  },
  {
    id: 'clip.setTransform',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    prototypeFunctions: ['updateClip'],
    prototypeSource: 'updateClip (transform patch)',
    manifestIds: ['command.setTransform', 'readme.preview-playback.1'],
    payload: { clipId: 'string', transform: 'object' },
    description: 'Set position, scale, rotation and opacity for a clip.',
  },
  {
    id: 'clip.setTransformParent',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-100',
    prototypeFunctions: [],
    prototypeSource: 'beyond the prototype: Freecut transform parenting',
    manifestIds: ['command.setTransformParent', 'extra.parenting'],
    payload: { clipId: 'string', parentId: 'string?' },
    description: 'Parent a clip transform to another clip, or clear the pick-whip link.',
  },
  {
    id: 'clip.setTransition',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    prototypeFunctions: ['setTransition'],
    prototypeSource: 'setTransition',
    manifestIds: [
      'command.addTransition',
      'command.updateTransition',
      'command.removeTransition',
      'readme.timeline-editing.4',
      'readme.transitions.1',
      'readme.transitions.2',
      'readme.transitions.3',
      ...TRANSITION_ROWS,
    ],
    payload: { clipId: 'string', transition: 'object?' },
    description: 'Add, retime, realign or remove the transition at the cut before a clip.',
  },
  {
    id: 'clip.slide',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    prototypeFunctions: ['moveClip'],
    prototypeSource: 'moveClip (slide edit)',
    manifestIds: ['readme.timeline-editing.3', 'readme.preview-playback.4'],
    payload: { clipId: 'string', delta: 'duration' },
    description: 'Slide a clip along the track, trimming its neighbours instead of rippling.',
  },
  {
    id: 'clip.slip',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    prototypeFunctions: ['updateClip'],
    prototypeSource: 'updateClip (slip edit on the source in and out points)',
    manifestIds: ['readme.timeline-editing.3', 'readme.preview-playback.4'],
    payload: { clipId: 'string', delta: 'duration' },
    description: 'Slip the source range inside a clip without moving the clip.',
  },
  {
    id: 'clip.split',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    prototypeFunctions: ['splitClipAt'],
    prototypeSource: 'splitClipAt',
    manifestIds: ['command.split'],
    payload: { at: 'time', clipIds: 'string[]?' },
    description: 'Split clips at a time, carrying linked clips and Ken Burns geometry across.',
  },
  {
    id: 'clip.trimEnd',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    prototypeFunctions: ['trimClipEnd'],
    prototypeSource: 'trimClipEnd',
    manifestIds: ['command.trimEnd'],
    payload: { clipId: 'string', end: 'time', ripple: 'boolean?' },
    description: 'Trim a clip out point, optionally rippling the rest of the track.',
  },
  {
    id: 'clip.trimStart',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    prototypeFunctions: ['trimClipStart'],
    prototypeSource: 'trimClipStart',
    manifestIds: ['command.trimStart'],
    payload: { clipId: 'string', start: 'time', ripple: 'boolean?' },
    description: 'Trim a clip in point, optionally rippling the rest of the track.',
  },
  {
    id: 'clip.ungroup',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-100',
    prototypeFunctions: [],
    prototypeSource: 'beyond the prototype: Freecut groups and null controllers',
    manifestIds: [],
    payload: { groupId: 'string' },
    description: 'Dissolve a group, leaving its clips in place.',
  },
  {
    id: 'clip.update',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    prototypeFunctions: ['updateClip'],
    prototypeSource: 'updateClip',
    manifestIds: ['command.updateItem'],
    payload: { clipId: 'string', patch: 'object' },
    description: 'Patch clip fields the narrower commands do not own: name, text, style, position.',
  },
  {
    id: 'composition.add',
    scope: 'composition',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-100',
    prototypeFunctions: [],
    prototypeSource: 'beyond the prototype: Freecut compound clips and nested compositions',
    manifestIds: [
      'command.addClip',
      'extra.compose',
      'readme.timeline-editing.1',
      'readme.timeline-editing.2',
    ],
    payload: {
      name: 'string',
      clipIds: 'string[]?',
      trackId: 'string?',
      at: 'time?',
    },
    description: 'Create a compound clip from a selection and place it, openable as its own sequence.',
  },
  {
    id: 'composition.setControlOverrides',
    scope: 'composition',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-100',
    prototypeFunctions: [],
    prototypeSource: 'beyond the prototype: Freecut composition instance overrides',
    manifestIds: [],
    payload: { compositionClipId: 'string', overrides: 'object' },
    description: 'Override published control values on one instance of a composition.',
  },
  {
    id: 'composition.setPublishedControls',
    scope: 'composition',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-100',
    prototypeFunctions: [],
    prototypeSource: 'beyond the prototype: Freecut published composition controls',
    manifestIds: ['extra.published-controls'],
    payload: { compositionId: 'string', controls: 'object[]' },
    description: 'Publish the controls a composition exposes to its instances.',
  },
  {
    id: 'effect.add',
    scope: 'effect',
    mutatesGraph: true,
    undoable: true,
    capability: 'gpuWorker',
    owner: 'FL-99',
    prototypeFunctions: [],
    prototypeSource: 'beyond the prototype: Freecut GPU effect catalogue',
    manifestIds: [
      'command.addEffect',
      'readme.effects-masks-compositing.1',
      'readme.effects-masks-compositing.2',
      'readme.effects-masks-compositing.3',
      'readme.effects-masks-compositing.4',
      'readme.effects-masks-compositing.5',
    ],
    payload: {
      clipId: 'string',
      effect: 'string',
      params: 'object?',
      index: 'number?',
    },
    description: 'Add a GPU effect to a clip effect stack at an index.',
  },
  {
    id: 'effect.remove',
    scope: 'effect',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-99',
    prototypeFunctions: [],
    prototypeSource: 'beyond the prototype: Freecut GPU effect catalogue',
    manifestIds: ['command.removeEffect'],
    payload: { clipId: 'string', effectId: 'string' },
    description: 'Remove one effect from a clip effect stack.',
  },
  {
    id: 'effect.reorder',
    scope: 'effect',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-99',
    prototypeFunctions: [],
    prototypeSource: 'beyond the prototype: Freecut effect stack order',
    manifestIds: [],
    payload: { clipId: 'string', effectId: 'string', index: 'number' },
    description: 'Reorder the effect stack, which changes the rendered result.',
  },
  {
    id: 'effect.update',
    scope: 'effect',
    mutatesGraph: true,
    undoable: true,
    capability: 'gpuWorker',
    owner: 'FL-99',
    prototypeFunctions: [],
    prototypeSource: 'beyond the prototype: Freecut GPU effect parameters',
    manifestIds: EFFECT_ROWS,
    payload: { clipId: 'string', effectId: 'string', params: 'object' },
    description: 'Set the parameters of one effect instance, including LUT and key controls.',
  },
  {
    id: 'history.redo',
    scope: 'history',
    mutatesGraph: true,
    undoable: false,
    capability: null,
    owner: 'FL-94',
    prototypeFunctions: ['redo'],
    prototypeSource: 'redo',
    manifestIds: [],
    payload: { toRevision: 'number?' },
    description: 'Redo the last undone revision, as a server-side revision move.',
  },
  {
    id: 'history.undo',
    scope: 'history',
    mutatesGraph: true,
    undoable: false,
    capability: null,
    owner: 'FL-94',
    prototypeFunctions: ['undo', 'commit'],
    prototypeSource: 'undo (over the commit history)',
    manifestIds: ['readme.timeline-editing.6'],
    payload: { toRevision: 'number?' },
    description: 'Undo the last undoable revision; the stack lives with the stored project.',
  },
  {
    id: 'job.cancel',
    scope: 'job',
    mutatesGraph: false,
    undoable: false,
    capability: null,
    owner: 'FL-104',
    prototypeFunctions: [],
    prototypeSource: 'beyond the prototype: durable job cancellation',
    manifestIds: ['extra.render-queue'],
    payload: { jobId: 'string' },
    description: 'Ask the durable job model to cancel a queued or running job.',
  },
  {
    id: 'job.enqueueCaptioning',
    scope: 'job',
    mutatesGraph: false,
    undoable: false,
    capability: 'analysisWorker',
    owner: 'FL-111',
    prototypeFunctions: [],
    prototypeSource: 'beyond the prototype: local vision-language captioning',
    manifestIds: ['readme.local-ai-analysis.2'],
    payload: {
      sequenceId: 'string',
      clipIds: 'string[]?',
      sampleCadence: 'duration?',
      destinationId: 'string',
    },
    description: 'Queue AI captioning of media with an explicit destination.',
  },
  {
    id: 'job.enqueueExport',
    scope: 'job',
    mutatesGraph: false,
    undoable: false,
    capability: 'renderWorker',
    owner: 'FL-104',
    prototypeFunctions: ['estimateRender'],
    prototypeSource: 'estimateRender via ExportDialog',
    manifestIds: [
      'readme.export.1',
      'readme.export.2',
      'readme.export.3',
      'readme.export.4',
      'readme.export.5',
      'readme.export.6',
      'readme.export.7',
    ],
    payload: {
      sequenceId: 'string',
      format: 'string',
      colour: 'string',
      resolution: 'string',
      destinationId: 'string',
      container: 'string?',
      videoCodec: 'string?',
      audioFormat: 'string?',
      subtitles: 'string?',
      quality: 'string?',
    },
    description: 'Queue a render of any sequence to an explicit destination.',
  },
  {
    id: 'job.enqueueFillerRemoval',
    scope: 'job',
    mutatesGraph: false,
    undoable: false,
    capability: 'analysisWorker',
    owner: 'FL-103',
    prototypeFunctions: [],
    prototypeSource: 'beyond the prototype: filler-word removal with review',
    manifestIds: ['extra.filler-removal'],
    payload: { sequenceId: 'string', clipIds: 'string[]?', destinationId: 'string' },
    description: 'Queue filler-word detection; the edit itself is applied after review.',
  },
  {
    id: 'job.enqueueInterpolation',
    scope: 'job',
    mutatesGraph: false,
    undoable: false,
    capability: 'restorationWorker',
    owner: 'FL-111',
    prototypeFunctions: [],
    prototypeSource: 'beyond the prototype: RIFE frame interpolation',
    manifestIds: ['extra.interpolation-rife'],
    payload: { clipId: 'string', targetFps: 'rate', destinationId: 'string' },
    description: 'Queue frame interpolation for a clip to an explicit destination.',
  },
  {
    id: 'job.enqueueMusicGeneration',
    scope: 'job',
    mutatesGraph: false,
    undoable: false,
    capability: 'generationWorker',
    owner: 'FL-111',
    prototypeFunctions: [],
    prototypeSource: 'beyond the prototype: local MusicGen generation',
    manifestIds: ['readme.local-ai-analysis.6', 'extra.musicgen'],
    payload: {
      prompt: 'string',
      duration: 'duration',
      preset: 'string?',
      destinationId: 'string',
    },
    description: 'Queue local music generation; the result arrives as an importable asset.',
  },
  {
    id: 'job.enqueueProxy',
    scope: 'job',
    mutatesGraph: false,
    undoable: false,
    capability: 'renderWorker',
    owner: 'FL-105',
    prototypeFunctions: [],
    prototypeSource: 'beyond the prototype: proxy and waveform generation',
    manifestIds: ['readme.media-import.4'],
    payload: { assetIds: 'string[]', destinationId: 'string' },
    description: 'Queue proxy, thumbnail and waveform generation for project media.',
  },
  {
    id: 'job.enqueueRestoration',
    scope: 'job',
    mutatesGraph: false,
    undoable: false,
    capability: 'restorationWorker',
    owner: 'FL-110',
    prototypeFunctions: ['estimateRender'],
    prototypeSource: 'estimateRender via RestorePanel',
    manifestIds: [],
    payload: {
      mode: 'string',
      upscale: 'number',
      preview: 'boolean',
      destinationId: 'string',
    },
    description: 'Queue a Frameleaf restoration pass with an explicit, never implicit, destination.',
  },
  {
    id: 'job.enqueueReverseConform',
    scope: 'job',
    mutatesGraph: false,
    undoable: false,
    capability: 'renderWorker',
    owner: 'FL-111',
    prototypeFunctions: [],
    prototypeSource: 'beyond the prototype: reversed media conforming',
    manifestIds: ['extra.reverse-conform'],
    payload: { clipId: 'string', destinationId: 'string' },
    description: 'Queue a reversed conform of a clip source.',
  },
  {
    id: 'job.enqueueSceneDetection',
    scope: 'job',
    mutatesGraph: false,
    undoable: false,
    capability: 'analysisWorker',
    owner: 'FL-111',
    prototypeFunctions: [],
    prototypeSource: 'beyond the prototype: histogram and adaptive scene detection',
    manifestIds: ['readme.local-ai-analysis.3'],
    payload: {
      assetIds: 'string[]',
      mode: 'string',
      verifyWithModel: 'boolean?',
      destinationId: 'string',
    },
    description: 'Queue scene detection over project media.',
  },
  {
    id: 'job.enqueueSilenceRemoval',
    scope: 'job',
    mutatesGraph: false,
    undoable: false,
    capability: 'analysisWorker',
    owner: 'FL-103',
    prototypeFunctions: [],
    prototypeSource: 'beyond the prototype: silence removal with review',
    manifestIds: ['extra.silence-removal'],
    payload: {
      sequenceId: 'string',
      thresholdDb: 'number?',
      minimumSilence: 'duration?',
      destinationId: 'string',
    },
    description: 'Queue silence detection; the edit itself is applied after review.',
  },
  {
    id: 'job.enqueueTextToSpeech',
    scope: 'job',
    mutatesGraph: false,
    undoable: false,
    capability: 'generationWorker',
    owner: 'FL-111',
    prototypeFunctions: [],
    prototypeSource: 'beyond the prototype: local text-to-speech voiceovers',
    manifestIds: [
      'readme.local-ai-analysis.5',
      'extra.tts-kokoro',
      'extra.tts-moss',
      'extra.tts-supertonic',
    ],
    payload: {
      text: 'string',
      voice: 'string',
      engine: 'string?',
      destinationId: 'string',
    },
    description: 'Queue a local text-to-speech voiceover; the result arrives as an asset.',
  },
  {
    id: 'job.enqueueTranscription',
    scope: 'job',
    mutatesGraph: false,
    undoable: false,
    capability: 'transcriptionWorker',
    owner: 'FL-111',
    prototypeFunctions: ['sampleCaptions'],
    prototypeSource: 'sampleCaptions (simulated transcription in the prototype)',
    manifestIds: ['readme.local-ai-analysis.1'],
    payload: { sequenceId: 'string', language: 'string', destinationId: 'string' },
    description: 'Queue on-device transcription; captions land through captions.set.',
  },
  {
    id: 'job.enqueueUpscale',
    scope: 'job',
    mutatesGraph: false,
    undoable: false,
    capability: 'restorationWorker',
    owner: 'FL-111',
    prototypeFunctions: [],
    prototypeSource: 'beyond the prototype: Anime4K upscaling',
    manifestIds: ['extra.upscale-anime4k'],
    payload: { clipId: 'string', factor: 'number', destinationId: 'string' },
    description: 'Queue an upscale pass for a clip to an explicit destination.',
  },
  {
    id: 'keyframe.add',
    scope: 'keyframe',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-100',
    prototypeFunctions: [],
    prototypeSource: 'beyond the prototype: Freecut keyframe model',
    manifestIds: [
      'command.addKeyframe',
      'readme.keyframe-animation.5',
      'readme.keyframe-animation.6',
    ],
    payload: {
      clipId: 'string',
      property: 'string',
      at: 'time',
      value: 'object',
      easing: 'string?',
    },
    description: 'Add a keyframe on an animatable property at a time.',
  },
  {
    id: 'keyframe.remove',
    scope: 'keyframe',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-100',
    prototypeFunctions: [],
    prototypeSource: 'beyond the prototype: Freecut keyframe model',
    manifestIds: ['command.removeKeyframes'],
    payload: { clipId: 'string', property: 'string', keyframeIds: 'string[]' },
    description: 'Remove keyframes from one property.',
  },
  {
    id: 'keyframe.setEasing',
    scope: 'keyframe',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-100',
    prototypeFunctions: [],
    prototypeSource: 'beyond the prototype: Freecut easing presets and tangents',
    manifestIds: ['readme.keyframe-animation.2'],
    payload: {
      clipId: 'string',
      property: 'string',
      keyframeIds: 'string[]',
      easing: 'string',
      bezier: 'object?',
    },
    description: 'Set easing or an explicit bezier on selected keyframes.',
  },
  {
    id: 'keyframe.update',
    scope: 'keyframe',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-100',
    prototypeFunctions: [],
    prototypeSource: 'beyond the prototype: Freecut graph editor and dopesheet',
    manifestIds: ['readme.keyframe-animation.1'],
    payload: {
      clipId: 'string',
      property: 'string',
      keyframeId: 'string',
      at: 'time?',
      value: 'object?',
    },
    description: 'Retime or revalue one keyframe from the graph editor or dopesheet.',
  },
  {
    id: 'lottie.update',
    scope: 'media',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-105',
    prototypeFunctions: [],
    prototypeSource: 'beyond the prototype: Lottie colour, text and slot editing',
    manifestIds: ['readme.media-import.2'],
    payload: {
      clipId: 'string',
      colors: 'object?',
      text: 'object?',
      slots: 'object?',
    },
    description: 'Remap Lottie colours and themes, edit its text and adjust value slots.',
  },
  {
    id: 'marker.add',
    scope: 'sequence',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    prototypeFunctions: [],
    prototypeSource: 'beyond the prototype: sequence markers',
    manifestIds: ['readme.timeline-editing.6'],
    payload: { at: 'time', name: 'string?', colour: 'string?' },
    description: 'Add a marker on the sequence at a time.',
  },
  {
    id: 'marker.remove',
    scope: 'sequence',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    prototypeFunctions: [],
    prototypeSource: 'beyond the prototype: sequence markers',
    manifestIds: [],
    payload: { markerId: 'string' },
    description: 'Remove a sequence marker.',
  },
  {
    id: 'marker.update',
    scope: 'sequence',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    prototypeFunctions: [],
    prototypeSource: 'beyond the prototype: sequence markers',
    manifestIds: [],
    payload: { markerId: 'string', patch: 'object' },
    description: 'Rename, recolour or move a sequence marker.',
  },
  {
    id: 'media.import',
    scope: 'media',
    mutatesGraph: true,
    undoable: false,
    capability: null,
    owner: 'FL-105',
    prototypeFunctions: [],
    prototypeSource: 'beyond the prototype: project media bin',
    manifestIds: ['readme.media-import.1'],
    payload: { assetIds: 'string[]' },
    description: 'Reference library assets from the project without copying an original.',
  },
  {
    id: 'media.relink',
    scope: 'media',
    mutatesGraph: true,
    undoable: false,
    capability: null,
    owner: 'FL-105',
    prototypeFunctions: [],
    prototypeSource: 'beyond the prototype: media relinking',
    manifestIds: ['readme.media-import.4'],
    payload: { mediaId: 'string', assetId: 'string' },
    description: 'Relink project media to another asset when the original moved.',
  },
  {
    id: 'media.remove',
    scope: 'media',
    mutatesGraph: true,
    undoable: false,
    capability: null,
    owner: 'FL-105',
    prototypeFunctions: [],
    prototypeSource: 'beyond the prototype: project media bin',
    manifestIds: [],
    payload: { mediaIds: 'string[]' },
    description: 'Drop unused media references from the project; originals are untouched.',
  },
  {
    id: 'music.add',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    prototypeFunctions: ['addMusic'],
    prototypeSource: 'addMusic',
    manifestIds: ['command.addItem'],
    payload: {
      musicId: 'string',
      at: 'time',
      duration: 'duration?',
      volume: 'number?',
    },
    description: 'Place a music bed on the music track.',
  },
  {
    id: 'preview.release',
    scope: 'preview',
    mutatesGraph: false,
    undoable: false,
    capability: null,
    owner: 'FL-96',
    prototypeFunctions: [],
    prototypeSource: 'Studio.jsx preview monitor',
    manifestIds: [],
    payload: {},
    description: 'Tell the host the engine no longer needs the frame it last requested.',
  },
  {
    id: 'preview.request',
    scope: 'preview',
    mutatesGraph: false,
    undoable: false,
    capability: 'gpuWorker',
    owner: 'FL-96',
    prototypeFunctions: [],
    prototypeSource: 'Studio.jsx preview monitor',
    manifestIds: [],
    payload: {
      at: 'time',
      quality: 'string',
      viewportWidth: 'number',
      viewportHeight: 'number',
    },
    description: 'Ask for one frame of the current revision, rendered at an exact rational time.',
  },
  {
    id: 'project.applyTemplate',
    scope: 'project',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    prototypeFunctions: [],
    prototypeSource: 'beyond the prototype: project templates',
    manifestIds: ['readme.timeline-editing.8'],
    payload: { templateId: 'string' },
    description: 'Apply a project template, including canvas and frame rate defaults.',
  },
  {
    id: 'project.exportBundle',
    scope: 'project',
    mutatesGraph: false,
    undoable: false,
    capability: null,
    owner: 'FL-91',
    prototypeFunctions: [],
    prototypeSource: 'beyond the prototype: portable project bundles',
    manifestIds: ['readme.projects-storage.5'],
    payload: { sequenceIds: 'string[]?', includeMedia: 'boolean?' },
    description: 'Export a validated portable project bundle, optionally with copies of the media the person owns.',
  },
  {
    id: 'project.importBundle',
    scope: 'project',
    mutatesGraph: true,
    undoable: false,
    capability: null,
    owner: 'FL-91',
    prototypeFunctions: [],
    prototypeSource: 'beyond the prototype: portable project bundles',
    manifestIds: [],
    payload: { bundleUploadId: 'string' },
    description: 'Import a validated portable project bundle into this project.',
  },
  {
    id: 'project.rename',
    scope: 'project',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    prototypeFunctions: ['renameProject'],
    prototypeSource: 'renameProject',
    manifestIds: [],
    payload: { name: 'string' },
    description: 'Rename the project.',
  },
  {
    id: 'project.setMasterAudio',
    scope: 'project',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-103',
    prototypeFunctions: [],
    prototypeSource: 'beyond the prototype: project master bus',
    manifestIds: ['readme.preview-playback.6'],
    payload: { gainDb: 'number?', muted: 'boolean?', ducking: 'boolean?' },
    description: 'Set the project master bus, which is not the monitor or device volume.',
  },
  {
    id: 'project.setSettings',
    scope: 'project',
    mutatesGraph: true,
    undoable: false,
    capability: null,
    owner: 'FL-94',
    prototypeFunctions: ['setSettings'],
    prototypeSource: 'setSettings',
    manifestIds: [],
    payload: { patch: 'object' },
    description: 'Set editor preferences stored with the project: mode, guides, loop, ducking.',
  },
  {
    id: 'property.bakeModifier',
    scope: 'keyframe',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-100',
    prototypeFunctions: [],
    prototypeSource: 'beyond the prototype: procedural motion modifiers',
    manifestIds: ['readme.keyframe-animation.3'],
    payload: { clipId: 'string', property: 'string', modifierId: 'string' },
    description: 'Bake a procedural motion modifier into explicit keyframes.',
  },
  {
    id: 'property.setExpression',
    scope: 'keyframe',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-100',
    prototypeFunctions: [],
    prototypeSource: 'beyond the prototype: property expressions',
    manifestIds: ['extra.expressions'],
    payload: { clipId: 'string', property: 'string', expression: 'string?' },
    description: 'Set or clear a property expression.',
  },
  {
    id: 'property.setModifier',
    scope: 'keyframe',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-100',
    prototypeFunctions: [],
    prototypeSource: 'beyond the prototype: procedural motion modifiers',
    manifestIds: [],
    payload: { clipId: 'string', property: 'string', modifier: 'object?' },
    description: 'Attach or clear a procedural motion modifier on a property.',
  },
  {
    id: 'review.add',
    scope: 'review',
    mutatesGraph: false,
    undoable: false,
    capability: null,
    owner: 'FL-94',
    prototypeFunctions: ['addReviewComment'],
    prototypeSource: 'addReviewComment',
    manifestIds: [],
    payload: { time: 'time', text: 'string' },
    description: 'Add a timestamped review comment.',
  },
  {
    id: 'review.remove',
    scope: 'review',
    mutatesGraph: false,
    undoable: false,
    capability: null,
    owner: 'FL-94',
    prototypeFunctions: ['removeReviewComment'],
    prototypeSource: 'removeReviewComment',
    manifestIds: [],
    payload: { commentId: 'string' },
    description: 'Remove a review comment.',
  },
  {
    id: 'review.update',
    scope: 'review',
    mutatesGraph: false,
    undoable: false,
    capability: null,
    owner: 'FL-94',
    prototypeFunctions: ['updateReviewComment'],
    prototypeSource: 'updateReviewComment',
    manifestIds: [],
    payload: { commentId: 'string', patch: 'object' },
    description: 'Edit or resolve a review comment.',
  },
  {
    id: 'sequence.add',
    scope: 'sequence',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    prototypeFunctions: [],
    prototypeSource: 'beyond the prototype: the prototype ships two fixed sequences',
    manifestIds: ['readme.timeline-editing.2'],
    payload: {
      name: 'string',
      fps: 'rate?',
      width: 'number?',
      height: 'number?',
    },
    description: 'Add a sequence to the project.',
  },
  {
    id: 'sequence.duplicate',
    scope: 'sequence',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    prototypeFunctions: [],
    prototypeSource: 'beyond the prototype: the prototype ships two fixed sequences',
    manifestIds: [],
    payload: { sequenceId: 'string', name: 'string?' },
    description: 'Duplicate a sequence, including its tracks and clips.',
  },
  {
    id: 'sequence.remove',
    scope: 'sequence',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    prototypeFunctions: [],
    prototypeSource: 'beyond the prototype: the prototype ships two fixed sequences',
    manifestIds: [],
    payload: { sequenceId: 'string' },
    description: 'Remove a sequence; the project keeps at least one.',
  },
  {
    id: 'sequence.setActive',
    scope: 'sequence',
    mutatesGraph: true,
    undoable: false,
    capability: null,
    owner: 'FL-94',
    prototypeFunctions: ['setActiveSequence'],
    prototypeSource: 'setActiveSequence',
    manifestIds: [],
    payload: { sequenceId: 'string' },
    description: 'Switch the active sequence, which is stored on the project.',
  },
  {
    id: 'sequence.setFields',
    scope: 'sequence',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    prototypeFunctions: ['setSequenceFields'],
    prototypeSource: 'setSequenceFields',
    manifestIds: [],
    payload: {
      name: 'string?',
      captionLanguage: 'string?',
      captionsBurnIn: 'boolean?',
    },
    description: 'Set sequence name, caption language and caption burn-in.',
  },
  {
    id: 'sequence.setSettings',
    scope: 'sequence',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    prototypeFunctions: [],
    prototypeSource: 'beyond the prototype: canvas and frame rate are fixed there',
    manifestIds: ['readme.timeline-editing.8'],
    payload: {
      sequenceId: 'string',
      fps: 'rate?',
      width: 'number?',
      height: 'number?',
    },
    description: 'Set the sequence canvas and frame rate, including auto-match from first media.',
  },
  {
    id: 'text.setMotion',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-100',
    prototypeFunctions: [],
    prototypeSource: 'beyond the prototype: per-character motion text',
    manifestIds: ['readme.keyframe-animation.4'],
    payload: { clipId: 'string', motion: 'object?' },
    description: 'Set per-character, per-word or per-line text animation.',
  },
  {
    id: 'title.add',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    prototypeFunctions: ['addTitle'],
    prototypeSource: 'addTitle',
    manifestIds: ['command.addText'],
    payload: {
      at: 'time',
      text: 'string',
      duration: 'duration?',
      style: 'string?',
      position: 'string?',
      animation: 'string?',
    },
    description: 'Add a title clip on the title track.',
  },
  {
    id: 'track.add',
    scope: 'track',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    prototypeFunctions: [],
    prototypeSource: 'beyond the prototype: its six track kinds are fixed',
    manifestIds: ['command.addTrack'],
    payload: { kind: 'string', name: 'string?', index: 'number?' },
    description: 'Add a track of a kind at an index.',
  },
  {
    id: 'track.remove',
    scope: 'track',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    prototypeFunctions: [],
    prototypeSource: 'beyond the prototype: its six track kinds are fixed',
    manifestIds: [],
    payload: { trackId: 'string' },
    description: 'Remove a track and the clips on it.',
  },
  {
    id: 'track.reorder',
    scope: 'track',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    prototypeFunctions: [],
    prototypeSource: 'beyond the prototype: its track order is fixed',
    manifestIds: [],
    payload: { trackId: 'string', index: 'number' },
    description: 'Reorder tracks, which changes compositing order.',
  },
  {
    id: 'track.set',
    scope: 'track',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    prototypeFunctions: ['setTrack'],
    prototypeSource: 'setTrack',
    manifestIds: ['readme.timeline-editing.5'],
    payload: { trackId: 'string', patch: 'object' },
    description: 'Set track name, mute, lock, solo and gain.',
  },
  {
    id: 'track.setAudio',
    scope: 'track',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-103',
    prototypeFunctions: ['setTrack'],
    prototypeSource: 'setTrack (gain only in the prototype)',
    manifestIds: ['readme.audio.1', 'readme.audio.3'],
    payload: {
      trackId: 'string',
      gainDb: 'number?',
      pan: 'number?',
      eq: 'object?',
    },
    description: 'Set the track fader, pan and the track EQ stage.',
  },
  {
    id: 'voiceover.add',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    prototypeFunctions: ['addVoiceover'],
    prototypeSource: 'addVoiceover',
    manifestIds: ['extra.microphone'],
    payload: { at: 'time', duration: 'duration', uploadId: 'string' },
    description: 'Place a recorded or generated voiceover on the voice track.',
  },
];

/**
 * Pinned manifest rows that are deliberately not commands, with the story that owns them.
 * A row here is a capability, a runtime behaviour, a read-only surface or a host-owned
 * lifecycle action: reaching it does not mean sending an editing command. The check rejects
 * any manifest row that is neither mapped nor listed here, so this table is the only way a
 * row can be left out, and it cannot be left out silently.
 */
export const nonCommandRows = [
  { id: 'extra.bento', owner: 'FL-98', reason: 'Panel layout preset; a client preference, not a graph change.' },
  {
    id: 'extra.portable-headless',
    owner: 'FL-91',
    reason: 'Workspace and lifecycle API the host owns; not an in-editor command.',
  },
  {
    id: 'module.docs',
    owner: 'FL-88',
    reason: 'Source module inventory row, not an action.',
  },
  { id: 'module.editor', owner: 'FL-88', reason: 'Source module inventory row, not an action.' },
  { id: 'module.effects', owner: 'FL-99', reason: 'Source module inventory row, not an action.' },
  { id: 'module.export', owner: 'FL-105', reason: 'Source module inventory row, not an action.' },
  { id: 'module.keyframes', owner: 'FL-100', reason: 'Source module inventory row, not an action.' },
  { id: 'module.lottie-browser', owner: 'FL-105', reason: 'Source module inventory row, not an action.' },
  { id: 'module.media-library', owner: 'FL-105', reason: 'Source module inventory row, not an action.' },
  { id: 'module.preview', owner: 'FL-98', reason: 'Source module inventory row, not an action.' },
  { id: 'module.project-bundle', owner: 'FL-91', reason: 'Source module inventory row, not an action.' },
  { id: 'module.projects', owner: 'FL-91', reason: 'Source module inventory row, not an action.' },
  { id: 'module.scene-browser', owner: 'FL-111', reason: 'Source module inventory row, not an action.' },
  { id: 'module.settings', owner: 'FL-88', reason: 'Source module inventory row, not an action.' },
  { id: 'module.timeline', owner: 'FL-94', reason: 'Source module inventory row, not an action.' },
  { id: 'module.workspace-gate', owner: 'FL-91', reason: 'Source module inventory row, not an action.' },
  {
    id: 'readme.audio.4',
    owner: 'FL-103',
    reason: 'Render-path preservation obligation proved by export evidence, not by a command.',
  },
  {
    id: 'readme.effects-masks-compositing.8',
    owner: 'FL-99',
    reason: 'Colour picker and eyedropper; an input control whose result travels in another payload.',
  },
  {
    id: 'readme.local-ai-analysis.7',
    owner: 'FL-111',
    reason: 'Model cache and unload controls live in settings, outside the project graph.',
  },
  {
    id: 'readme.media-import.3',
    owner: 'FL-105',
    reason: 'ProRes decode is a deployment capability, not an editing command.',
  },
  {
    id: 'readme.preview-playback.2',
    owner: 'FL-98',
    reason: 'Playback clock and composition runtime; no graph change.',
  },
  {
    id: 'readme.preview-playback.3',
    owner: 'FL-98',
    reason: 'Scrub overlays, prewarming and adaptive quality; no graph change.',
  },
  {
    id: 'readme.preview-playback.5',
    owner: 'FL-98',
    reason: 'Colour scopes are read-only measurement surfaces.',
  },
  {
    id: 'readme.projects-storage.1',
    owner: 'FL-91',
    reason: 'Project storage is server-side here; the workspace folder API does not apply.',
  },
  {
    id: 'readme.projects-storage.2',
    owner: 'FL-91',
    reason: 'Workspace switching is replaced by the account library; not an editing command.',
  },
  {
    id: 'readme.projects-storage.3',
    owner: 'FL-91',
    reason: 'Project storage and migration are host lifecycle, not editing commands.',
  },
  {
    id: 'readme.projects-storage.4',
    owner: 'FL-91',
    reason: 'Project trash and delete flows are host lifecycle with their own authorization.',
  },
  {
    id: 'readme.projects-storage.6',
    owner: 'FL-91',
    reason: 'Auto-save, thumbnails and orphan cleanup are host obligations, not commands.',
  },
];

/* ------------------------------------------------------------------ */
/* Formatting helpers                                                   */
/* ------------------------------------------------------------------ */

const jsonScalar = (value) => JSON.stringify(value);

/**
 * Serialize like root Prettier with the repository's recursive lexical JSON sorting, so the
 * generated catalogue is already formatted and a format check cannot rewrite it.
 */
export function canonicalJson(value) {
  const primitiveArray = (values) =>
    values.every((item) => item === null || ['string', 'number', 'boolean'].includes(typeof item))
      ? `[${values.map((item) => jsonScalar(item)).join(', ')}]`
      : null;

  const render = (current, indent = 0, column = 0) => {
    if (current !== null && typeof current === 'object' && !Array.isArray(current)) {
      const keys = Object.keys(current).sort();
      if (keys.length === 0) {
        return '{}';
      }
      const lines = ['{'];
      keys.forEach((key, index) => {
        const prefix = `${' '.repeat(indent + 2)}${jsonScalar(key)}: `;
        const child = render(current[key], indent + 2, prefix.length).split('\n');
        lines.push(prefix + child[0], ...child.slice(1));
        if (index < keys.length - 1) {
          lines[lines.length - 1] += ',';
        }
      });
      lines.push(`${' '.repeat(indent)}}`);
      return lines.join('\n');
    }
    if (Array.isArray(current)) {
      const flat = primitiveArray(current);
      if (flat !== null && column + flat.length <= 80) {
        return flat;
      }
      if (current.length === 0) {
        return '[]';
      }
      const lines = ['['];
      current.forEach((item, index) => {
        const child = render(item, indent + 2, indent + 2).split('\n');
        lines.push(' '.repeat(indent + 2) + child[0], ...child.slice(1));
        if (index < current.length - 1) {
          lines[lines.length - 1] += ',';
        }
      });
      lines.push(`${' '.repeat(indent)}]`);
      return lines.join('\n');
    }
    return jsonScalar(current);
  };

  return `${render(value)}\n`;
}

const sortedPayload = (payload) =>
  Object.keys(payload)
    .sort()
    .map((name) => [name, payload[name]]);

const fieldType = (declared) => (declared.endsWith('?') ? declared.slice(0, -1) : declared);
const fieldRequired = (declared) => !declared.endsWith('?');

/* ------------------------------------------------------------------ */
/* Artifacts                                                            */
/* ------------------------------------------------------------------ */

/** The published catalogue, with `deliveryPlanIds` computed from the pinned issue map. */
export function buildCatalogueDocument(issueMap) {
  const planById = new Map(issueMap.rows.map((row) => [row.id, row.issueIds]));
  const commands = catalogue.map((command) => ({
    capability: command.capability,
    deliveryPlanIds: [...new Set(command.manifestIds.flatMap((id) => planById.get(id) ?? []))].sort(),
    description: command.description,
    id: command.id,
    manifestIds: [...command.manifestIds].sort(),
    mutatesGraph: command.mutatesGraph,
    owner: command.owner,
    payload: command.payload,
    prototypeFunctions: [...command.prototypeFunctions].sort(),
    prototypeSource: command.prototypeSource,
    scope: command.scope,
    undoable: command.undoable,
  }));
  const mapped = new Set(commands.flatMap((command) => command.manifestIds));
  return {
    capabilities: CAPABILITIES,
    commands,
    counts: {
      commands: commands.length,
      commandsWithoutManifestRow: commands.filter((command) => command.manifestIds.length === 0).length,
      commandsWithoutPrototypeFunction: commands.filter((command) => command.prototypeFunctions.length === 0).length,
      manifestRows: issueMap.rows.length,
      manifestRowsDeclaredNonCommand: nonCommandRows.length,
      manifestRowsMapped: mapped.size,
    },
    engine: ENGINE,
    engineRevision: ENGINE_REVISION,
    fieldTypes: FIELD_TYPES,
    generator: GENERATOR,
    issueMapPath: ISSUE_MAP_PATH,
    manifestPath: MANIFEST_PATH,
    nonCommandRows: [...nonCommandRows].sort((a, b) => (a.id < b.id ? -1 : 1)),
    prototypePath: PROTOTYPE_PATH,
    schemaVersion: SCHEMA_VERSION,
    scopes: SCOPES,
    status: 'vocabulary-published-semantics-owned-by-later-stories',
    webVocabularyPath: WEB_VOCABULARY_PATH,
  };
}

const TS_HEADER = `/**
 * GENERATED FILE — do not edit.
 *
 * Source: ${CATALOGUE_PATH}
 * Generator: ${GENERATOR}
 *
 * The server mirror of the canonical Studio command vocabulary (FL-92, \`STU-205\`). It
 * exists so the server can validate a command envelope without trusting the client's idea
 * of the vocabulary, and so a drifted web or native contract fails CI instead of failing a
 * person's edit. Payload objects are described, never interpreted: \`object\` fields travel
 * through unread so unknown Freecut graph fields, nulls, arrays and rational timing
 * extensions survive the round trip.
 */
`;

/**
 * A string-literal union in the form Prettier gives it under the server's 120 column budget:
 * on the declaration line when it fits, on one indented line after `=` when that fits, and
 * one member per line otherwise. The mirror is checked byte for byte, so the generator has
 * to agree with the formatter rather than be rewritten by it.
 */
const SERVER_PRINT_WIDTH = 120;
const unionType = (name, values) => {
  const members = values.map((value) => `'${value}'`).join(' | ');
  const inline = `export type ${name} = ${members};`;
  if (inline.length <= SERVER_PRINT_WIDTH) {
    return [inline];
  }
  const indented = `  ${members};`;
  if (indented.length <= SERVER_PRINT_WIDTH) {
    return [`export type ${name} =`, indented];
  }
  return [
    `export type ${name} =`,
    ...values.map((value, index) => (index === values.length - 1 ? `  | '${value}';` : `  | '${value}'`)),
  ];
};

export function buildServerMirror(document) {
  const lines = [TS_HEADER];
  lines.push(
    `export const STUDIO_COMMAND_SCHEMA_VERSION = ${document.schemaVersion};`,
    `export const STUDIO_ENGINE_REVISION = '${document.engineRevision}';`,
    '',
    ...unionType('StudioCommandScope', document.scopes),
    '',
    ...unionType('StudioCommandCapability', document.capabilities),
    '',
    ...unionType('StudioPayloadFieldType', document.fieldTypes),
    '',
    'export type StudioPayloadField = StudioPayloadFieldType | `${StudioPayloadFieldType}?`;',
    '',
    'export interface StudioCommandMirror {',
    '  scope: StudioCommandScope;',
    '  mutatesGraph: boolean;',
    '  undoable: boolean;',
    '  capability: StudioCommandCapability | null;',
    '  owner: string;',
    '  payload: Readonly<Record<string, StudioPayloadField>>;',
    '}',
    '',
    'export const studioCommandMirror = {',
  );
  for (const command of document.commands) {
    lines.push(
      `  '${command.id}': {`,
      `    scope: '${command.scope}',`,
      `    mutatesGraph: ${command.mutatesGraph},`,
      `    undoable: ${command.undoable},`,
      `    capability: ${command.capability === null ? 'null' : `'${command.capability}'`},`,
      `    owner: '${command.owner}',`,
      ...(Object.keys(command.payload).length === 0
        ? ['    payload: {},']
        : [
            '    payload: {',
            ...sortedPayload(command.payload).map(([name, type]) => `      ${name}: '${type}',`),
            '    },',
          ]),
      '  },',
    );
  }
  lines.push(
    '} as const satisfies Record<string, StudioCommandMirror>;',
    '',
    'export type StudioCommandId = keyof typeof studioCommandMirror;',
    '',
    'export const studioCommandIds = Object.keys(studioCommandMirror) as StudioCommandId[];',
    '',
  );
  return lines.join('\n');
}

const DART_HEADER = `// GENERATED CODE - DO NOT MODIFY BY HAND.
//
// Source: ${CATALOGUE_PATH}
// Generator: ${GENERATOR}
//
// The native contract for the canonical Studio command vocabulary (FL-92, \`STU-205\`).
// Native clients build command envelopes from this table instead of restating the
// vocabulary, so a command the web host accepts and a command the phone or tablet sends
// cannot drift. Payload values typed \`object\` are opaque maps that are carried through
// unread, which is what keeps unknown graph fields, nulls, arrays and rational timing
// extensions lossless on the way to the server.
//
// This file publishes the contract. It does not implement any command: every row names the
// story that owns its semantics, and the server answers \`not-implemented\` until that
// story lands.
`;

export function buildNativeContract(document) {
  const lines = [DART_HEADER];
  lines.push(
    `const int frameleafStudioCommandSchemaVersion = ${document.schemaVersion};`,
    '',
    `const String frameleafStudioEngineRevision = '${document.engineRevision}';`,
    '',
    '/// The part of the project a command acts on.',
    'enum FrameleafStudioScope {',
    ...document.scopes.map((scope) => `  ${scope},`),
    '}',
    '',
    '/// A worker capability a command needs before it may be offered or accepted.',
    'enum FrameleafStudioCapability {',
    ...document.capabilities.map((capability) => `  ${capability},`),
    '}',
    '',
    '/// An exact rational: a reduced fraction of two integers, never a float.',
    '///',
    '/// A `time`, `duration` or `rate` field carries one of these (FL-93). On the wire it is',
    '/// the pair the web host and the server use, `{"num": .., "den": ..}`; here the two',
    '/// integers are named, so native code cannot mistake it for a double.',
    'class FrameleafStudioRational {',
    '  const FrameleafStudioRational(this.numerator, this.denominator);',
    '',
    '  factory FrameleafStudioRational.fromJson(Map<String, dynamic> json) {',
    '    final Object? numerator = json[\'num\'];',
    '    final Object? denominator = json[\'den\'];',
    '    if (numerator is! int || denominator is! int || denominator <= 0) {',
    '      throw const FormatException(\'a rational needs integer num and positive den\');',
    '    }',
    '    return FrameleafStudioRational(numerator, denominator);',
    '  }',
    '',
    '  final int numerator;',
    '  final int denominator;',
    '',
    '  Map<String, dynamic> toJson() => <String, dynamic>{',
    '    \'num\': numerator,',
    '    \'den\': denominator,',
    '  };',
    '',
    '  @override',
    '  String toString() => \'$numerator/$denominator\';',
    '}',
    '',
    '/// The field types that carry a [FrameleafStudioRational].',
    'const Set<String> frameleafStudioRationalFieldTypes = <String>{',
    "  'time',",
    "  'duration',",
    "  'rate',",
    '};',
    '',
    '/// One payload field: its name, its declared type and whether it must be present.',
    'class FrameleafStudioField {',
    '  const FrameleafStudioField(this.name, this.type, this.required);',
    '',
    '  final String name;',
    '  final String type;',
    '  final bool required;',
    '}',
    '',
    '/// One published command.',
    'class FrameleafStudioCommand {',
    '  const FrameleafStudioCommand({',
    '    required this.id,',
    '    required this.scope,',
    '    required this.mutatesGraph,',
    '    required this.undoable,',
    '    required this.capability,',
    '    required this.owner,',
    '    required this.payload,',
    '  });',
    '',
    '  final String id;',
    '  final FrameleafStudioScope scope;',
    '  final bool mutatesGraph;',
    '  final bool undoable;',
    '  final FrameleafStudioCapability? capability;',
    '  final String owner;',
    '  final List<FrameleafStudioField> payload;',
    '}',
    '',
    'const List<FrameleafStudioCommand> frameleafStudioCommands = <FrameleafStudioCommand>[',
  );
  for (const command of document.commands) {
    lines.push(
      '  FrameleafStudioCommand(',
      `    id: '${command.id}',`,
      `    scope: FrameleafStudioScope.${command.scope},`,
      `    mutatesGraph: ${command.mutatesGraph},`,
      `    undoable: ${command.undoable},`,
      `    capability: ${
        command.capability === null ? 'null' : `FrameleafStudioCapability.${command.capability}`
      },`,
      `    owner: '${command.owner}',`,
      '    payload: <FrameleafStudioField>[',
      ...sortedPayload(command.payload).map(
        ([name, type]) => `      FrameleafStudioField('${name}', '${fieldType(type)}', ${fieldRequired(type)}),`,
      ),
      '    ],',
      '  ),',
    );
  }
  lines.push(
    '];',
    '',
    '/// The same commands, keyed by id, for envelope validation.',
    'final Map<String, FrameleafStudioCommand> frameleafStudioCommandsById =',
    '    <String, FrameleafStudioCommand>{',
    '      for (final FrameleafStudioCommand command in frameleafStudioCommands)',
    '        command.id: command,',
    '    };',
    '',
  );
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* Checks                                                              */
/* ------------------------------------------------------------------ */

/** Exported functions of the prototype project model, between two of its banner comments. */
export function prototypeCommandFunctions(source) {
  const start = source.indexOf('Commands (each returns a new project');
  const end = source.indexOf('/* History');
  assert.ok(start > 0 && end > start, 'Prototype command section not found');
  const region = source.slice(start, end);
  const names = [
    ...region.matchAll(/export\s+(?:function|const)\s+([A-Za-z0-9_]+)/g),
  ].map(([, name]) => name);
  assert.ok(names.length > 0, 'Prototype command section declares no exported functions');
  return names;
}

/**
 * Read the web vocabulary without importing TypeScript: the id list, the registry rows and
 * the payload interface keys. A shape this parser cannot read is itself a failure, because
 * the point of the check is that the two files cannot silently disagree.
 */
export function parseWebVocabulary(source) {
  const idsBlock = source.match(/export const studioCommandIds = \[([\s\S]*?)\] as const;/);
  assert.ok(idsBlock, `${WEB_VOCABULARY_PATH}: studioCommandIds not found`);
  const ids = [...idsBlock[1].matchAll(/'([^']+)'/g)].map(([, id]) => id);

  const payloadBlock = source.match(/export interface StudioCommandPayloads \{([\s\S]*?)\n\}/);
  assert.ok(payloadBlock, `${WEB_VOCABULARY_PATH}: StudioCommandPayloads not found`);
  const payloadKeys = [...payloadBlock[1].matchAll(/^ {2}'([^']+)':/gm)].map(([, id]) => id);

  const field = (chunk, name, pattern) => {
    const match = chunk.match(new RegExp(`\\b${name}:\\s*(${pattern})`));
    return match ? match[1] : null;
  };
  const rows = source
    .split('define({')
    .slice(1)
    .map((chunk) => chunk.slice(0, chunk.indexOf('})')))
    .map((chunk) => ({
      id: field(chunk, 'id', "'[^']+'")?.slice(1, -1) ?? null,
      scope: field(chunk, 'scope', "'[^']+'")?.slice(1, -1) ?? null,
      mutatesGraph: field(chunk, 'mutatesGraph', 'true|false') === 'true',
      undoable: field(chunk, 'undoable', 'true|false') === 'true',
      capability: field(chunk, 'requiresCapability', "'[^']+'")?.slice(1, -1) ?? null,
      owner: field(chunk, 'owner', "'[^']+'")?.slice(1, -1) ?? null,
      prototypeSource: field(chunk, 'prototypeSource', "'[^']+'")?.slice(1, -1) ?? null,
    }));
  return { ids, payloadKeys, rows };
}

export function validate({ document, manifest, issueMap, prototypeSource, webSource }) {
  const ids = document.commands.map((command) => command.id);
  assert.deepEqual([...ids].sort(), ids, 'Catalogue rows must stay sorted by id');
  assert.equal(new Set(ids).size, ids.length, 'Duplicate command id');
  for (const command of document.commands) {
    assert.ok(SCOPES.includes(command.scope), `${command.id}: unknown scope`);
    assert.ok(
      command.capability === null || CAPABILITIES.includes(command.capability),
      `${command.id}: unknown capability`,
    );
    assert.match(command.owner, /^FL-\d+$/, `${command.id}: owner must be a Jira key`);
    assert.notEqual(command.owner, 'FL-92', `${command.id}: FL-92 publishes the vocabulary, it owns no semantics`);
    assert.ok(command.description.length > 0, `${command.id}: missing description`);
    assert.ok(command.prototypeSource.length > 0, `${command.id}: missing prototype source`);
    for (const name of command.prototypeFunctions) {
      assert.ok(
        command.prototypeSource.includes(name),
        `${command.id}: prototypeSource must name ${name}`,
      );
    }
    // A graph change always carries intent. Only a lease-free signal (`preview.release`) may
    // have nothing to say beyond its id; the server mirror then admits no fields at all.
    assert.ok(
      Object.keys(command.payload).length > 0 || (!command.mutatesGraph && EMPTY_PAYLOAD_COMMANDS.includes(command.id)),
      `${command.id}: payload must declare a field`,
    );
    for (const [name, declared] of Object.entries(command.payload)) {
      assert.ok(FIELD_TYPES.includes(fieldType(declared)), `${command.id}.${name}: unknown field type ${declared}`);
    }
    if (command.undoable) {
      assert.ok(command.mutatesGraph, `${command.id}: only a graph change can be undoable`);
    }
    if (command.scope === 'job') {
      assert.equal(command.mutatesGraph, false, `${command.id}: a job submission is not a graph change`);
      assert.equal(command.undoable, false, `${command.id}: a job submission is not undoable`);
      if (command.id.startsWith('job.enqueue')) {
        assert.ok(command.capability, `${command.id}: queued work must name the worker it needs`);
      }
    }
  }

  const manifestIds = new Set(manifest.features.map((feature) => feature.id));
  assert.equal(manifestIds.size, manifest.counts.features, 'Feature manifest row count drifted');
  assert.deepEqual(
    issueMap.rows.map((row) => row.id).sort(),
    [...manifestIds].sort(),
    'Issue map and feature manifest must describe the same rows',
  );
  const declared = new Set(document.nonCommandRows.map((row) => row.id));
  const planById = new Map(issueMap.rows.map((row) => [row.id, row.issueIds]));
  const planKeys = new Map(
    Object.entries({
      'AI-104': 'FL-111',
      'STU-201': 'FL-88',
      'STU-204': 'FL-91',
      'STU-205': 'FL-92',
      'STU-301': 'FL-94',
      'STU-302': 'FL-98',
      'STU-303': 'FL-99',
      'STU-304': 'FL-100',
      'STU-305': 'FL-103',
      'STU-306': 'FL-105',
      'STU-403': 'FL-104',
    }),
  );
  for (const row of document.nonCommandRows) {
    assert.ok(manifestIds.has(row.id), `Non-command row ${row.id} is not a manifest row`);
    assert.ok(row.reason.length > 0, `Non-command row ${row.id} needs a reason`);
    const planId = planById.get(row.id)[0];
    assert.equal(
      row.owner,
      planKeys.get(planId),
      `Non-command row ${row.id} must be owned by the story the plan assigns (${planId})`,
    );
  }
  const mapped = new Set(document.commands.flatMap((command) => command.manifestIds));
  for (const id of mapped) {
    assert.ok(manifestIds.has(id), `Command catalogue references unknown manifest row ${id}`);
    assert.ok(!declared.has(id), `${id} is both mapped to a command and declared a non-command row`);
  }
  for (const id of manifestIds) {
    assert.ok(
      mapped.has(id) || declared.has(id),
      `Manifest row ${id} has no command and is not declared a non-command row`,
    );
  }
  for (const command of document.commands) {
    assert.deepEqual(
      command.deliveryPlanIds,
      [...new Set(command.manifestIds.flatMap((id) => planById.get(id) ?? []))].sort(),
      `${command.id}: deliveryPlanIds must be computed from the issue map`,
    );
  }

  const prototypeFunctions = prototypeCommandFunctions(prototypeSource);
  const referenced = new Set(document.commands.flatMap((command) => command.prototypeFunctions));
  for (const name of prototypeFunctions) {
    assert.ok(referenced.has(name), `Prototype command ${name} has no Studio command id`);
  }

  const web = parseWebVocabulary(webSource);
  assert.deepEqual(web.ids, ids, 'Web command ids drifted from the catalogue');
  assert.deepEqual([...web.payloadKeys].sort(), [...ids].sort(), 'Web payload types drifted from the catalogue');
  assert.deepEqual(
    web.rows.map((row) => row.id),
    ids,
    'Web registry rows drifted from the catalogue',
  );
  const byId = new Map(document.commands.map((command) => [command.id, command]));
  for (const row of web.rows) {
    const command = byId.get(row.id);
    assert.equal(row.scope, command.scope, `${row.id}: web scope drifted`);
    assert.equal(row.mutatesGraph, command.mutatesGraph, `${row.id}: web mutatesGraph drifted`);
    assert.equal(row.undoable, command.undoable, `${row.id}: web undoable drifted`);
    assert.equal(row.capability, command.capability, `${row.id}: web capability drifted`);
    assert.equal(row.owner, command.owner, `${row.id}: web owner drifted`);
    assert.equal(row.prototypeSource, command.prototypeSource, `${row.id}: web prototype source drifted`);
  }
}

/* ------------------------------------------------------------------ */
/* Entry point                                                          */
/* ------------------------------------------------------------------ */

const read = (root, file) => readFile(path.join(root, file), 'utf8');

export async function generate(root) {
  const [manifestText, issueMapText, prototypeSource, webSource] = await Promise.all([
    read(root, MANIFEST_PATH),
    read(root, ISSUE_MAP_PATH),
    read(root, PROTOTYPE_PATH),
    read(root, WEB_VOCABULARY_PATH),
  ]);
  const manifest = JSON.parse(manifestText);
  const issueMap = JSON.parse(issueMapText);
  const document = buildCatalogueDocument(issueMap);
  validate({ document, manifest, issueMap, prototypeSource, webSource });
  return {
    document,
    files: {
      [CATALOGUE_PATH]: canonicalJson(document),
      [SERVER_MIRROR_PATH]: buildServerMirror(document),
    },
  };
}

export async function main(argv, root) {
  const write = argv.includes('--write');
  const { document, files } = await generate(root);
  const stale = [];
  for (const [file, content] of Object.entries(files)) {
    if (write) {
      await writeFile(path.join(root, file), content);
      continue;
    }
    const current = await readFile(path.join(root, file), 'utf8').catch(() => null);
    if (current !== content) {
      stale.push(file);
    }
  }
  if (stale.length > 0) {
    process.stderr.write(
      `Studio command contracts are stale:\n  ${stale.join('\n  ')}\nRun: node ${GENERATOR} --write\n`,
    );
    return 1;
  }
  process.stdout.write(
    `Studio command catalogue verified: ${document.counts.commands} commands, ` +
      `${document.counts.manifestRowsMapped} mapped manifest rows, ` +
      `${document.counts.manifestRowsDeclaredNonCommand} declared non-command rows.\n`,
  );
  return 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  const rootIndex = process.argv.indexOf('--repository');
  const root = rootIndex === -1 ? process.cwd() : process.argv[rootIndex + 1];
  process.exitCode = await main(process.argv.slice(2), root);
}
