/**
 * GENERATED FILE — do not edit.
 *
 * Source: studio/frameleaf-studio-commands.json
 * Generator: scripts/frameleaf-studio-commands.mjs
 *
 * The server mirror of the canonical Studio command vocabulary. It
 * exists so the server can validate a command envelope without trusting the client's idea
 * of the vocabulary, and so a drifted web or native contract fails CI instead of failing a
 * person's edit. Payload objects are described, never interpreted: `object` fields travel
 * through unread so unknown Freecut graph fields, nulls, arrays and rational timing
 * extensions survive the round trip.
 */

export const STUDIO_COMMAND_SCHEMA_VERSION = 1;
export const STUDIO_ENGINE_REVISION = '4d62e8082c5eb387a96275bcbd323d28f6e41a62';

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

export type StudioCommandCapability =
  'analysisWorker' | 'generationWorker' | 'gpuWorker' | 'renderWorker' | 'restorationWorker' | 'transcriptionWorker';

export type StudioPayloadFieldType =
  | 'Array<{id:string,at:Rational,gainDb:number}>'
  | 'boolean'
  | 'duration'
  | 'number'
  | 'object'
  | 'object[]'
  | 'rate'
  | 'string'
  | 'string[]'
  | 'time';

export type StudioPayloadField = StudioPayloadFieldType | `${StudioPayloadFieldType}?`;

export interface StudioCommandMirror {
  scope: StudioCommandScope;
  mutatesGraph: boolean;
  undoable: boolean;
  capability: StudioCommandCapability | null;
  payload: Readonly<Record<string, StudioPayloadField>>;
}

export const studioCommandMirror = {
  'captions.set': {
    scope: 'sequence',
    mutatesGraph: true,
    undoable: true,
    capability: 'transcriptionWorker',
    payload: {
      captions: 'object[]',
    },
  },
  'clip.add': {
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      assetId: 'string',
      at: 'time',
      duration: 'duration?',
      kind: 'string?',
      trackId: 'string',
    },
  },
  'clip.delete': {
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      clipId: 'string?',
      clipIds: 'string[]?',
      ripple: 'boolean?',
    },
  },
  'clip.group': {
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      clipIds: 'string[]',
      name: 'string?',
    },
  },
  'clip.insert': {
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      assetId: 'string',
      at: 'time',
      sourceIn: 'time',
      sourceOut: 'time',
      trackId: 'string',
    },
  },
  'clip.join': {
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      clipIds: 'string[]',
    },
  },
  'clip.move': {
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      clipId: 'string',
      linkedSelectionEnabled: 'boolean?',
      start: 'time',
      trackId: 'string?',
    },
  },
  'clip.overwrite': {
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      assetId: 'string',
      at: 'time',
      sourceIn: 'time',
      sourceOut: 'time',
      trackId: 'string',
    },
  },
  'clip.push': {
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      clipId: 'string',
      delta: 'duration',
    },
  },
  'clip.relink': {
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      assetId: 'string',
      clipId: 'string',
    },
  },
  'clip.reorder': {
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      clipId: 'string',
      index: 'number',
      trackId: 'string',
    },
  },
  'clip.roll': {
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      at: 'time',
      clipId: 'string',
    },
  },
  'clip.setAudio': {
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      clipId: 'string',
      eq: 'object?',
      fadeIn: 'duration?',
      fadeOut: 'duration?',
      muted: 'boolean?',
      pitchCents: 'number?',
      pitchSemitones: 'number?',
      volume: 'number?',
    },
  },
  'clip.setBlendMode': {
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      blendMode: 'string',
      clipId: 'string',
      opacity: 'number?',
    },
  },
  'clip.setCrop': {
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      clipId: 'string',
      cornerPin: 'object?',
      crop: 'object?',
    },
  },
  'clip.setGrade': {
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      clipId: 'string',
      grade: 'object?',
    },
  },
  'clip.setKenBurns': {
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      clipId: 'string',
      kenBurns: 'object?',
    },
  },
  'clip.setLink': {
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      clipIds: 'string[]',
      linked: 'boolean',
    },
  },
  'clip.setMask': {
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      clipId: 'string',
      mask: 'object?',
    },
  },
  'clip.setSpeed': {
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      clipId: 'string',
      speed: 'rate',
    },
  },
  'clip.setTransform': {
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      clipId: 'string',
      transform: 'object',
    },
  },
  'clip.setTransformParent': {
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      clipId: 'string',
      parentId: 'string?',
    },
  },
  'clip.setTransition': {
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      clipId: 'string',
      transition: 'object?',
    },
  },
  'clip.slide': {
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      clipId: 'string',
      delta: 'duration',
    },
  },
  'clip.slip': {
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      clipId: 'string',
      delta: 'duration',
    },
  },
  'clip.split': {
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      at: 'time',
      clipIds: 'string[]?',
    },
  },
  'clip.trimEnd': {
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      clipId: 'string',
      end: 'time',
      ripple: 'boolean?',
    },
  },
  'clip.trimStart': {
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      clipId: 'string',
      ripple: 'boolean?',
      start: 'time',
    },
  },
  'clip.ungroup': {
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      groupId: 'string',
    },
  },
  'clip.update': {
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      clipId: 'string',
      patch: 'object',
    },
  },
  'composition.add': {
    scope: 'composition',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      at: 'time?',
      clipIds: 'string[]?',
      name: 'string',
      trackId: 'string?',
    },
  },
  'composition.setControlOverrides': {
    scope: 'composition',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      compositionClipId: 'string',
      overrides: 'object',
    },
  },
  'composition.setPublishedControls': {
    scope: 'composition',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      compositionId: 'string',
      controls: 'object[]',
    },
  },
  'effect.add': {
    scope: 'effect',
    mutatesGraph: true,
    undoable: true,
    capability: 'gpuWorker',
    payload: {
      clipId: 'string',
      effect: 'string',
      index: 'number?',
      params: 'object?',
    },
  },
  'effect.remove': {
    scope: 'effect',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      clipId: 'string',
      effectId: 'string',
    },
  },
  'effect.reorder': {
    scope: 'effect',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      clipId: 'string',
      effectId: 'string',
      index: 'number',
    },
  },
  'effect.update': {
    scope: 'effect',
    mutatesGraph: true,
    undoable: true,
    capability: 'gpuWorker',
    payload: {
      clipId: 'string',
      effectId: 'string',
      params: 'object',
    },
  },
  'history.redo': {
    scope: 'history',
    mutatesGraph: true,
    undoable: false,
    capability: null,
    payload: {
      toRevision: 'number?',
    },
  },
  'history.undo': {
    scope: 'history',
    mutatesGraph: true,
    undoable: false,
    capability: null,
    payload: {
      toRevision: 'number?',
    },
  },
  'job.cancel': {
    scope: 'job',
    mutatesGraph: false,
    undoable: false,
    capability: null,
    payload: {
      jobId: 'string',
    },
  },
  'job.enqueueCaptioning': {
    scope: 'job',
    mutatesGraph: false,
    undoable: false,
    capability: 'analysisWorker',
    payload: {
      clipIds: 'string[]?',
      destinationId: 'string',
      sampleCadence: 'duration?',
      sequenceId: 'string',
    },
  },
  'job.enqueueExport': {
    scope: 'job',
    mutatesGraph: false,
    undoable: false,
    capability: 'renderWorker',
    payload: {
      audioFormat: 'string?',
      colour: 'string',
      container: 'string?',
      destinationId: 'string',
      format: 'string',
      quality: 'string?',
      resolution: 'string',
      sequenceId: 'string',
      subtitles: 'string?',
      videoCodec: 'string?',
    },
  },
  'job.enqueueFillerRemoval': {
    scope: 'job',
    mutatesGraph: false,
    undoable: false,
    capability: 'analysisWorker',
    payload: {
      clipIds: 'string[]?',
      destinationId: 'string',
      sequenceId: 'string',
    },
  },
  'job.enqueueInterpolation': {
    scope: 'job',
    mutatesGraph: false,
    undoable: false,
    capability: 'restorationWorker',
    payload: {
      clipId: 'string',
      destinationId: 'string',
      factor: 'number?',
      targetFps: 'rate',
    },
  },
  'job.enqueueMusicGeneration': {
    scope: 'job',
    mutatesGraph: false,
    undoable: false,
    capability: 'generationWorker',
    payload: {
      destinationId: 'string',
      duration: 'duration',
      preset: 'string?',
      prompt: 'string',
    },
  },
  'job.enqueueProxy': {
    scope: 'job',
    mutatesGraph: false,
    undoable: false,
    capability: 'renderWorker',
    payload: {
      assetIds: 'string[]',
      destinationId: 'string',
    },
  },
  'job.enqueueRestoration': {
    scope: 'job',
    mutatesGraph: false,
    undoable: false,
    capability: 'restorationWorker',
    payload: {
      assetId: 'string?',
      destinationId: 'string',
      keepGrain: 'boolean?',
      mode: 'string',
      preview: 'boolean',
      restorationId: 'string?',
      upscale: 'number',
    },
  },
  'job.enqueueReverseConform': {
    scope: 'job',
    mutatesGraph: false,
    undoable: false,
    capability: 'renderWorker',
    payload: {
      clipId: 'string',
      destinationId: 'string',
    },
  },
  'job.enqueueSceneDetection': {
    scope: 'job',
    mutatesGraph: false,
    undoable: false,
    capability: 'analysisWorker',
    payload: {
      assetIds: 'string[]',
      destinationId: 'string',
      mode: 'string',
      verifyWithModel: 'boolean?',
    },
  },
  'job.enqueueSilenceRemoval': {
    scope: 'job',
    mutatesGraph: false,
    undoable: false,
    capability: 'analysisWorker',
    payload: {
      destinationId: 'string',
      minimumSilence: 'duration?',
      sequenceId: 'string',
      thresholdDb: 'number?',
    },
  },
  'job.enqueueTextToSpeech': {
    scope: 'job',
    mutatesGraph: false,
    undoable: false,
    capability: 'generationWorker',
    payload: {
      destinationId: 'string',
      engine: 'string?',
      text: 'string',
      voice: 'string',
    },
  },
  'job.enqueueTranscription': {
    scope: 'job',
    mutatesGraph: false,
    undoable: false,
    capability: 'transcriptionWorker',
    payload: {
      destinationId: 'string',
      language: 'string',
      sequenceId: 'string',
    },
  },
  'job.enqueueUpscale': {
    scope: 'job',
    mutatesGraph: false,
    undoable: false,
    capability: 'restorationWorker',
    payload: {
      clipId: 'string',
      destinationId: 'string',
      factor: 'number',
    },
  },
  'keyframe.add': {
    scope: 'keyframe',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      at: 'time',
      clipId: 'string',
      easing: 'string?',
      property: 'string',
      value: 'object',
    },
  },
  'keyframe.remove': {
    scope: 'keyframe',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      clipId: 'string',
      keyframeIds: 'string[]',
      property: 'string',
    },
  },
  'keyframe.setEasing': {
    scope: 'keyframe',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      bezier: 'object?',
      clipId: 'string',
      easing: 'string',
      keyframeIds: 'string[]',
      property: 'string',
      spring: 'object?',
    },
  },
  'keyframe.update': {
    scope: 'keyframe',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      at: 'time?',
      clipId: 'string',
      keyframeId: 'string',
      property: 'string',
      spatial: 'object?',
      temporalEase: 'object?',
      value: 'object?',
    },
  },
  'lottie.update': {
    scope: 'media',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      clipId: 'string',
      colors: 'object?',
      slots: 'object?',
      text: 'object?',
    },
  },
  'marker.add': {
    scope: 'sequence',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      at: 'time',
      colour: 'string?',
      name: 'string?',
    },
  },
  'marker.remove': {
    scope: 'sequence',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      markerId: 'string',
    },
  },
  'marker.update': {
    scope: 'sequence',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      markerId: 'string',
      patch: 'object',
    },
  },
  'media.import': {
    scope: 'media',
    mutatesGraph: true,
    undoable: false,
    capability: null,
    payload: {
      assetIds: 'string[]',
    },
  },
  'media.relink': {
    scope: 'media',
    mutatesGraph: true,
    undoable: false,
    capability: null,
    payload: {
      assetId: 'string',
      mediaId: 'string',
    },
  },
  'media.remove': {
    scope: 'media',
    mutatesGraph: true,
    undoable: false,
    capability: null,
    payload: {
      mediaIds: 'string[]',
    },
  },
  'music.add': {
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      at: 'time',
      duration: 'duration?',
      musicId: 'string',
      volume: 'number?',
    },
  },
  'preview.release': {
    scope: 'preview',
    mutatesGraph: false,
    undoable: false,
    capability: null,
    payload: {},
  },
  'preview.request': {
    scope: 'preview',
    mutatesGraph: false,
    undoable: false,
    capability: 'gpuWorker',
    payload: {
      at: 'time',
      quality: 'string',
      viewportHeight: 'number',
      viewportWidth: 'number',
    },
  },
  'project.applyTemplate': {
    scope: 'project',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      templateId: 'string',
      timing: 'string?',
    },
  },
  'project.exportBundle': {
    scope: 'project',
    mutatesGraph: false,
    undoable: false,
    capability: null,
    payload: {
      includeMedia: 'boolean?',
      sequenceIds: 'string[]?',
    },
  },
  'project.importBundle': {
    scope: 'project',
    mutatesGraph: true,
    undoable: false,
    capability: null,
    payload: {
      bundleUploadId: 'string',
    },
  },
  'project.rename': {
    scope: 'project',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      name: 'string',
    },
  },
  'project.setMasterAudio': {
    scope: 'project',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      ducking: 'boolean?',
      gainDb: 'number?',
      gainEnvelope: 'Array<{id:string,at:Rational,gainDb:number}>?',
      muted: 'boolean?',
    },
  },
  'project.setSettings': {
    scope: 'project',
    mutatesGraph: true,
    undoable: false,
    capability: null,
    payload: {
      patch: 'object',
    },
  },
  'property.bakeModifier': {
    scope: 'keyframe',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      clipId: 'string',
      modifierId: 'string',
      property: 'string',
    },
  },
  'property.setExpression': {
    scope: 'keyframe',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      clipId: 'string',
      expression: 'string?',
      property: 'string',
    },
  },
  'property.setModifier': {
    scope: 'keyframe',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      clipId: 'string',
      modifier: 'object?',
      property: 'string',
    },
  },
  'review.add': {
    scope: 'review',
    mutatesGraph: false,
    undoable: false,
    capability: null,
    payload: {
      text: 'string',
      time: 'time',
    },
  },
  'review.remove': {
    scope: 'review',
    mutatesGraph: false,
    undoable: false,
    capability: null,
    payload: {
      commentId: 'string',
    },
  },
  'review.update': {
    scope: 'review',
    mutatesGraph: false,
    undoable: false,
    capability: null,
    payload: {
      commentId: 'string',
      patch: 'object',
    },
  },
  'sequence.add': {
    scope: 'sequence',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      fps: 'rate?',
      height: 'number?',
      name: 'string',
      width: 'number?',
    },
  },
  'sequence.duplicate': {
    scope: 'sequence',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      name: 'string?',
      sequenceId: 'string',
    },
  },
  'sequence.remove': {
    scope: 'sequence',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      sequenceId: 'string',
    },
  },
  'sequence.setActive': {
    scope: 'sequence',
    mutatesGraph: true,
    undoable: false,
    capability: null,
    payload: {
      sequenceId: 'string',
    },
  },
  'sequence.setFields': {
    scope: 'sequence',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      captionLanguage: 'string?',
      captionsBurnIn: 'boolean?',
      name: 'string?',
    },
  },
  'sequence.setSettings': {
    scope: 'sequence',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      fps: 'rate?',
      height: 'number?',
      sequenceId: 'string',
      timing: 'string?',
      width: 'number?',
    },
  },
  'shape.add': {
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      at: 'time',
      duration: 'duration?',
      mask: 'object?',
      shapeType: 'string',
      style: 'object?',
      trackId: 'string?',
      transform: 'object?',
    },
  },
  'shape.setStyle': {
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      clipId: 'string',
      style: 'object',
    },
  },
  'text.setMotion': {
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      clipId: 'string',
      motion: 'object?',
    },
  },
  'title.add': {
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      animation: 'string?',
      at: 'time',
      duration: 'duration?',
      position: 'string?',
      style: 'string?',
      text: 'string',
    },
  },
  'title.setStyle': {
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      clipId: 'string',
      spanLayout: 'string?',
      spans: 'object[]?',
      style: 'object',
    },
  },
  'track.add': {
    scope: 'track',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      index: 'number?',
      kind: 'string',
      name: 'string?',
    },
  },
  'track.closeGap': {
    scope: 'track',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      at: 'time?',
      trackId: 'string',
    },
  },
  'track.remove': {
    scope: 'track',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      trackId: 'string',
    },
  },
  'track.reorder': {
    scope: 'track',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      index: 'number',
      trackId: 'string',
    },
  },
  'track.set': {
    scope: 'track',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      patch: 'object',
      trackId: 'string',
    },
  },
  'track.setAudio': {
    scope: 'track',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      eq: 'object?',
      gainDb: 'number?',
      pan: 'number?',
      trackId: 'string',
    },
  },
  'voiceover.add': {
    scope: 'clip',
    mutatesGraph: true,
    undoable: true,
    capability: null,
    payload: {
      at: 'time',
      duration: 'duration',
      uploadId: 'string',
    },
  },
} as const satisfies Record<string, StudioCommandMirror>;

export type StudioCommandId = keyof typeof studioCommandMirror;

export const studioCommandIds = Object.keys(studioCommandMirror) as StudioCommandId[];
