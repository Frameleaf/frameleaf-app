#!/usr/bin/env node

/**
 * The canonical Studio command catalogue and its generated contracts.
 *
 * This table generates studio/frameleaf-studio-commands.json and the server envelope
 * mirror. The default --check mode verifies both artifacts, the web vocabulary, and
 * coverage of every pinned Freecut feature row.
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
export const MANIFEST_PATH = 'studio/freecut-feature-manifest.json';
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
 * `time`, `duration` and `rate` are exact rationals, never floats: an
 * instant on the timeline, a length, and a cadence or speed multiplier. They travel as a
 * reduced `{ num, den }` pair of integers, which is the only representation in which an
 * NTSC boundary the person set is the boundary the encoder is asked for. The web side
 * types them `StudioTime`, `StudioDuration` and `StudioRate` over `Rational`.
 *
 * `object` and `object[]` are deliberately opaque: a payload carries *intent*, and any
 * graph-shaped value inside it round-trips unread so an unknown Freecut field, a null, an
 * array or a rational timing extension survives web, server and native.
 */
export const FIELD_TYPES = [
  'Array<{id:string,at:Rational,gainDb:number}>',
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
 * `manifestIds` names the pinned Freecut feature rows this command reaches. An empty
 * list means the command is a Frameleaf addition with no upstream row.
 */
export const catalogue = [
  {
    id: 'captions.set',
    scope: 'sequence',
    mutatesGraph: true,
    undoable: true,
    capability: 'transcriptionWorker',
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
    id: 'clip.join',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    manifestIds: ['readme.timeline-editing.3'],
    payload: { clipIds: 'string[]' },
    description: 'Join contiguous parts of one source back into a clip, with their linked parts.',
  },
  {
    id: 'clip.move',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    manifestIds: ['command.moveItem'],
    payload: { clipId: 'string', start: 'time', trackId: 'string?', linkedSelectionEnabled: 'boolean?' },
    description: 'Move a clip to another time and optionally another track, carrying linked clips unless linkedSelectionEnabled is false (defaults to true).',
  },
  {
    id: 'clip.overwrite',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
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
    id: 'clip.push',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    manifestIds: ['readme.timeline-editing.5'],
    payload: { clipId: 'string', delta: 'duration' },
    description: 'Push or pull everything from a clip onward, on every track, by a signed delta.',
  },
  {
    id: 'clip.relink',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    manifestIds: ['readme.media-import.4'],
    payload: { clipId: 'string', assetId: 'string' },
    description: 'Point a placed clip and its synchronised linked clips at another library asset.',
  },
  {
    id: 'clip.reorder',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
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
    manifestIds: ['extra.interpolation-rife'],
    payload: { clipId: 'string', targetFps: 'rate', destinationId: 'string', factor: 'number?' },
    description: 'Queue frame interpolation for a clip to an explicit destination.',
  },
  {
    id: 'job.enqueueMusicGeneration',
    scope: 'job',
    mutatesGraph: false,
    undoable: false,
    capability: 'generationWorker',
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
    manifestIds: [],
    payload: {
      mode: 'string',
      upscale: 'number',
      preview: 'boolean',
      destinationId: 'string',
      assetId: 'string?',
      restorationId: 'string?',
      keepGrain: 'boolean?',
    },
    description: 'Queue a Frameleaf restoration pass with an explicit, never implicit, destination.',
  },
  {
    id: 'job.enqueueReverseConform',
    scope: 'job',
    mutatesGraph: false,
    undoable: false,
    capability: 'renderWorker',
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
    manifestIds: ['readme.keyframe-animation.2'],
    payload: {
      clipId: 'string',
      property: 'string',
      keyframeIds: 'string[]',
      easing: 'string',
      bezier: 'object?',
      spring: 'object?',
    },
    description: 'Set easing, an explicit bezier or spring parameters on selected keyframes.',
  },
  {
    id: 'keyframe.update',
    scope: 'keyframe',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    manifestIds: ['readme.keyframe-animation.1'],
    payload: {
      clipId: 'string',
      property: 'string',
      keyframeId: 'string',
      at: 'time?',
      value: 'object?',
      temporalEase: 'object?',
      spatial: 'object?',
    },
    description:
      'Retime or revalue one keyframe from the graph editor or dopesheet, or set its velocity handles and path tangents.',
  },
  {
    id: 'lottie.update',
    scope: 'media',
    mutatesGraph: true,
    undoable: true,
    capability: null,
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
    manifestIds: ['readme.timeline-editing.8'],
    payload: { templateId: 'string', timing: 'string?' },
    description:
      'Apply a project template, including canvas and frame rate defaults; a rate change on existing content needs timing keep-time or keep-frames.',
  },
  {
    id: 'project.exportBundle',
    scope: 'project',
    mutatesGraph: false,
    undoable: false,
    capability: null,
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
    manifestIds: ['readme.preview-playback.6'],
    payload: {
      gainDb: 'number?',
      muted: 'boolean?',
      ducking: 'boolean?',
      gainEnvelope: 'Array<{id:string,at:Rational,gainDb:number}>?',
    },
    description: 'Set the project master bus, which is not the monitor or device volume.',
  },
  {
    id: 'project.setSettings',
    scope: 'project',
    mutatesGraph: true,
    undoable: false,
    capability: null,
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
    manifestIds: ['readme.timeline-editing.8'],
    payload: {
      sequenceId: 'string',
      fps: 'rate?',
      width: 'number?',
      height: 'number?',
      timing: 'string?',
    },
    description:
      'Set the sequence canvas and frame rate, including auto-match from first media; a rate change on existing content needs timing keep-time or keep-frames.',
  },
  {
    id: 'text.setMotion',
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
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
    manifestIds: ['command.addTrack'],
    payload: { kind: 'string', name: 'string?', index: 'number?' },
    description: 'Add a track of a kind at an index.',
  },
  {
    id: 'track.closeGap',
    scope: 'track',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    manifestIds: ['readme.timeline-editing.5'],
    payload: { trackId: 'string', at: 'time?' },
    description: 'Close the gap at a time on a track, or every gap on it, rippling later clips.',
  },
  {
    id: 'track.remove',
    scope: 'track',
    mutatesGraph: true,
    undoable: true,
    capability: null,
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
    manifestIds: ['extra.microphone'],
    payload: { at: 'time', duration: 'duration', uploadId: 'string' },
    description: 'Place a recorded or generated voiceover on the voice track.',
  },
];

/**
 * Pinned manifest rows that are deliberately not commands.
 * A row here is a capability, a runtime behaviour, a read-only surface or a host-owned
 * lifecycle action: reaching it does not mean sending an editing command. The check rejects
 * any manifest row that is neither mapped nor listed here, so this table is the only way a
 * row can be left out, and it cannot be left out silently.
 *
 * `commands` names the catalogue commands whose graph edits are the row's behaviour in
 * Frameleaf: the row is not one command, but those commands are what the command matrix
 * measures for it (scripts/frameleaf-studio-evidence.mjs reads the link from the published
 * catalogue). A row with no command behind it at all says what covers it instead in
 * `withoutCommand`; the check rejects a row that has neither, a row that has both, and a
 * link to a command the catalogue does not have. Each link was reviewed by the row's owner.
 */
export const nonCommandRows = [
  // FL-98: the bento layout (bento-layout.ts) arranges the selected items on the canvas by
  // writing their transforms, as one undoable edit (applyBentoLayout). It is a graph change; it
  // is listed here because it has no command of its own. Only the saved custom presets
  // (bento-presets-store.ts) are a client preference.
  {
    id: 'extra.bento',
    reason: 'Arranges the selected clips on the canvas by writing their transforms; it has no command of its own.',
    commands: ['clip.setTransform'],
  },
  {
    id: 'extra.portable-headless',
    reason: 'Workspace and lifecycle API the host owns; not an in-editor command.',
    withoutCommand: 'The headless render contract is the render worker; its probes cover it, not a command.',
  },
  {
    id: 'module.docs',
    reason: 'Source module inventory row, not an action.',
    withoutCommand: 'In-app help pages are read-only documentation; nothing edits the project.',
  },
  // FL-88: the editor is the mount every command reaches the graph through; its own commands are
  // undo and redo.
  {
    id: 'module.editor',
    reason: 'Source module inventory row, not an action.',
    commands: ['history.undo', 'history.redo'],
  },
  // FL-99: the effect-management feature as a whole; these four are exactly its graph
  // operations.
  {
    id: 'module.effects',
    reason: 'Source module inventory row, not an action.',
    commands: ['effect.add', 'effect.remove', 'effect.reorder', 'effect.update'],
  },
  // FL-105: export in Frameleaf is the export job and the project bundle.
  {
    id: 'module.export',
    reason: 'Source module inventory row, not an action.',
    commands: ['job.enqueueExport', 'project.exportBundle'],
  },
  // FL-100: keyframes and the property modifiers and expressions the keyframe editor drives.
  {
    id: 'module.keyframes',
    reason: 'Source module inventory row, not an action.',
    commands: [
      'keyframe.add',
      'keyframe.remove',
      'keyframe.setEasing',
      'keyframe.update',
      'property.bakeModifier',
      'property.setExpression',
      'property.setModifier',
    ],
  },
  // FL-105: the Lottie browser places a Lottie item and edits it.
  {
    id: 'module.lottie-browser',
    reason: 'Source module inventory row, not an action.',
    commands: ['clip.add', 'lottie.update'],
  },
  // FL-105: the media library's import, relink and removal.
  {
    id: 'module.media-library',
    reason: 'Source module inventory row, not an action.',
    commands: ['clip.relink', 'media.import', 'media.relink', 'media.remove'],
  },
  // FL-98: the preview module edits the graph only through its gizmos (transform, parenting,
  // crop, mask); its frames come from preview.request/release, which the matrix measures at the
  // gate only, as host services.
  {
    id: 'module.preview',
    reason: 'Source module inventory row, not an action.',
    commands: [
      'clip.setTransform',
      'clip.setTransformParent',
      'clip.setCrop',
      'clip.setMask',
      'preview.request',
      'preview.release',
    ],
  },
  // FL-91: bundles export and import a whole project.
  {
    id: 'module.project-bundle',
    reason: 'Source module inventory row, not an action.',
    commands: ['project.exportBundle', 'project.importBundle'],
  },
  // FL-91: what a project holds in the editor: its name, settings, template and sequences.
  {
    id: 'module.projects',
    reason: 'Source module inventory row, not an action.',
    commands: [
      'project.rename',
      'project.setSettings',
      'project.applyTemplate',
      'sequence.add',
      'sequence.duplicate',
      'sequence.remove',
      'sequence.setActive',
      'sequence.setFields',
      'sequence.setSettings',
    ],
  },
  // FL-111: the scene browser shows detected scenes and inserts the chosen one.
  {
    id: 'module.scene-browser',
    reason: 'Source module inventory row, not an action.',
    commands: ['job.enqueueSceneDetection', 'clip.insert'],
  },
  {
    id: 'module.settings',
    reason: 'Source module inventory row, not an action.',
    withoutCommand: 'Editor preferences and hotkeys are per-device state, not the project graph.',
  },
  // FL-94: the timeline module is the timeline's own edits: clips, tracks and markers.
  {
    id: 'module.timeline',
    reason: 'Source module inventory row, not an action.',
    commands: [
      'clip.add',
      'clip.delete',
      'clip.insert',
      'clip.join',
      'clip.move',
      'clip.overwrite',
      'clip.push',
      'clip.reorder',
      'clip.roll',
      'clip.setLink',
      'clip.setSpeed',
      'clip.slide',
      'clip.slip',
      'clip.split',
      'clip.trimEnd',
      'clip.trimStart',
      'marker.add',
      'marker.remove',
      'marker.update',
      'track.add',
      'track.closeGap',
      'track.remove',
      'track.reorder',
      'track.set',
    ],
  },
  {
    id: 'module.workspace-gate',
    reason: 'Source module inventory row, not an action.',
    withoutCommand: 'Replaced by server project storage: there is no workspace folder to ask for.',
  },
  // FL-103: pitch, EQ, fades and volume are clip and track audio; transition audio is the
  // transition itself.
  {
    id: 'readme.audio.4',
    reason: 'Render-path preservation obligation proved by export evidence, not by a command.',
    commands: ['clip.setAudio', 'track.setAudio', 'clip.setTransition'],
  },
  // FL-99: the colour picker and eyedropper are preview-axis controls; what they produce is a
  // colour value committed through effect.update (gradient map, chroma key, temperature tint)
  // or clip.update (shape fill and stroke, text colour). The command matrix does not yet
  // exercise a colour-typed invalid case (malformed hex or alpha), so this row's `invalid` case
  // stays missing even with the link in place.
  {
    id: 'readme.effects-masks-compositing.8',
    reason: 'Colour picker and eyedropper; an input control whose result travels in another payload.',
    commands: ['effect.update', 'clip.update'],
  },
  {
    id: 'readme.local-ai-analysis.7',
    reason: 'Model cache and unload controls live in settings, outside the project graph.',
    withoutCommand: 'Model cache and unload controls are per-device settings, not the project graph.',
  },
  // FL-105: ProRes sources are imported and previewed like any other source.
  {
    id: 'readme.media-import.3',
    reason: 'ProRes decode is a deployment capability, not an editing command.',
    commands: ['media.import', 'preview.request'],
  },
  // FL-98: frame-accurate playback is the exact frame at a rational time, asked for by
  // preview.request (FL-93/FL-96).
  {
    id: 'readme.preview-playback.2',
    reason: 'Playback clock and composition runtime; no graph change.',
    commands: ['preview.request'],
  },
  {
    id: 'readme.preview-playback.3',
    reason: 'Scrub overlays, prewarming and adaptive quality; no graph change.',
    withoutCommand: 'Playback performance only; nothing changes the graph.',
  },
  {
    id: 'readme.preview-playback.5',
    reason: 'Colour scopes are read-only measurement surfaces.',
    withoutCommand: 'The scopes measure the picture and never edit it.',
  },
  {
    id: 'readme.projects-storage.1',
    reason: 'Project storage is server-side here; the workspace folder API does not apply.',
    withoutCommand: 'Replaced by server project storage; covered by the save and reopen cases of the graph axis.',
  },
  {
    id: 'readme.projects-storage.2',
    reason: 'Workspace switching is replaced by the account library; not an editing command.',
    withoutCommand: 'Replaced by the server project library; covered by the project service.',
  },
  {
    id: 'readme.projects-storage.3',
    reason: 'Project storage and migration are host lifecycle, not editing commands.',
    withoutCommand: 'Projects are stored as server revisions; covered by the save and reopen cases of the graph axis.',
  },
  {
    id: 'readme.projects-storage.4',
    reason: 'Project trash and delete flows are host lifecycle with their own authorization.',
    withoutCommand:
      'Trash, restore and permanent delete are measured on the project service against a real database, not through an editor command.',
  },
  {
    id: 'readme.projects-storage.6',
    reason: 'Auto-save, thumbnails and orphan cleanup are host obligations, not commands.',
    withoutCommand: 'Autosave is the save and reopen cases of the graph axis; the rest is server housekeeping.',
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

/* ------------------------------------------------------------------ */
/* Artifacts                                                            */
/* ------------------------------------------------------------------ */

/** The published catalogue. */
export function buildCatalogueDocument(manifest) {
  const commands = catalogue.map((command) => ({
    capability: command.capability,
    description: command.description,
    id: command.id,
    manifestIds: [...command.manifestIds].sort(),
    mutatesGraph: command.mutatesGraph,
    payload: command.payload,
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
      manifestRows: manifest.features.length,
      manifestRowsDeclaredNonCommand: nonCommandRows.length,
      manifestRowsMapped: mapped.size,
      nonCommandRowsLinkedToCommands: nonCommandRows.filter((row) => (row.commands ?? []).length > 0).length,
    },
    engine: ENGINE,
    engineRevision: ENGINE_REVISION,
    fieldTypes: FIELD_TYPES,
    generator: GENERATOR,
    manifestPath: MANIFEST_PATH,
    nonCommandRows: [...nonCommandRows]
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map(({ id, reason, commands = [], withoutCommand }) => ({
        commands: [...commands].sort(),
        id,
        reason,
        ...(withoutCommand === undefined ? {} : { withoutCommand }),
      })),
    schemaVersion: SCHEMA_VERSION,
    scopes: SCOPES,
    webVocabularyPath: WEB_VOCABULARY_PATH,
  };
}

const TS_HEADER = `/**
 * GENERATED FILE — do not edit.
 *
 * Source: ${CATALOGUE_PATH}
 * Generator: ${GENERATOR}
 *
 * The server mirror of the canonical Studio command vocabulary. It
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

/* ------------------------------------------------------------------ */
/* Checks                                                              */
/* ------------------------------------------------------------------ */

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
    }));
  return { ids, payloadKeys, rows };
}

export function validate({ document, manifest, webSource }) {
  const ids = document.commands.map((command) => command.id);
  assert.deepEqual([...ids].sort(), ids, 'Catalogue rows must stay sorted by id');
  assert.equal(new Set(ids).size, ids.length, 'Duplicate command id');
  for (const command of document.commands) {
    assert.ok(SCOPES.includes(command.scope), `${command.id}: unknown scope`);
    assert.ok(
      command.capability === null || CAPABILITIES.includes(command.capability),
      `${command.id}: unknown capability`,
    );
    assert.ok(command.description.length > 0, `${command.id}: missing description`);
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
  const declared = new Set(document.nonCommandRows.map((row) => row.id));
  for (const row of document.nonCommandRows) {
    assert.ok(manifestIds.has(row.id), `Non-command row ${row.id} is not a manifest row`);
    assert.ok(row.reason.length > 0, `Non-command row ${row.id} needs a reason`);
    // A non-command row is still proved by something: the commands whose edits are its
    // behaviour, or a stated reason nothing in the catalogue is. Never neither, never both.
    assert.ok(Array.isArray(row.commands), `Non-command row ${row.id} needs a commands list`);
    assert.equal(new Set(row.commands).size, row.commands.length, `Non-command row ${row.id} names a command twice`);
    for (const id of row.commands) {
      assert.ok(ids.includes(id), `Non-command row ${row.id} is linked to unknown command ${id}`);
    }
    if (row.commands.length === 0) {
      assert.ok(
        typeof row.withoutCommand === 'string' && row.withoutCommand.length > 0,
        `Non-command row ${row.id} is linked to no command and does not say what covers it instead`,
      );
    } else {
      assert.ok(
        !Object.hasOwn(row, 'withoutCommand'),
        `Non-command row ${row.id} is linked to a command and also claims to have none`,
      );
    }
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
  }
}

/* ------------------------------------------------------------------ */
/* Entry point                                                          */
/* ------------------------------------------------------------------ */

const read = (root, file) => readFile(path.join(root, file), 'utf8');

export async function generate(root) {
  const [manifestText, webSource] = await Promise.all([
    read(root, MANIFEST_PATH),
    read(root, WEB_VOCABULARY_PATH),
  ]);
  const manifest = JSON.parse(manifestText);
  const document = buildCatalogueDocument(manifest);
  validate({ document, manifest, webSource });
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
