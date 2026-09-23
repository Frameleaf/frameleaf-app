// GENERATED CODE - DO NOT MODIFY BY HAND.
//
// Source: studio/frameleaf-studio-commands.json
// Generator: scripts/frameleaf-studio-commands.mjs
//
// The native contract for the canonical Studio command vocabulary (FL-92, `STU-205`).
// Native clients build command envelopes from this table instead of restating the
// vocabulary, so a command the web host accepts and a command the phone or tablet sends
// cannot drift. Payload values typed `object` are opaque maps that are carried through
// unread, which is what keeps unknown graph fields, nulls, arrays and rational timing
// extensions lossless on the way to the server.
//
// This file publishes the contract. It does not implement any command: every row names the
// story that owns its semantics, and the server answers `not-implemented` until that
// story lands.

const int frameleafStudioCommandSchemaVersion = 1;

const String frameleafStudioEngineRevision = '4d62e8082c5eb387a96275bcbd323d28f6e41a62';

/// The part of the project a command acts on.
enum FrameleafStudioScope {
  clip,
  composition,
  effect,
  history,
  job,
  keyframe,
  media,
  project,
  review,
  sequence,
  track,
}

/// A worker capability a command needs before it may be offered or accepted.
enum FrameleafStudioCapability {
  analysisWorker,
  generationWorker,
  gpuWorker,
  renderWorker,
  restorationWorker,
  transcriptionWorker,
}

/// An exact rational: a reduced fraction of two integers, never a float.
///
/// A `time`, `duration` or `rate` field carries one of these (FL-93). On the wire it is
/// the pair the web host and the server use, `{"num": .., "den": ..}`; here the two
/// integers are named, so native code cannot mistake it for a double.
class FrameleafStudioRational {
  const FrameleafStudioRational(this.numerator, this.denominator);

  factory FrameleafStudioRational.fromJson(Map<String, dynamic> json) {
    final Object? numerator = json['num'];
    final Object? denominator = json['den'];
    if (numerator is! int || denominator is! int || denominator <= 0) {
      throw const FormatException('a rational needs integer num and positive den');
    }
    return FrameleafStudioRational(numerator, denominator);
  }

  final int numerator;
  final int denominator;

  Map<String, dynamic> toJson() => <String, dynamic>{
    'num': numerator,
    'den': denominator,
  };

  @override
  String toString() => '$numerator/$denominator';
}

/// The field types that carry a [FrameleafStudioRational].
const Set<String> frameleafStudioRationalFieldTypes = <String>{
  'time',
  'duration',
  'rate',
};

/// One payload field: its name, its declared type and whether it must be present.
class FrameleafStudioField {
  const FrameleafStudioField(this.name, this.type, this.required);

  final String name;
  final String type;
  final bool required;
}

/// One published command.
class FrameleafStudioCommand {
  const FrameleafStudioCommand({
    required this.id,
    required this.scope,
    required this.mutatesGraph,
    required this.undoable,
    required this.capability,
    required this.owner,
    required this.payload,
  });

  final String id;
  final FrameleafStudioScope scope;
  final bool mutatesGraph;
  final bool undoable;
  final FrameleafStudioCapability? capability;
  final String owner;
  final List<FrameleafStudioField> payload;
}

const List<FrameleafStudioCommand> frameleafStudioCommands = <FrameleafStudioCommand>[
  FrameleafStudioCommand(
    id: 'captions.set',
    scope: FrameleafStudioScope.sequence,
    mutatesGraph: true,
    undoable: true,
    capability: FrameleafStudioCapability.transcriptionWorker,
    owner: 'FL-94',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('captions', 'object[]', true),
    ],
  ),
  FrameleafStudioCommand(
    id: 'clip.add',
    scope: FrameleafStudioScope.clip,
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('assetId', 'string', true),
      FrameleafStudioField('at', 'time', true),
      FrameleafStudioField('duration', 'duration', false),
      FrameleafStudioField('kind', 'string', false),
      FrameleafStudioField('trackId', 'string', true),
    ],
  ),
  FrameleafStudioCommand(
    id: 'clip.delete',
    scope: FrameleafStudioScope.clip,
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('clipId', 'string', false),
      FrameleafStudioField('clipIds', 'string[]', false),
      FrameleafStudioField('ripple', 'boolean', false),
    ],
  ),
  FrameleafStudioCommand(
    id: 'clip.group',
    scope: FrameleafStudioScope.clip,
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-100',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('clipIds', 'string[]', true),
      FrameleafStudioField('name', 'string', false),
    ],
  ),
  FrameleafStudioCommand(
    id: 'clip.insert',
    scope: FrameleafStudioScope.clip,
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('assetId', 'string', true),
      FrameleafStudioField('at', 'time', true),
      FrameleafStudioField('sourceIn', 'time', true),
      FrameleafStudioField('sourceOut', 'time', true),
      FrameleafStudioField('trackId', 'string', true),
    ],
  ),
  FrameleafStudioCommand(
    id: 'clip.move',
    scope: FrameleafStudioScope.clip,
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('clipId', 'string', true),
      FrameleafStudioField('start', 'time', true),
      FrameleafStudioField('trackId', 'string', false),
    ],
  ),
  FrameleafStudioCommand(
    id: 'clip.overwrite',
    scope: FrameleafStudioScope.clip,
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('assetId', 'string', true),
      FrameleafStudioField('at', 'time', true),
      FrameleafStudioField('sourceIn', 'time', true),
      FrameleafStudioField('sourceOut', 'time', true),
      FrameleafStudioField('trackId', 'string', true),
    ],
  ),
  FrameleafStudioCommand(
    id: 'clip.reorder',
    scope: FrameleafStudioScope.clip,
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('clipId', 'string', true),
      FrameleafStudioField('index', 'number', true),
      FrameleafStudioField('trackId', 'string', true),
    ],
  ),
  FrameleafStudioCommand(
    id: 'clip.roll',
    scope: FrameleafStudioScope.clip,
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('at', 'time', true),
      FrameleafStudioField('clipId', 'string', true),
    ],
  ),
  FrameleafStudioCommand(
    id: 'clip.setAudio',
    scope: FrameleafStudioScope.clip,
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-103',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('clipId', 'string', true),
      FrameleafStudioField('eq', 'object', false),
      FrameleafStudioField('fadeIn', 'duration', false),
      FrameleafStudioField('fadeOut', 'duration', false),
      FrameleafStudioField('muted', 'boolean', false),
      FrameleafStudioField('pitchCents', 'number', false),
      FrameleafStudioField('pitchSemitones', 'number', false),
      FrameleafStudioField('volume', 'number', false),
    ],
  ),
  FrameleafStudioCommand(
    id: 'clip.setBlendMode',
    scope: FrameleafStudioScope.clip,
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-99',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('blendMode', 'string', true),
      FrameleafStudioField('clipId', 'string', true),
      FrameleafStudioField('opacity', 'number', false),
    ],
  ),
  FrameleafStudioCommand(
    id: 'clip.setCrop',
    scope: FrameleafStudioScope.clip,
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-98',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('clipId', 'string', true),
      FrameleafStudioField('cornerPin', 'object', false),
      FrameleafStudioField('crop', 'object', false),
    ],
  ),
  FrameleafStudioCommand(
    id: 'clip.setGrade',
    scope: FrameleafStudioScope.clip,
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-98',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('clipId', 'string', true),
      FrameleafStudioField('grade', 'object', false),
    ],
  ),
  FrameleafStudioCommand(
    id: 'clip.setKenBurns',
    scope: FrameleafStudioScope.clip,
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('clipId', 'string', true),
      FrameleafStudioField('kenBurns', 'object', false),
    ],
  ),
  FrameleafStudioCommand(
    id: 'clip.setLink',
    scope: FrameleafStudioScope.clip,
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('clipIds', 'string[]', true),
      FrameleafStudioField('linked', 'boolean', true),
    ],
  ),
  FrameleafStudioCommand(
    id: 'clip.setMask',
    scope: FrameleafStudioScope.clip,
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-99',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('clipId', 'string', true),
      FrameleafStudioField('mask', 'object', false),
    ],
  ),
  FrameleafStudioCommand(
    id: 'clip.setSpeed',
    scope: FrameleafStudioScope.clip,
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('clipId', 'string', true),
      FrameleafStudioField('speed', 'rate', true),
    ],
  ),
  FrameleafStudioCommand(
    id: 'clip.setTransform',
    scope: FrameleafStudioScope.clip,
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('clipId', 'string', true),
      FrameleafStudioField('transform', 'object', true),
    ],
  ),
  FrameleafStudioCommand(
    id: 'clip.setTransformParent',
    scope: FrameleafStudioScope.clip,
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-100',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('clipId', 'string', true),
      FrameleafStudioField('parentId', 'string', false),
    ],
  ),
  FrameleafStudioCommand(
    id: 'clip.setTransition',
    scope: FrameleafStudioScope.clip,
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('clipId', 'string', true),
      FrameleafStudioField('transition', 'object', false),
    ],
  ),
  FrameleafStudioCommand(
    id: 'clip.slide',
    scope: FrameleafStudioScope.clip,
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('clipId', 'string', true),
      FrameleafStudioField('delta', 'duration', true),
    ],
  ),
  FrameleafStudioCommand(
    id: 'clip.slip',
    scope: FrameleafStudioScope.clip,
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('clipId', 'string', true),
      FrameleafStudioField('delta', 'duration', true),
    ],
  ),
  FrameleafStudioCommand(
    id: 'clip.split',
    scope: FrameleafStudioScope.clip,
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('at', 'time', true),
      FrameleafStudioField('clipIds', 'string[]', false),
    ],
  ),
  FrameleafStudioCommand(
    id: 'clip.trimEnd',
    scope: FrameleafStudioScope.clip,
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('clipId', 'string', true),
      FrameleafStudioField('end', 'time', true),
      FrameleafStudioField('ripple', 'boolean', false),
    ],
  ),
  FrameleafStudioCommand(
    id: 'clip.trimStart',
    scope: FrameleafStudioScope.clip,
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('clipId', 'string', true),
      FrameleafStudioField('ripple', 'boolean', false),
      FrameleafStudioField('start', 'time', true),
    ],
  ),
  FrameleafStudioCommand(
    id: 'clip.ungroup',
    scope: FrameleafStudioScope.clip,
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-100',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('groupId', 'string', true),
    ],
  ),
  FrameleafStudioCommand(
    id: 'clip.update',
    scope: FrameleafStudioScope.clip,
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('clipId', 'string', true),
      FrameleafStudioField('patch', 'object', true),
    ],
  ),
  FrameleafStudioCommand(
    id: 'composition.add',
    scope: FrameleafStudioScope.composition,
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-100',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('at', 'time', false),
      FrameleafStudioField('clipIds', 'string[]', false),
      FrameleafStudioField('name', 'string', true),
      FrameleafStudioField('trackId', 'string', false),
    ],
  ),
  FrameleafStudioCommand(
    id: 'composition.setControlOverrides',
    scope: FrameleafStudioScope.composition,
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-100',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('compositionClipId', 'string', true),
      FrameleafStudioField('overrides', 'object', true),
    ],
  ),
  FrameleafStudioCommand(
    id: 'composition.setPublishedControls',
    scope: FrameleafStudioScope.composition,
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-100',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('compositionId', 'string', true),
      FrameleafStudioField('controls', 'object[]', true),
    ],
  ),
  FrameleafStudioCommand(
    id: 'effect.add',
    scope: FrameleafStudioScope.effect,
    mutatesGraph: true,
    undoable: true,
    capability: FrameleafStudioCapability.gpuWorker,
    owner: 'FL-99',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('clipId', 'string', true),
      FrameleafStudioField('effect', 'string', true),
      FrameleafStudioField('index', 'number', false),
      FrameleafStudioField('params', 'object', false),
    ],
  ),
  FrameleafStudioCommand(
    id: 'effect.remove',
    scope: FrameleafStudioScope.effect,
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-99',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('clipId', 'string', true),
      FrameleafStudioField('effectId', 'string', true),
    ],
  ),
  FrameleafStudioCommand(
    id: 'effect.reorder',
    scope: FrameleafStudioScope.effect,
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-99',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('clipId', 'string', true),
      FrameleafStudioField('effectId', 'string', true),
      FrameleafStudioField('index', 'number', true),
    ],
  ),
  FrameleafStudioCommand(
    id: 'effect.update',
    scope: FrameleafStudioScope.effect,
    mutatesGraph: true,
    undoable: true,
    capability: FrameleafStudioCapability.gpuWorker,
    owner: 'FL-99',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('clipId', 'string', true),
      FrameleafStudioField('effectId', 'string', true),
      FrameleafStudioField('params', 'object', true),
    ],
  ),
  FrameleafStudioCommand(
    id: 'history.redo',
    scope: FrameleafStudioScope.history,
    mutatesGraph: true,
    undoable: false,
    capability: null,
    owner: 'FL-94',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('toRevision', 'number', false),
    ],
  ),
  FrameleafStudioCommand(
    id: 'history.undo',
    scope: FrameleafStudioScope.history,
    mutatesGraph: true,
    undoable: false,
    capability: null,
    owner: 'FL-94',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('toRevision', 'number', false),
    ],
  ),
  FrameleafStudioCommand(
    id: 'job.cancel',
    scope: FrameleafStudioScope.job,
    mutatesGraph: false,
    undoable: false,
    capability: null,
    owner: 'FL-104',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('jobId', 'string', true),
    ],
  ),
  FrameleafStudioCommand(
    id: 'job.enqueueCaptioning',
    scope: FrameleafStudioScope.job,
    mutatesGraph: false,
    undoable: false,
    capability: FrameleafStudioCapability.analysisWorker,
    owner: 'FL-111',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('clipIds', 'string[]', false),
      FrameleafStudioField('destinationId', 'string', true),
      FrameleafStudioField('sampleCadence', 'duration', false),
      FrameleafStudioField('sequenceId', 'string', true),
    ],
  ),
  FrameleafStudioCommand(
    id: 'job.enqueueExport',
    scope: FrameleafStudioScope.job,
    mutatesGraph: false,
    undoable: false,
    capability: FrameleafStudioCapability.renderWorker,
    owner: 'FL-104',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('audioFormat', 'string', false),
      FrameleafStudioField('colour', 'string', true),
      FrameleafStudioField('container', 'string', false),
      FrameleafStudioField('destinationId', 'string', true),
      FrameleafStudioField('format', 'string', true),
      FrameleafStudioField('quality', 'string', false),
      FrameleafStudioField('resolution', 'string', true),
      FrameleafStudioField('sequenceId', 'string', true),
      FrameleafStudioField('subtitles', 'string', false),
      FrameleafStudioField('videoCodec', 'string', false),
    ],
  ),
  FrameleafStudioCommand(
    id: 'job.enqueueFillerRemoval',
    scope: FrameleafStudioScope.job,
    mutatesGraph: false,
    undoable: false,
    capability: FrameleafStudioCapability.analysisWorker,
    owner: 'FL-103',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('clipIds', 'string[]', false),
      FrameleafStudioField('destinationId', 'string', true),
      FrameleafStudioField('sequenceId', 'string', true),
    ],
  ),
  FrameleafStudioCommand(
    id: 'job.enqueueInterpolation',
    scope: FrameleafStudioScope.job,
    mutatesGraph: false,
    undoable: false,
    capability: FrameleafStudioCapability.restorationWorker,
    owner: 'FL-111',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('clipId', 'string', true),
      FrameleafStudioField('destinationId', 'string', true),
      FrameleafStudioField('targetFps', 'rate', true),
    ],
  ),
  FrameleafStudioCommand(
    id: 'job.enqueueMusicGeneration',
    scope: FrameleafStudioScope.job,
    mutatesGraph: false,
    undoable: false,
    capability: FrameleafStudioCapability.generationWorker,
    owner: 'FL-111',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('destinationId', 'string', true),
      FrameleafStudioField('duration', 'duration', true),
      FrameleafStudioField('preset', 'string', false),
      FrameleafStudioField('prompt', 'string', true),
    ],
  ),
  FrameleafStudioCommand(
    id: 'job.enqueueProxy',
    scope: FrameleafStudioScope.job,
    mutatesGraph: false,
    undoable: false,
    capability: FrameleafStudioCapability.renderWorker,
    owner: 'FL-105',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('assetIds', 'string[]', true),
      FrameleafStudioField('destinationId', 'string', true),
    ],
  ),
  FrameleafStudioCommand(
    id: 'job.enqueueRestoration',
    scope: FrameleafStudioScope.job,
    mutatesGraph: false,
    undoable: false,
    capability: FrameleafStudioCapability.restorationWorker,
    owner: 'FL-110',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('destinationId', 'string', true),
      FrameleafStudioField('mode', 'string', true),
      FrameleafStudioField('preview', 'boolean', true),
      FrameleafStudioField('upscale', 'number', true),
    ],
  ),
  FrameleafStudioCommand(
    id: 'job.enqueueReverseConform',
    scope: FrameleafStudioScope.job,
    mutatesGraph: false,
    undoable: false,
    capability: FrameleafStudioCapability.renderWorker,
    owner: 'FL-111',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('clipId', 'string', true),
      FrameleafStudioField('destinationId', 'string', true),
    ],
  ),
  FrameleafStudioCommand(
    id: 'job.enqueueSceneDetection',
    scope: FrameleafStudioScope.job,
    mutatesGraph: false,
    undoable: false,
    capability: FrameleafStudioCapability.analysisWorker,
    owner: 'FL-111',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('assetIds', 'string[]', true),
      FrameleafStudioField('destinationId', 'string', true),
      FrameleafStudioField('mode', 'string', true),
      FrameleafStudioField('verifyWithModel', 'boolean', false),
    ],
  ),
  FrameleafStudioCommand(
    id: 'job.enqueueSilenceRemoval',
    scope: FrameleafStudioScope.job,
    mutatesGraph: false,
    undoable: false,
    capability: FrameleafStudioCapability.analysisWorker,
    owner: 'FL-103',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('destinationId', 'string', true),
      FrameleafStudioField('minimumSilence', 'duration', false),
      FrameleafStudioField('sequenceId', 'string', true),
      FrameleafStudioField('thresholdDb', 'number', false),
    ],
  ),
  FrameleafStudioCommand(
    id: 'job.enqueueTextToSpeech',
    scope: FrameleafStudioScope.job,
    mutatesGraph: false,
    undoable: false,
    capability: FrameleafStudioCapability.generationWorker,
    owner: 'FL-111',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('destinationId', 'string', true),
      FrameleafStudioField('engine', 'string', false),
      FrameleafStudioField('text', 'string', true),
      FrameleafStudioField('voice', 'string', true),
    ],
  ),
  FrameleafStudioCommand(
    id: 'job.enqueueTranscription',
    scope: FrameleafStudioScope.job,
    mutatesGraph: false,
    undoable: false,
    capability: FrameleafStudioCapability.transcriptionWorker,
    owner: 'FL-111',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('destinationId', 'string', true),
      FrameleafStudioField('language', 'string', true),
      FrameleafStudioField('sequenceId', 'string', true),
    ],
  ),
  FrameleafStudioCommand(
    id: 'job.enqueueUpscale',
    scope: FrameleafStudioScope.job,
    mutatesGraph: false,
    undoable: false,
    capability: FrameleafStudioCapability.restorationWorker,
    owner: 'FL-111',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('clipId', 'string', true),
      FrameleafStudioField('destinationId', 'string', true),
      FrameleafStudioField('factor', 'number', true),
    ],
  ),
  FrameleafStudioCommand(
    id: 'keyframe.add',
    scope: FrameleafStudioScope.keyframe,
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-100',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('at', 'time', true),
      FrameleafStudioField('clipId', 'string', true),
      FrameleafStudioField('easing', 'string', false),
      FrameleafStudioField('property', 'string', true),
      FrameleafStudioField('value', 'object', true),
    ],
  ),
  FrameleafStudioCommand(
    id: 'keyframe.remove',
    scope: FrameleafStudioScope.keyframe,
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-100',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('clipId', 'string', true),
      FrameleafStudioField('keyframeIds', 'string[]', true),
      FrameleafStudioField('property', 'string', true),
    ],
  ),
  FrameleafStudioCommand(
    id: 'keyframe.setEasing',
    scope: FrameleafStudioScope.keyframe,
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-100',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('bezier', 'object', false),
      FrameleafStudioField('clipId', 'string', true),
      FrameleafStudioField('easing', 'string', true),
      FrameleafStudioField('keyframeIds', 'string[]', true),
      FrameleafStudioField('property', 'string', true),
    ],
  ),
  FrameleafStudioCommand(
    id: 'keyframe.update',
    scope: FrameleafStudioScope.keyframe,
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-100',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('at', 'time', false),
      FrameleafStudioField('clipId', 'string', true),
      FrameleafStudioField('keyframeId', 'string', true),
      FrameleafStudioField('property', 'string', true),
      FrameleafStudioField('value', 'object', false),
    ],
  ),
  FrameleafStudioCommand(
    id: 'lottie.update',
    scope: FrameleafStudioScope.media,
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-105',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('clipId', 'string', true),
      FrameleafStudioField('colors', 'object', false),
      FrameleafStudioField('slots', 'object', false),
      FrameleafStudioField('text', 'object', false),
    ],
  ),
  FrameleafStudioCommand(
    id: 'marker.add',
    scope: FrameleafStudioScope.sequence,
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('at', 'time', true),
      FrameleafStudioField('colour', 'string', false),
      FrameleafStudioField('name', 'string', false),
    ],
  ),
  FrameleafStudioCommand(
    id: 'marker.remove',
    scope: FrameleafStudioScope.sequence,
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('markerId', 'string', true),
    ],
  ),
  FrameleafStudioCommand(
    id: 'marker.update',
    scope: FrameleafStudioScope.sequence,
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('markerId', 'string', true),
      FrameleafStudioField('patch', 'object', true),
    ],
  ),
  FrameleafStudioCommand(
    id: 'media.import',
    scope: FrameleafStudioScope.media,
    mutatesGraph: true,
    undoable: false,
    capability: null,
    owner: 'FL-105',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('assetIds', 'string[]', true),
    ],
  ),
  FrameleafStudioCommand(
    id: 'media.relink',
    scope: FrameleafStudioScope.media,
    mutatesGraph: true,
    undoable: false,
    capability: null,
    owner: 'FL-105',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('assetId', 'string', true),
      FrameleafStudioField('mediaId', 'string', true),
    ],
  ),
  FrameleafStudioCommand(
    id: 'media.remove',
    scope: FrameleafStudioScope.media,
    mutatesGraph: true,
    undoable: false,
    capability: null,
    owner: 'FL-105',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('mediaIds', 'string[]', true),
    ],
  ),
  FrameleafStudioCommand(
    id: 'music.add',
    scope: FrameleafStudioScope.clip,
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('at', 'time', true),
      FrameleafStudioField('duration', 'duration', false),
      FrameleafStudioField('musicId', 'string', true),
      FrameleafStudioField('volume', 'number', false),
    ],
  ),
  FrameleafStudioCommand(
    id: 'project.applyTemplate',
    scope: FrameleafStudioScope.project,
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('templateId', 'string', true),
    ],
  ),
  FrameleafStudioCommand(
    id: 'project.exportBundle',
    scope: FrameleafStudioScope.project,
    mutatesGraph: false,
    undoable: false,
    capability: null,
    owner: 'FL-91',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('sequenceIds', 'string[]', false),
    ],
  ),
  FrameleafStudioCommand(
    id: 'project.importBundle',
    scope: FrameleafStudioScope.project,
    mutatesGraph: true,
    undoable: false,
    capability: null,
    owner: 'FL-91',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('bundleUploadId', 'string', true),
    ],
  ),
  FrameleafStudioCommand(
    id: 'project.rename',
    scope: FrameleafStudioScope.project,
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('name', 'string', true),
    ],
  ),
  FrameleafStudioCommand(
    id: 'project.setMasterAudio',
    scope: FrameleafStudioScope.project,
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-103',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('ducking', 'boolean', false),
      FrameleafStudioField('gainDb', 'number', false),
      FrameleafStudioField('muted', 'boolean', false),
    ],
  ),
  FrameleafStudioCommand(
    id: 'project.setSettings',
    scope: FrameleafStudioScope.project,
    mutatesGraph: true,
    undoable: false,
    capability: null,
    owner: 'FL-94',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('patch', 'object', true),
    ],
  ),
  FrameleafStudioCommand(
    id: 'property.bakeModifier',
    scope: FrameleafStudioScope.keyframe,
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-100',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('clipId', 'string', true),
      FrameleafStudioField('modifierId', 'string', true),
      FrameleafStudioField('property', 'string', true),
    ],
  ),
  FrameleafStudioCommand(
    id: 'property.setExpression',
    scope: FrameleafStudioScope.keyframe,
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-100',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('clipId', 'string', true),
      FrameleafStudioField('expression', 'string', false),
      FrameleafStudioField('property', 'string', true),
    ],
  ),
  FrameleafStudioCommand(
    id: 'property.setModifier',
    scope: FrameleafStudioScope.keyframe,
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-100',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('clipId', 'string', true),
      FrameleafStudioField('modifier', 'object', false),
      FrameleafStudioField('property', 'string', true),
    ],
  ),
  FrameleafStudioCommand(
    id: 'review.add',
    scope: FrameleafStudioScope.review,
    mutatesGraph: false,
    undoable: false,
    capability: null,
    owner: 'FL-94',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('text', 'string', true),
      FrameleafStudioField('time', 'time', true),
    ],
  ),
  FrameleafStudioCommand(
    id: 'review.remove',
    scope: FrameleafStudioScope.review,
    mutatesGraph: false,
    undoable: false,
    capability: null,
    owner: 'FL-94',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('commentId', 'string', true),
    ],
  ),
  FrameleafStudioCommand(
    id: 'review.update',
    scope: FrameleafStudioScope.review,
    mutatesGraph: false,
    undoable: false,
    capability: null,
    owner: 'FL-94',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('commentId', 'string', true),
      FrameleafStudioField('patch', 'object', true),
    ],
  ),
  FrameleafStudioCommand(
    id: 'sequence.add',
    scope: FrameleafStudioScope.sequence,
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('fps', 'rate', false),
      FrameleafStudioField('height', 'number', false),
      FrameleafStudioField('name', 'string', true),
      FrameleafStudioField('width', 'number', false),
    ],
  ),
  FrameleafStudioCommand(
    id: 'sequence.duplicate',
    scope: FrameleafStudioScope.sequence,
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('name', 'string', false),
      FrameleafStudioField('sequenceId', 'string', true),
    ],
  ),
  FrameleafStudioCommand(
    id: 'sequence.remove',
    scope: FrameleafStudioScope.sequence,
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('sequenceId', 'string', true),
    ],
  ),
  FrameleafStudioCommand(
    id: 'sequence.setActive',
    scope: FrameleafStudioScope.sequence,
    mutatesGraph: true,
    undoable: false,
    capability: null,
    owner: 'FL-94',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('sequenceId', 'string', true),
    ],
  ),
  FrameleafStudioCommand(
    id: 'sequence.setFields',
    scope: FrameleafStudioScope.sequence,
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('captionLanguage', 'string', false),
      FrameleafStudioField('captionsBurnIn', 'boolean', false),
      FrameleafStudioField('name', 'string', false),
    ],
  ),
  FrameleafStudioCommand(
    id: 'sequence.setSettings',
    scope: FrameleafStudioScope.sequence,
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('fps', 'rate', false),
      FrameleafStudioField('height', 'number', false),
      FrameleafStudioField('sequenceId', 'string', true),
      FrameleafStudioField('width', 'number', false),
    ],
  ),
  FrameleafStudioCommand(
    id: 'text.setMotion',
    scope: FrameleafStudioScope.clip,
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-100',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('clipId', 'string', true),
      FrameleafStudioField('motion', 'object', false),
    ],
  ),
  FrameleafStudioCommand(
    id: 'title.add',
    scope: FrameleafStudioScope.clip,
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('animation', 'string', false),
      FrameleafStudioField('at', 'time', true),
      FrameleafStudioField('duration', 'duration', false),
      FrameleafStudioField('position', 'string', false),
      FrameleafStudioField('style', 'string', false),
      FrameleafStudioField('text', 'string', true),
    ],
  ),
  FrameleafStudioCommand(
    id: 'track.add',
    scope: FrameleafStudioScope.track,
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('index', 'number', false),
      FrameleafStudioField('kind', 'string', true),
      FrameleafStudioField('name', 'string', false),
    ],
  ),
  FrameleafStudioCommand(
    id: 'track.remove',
    scope: FrameleafStudioScope.track,
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('trackId', 'string', true),
    ],
  ),
  FrameleafStudioCommand(
    id: 'track.reorder',
    scope: FrameleafStudioScope.track,
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('index', 'number', true),
      FrameleafStudioField('trackId', 'string', true),
    ],
  ),
  FrameleafStudioCommand(
    id: 'track.set',
    scope: FrameleafStudioScope.track,
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('patch', 'object', true),
      FrameleafStudioField('trackId', 'string', true),
    ],
  ),
  FrameleafStudioCommand(
    id: 'track.setAudio',
    scope: FrameleafStudioScope.track,
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-103',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('eq', 'object', false),
      FrameleafStudioField('gainDb', 'number', false),
      FrameleafStudioField('pan', 'number', false),
      FrameleafStudioField('trackId', 'string', true),
    ],
  ),
  FrameleafStudioCommand(
    id: 'voiceover.add',
    scope: FrameleafStudioScope.clip,
    mutatesGraph: true,
    undoable: true,
    capability: null,
    owner: 'FL-94',
    payload: <FrameleafStudioField>[
      FrameleafStudioField('at', 'time', true),
      FrameleafStudioField('duration', 'duration', true),
      FrameleafStudioField('uploadId', 'string', true),
    ],
  ),
];

/// The same commands, keyed by id, for envelope validation.
final Map<String, FrameleafStudioCommand> frameleafStudioCommandsById =
    <String, FrameleafStudioCommand>{
      for (final FrameleafStudioCommand command in frameleafStudioCommands)
        command.id: command,
    };
