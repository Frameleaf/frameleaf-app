/**
 * Canonical Studio commands applied by the real engine (FL-92, `STU-205`).
 *
 * `studio/frameleaf-studio-commands.json` publishes the vocabulary; this module gives the rows that
 * reach Freecut's 19 public commands (`command.*` in `freecut-feature-manifest.json`) their
 * semantics. Each command is validated, then driven through Freecut's own timeline actions — the
 * same modules the editor's UI and Freecut's headless `editProject` use — so transition repair,
 * linked audio, split bookkeeping and ripple behave exactly as they do in the editor.
 *
 * Rules the host relies on:
 *
 * - **Atomic.** A batch either applies completely or not at all; the first failing envelope is
 *   named and the input graph is returned untouched.
 * - **Deterministic.** Every id the engine would mint with `crypto.randomUUID` is derived from the
 *   envelope's idempotency key, so the same graph and the same batch always produce the same graph
 *   (and the same canonical digest), in any browser and on retry.
 * - **Exact time.** Payload times are FL-93 rationals in seconds. Timeline positions become
 *   frames at the project's frame rate with exact integer arithmetic, rounding to the nearest
 *   frame. Audio fades retain seconds, including durations shorter than one video frame.
 * - **Lossless.** Freecut serialises its stores back into the project it was given, so fields this
 *   module does not touch round-trip unchanged.
 *
 * Undo and redo are not engine operations: the host keeps the graph each accepted batch replaced
 * and restores it as a new revision (history is append-only, FL-89).
 */
import type { Project } from '@/types/project'
import type { TimelineItem, TextItem } from '@/types/timeline'
import type { MediaMetadata } from '@/types/storage'
import {
  DEFAULT_SPRING_PARAMS,
  isDirectLinkableProperty,
  isVectorAnimatableProperty as isVectorProperty,
  type AnimatableProperty,
  type EasingConfig,
  type EasingType,
  type Keyframe,
  type VectorKeyframe,
} from '@/types/keyframe'
import type { TransformProperties } from '@/types/transform'
import type { TransitionPresentation } from '@/types/transition'
import { migrateProject } from '@/shared/projects/migrations'
import { cadenceFromDecimal, projectCadenceOf, withProjectCadence } from '@frameleaf/host/studio-timing'
import {
  buildTimelineFromStores,
  hydrateTimelineStoresFromProject,
} from '@/features/timeline/stores/timeline-persistence'
import { useItemsStore } from '@/features/timeline/stores/items-store'
import { useTransitionsStore } from '@/features/timeline/stores/transitions-store'
import { useTimelineSettingsStore } from '@/features/timeline/stores/timeline-settings-store'
import { useKeyframesStore } from '@/features/timeline/stores/keyframes-store'
import { useMediaLibraryStore } from '@/features/media-library/stores/media-library-store'
import { createClassicTrack } from '@/features/timeline/utils/classic-tracks'
import { findCompatibleCaptionTrack, getCaptionStyleTemplateFromPreset, isCaptionTrackCandidate } from '@/features/media-library/utils/caption-items'
import {
  filterUnlockedItemIds,
  getLinkedItemIds,
  getUniqueLinkedItemAnchorIds,
} from '@/features/timeline/utils/linked-items'
import { buildLinkedLeftShiftUpdates, expandIdsWithLinkedItems } from '@/features/timeline/stores/actions/linked-edit'
import { useEditorStore } from '@/shared/state/editor'
import { usePlaybackStore } from '@/shared/state/playback'
import {
  buildDroppedMediaTimelineItems,
  getDroppedMediaDurationInFrames,
} from '@/features/timeline/utils/dropped-media'
import {
  addEffect,
  addItem,
  addItems,
  addKeyframe,
  addTransition,
  createPreComp,
  moveItems,
  removeEffect,
  removeItems,
  removeKeyframe,
  removeTransition,
  rippleDeleteItems,
  rippleTrimItem,
  setItemEffects,
  setTracks,
  setTransformParent,
  splitAllItemsAtFrame,
  splitItem,
  trimItemEnd,
  trimItemStart,
  updateItem,
  updateItemTransform,
  updateKeyframe,
  updateKeyframes,
  updateTransition,
  setPropertyExpression,
  removePropertyExpression,
  applyMotionModifierToItems,
  bakeMotionToKeyframes,
  addKeyframes,
  upsertVectorKeyframe,
  updateVectorKeyframe,
  removeVectorKeyframe,
} from '@/features/timeline/stores/timeline-actions'
import { dissolvePreComp } from '@/features/timeline/stores/actions/composition-actions'
import { useCompositionsStore } from '@/features/timeline/stores/compositions-store'
import { sanitizeTextMotion } from '@/shared/projects/migrations/sanitize-text-motion'
import { sanitizeCompositionControlSchema } from '@/shared/utils/composition-controls'
import { COMPOSITION_CONTROLS_VERSION } from '@/types/composition-controls'
import {
  evaluatePropertyExpression,
  isExpressionValueCompatible,
} from '@/features/keyframes/utils/property-expression'
import { buildBakeMotionPlan } from '@/features/keyframes/utils/bake-motion'
import { getActiveMotionModifierChannels } from '@/features/keyframes/utils/motion-modifier-eval'
import type { MotionModifier, MotionModifierType } from '@/types/motion'
import {
  joinItems,
  rateStretchItem,
  rollingTrimItems,
  slideItem,
  slipItem,
} from '@/features/timeline/stores/actions/item-edit-actions'
import {
  closeAllGapsOnTrack,
  closeGapAtPosition,
  linkItems,
  trackPushItems,
  unlinkItems,
} from '@/features/timeline/stores/actions/item-actions'
import { canJoinMultipleItems } from '@/features/timeline/utils/clip-utils'
import {
  addMarker,
  removeMarker,
  updateMarker,
} from '@/features/timeline/stores/actions/marker-actions'
import { applyTransitionRepairs } from '@/features/timeline/stores/actions/shared'
import {
  applySplitBookkeeping,
  type SplitResultEntry,
} from '@/features/timeline/stores/actions/split-bookkeeping'
import { propagateInsertedGapToSyncLockedTracks } from '@/features/timeline/stores/actions/sync-lock-ripple'
import { useMarkersStore } from '@/features/timeline/stores/markers-store'
import { buildMediaTimelineItems } from '@/features/timeline/utils/media-timeline-item-builder'
import { MAX_SPEED, MIN_SPEED } from '@/features/timeline/utils/source-calculations'
import {
  AUDIO_PITCH_SEMITONES_MIN, AUDIO_PITCH_SEMITONES_MAX,
  AUDIO_PITCH_CENTS_MIN, AUDIO_PITCH_CENTS_MAX,
} from '@/shared/utils/audio-pitch'
import { DEFAULT_AUDIO_EQ_SETTINGS, getAudioEqSettings, resolveAudioEqSettings } from '@/shared/utils/audio-eq'
import { buildTimelineEqPatchFromResolvedSettings } from '@/features/editor/components/properties-sidebar/clip-panel/audio-eq-ui'
import type { AudioEqSettings } from '@/types/audio'
import { isTrackSyncLockEnabled } from '@/features/timeline/utils/track-sync-lock'
import { getGpuEffect } from '@/infrastructure/gpu-effects'
import { transitionRegistry } from '@/shared/timeline/transitions/registry'
import '@/shared/timeline/transitions'
import {
  resolveTransform,
  getSourceDimensions,
} from '@/runtime/composition-runtime/utils/transform-resolver'
import {
  TEXT_STYLE_PRESET_IDS,
  type TextStylePresetId,
} from '@/shared/typography/text-style-preset-ids'
import { applyTextStylePresetToItem } from '@/shared/typography/text-style-presets'
import {
  TEXT_MOTION_IN_PRESET_IDS,
  TEXT_MOTION_OUT_PRESET_IDS,
} from '@/shared/typography/text-motion/text-motion-preset-ids'
import { createTextMotionEffect } from '@/shared/typography/text-motion/text-motion-presets'
import { PROJECT_TEMPLATES } from '@/features/projects/utils/validation'
import { isAllowedProjectFps } from '@/features/projects/utils/project-fps'
import {
  RETIME_POLICIES,
  hasTimedContent,
  retimeCompositionReaders,
  retimeContent,
  sameRate,
  type RetimePolicy,
} from '@/features/timeline/utils/project-retime'

export interface Rational {
  num: number
  den: number
}

export interface CanonicalEnvelope {
  id: string
  payload: Record<string, unknown>
  revision: number
  idempotencyKey: string
  issuedAt?: number
}

export type RejectionReason = 'invalid' | 'not-implemented' | 'failed'

export class CommandRejection extends Error {
  constructor(
    readonly reason: RejectionReason,
    message: string,
  ) {
    super(message)
    this.name = 'CommandRejection'
  }
}

const invalid = (message: string): never => {
  throw new CommandRejection('invalid', message)
}

/**
 * The canonical commands that reach Freecut's public commands, with the manifest row each one
 * implements. `history.undo` and `history.redo` are answered by the host's graph history.
 */
export const ENGINE_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  'captions.set': ['readme.local-ai-analysis.1'],
  'clip.add': ['command.addItem', 'command.addClip'],
  'clip.delete': ['command.removeItems'],
  'clip.move': ['command.moveItem'],
  'clip.setTransform': ['command.setTransform'],
  'clip.setTransformParent': ['command.setTransformParent'],
  'clip.setTransition': [
    'command.addTransition',
    'command.updateTransition',
    'command.removeTransition',
  ],
  'clip.split': ['command.split'],
  'clip.trimEnd': ['command.trimEnd'],
  'clip.trimStart': ['command.trimStart'],
  'clip.update': ['command.updateItem'],
  'clip.setAudio': ['readme.audio.1', 'readme.audio.2', 'readme.audio.3'],
  'track.setAudio': ['readme.audio.1', 'readme.audio.3'],
  'composition.add': ['command.addClip'],
  'effect.add': ['command.addEffect'],
  'effect.remove': ['command.removeEffect'],
  'keyframe.add': ['command.addKeyframe'],
  'keyframe.remove': ['command.removeKeyframes'],
  'music.add': ['command.addItem'],
  'title.add': ['command.addText'],
  'track.add': ['command.addTrack'],
  // FL-94: the linked edit tools, source edits, tracks and markers of readme.timeline-editing.
  'clip.insert': ['readme.timeline-editing.7'],
  'clip.overwrite': ['readme.timeline-editing.7'],
  'clip.join': ['readme.timeline-editing.3'],
  'clip.push': ['readme.timeline-editing.5'],
  'clip.reorder': ['readme.timeline-editing.5'],
  'clip.roll': ['readme.timeline-editing.3'],
  'clip.setLink': ['readme.timeline-editing.3'],
  'clip.setSpeed': ['readme.timeline-editing.3'],
  'clip.slide': ['readme.timeline-editing.3'],
  'clip.slip': ['readme.timeline-editing.3'],
  'marker.add': ['readme.timeline-editing.6'],
  'marker.remove': ['readme.timeline-editing.6'],
  'marker.update': ['readme.timeline-editing.6'],
  'track.closeGap': ['readme.timeline-editing.5'],
  'track.remove': ['readme.timeline-editing.5'],
  'track.reorder': ['readme.timeline-editing.5'],
  'track.set': ['readme.timeline-editing.5'],
  // FL-94: canvas and rate changes, with an explicit timing policy once a timeline has content.
  'project.applyTemplate': ['readme.timeline-editing.8'],
  'project.setMasterAudio': ['readme.preview-playback.6'],
  'sequence.setSettings': ['readme.timeline-editing.8'],
  // FL-100: keyframe animation.
  'keyframe.update': ['readme.keyframe-animation.1'],
  'keyframe.setEasing': ['readme.keyframe-animation.2'],
  'property.setExpression': ['extra.expressions'],
  'property.setModifier': ['readme.keyframe-animation.3'],
  'property.bakeModifier': ['readme.keyframe-animation.3'],
  'text.setMotion': ['readme.keyframe-animation.4'],
  'clip.setKenBurns': ['readme.keyframe-animation.6'],
  'clip.group': ['extra.compose'],
  'clip.ungroup': ['extra.compose'],
  'composition.setPublishedControls': ['extra.published-controls'],
  'composition.setControlOverrides': ['extra.published-controls'],
}

export const isEngineCommand = (id: string): boolean => Object.hasOwn(ENGINE_COMMANDS, id)

/* ------------------------------------------------------------------ */
/* Exact time                                                           */
/* ------------------------------------------------------------------ */

const isRational = (value: unknown): value is Rational => {
  if (!value || typeof value !== 'object') return false
  const { num, den } = value as Rational
  return Number.isSafeInteger(num) && Number.isSafeInteger(den) && den > 0
}

/**
 * The project's frame rate as an exact fraction (FL-93). A graph that stores `metadata.frameRate`
 * is read from it; Freecut's own `fps` number is read exactly when it is an integer or an NTSC
 * `x/1001` rate, and refused otherwise, never rounded onto a nearby fraction.
 */
export const frameRateOf = (rate: number | Rational): { num: bigint; den: bigint } => {
  const exact = typeof rate === 'number' ? cadenceFromDecimal(rate) : projectCadenceOf({ frameRate: rate })
  if (!exact) invalid('The project frame rate has no exact reading')
  return { num: BigInt(exact!.num), den: BigInt(exact!.den) }
}

/** Seconds (exact) to the nearest frame; halves round up. */
export const secondsToFrames = (time: Rational, rate: number | Rational): number => {
  const cadence = frameRateOf(rate)
  const numerator = BigInt(time.num) * cadence.num
  const denominator = BigInt(time.den) * cadence.den
  const doubled = 2n * numerator + denominator
  const twice = 2n * denominator
  // floor((2n + d) / 2d) for either sign.
  const quotient = doubled >= 0n ? doubled / twice : -((-doubled + twice - 1n) / twice)
  const frames = Number(quotient)
  if (!Number.isSafeInteger(frames)) invalid('The time is out of range')
  return frames
}

const timeField = (payload: Record<string, unknown>, name: string, cadence: Rational): number => {
  const value = payload[name]
  if (!isRational(value)) invalid(`${name} must be an exact rational time`)
  const frames = secondsToFrames(value as Rational, cadence)
  if (frames < 0) invalid(`${name} must not be negative`)
  return frames
}

const optionalTime = (
  payload: Record<string, unknown>,
  name: string,
  cadence: Rational,
): number | undefined => (payload[name] === undefined ? undefined : timeField(payload, name, cadence))

const stringField = (payload: Record<string, unknown>, name: string): string => {
  const value = payload[name]
  if (typeof value !== 'string' || value.length === 0) invalid(`${name} is required`)
  return value as string
}

const optionalString = (payload: Record<string, unknown>, name: string): string | undefined => {
  const value = payload[name]
  if (value === undefined) return undefined
  if (typeof value !== 'string') invalid(`${name} must be a string`)
  return value as string
}

const optionalNumber = (payload: Record<string, unknown>, name: string): number | undefined => {
  const value = payload[name]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(`${name} must be a number`)
  return value as number
}

/* ------------------------------------------------------------------ */
/* Deterministic identities                                             */
/* ------------------------------------------------------------------ */

/** xmur3 → sfc32: a small, fast, seedable generator; only its determinism matters here. */
const seededRandom = (seed: string): (() => number) => {
  let h = 1779033703 ^ seed.length
  for (let index = 0; index < seed.length; index++) {
    h = Math.imul(h ^ seed.charCodeAt(index), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  const next = () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507)
    h = Math.imul(h ^ (h >>> 13), 3266489909)
    return (h ^= h >>> 16) >>> 0
  }
  let a = next()
  let b = next()
  let c = next()
  let d = next()
  return () => {
    a >>>= 0
    b >>>= 0
    c >>>= 0
    d >>>= 0
    let t = (a + b) | 0
    a = b ^ (b >>> 9)
    b = (c + (c << 3)) | 0
    c = (c << 21) | (c >>> 11)
    d = (d + 1) | 0
    t = (t + d) | 0
    c = (c + t) | 0
    return (t >>> 0) / 4294967296
  }
}

/** A UUID v4-shaped identity derived from the seed, stable across runs and browsers. */
export const deterministicUuids = (seed: string): (() => string) => {
  const random = seededRandom(seed)
  return () => {
    const bytes = Array.from({ length: 16 }, () => Math.floor(random() * 256))
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    const hex = bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }
}

/**
 * Run `work` with `crypto.randomUUID` and `Date.now` fixed for this envelope. The command runtime
 * owns its document, so nothing else observes the substitution, and both are restored after.
 */
async function withDeterminism<T>(
  seed: string,
  clock: number,
  work: () => Promise<T> | T,
): Promise<T> {
  const cryptoObject = globalThis.crypto as Crypto & { randomUUID: () => string }
  const hadOwn = Object.hasOwn(cryptoObject, 'randomUUID')
  const previous = cryptoObject.randomUUID
  const previousNow = Date.now
  Object.defineProperty(cryptoObject, 'randomUUID', {
    value: deterministicUuids(seed),
    configurable: true,
    writable: true,
  })
  Date.now = () => clock
  try {
    return await work()
  } finally {
    Date.now = previousNow
    if (hadOwn) {
      Object.defineProperty(cryptoObject, 'randomUUID', {
        value: previous,
        configurable: true,
        writable: true,
      })
    } else {
      delete (cryptoObject as { randomUUID?: unknown }).randomUUID
    }
  }
}

/* ------------------------------------------------------------------ */
/* Canonical graph digest                                               */
/* ------------------------------------------------------------------ */

/** JSON with object keys sorted, so equal graphs serialise identically. */
export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value))
    return `[${value.map((entry) => canonicalJson(entry === undefined ? null : entry)).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`
}

export async function graphDigest(graph: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(graph))
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/* ------------------------------------------------------------------ */
/* Store helpers                                                        */
/* ------------------------------------------------------------------ */

const items = () => useItemsStore.getState().items
const tracks = () => useItemsStore.getState().tracks

const requireItem = (id: string, field = 'clipId'): TimelineItem => {
  const item = useItemsStore.getState().itemById[id]
  if (!item) invalid(`${field}: clip "${id}" does not exist`)
  return item as TimelineItem
}

const RUNTIME_ONLY_EXPRESSION_ERRORS = /^(Division by zero|Expression produced a non-finite value|Property reference is unavailable|Expression dependency limit exceeded)/


export const MODIFIER_TYPES: readonly MotionModifierType[] = ['float-drift', 'breath-pulse', 'micro-shake', 'sway', 'spin']

const finiteIn = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max

/** A procedural modifier from a payload, with every field inside the range the evaluator reads. */
const modifierField = (value: unknown): MotionModifier => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('modifier must be an object or null')
  const candidate = value as Record<string, unknown>
  const type = candidate.type as MotionModifierType
  if (!MODIFIER_TYPES.includes(type)) invalid(`modifier.type must be one of ${MODIFIER_TYPES.join(', ')}`)
  if (!finiteIn(candidate.amplitude, 0, 2)) invalid('modifier.amplitude must be a number in 0..2')
  if (!finiteIn(candidate.frequency, 0.01, 30)) invalid('modifier.frequency must be a number of Hz in 0.01..30')
  const phaseFrames = candidate.phaseFrames ?? 0
  if (!finiteIn(phaseFrames, 0, 1_000_000)) invalid('modifier.phaseFrames must be a whole, non-negative number')
  const seed = candidate.seed ?? 1
  if (!finiteIn(seed, -1_000_000, 1_000_000)) invalid('modifier.seed must be a number')
  if (candidate.enabled !== undefined && typeof candidate.enabled !== 'boolean') invalid('modifier.enabled must be a boolean')
  let channelGains: MotionModifier['channelGains']
  if (candidate.channelGains !== undefined) {
    if (!candidate.channelGains || typeof candidate.channelGains !== 'object') invalid('modifier.channelGains must be an object')
    channelGains = {}
    for (const [channel, gain] of Object.entries(candidate.channelGains as Record<string, unknown>)) {
      if (!['x', 'y', 'width', 'height', 'rotation', 'opacity'].includes(channel)) invalid(`modifier.channelGains: unknown channel ${channel}`)
      if (!finiteIn(gain, 0, 2)) invalid(`modifier.channelGains.${channel} must be a number in 0..2`)
      ;(channelGains as Record<string, number>)[channel] = gain as number
    }
  }
  return {
    version: 2,
    id: typeof candidate.id === 'string' && candidate.id ? candidate.id : crypto.randomUUID(),
    type,
    enabled: candidate.enabled !== false,
    amplitude: candidate.amplitude as number,
    frequency: candidate.frequency as number,
    phaseFrames: Math.round(phaseFrames as number),
    seed: seed as number,
    ...(channelGains ? { channelGains } : {}),
  }
}

const CSS_COLOR = /^(#[0-9a-f]{3,4}|#[0-9a-f]{6}|#[0-9a-f]{8}|(rgb|rgba|hsl|hsla)\([0-9.,%\s/+-]+\))$/i

const KEN_BURNS_PROPERTIES: readonly string[] = ['x', 'y', 'width', 'height']
interface KenBurnsRect {
  x: number
  y: number
  w: number
  h: number
}

/** The prototype's region rule (`normalizeRect`): a square region, 20%-100% of the photo, inside it. */
const kenBurnsRect = (value: unknown, name: string): KenBurnsRect => {
  if (!value || typeof value !== 'object') invalid(`kenBurns.${name} must be { x, y, w, h }`)
  const rect = value as Record<string, unknown>
  for (const key of ['x', 'y', 'w', 'h']) {
    if (!finiteIn(rect[key], 0, 1)) invalid(`kenBurns.${name}.${key} must be a number in 0..1`)
  }
  const { x, y, w, h } = rect as unknown as KenBurnsRect
  if (w < 0.2 || h < 0.2) invalid(`kenBurns.${name} must show at least a fifth of the photo`)
  if (Math.abs(w - h) > 1e-9) invalid(`kenBurns.${name} must keep the frame's shape (w equal to h)`)
  if (x + w > 1 + 1e-9 || y + h > 1 + 1e-9) invalid(`kenBurns.${name} must lie inside the photo`)
  return { x, y, w, h }
}

const keyframesOnItem = (item: TimelineItem) =>
  useKeyframesStore.getState().keyframesByItemId[item.id]?.properties ?? []

const vectorField = (value: unknown, name: string): { x: number; y: number } => {
  const vector = value as { x?: unknown; y?: unknown } | null
  if (!vector || typeof vector !== 'object' || !finiteIn(vector.x, -1e9, 1e9) || !finiteIn(vector.y, -1e9, 1e9))
    invalid(`${name} must be { x, y } numbers`)
  return { x: vector!.x as number, y: vector!.y as number }
}

const vectorKeyframesOn = (item: TimelineItem, property: string): VectorKeyframe[] =>
  useKeyframesStore
    .getState()
    .keyframesByItemId[item.id]?.vectorProperties?.find((entry) => entry.property === property)?.keyframes ?? []

const requireVectorKeyframe = (item: TimelineItem, property: string, keyframeId: string): VectorKeyframe => {
  const keyframe = vectorKeyframesOn(item, property).find((entry) => entry.id === keyframeId)
  if (!keyframe) invalid(`keyframeId: "${keyframeId}" is not on ${property}`)
  return keyframe!
}

const easeHandle = (value: unknown, name: string) => {
  const handle = value as { speed?: unknown; influence?: unknown } | null
  if (!handle || typeof handle !== 'object') invalid(`${name} must be { speed, influence }`)
  if (!finiteIn(handle!.speed, -1e9, 1e9)) invalid(`${name}.speed must be a number`)
  // Influence is a share of the neighbouring segment: 0.1% to 100%, as in the graph editor.
  if (!finiteIn(handle!.influence, 0.1, 100)) invalid(`${name}.influence must be a percentage in 0.1..100`)
  return { speed: handle!.speed as number, influence: handle!.influence as number }
}

/** Frame, value, easing handles and (Position only) path tangents of one vector keyframe. */
const updateVectorKeyframeFrom = (
  item: TimelineItem,
  property: string,
  payload: Record<string, unknown>,
  cadence: Rational,
) => {
  const keyframe = requireVectorKeyframe(item, property, stringField(payload, 'keyframeId'))
  const updates: Partial<Omit<VectorKeyframe, 'id'>> = {}
  if (payload.at !== undefined) {
    const at = timeField(payload, 'at', cadence)
    if (at < item.from || at >= item.from + item.durationInFrames) invalid('at must fall inside the clip')
    updates.frame = at - item.from
    if (vectorKeyframesOn(item, property).some((other) => other.id !== keyframe.id && other.frame === updates.frame))
      invalid(`at: ${property} already has a keyframe there`)
  }
  if (payload.value !== undefined) updates.value = vectorField(payload.value, 'value')
  if (payload.temporalEase !== undefined) {
    const ease = payload.temporalEase as { in?: unknown; out?: unknown } | null
    if (ease === null) updates.temporalEase = undefined
    else {
      if (typeof ease !== 'object' || (ease.in === undefined && ease.out === undefined))
        invalid('temporalEase must be { in?, out? } or null')
      updates.temporalEase = {
        ...(ease!.in !== undefined ? { in: easeHandle(ease!.in, 'temporalEase.in') } : {}),
        ...(ease!.out !== undefined ? { out: easeHandle(ease!.out, 'temporalEase.out') } : {}),
      }
    }
  }
  if (payload.spatial !== undefined) {
    if (property !== 'position') invalid('only position keyframes have path tangents')
    const spatial = payload.spatial as { inTangent?: unknown; outTangent?: unknown; continuous?: unknown } | null
    if (spatial === null) updates.spatial = undefined
    else {
      if (typeof spatial !== 'object') invalid('spatial must be { inTangent, outTangent, continuous? } or null')
      if (spatial!.continuous !== undefined && typeof spatial!.continuous !== 'boolean') invalid('spatial.continuous must be a boolean')
      const continuous = spatial!.continuous === true
      let inTangent = spatial!.inTangent === undefined ? undefined : vectorField(spatial!.inTangent, 'spatial.inTangent')
      let outTangent = spatial!.outTangent === undefined ? undefined : vectorField(spatial!.outTangent, 'spatial.outTangent')
      // Mirrored tangents: one handle given, the other is its reflection through the vertex.
      if (continuous && inTangent && !outTangent) outTangent = { x: -inTangent.x, y: -inTangent.y }
      if (continuous && outTangent && !inTangent) inTangent = { x: -outTangent.x, y: -outTangent.y }
      if (!inTangent || !outTangent) invalid('spatial needs both tangents unless they are continuous')
      if (continuous && (Math.abs(inTangent!.x + outTangent!.x) > 1e-9 || Math.abs(inTangent!.y + outTangent!.y) > 1e-9))
        invalid('continuous tangents must mirror each other')
      updates.spatial = { inTangent: inTangent!, outTangent: outTangent!, ...(continuous ? { continuous } : {}) }
    }
  }
  if (Object.keys(updates).length === 0)
    invalid('keyframe.update needs at, value, temporalEase or spatial')
  updateVectorKeyframe(item.id, property as never, keyframe.id, updates)
  const after = vectorKeyframesOn(item, property).find((entry) => entry.id === keyframe.id)
  if (!after || (updates.frame !== undefined && after.frame !== updates.frame))
    failed('keyframe.update: keyframes cannot be moved inside a transition')
}

const keyframeCount = (item: TimelineItem): number =>
  (useKeyframesStore.getState().keyframesByItemId[item.id]?.properties ?? []).reduce(
    (sum, entry) => sum + entry.keyframes.length,
    0,
  )

export const EASINGS: readonly EasingType[] = ['linear', 'ease-in', 'ease-out', 'ease-in-out', 'hold', 'cubic-bezier', 'spring']

const keyframesOn = (item: TimelineItem, property: AnimatableProperty): Keyframe[] =>
  useKeyframesStore
    .getState()
    .keyframesByItemId[item.id]?.properties.find((entry) => entry.property === property)?.keyframes ?? []

const requireKeyframe = (item: TimelineItem, property: AnimatableProperty, keyframeId: string): Keyframe => {
  const keyframe = keyframesOn(item, property).find((entry) => entry.id === keyframeId)
  if (!keyframe) invalid(`keyframeId: "${keyframeId}" is not on ${property}`)
  return keyframe!
}

const requireTrack = (id: string, field = 'trackId') => {
  const track = tracks().find((candidate) => candidate.id === id)
  if (!track) invalid(`${field}: track "${id}" does not exist`)
  if (track!.isGroup) invalid(`${field}: track "${id}" is a group`)
  return track!
}

const canvas = () => {
  const settings = useTimelineSettingsStore.getState()
  return {
    width: projectCanvas.width,
    height: projectCanvas.height,
    fps: settings.fps || projectCanvas.fps,
  }
}

let projectCanvas = { width: 1920, height: 1080, fps: 30 }

const failed = (message: string): never => {
  throw new CommandRejection('failed', message)
}

/** The clip immediately after `item` on its track, for a transition out of it. */
const nextOnTrack = (item: TimelineItem): TimelineItem | undefined => {
  const end = item.from + item.durationInFrames
  return items()
    .filter(
      (candidate) =>
        candidate.trackId === item.trackId && candidate.id !== item.id && candidate.from >= end - 1,
    )
    .sort((a, b) => a.from - b.from)[0]
}

/* ------------------------------------------------------------------ */
/* Timeline edit helpers (FL-94)                                        */
/* ------------------------------------------------------------------ */

const gcd = (a: bigint, b: bigint): bigint => {
  let x = a < 0n ? -a : a
  let y = b < 0n ? -b : b
  while (y !== 0n) [x, y] = [y, x % y]
  return x
}

/** `a - b`, exactly, reduced. */
const subtractTimes = (a: Rational, b: Rational): Rational => {
  const numerator = BigInt(a.num) * BigInt(b.den) - BigInt(b.num) * BigInt(a.den)
  const denominator = BigInt(a.den) * BigInt(b.den)
  const divisor = gcd(numerator, denominator) || 1n
  const num = Number(numerator / divisor)
  const den = Number(denominator / divisor)
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den)) invalid('The time is out of range')
  return { num, den }
}

/** A signed rational length (`duration` fields may be negative deltas) in frames of `rate`. */
const signedFrames = (
  payload: Record<string, unknown>,
  name: string,
  rate: number | Rational,
): number => {
  const value = payload[name]
  if (!isRational(value)) invalid(`${name} must be an exact rational duration`)
  return secondsToFrames(value as Rational, rate)
}

/** Nearest integer to `numerator / denominator` (both positive); halves round up. */
const roundQuotient = (numerator: bigint, denominator: bigint): number => {
  const value = Number((2n * numerator + denominator) / (2n * denominator))
  if (!Number.isSafeInteger(value)) invalid('The duration is out of range')
  return value
}

/** Run `work` with Freecut's linked-selection toggle set, restoring the editor's own value after. */
const withLinkedSelection = <T>(enabled: boolean, work: () => T): T => {
  const previous = useEditorStore.getState().linkedSelectionEnabled
  useEditorStore.setState({ linkedSelectionEnabled: enabled })
  try {
    return work()
  } finally {
    useEditorStore.setState({ linkedSelectionEnabled: previous })
  }
}

const trackOf = (item: TimelineItem) => tracks().find((track) => track.id === item.trackId)

/** Freecut's edit actions do not check track locks themselves (the UI does); commands must. */
const assertUnlocked = (ids: readonly string[], command: string) => {
  for (const id of ids) {
    if (trackOf(requireItem(id))?.locked) failed(`${command}: a clip it would change is on a locked track`)
  }
}

/** The clips `ids` and everything linked to them, as Freecut's linked edits would reach. */
const linkedSet = (ids: readonly string[]): string[] =>
  expandIdsWithLinkedItems(items(), [...ids], true)

/** The clip directly before (`left`) or after (`right`) `item` on its track, touching it. */
const adjacentOnTrack = (item: TimelineItem, side: 'left' | 'right'): TimelineItem | undefined =>
  items().find(
    (candidate) =>
      candidate.trackId === item.trackId &&
      candidate.id !== item.id &&
      (side === 'right'
        ? candidate.from === item.from + item.durationInFrames
        : candidate.from + candidate.durationInFrames === item.from),
  )

/** No two clips on the given tracks may occupy the same frame after an edit. */
const assertNoOverlap = (trackIds: Iterable<string>, command: string) => {
  for (const trackId of new Set(trackIds)) {
    const onTrack = items()
      .filter((item) => item.trackId === trackId)
      .sort((a, b) => a.from - b.from)
    for (let index = 1; index < onTrack.length; index++) {
      const previous = onTrack[index - 1]!
      if (previous.from + previous.durationInFrames > onTrack[index]!.from) {
        failed(`${command}: clips would overlap on track "${trackId}"`)
      }
    }
  }
}

const HEX_COLOUR = /^#[0-9a-f]{6}$/i

/** Media usable by a source edit: the kinds `clip.add` accepts, with its source cadence. */
const sourceMediaOf = (media: Map<string, MediaMetadata>, assetId: string) => {
  const source = media.get(assetId)
  if (!source) invalid(`assetId: "${assetId}" is not media this session may use`)
  const mediaType = source!.mimeType.startsWith('image/')
    ? ('image' as const)
    : source!.mimeType.startsWith('video/')
      ? ('video' as const)
      : invalid(`assetId: unsupported media type ${source!.mimeType}`)
  return { source: source!, mediaType: mediaType as 'image' | 'video' }
}

/**
 * The first unlocked audio track for a video's linked sound, created as `clip.add` does when the
 * project has none. A locked audio track is never written to.
 */
const audioTrackForLinkedSound = (command: string): string => {
  const audio = tracks().filter((candidate) => !candidate.isGroup && candidate.kind === 'audio')
  const open = audio.find((candidate) => !candidate.locked)
  if (open) return open.id
  if (audio.length > 0) failed(`${command}: every audio track is locked`)
  const all = tracks()
  const created = createClassicTrack({
    tracks: all,
    kind: 'audio',
    order: Math.max(0, ...all.map((t) => t.order)) + 1,
  })
  setTracks([...all, created])
  return created.id
}

/**
 * Split every clip on `trackIds` that crosses `frame`, keeping linked groups and transitions
 * consistent. Companions of a split clip that sit on other tracks are split with it, as Freecut's
 * own split does, so their halves stay paired.
 */
const splitTracksAt = (trackIds: ReadonlySet<string>, frame: number, command: string) => {
  const crossing = items().filter(
    (item) =>
      trackIds.has(item.trackId) &&
      item.from < frame &&
      item.from + item.durationInFrames > frame,
  )
  const anchors = getUniqueLinkedItemAnchorIds(items(), crossing.map((item) => item.id))
  for (const anchorId of anchors) {
    const group = getLinkedItemIds(items(), anchorId)
    const crosses = (id: string) => {
      const item = requireItem(id)
      return item.from < frame && item.from + item.durationInFrames > frame
    }
    // A linked group is cut together or not at all, as Freecut's split requires.
    if (!group.every(crosses)) failed(`${command}: linked clips of "${anchorId}" are not all cut at that time`)
    const results: SplitResultEntry[] = []
    for (const id of group) {
      const item = requireItem(id)
      const result = useItemsStore.getState()._splitItem(id, frame)
      if (!result) failed(`${command}: "${id}" cannot be cut at that time`)
      results.push({ originalId: id, originalLinkedGroupId: item.linkedGroupId, result: result! })
    }
    applySplitBookkeeping(results)
  }
}

/**
 * Build the items a source edit places: the primary clip on `trackId` and, for a video with
 * sound, its linked audio. The source range is exact: `sourceIn`/`sourceOut` become source frames
 * on the media's own cadence, and the timeline length is the range's exact length on the project's.
 */
const buildSourceEdit = (
  payload: Record<string, unknown>,
  { fps, cadence, media }: { fps: number; cadence: Rational; media: Map<string, MediaMetadata> },
  command: string,
) => {
  const { source, mediaType } = sourceMediaOf(media, stringField(payload, 'assetId'))
  const track = requireTrack(stringField(payload, 'trackId'))
  if ((track.kind ?? 'video') !== 'video') invalid('trackId: library media goes on a video track')
  if (track.locked) failed(`${command}: the destination track is locked`)
  const at = timeField(payload, 'at', cadence)
  const sourceIn = payload.sourceIn
  const sourceOut = payload.sourceOut
  if (!isRational(sourceIn) || !isRational(sourceOut)) invalid('sourceIn and sourceOut must be exact rational times')
  if ((sourceIn as Rational).num < 0) invalid('sourceIn must not be negative')
  const length = subtractTimes(sourceOut as Rational, sourceIn as Rational)
  if (length.num <= 0) invalid('sourceOut must be after sourceIn')
  const durationInFrames = secondsToFrames(length, cadence)
  if (durationInFrames < 1) invalid('The marked range is shorter than one frame')

  let sourceStart: number | undefined
  let sourceEnd: number | undefined
  if (mediaType === 'video') {
    // FL-93: the source cadence must be read exactly; a VFR or unusual rate is refused, not rounded.
    sourceStart = secondsToFrames(sourceIn as Rational, source.fps)
    sourceEnd = secondsToFrames(sourceOut as Rational, source.fps)
    const available = Math.max(1, Math.round(source.duration * source.fps))
    if (sourceEnd > available) invalid('sourceOut is past the end of the source')
    if (sourceEnd <= sourceStart) invalid('The marked range is shorter than one source frame')
  }
  const linkVideoAudio = mediaType === 'video' && !!source.audioCodec
  const audioTrackId = linkVideoAudio ? audioTrackForLinkedSound(command) : undefined
  const { width, height } = canvas()
  const placed = buildMediaTimelineItems({
    media: source,
    mediaId: source.id,
    mediaType,
    label: source.fileName,
    projectFps: fps,
    blobUrl: '',
    canvasWidth: width,
    canvasHeight: height,
    sourceStart,
    sourceEnd,
    placements: {
      primary: { trackId: track.id, from: at, durationInFrames },
      ...(audioTrackId ? { linkedAudio: { trackId: audioTrackId, from: at, durationInFrames } } : {}),
    },
    linkVideoAudio,
  })
  return { placed, at, durationInFrames, trackIds: placed.map((item) => item.trackId) }
}

/** Add the placed clips and check each landed exactly where the edit put it. */
const landSourceEdit = (placed: TimelineItem[], command: string) => {
  addItems(placed)
  for (const item of placed) {
    const landed = useItemsStore.getState().itemById[item.id]
    if (!landed || landed.from !== item.from || landed.durationInFrames !== item.durationInFrames) {
      failed(`${command}: the clip could not be placed`)
    }
  }
  applyTransitionRepairs(placed.map((item) => item.id))
}

/* ------------------------------------------------------------------ */
/* Vocabulary mappings                                                  */
/* ------------------------------------------------------------------ */

/** The prototype's transition names (`studio-project.mjs` `transitionTypes`) as Freecut presentations. */
export const prototypeTransitions: Record<string, TransitionPresentation> = {
  'Cross dissolve': 'dissolve',
  'Dip to black': 'dipToColorDissolve',
  Wipe: 'wipe',
  Slide: 'slide',
  Zoom: 'lensWarpZoom',
}

export const transitionPresentationOf = (type: string): TransitionPresentation => {
  const presentation = prototypeTransitions[type] ?? type
  if (!transitionRegistry.has(presentation)) invalid(`transition: unknown type "${type}"`)
  return presentation
}

/** The prototype's title styles (`titleStyles`) as Freecut text style presets, or a plain weight. */
export const prototypeTitleStyles: Record<string, TextStylePresetId | 'plain' | 'bold'> = {
  Minimal: 'plain',
  Bold: 'bold',
  Serif: 'quote',
  Outline: 'outline-pill',
  'Lower third': 'lower-third',
  'Caption bar': 'badge',
}

const titleStyleOf = (style: string): TextStylePresetId | 'plain' | 'bold' => {
  const mapped = prototypeTitleStyles[style] ?? style
  if (mapped === 'plain' || mapped === 'bold') return mapped
  if (!(TEXT_STYLE_PRESET_IDS as readonly string[]).includes(mapped))
    invalid(`style: unknown title style "${style}"`)
  return mapped as TextStylePresetId
}

/** The prototype's nine-point title positions (`titlePositions`). */
const titlePositionOf = (position: string): Pick<TextItem, 'textAlign' | 'verticalAlign'> => {
  const match = /^([tmb])([lcr])$/.exec(position)
  if (!match) invalid(`position: unknown title position "${position}"`)
  const [, vertical, horizontal] = match!
  return {
    verticalAlign: vertical === 't' ? 'top' : vertical === 'm' ? 'middle' : 'bottom',
    textAlign: horizontal === 'l' ? 'left' : horizontal === 'c' ? 'center' : 'right',
  }
}

/** The prototype's title animations (`titleAnimations`) as Freecut text motion presets. */
export const prototypeTitleAnimations: Record<string, { in: string; out?: string }> = {
  Fade: { in: 'fade-up', out: 'fade-down' },
  Rise: { in: 'rise', out: 'sink' },
  Typewriter: { in: 'typewriter', out: 'typewriter-erase' },
  Slide: { in: 'slide-mask' },
}

const titleMotionOf = (animation: string): TextItem['textMotion'] => {
  const mapped = prototypeTitleAnimations[animation] ?? { in: animation }
  if (!(TEXT_MOTION_IN_PRESET_IDS as readonly string[]).includes(mapped.in)) {
    invalid(`animation: unknown title animation "${animation}"`)
  }
  const motion: NonNullable<TextItem['textMotion']> = {
    in: createTextMotionEffect(
      mapped.in as (typeof TEXT_MOTION_IN_PRESET_IDS)[number],
      0,
    ) as NonNullable<TextItem['textMotion']>['in'],
  }
  if (mapped.out && (TEXT_MOTION_OUT_PRESET_IDS as readonly string[]).includes(mapped.out)) {
    motion.out = createTextMotionEffect(
      mapped.out as (typeof TEXT_MOTION_OUT_PRESET_IDS)[number],
      0,
    ) as NonNullable<TextItem['textMotion']>['out']
  }
  return motion
}

const applyTitleStyle = (item: TextItem, style: string): Partial<TextItem> => {
  const mapped = titleStyleOf(style)
  if (mapped === 'plain') return { fontWeight: 'medium' }
  if (mapped === 'bold') return { fontWeight: 'bold' }
  const {
    text: _text,
    textSpans: _spans,
    label: _label,
    ...styling
  } = applyTextStylePresetToItem(item, mapped, canvas())
  return styling
}

/** `{ x, y, scale, rotation, opacity }` from the prototype, onto Freecut's transform. */
const transformOf = (
  item: TimelineItem,
  intent: Record<string, unknown>,
): Partial<TransformProperties> => {
  const allowed = new Set(['x', 'y', 'scale', 'rotation', 'opacity'])
  for (const key of Object.keys(intent)) {
    if (!allowed.has(key)) invalid(`transform: unknown field "${key}"`)
  }
  const transform: Partial<TransformProperties> = {}
  for (const key of ['x', 'y', 'rotation', 'opacity'] as const) {
    const value = intent[key]
    if (value === undefined) continue
    if (typeof value !== 'number' || !Number.isFinite(value))
      invalid(`transform.${key} must be a number`)
    transform[key] = value as number
  }
  if (transform.opacity !== undefined && (transform.opacity < 0 || transform.opacity > 1)) {
    invalid('transform.opacity must be between 0 and 1')
  }
  if (intent.scale !== undefined) {
    const scale = intent.scale
    if (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0)
      invalid('transform.scale must be positive')
    // Scale is relative to Freecut's fit-to-canvas size, as the prototype's is to the frame.
    const fitted = resolveTransform(
      { ...item, transform: undefined } as TimelineItem,
      canvas(),
      getSourceDimensions(item),
    )
    transform.width = fitted.width * (scale as number)
    transform.height = fitted.height * (scale as number)
  }
  if (Object.keys(transform).length === 0) invalid('transform must change something')
  return transform
}

/**
 * Freecut's transform action leaves an item without a `transform` object unchanged, silently
 * (`items-store.ts` `_updateItemTransform`). Give it an empty one first, then check the result.
 */
const setTransform = (id: string, transform: Partial<TransformProperties>) => {
  if (!('transform' in requireItem(id))) updateItem(id, { transform: {} } as Partial<TimelineItem>)
  updateItemTransform(id, transform)
  const applied = (requireItem(id) as { transform?: Record<string, unknown> }).transform ?? {}
  for (const [key, value] of Object.entries(transform)) {
    if (applied[key] !== value) failed(`transform.${key} was not applied`)
  }
}

/* ------------------------------------------------------------------ */
/* Handlers                                                             */
/* ------------------------------------------------------------------ */

/**
 * One context per batch. A settings command replaces `project` and moves `fps`/`cadence`, so later
 * envelopes in the same batch read their times on the new rate.
 */
interface BatchContext {
  fps: number
  cadence: Rational
  media: Map<string, MediaMetadata>
  project: Project
}

type Handler = (payload: Record<string, unknown>, context: BatchContext) => void | Promise<void>

/* ------------------------------------------------------------------ */
/* Canvas and rate (FL-94)                                              */
/* ------------------------------------------------------------------ */

/**
 * Freecut's own project canvas limits (`projects/utils/validation.ts`). Odd sizes are allowed, as
 * Freecut's templates use them (Twitter/X 1200x675); the renderer rounds them to even for encoding.
 */
const canvasSide = (payload: Record<string, unknown>, name: string, min: number, max: number) => {
  const value = payload[name]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    invalid(`${name} must be a whole number of pixels from ${min} to ${max}`)
  }
  return value as number
}

/**
 * A rate the editor offers for a project (`isAllowedProjectFps`), or the exact NTSC x/1001 rate of
 * one of them (FL-93), such as 30000/1001.
 */
const sequenceRate = (payload: Record<string, unknown>): Rational | undefined => {
  const value = payload.fps
  if (value === undefined) return undefined
  const exact = isRational(value) && value.num > 0 ? cadenceFromDecimal(value.num / value.den) : null
  const matches = exact && exact.num * (value as Rational).den === (value as Rational).num * exact.den
  const offered = exact && isAllowedProjectFps(exact.den === 1 ? exact.num : exact.num / 1000)
  if (!matches || !offered) {
    invalid('fps must be a project frame rate (24, 25, 30, 50, 60, 120 or 240) or its x/1001 rate')
  }
  return exact!
}

/** A stored rate as an exact cadence, or a refusal naming what has none. */
const storedRate = (fps: number, what: string): number => {
  if (!cadenceFromDecimal(fps)) invalid(`${what} has the frame rate ${fps}, which has no exact reading`)
  return fps
}

const timingPolicy = (payload: Record<string, unknown>): RetimePolicy | undefined => {
  const value = payload.timing
  if (value === undefined) return undefined
  if (!RETIME_POLICIES.includes(value as RetimePolicy)) invalid(`timing must be one of ${RETIME_POLICIES.join(', ')}`)
  return value as RetimePolicy
}

const requirePolicy = (timing: RetimePolicy | undefined, what: string): RetimePolicy => {
  if (!timing) {
    invalid(`timing is required: ${what} has content, so choose keep-time or keep-frames for the new frame rate`)
  }
  return timing!
}

type StoredComposition = NonNullable<NonNullable<Project['timeline']>['compositions']>[number]

/** The id `sequence.setSettings` and bundle exports use for the project's main timeline. */
const MAIN_SEQUENCE_ID = 'main'

const readsComposition = (timeline: NonNullable<Project['timeline']>, compositionId: string) =>
  [timeline.items ?? [], ...(timeline.compositions ?? []).map((entry) => entry.items ?? [])].some((items) =>
    items.some((item) => (item as { compositionId?: string }).compositionId === compositionId),
  )

/**
 * Apply a canvas and rate change to the main timeline (`'main'`) or one sequence/composition, then
 * reload the stores from the changed graph. Nothing is retimed unless `keep-time` was chosen.
 */
async function applySequenceSettings(
  context: BatchContext,
  sequenceId: string,
  settings: { rate?: Rational; width?: number; height?: number },
  timing: RetimePolicy | undefined,
): Promise<void> {
  const timeline = buildTimelineFromStores()
  const toFps = settings.rate && settings.rate.num / settings.rate.den
  let metadata = context.project.metadata
  let next = timeline

  const composition = timeline.compositions?.find((entry) => entry.id === sequenceId)
  if (sequenceId === MAIN_SEQUENCE_ID && composition) {
    invalid(`sequenceId: "${MAIN_SEQUENCE_ID}" names both the main timeline and a sequence`)
  }

  if (sequenceId === MAIN_SEQUENCE_ID) {
    const fromFps = storedRate(metadata.fps, 'the project')
    if (toFps !== undefined && !sameRate(toFps, fromFps) && hasTimedContent(timeline as never)) {
      if (requirePolicy(timing, 'the main timeline') === 'keep-time') {
        next = retimeContent(timeline as never, fromFps, toFps)
      }
    }
    metadata = {
      ...metadata,
      ...(settings.width !== undefined && { width: settings.width }),
      ...(settings.height !== undefined && { height: settings.height }),
      ...(settings.rate && { fps: toFps!, frameRate: { ...settings.rate } }),
    } as typeof metadata
  } else {
    if (!composition) invalid(`sequenceId: sequence "${sequenceId}" does not exist`)
    const fromFps = storedRate(composition!.fps, `sequence "${sequenceId}"`)
    let changed: StoredComposition = { ...composition! }
    if (toFps !== undefined && !sameRate(toFps, fromFps)) {
      // Compound clips that read the sequence move with its rate even when it is empty.
      const policy =
        hasTimedContent(composition as never) || readsComposition(timeline, sequenceId)
          ? requirePolicy(timing, `sequence "${sequenceId}"`)
          : undefined
      // Compound clips read the sequence's frames in seconds at its rate: with its frame numbers
      // kept, what they show would change under them.
      if (policy === 'keep-frames' && readsComposition(timeline, sequenceId)) {
        invalid(`sequence "${sequenceId}" is used by compound clips; change its rate with keep-time`)
      }
      if (policy === 'keep-time') {
        changed = retimeContent(changed as never, fromFps, toFps)
        const readers = (items: unknown[]) =>
          retimeCompositionReaders(items as TimelineItem[], sequenceId, fromFps, toFps) as never
        next = {
          ...timeline,
          items: readers(timeline.items ?? []),
          compositions: timeline.compositions!.map((entry) => ({ ...entry, items: readers(entry.items ?? []) })),
        }
        changed = { ...changed, items: readers(changed.items ?? []) }
      }
      changed.fps = toFps
    }
    if (settings.width !== undefined) changed.width = settings.width
    if (settings.height !== undefined) changed.height = settings.height
    next = {
      ...next,
      compositions: (next.compositions ?? []).map((entry) => (entry.id === sequenceId ? changed : entry)),
    }
  }

  context.project = { ...context.project, metadata, timeline: next }
  await hydrateTimelineStoresFromProject(context.project)
  projectCanvas = { width: metadata.width || 1920, height: metadata.height || 1080, fps: metadata.fps || 30 }
  context.fps = projectCanvas.fps
  context.cadence = projectCadenceOf(metadata) ?? context.cadence
}

/** Clip and track EQ replace the same engine stage, with identical admission rules. */
function canonicalAudioEq(value: unknown) {
  if (value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) invalid('eq must be an object or null')
  const eq = value as Record<string, unknown>
  const defaults: Record<string, unknown> = { enabled: true, ...DEFAULT_AUDIO_EQ_SETTINGS }
  const resolved = resolveAudioEqSettings(eq as AudioEqSettings)
  for (const [key, setting] of Object.entries(eq)) {
    if (!Object.hasOwn(defaults, key)) invalid(`eq: unknown field "${key}"`)
    if (typeof setting !== typeof defaults[key] || (typeof setting === 'number' && !Number.isFinite(setting)) ||
        (key !== 'enabled' && resolved[key as keyof typeof resolved] !== setting))
      invalid(`eq.${key} is outside the engine's type or range, or contradicts its cut-band aliases`)
  }
  return { ...resolved, enabled: eq.enabled as boolean | undefined }
}

const handlers: Record<string, Handler> = {
  'captions.set'(payload, { cadence }) {
    if (Object.keys(payload).some((key) => key !== 'captions') || !Array.isArray(payload.captions))
      invalid('captions.set requires a captions array')
    const previous = items().filter((item): item is TextItem => item.type === 'text' && item.textRole === 'caption')
    const byId = new Map(previous.map((item) => [item.id, item]))
    const occupied = new Set([...items(), ...useCompositionsStore.getState().compositions.flatMap((composition) => composition.items)]
      .map((item) => item.id))
    const ids = new Set<string>()
    let bytes = 0
    const captions = (payload.captions as unknown[]).map((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Each caption must be an object')
      const line = value as Record<string, unknown>
      if (Object.keys(line).some((key) => !['id', 'start', 'end', 'text'].includes(key))) invalid('Unknown caption field')
      const id = line.id === undefined ? undefined : stringField(line, 'id')
      if (id !== undefined && (ids.has(id) || (occupied.has(id) && !byId.has(id)))) invalid('Caption ids must be unique and cannot replace other clips')
      if (id !== undefined) ids.add(id)
      const text = stringField(line, 'text')
      if (!text.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) invalid('Caption text must be nonblank and contain no control characters')
      if (!isRational(line.start) || !isRational(line.end)) invalid('Caption times must be exact rationals')
      const start = line.start as Rational
      const end = line.end as Rational
      if (start.num < 0 || end.num < 0 || BigInt(end.num) * BigInt(start.den) <= BigInt(start.num) * BigInt(end.den)) invalid('Caption end must be after its nonnegative start')
      const from = secondsToFrames(start, cadence)
      const durationInFrames = secondsToFrames(end, cadence) - from
      if (durationInFrames < 1) invalid('Captions must span at least one frame')
      bytes += new TextEncoder().encode(JSON.stringify({ id, start: { num: start.num, den: start.den }, end: { num: end.num, den: end.den }, text })).byteLength
      // Match the existing inline subtitle import limit, including cue metadata.
      if (bytes > 4 * 1024 * 1024) invalid('Caption sets must be no larger than 4 MB')
      return { id, text, from, durationInFrames }
    }).sort((a, b) => a.from - b.from)
    const subtitles = items().filter((item) => item.type === 'subtitle')
    const virtual = items().filter((item) => item.transcriptCaptions?.enabled)
    assertUnlocked([...previous, ...subtitles, ...virtual].map((item) => item.id), 'captions.set')
    withLinkedSelection(false, () => removeItems([...previous.filter((item) => !ids.has(item.id)), ...subtitles].map((item) => item.id)))
    for (const item of virtual) updateItem(item.id, { transcriptCaptions: { ...item.transcriptCaptions!, enabled: false } })
    const additions: TextItem[] = []
    const planned = items().filter((item) => !byId.has(item.id))
    const { width, height } = canvas()
    for (const line of captions) {
      const old = line.id ? byId.get(line.id) : undefined
      let track = old && !planned.some((item) => item.trackId === old.trackId && item.from < line.from + line.durationInFrames && item.from + item.durationInFrames > line.from)
        ? trackOf(old)
        : findCompatibleCaptionTrack(tracks().filter((candidate) => isCaptionTrackCandidate(candidate, items()) &&
          items().every((item) => item.trackId !== candidate.id || byId.has(item.id))), planned, line.from, line.from + line.durationInFrames)
      if (!track) {
        track = createClassicTrack({ tracks: tracks(), kind: 'video', order: Math.min(0, ...tracks().map((candidate) => candidate.order)) - 1 })
        setTracks([...tracks(), track])
      }
      if (old) {
        const update = { text: line.text, from: line.from, durationInFrames: line.durationInFrames, trackId: track.id,
          label: line.text.slice(0, 64), ...(old.text !== line.text ? { textSpans: undefined, textLayoutDrafts: undefined } : {}) }
        updateItem(old.id, update)
        planned.push({ ...old, ...update })
      } else {
        let id = line.id
        if (!id) {
          do { id = crypto.randomUUID() } while (occupied.has(id) || ids.has(id))
          ids.add(id)
        }
        const item: TextItem = { ...getCaptionStyleTemplateFromPreset('netflix', width, height), ...line, id,
          type: 'text', textRole: 'caption', trackId: track.id, label: line.text.slice(0, 64), color: '#ffffff' }
        additions.push(item)
        planned.push(item)
      }
    }
    addItems(additions)
  },

  'clip.add'(payload, { fps, cadence, media }) {
    const assetId = stringField(payload, 'assetId')
    const track = requireTrack(stringField(payload, 'trackId'))
    const from = timeField(payload, 'at', cadence)
    const duration = optionalTime(payload, 'duration', cadence)
    if (duration !== undefined && duration < 1) invalid('duration must be at least one frame')
    const source = media.get(assetId)
    if (!source) invalid(`assetId: "${assetId}" is not media this session may use`)
    const mediaType = source!.mimeType.startsWith('image/')
      ? 'image'
      : source!.mimeType.startsWith('video/')
        ? 'video'
        : invalid(`assetId: unsupported media type ${source!.mimeType}`)
    const kind = optionalString(payload, 'kind')
    if (kind !== undefined && kind !== mediaType && !(kind === 'photo' && mediaType === 'image')) {
      invalid(`kind: "${kind}" does not match the asset`)
    }
    if ((track.kind ?? 'video') !== 'video') invalid('trackId: library media goes on a video track')
    const natural = getDroppedMediaDurationInFrames(source!, mediaType as 'image' | 'video', fps)
    if (mediaType === 'video' && duration !== undefined && duration > natural) {
      invalid('duration is longer than the source')
    }
    const durationInFrames = duration ?? natural
    // A video with sound gets Freecut's linked audio companion, on the first audio track.
    const linkVideoAudio = mediaType === 'video' && !!source!.audioCodec
    let audioTrackId: string | undefined
    if (linkVideoAudio) {
      audioTrackId = tracks().find(
        (candidate) => !candidate.isGroup && candidate.kind === 'audio',
      )?.id
      if (!audioTrackId) {
        const all = tracks()
        const created = createClassicTrack({
          tracks: all,
          kind: 'audio',
          order: Math.max(0, ...all.map((t) => t.order)) + 1,
        })
        setTracks([...all, created])
        audioTrackId = created.id
      }
    }
    const { width, height } = canvas()
    // The editor's own drop path (`buildDroppedMediaTimelineItems`), so a command-placed clip is
    // the clip a person dragging the same media would get.
    const placed = buildDroppedMediaTimelineItems({
      media: source!,
      mediaId: assetId,
      mediaType: mediaType as 'image' | 'video',
      label: source!.fileName,
      timelineFps: fps,
      blobUrl: '',
      canvasWidth: width,
      canvasHeight: height,
      placement: {
        primary: { trackId: track.id, from, durationInFrames },
        ...(audioTrackId ? { linkedAudio: { trackId: audioTrackId, from, durationInFrames } } : {}),
      },
      linkVideoAudio,
    })
    addItems(placed)
    for (const item of placed) {
      const landed = useItemsStore.getState().itemById[item.id]
      if (!landed || landed.from !== from) failed('clip.add: that place on the track is taken')
    }
  },

  'music.add'() {
    // FL-86: the bundled music catalogue is rights-blocked in every build; no track id resolves.
    failed('music: the music catalogue is not available in this build (FL-86 rights)')
  },

  'clip.delete'(payload) {
    const ids = Array.isArray(payload.clipIds)
      ? (payload.clipIds as unknown[])
      : payload.clipId !== undefined
        ? [payload.clipId]
        : []
    if (ids.length === 0 || ids.some((id) => typeof id !== 'string'))
      invalid('clipId or clipIds is required')
    for (const id of ids as string[]) requireItem(id, 'clipIds')
    if (payload.ripple === true) rippleDeleteItems(ids as string[])
    else removeItems(ids as string[])
  },

  'clip.move'(payload, { cadence }) {
    const item = requireItem(stringField(payload, 'clipId'))
    const from = timeField(payload, 'start', cadence)
    const trackId = optionalString(payload, 'trackId')
    if (payload.linkedSelectionEnabled !== undefined && typeof payload.linkedSelectionEnabled !== 'boolean') {
      invalid('linkedSelectionEnabled must be a boolean')
    }
    if (trackId && requireTrack(trackId).locked) failed('clip.move: the destination track is locked')
    const ids = filterUnlockedItemIds(items(), tracks(), expandIdsWithLinkedItems(
      items(), [item.id], payload.linkedSelectionEnabled !== false,
    ))
    if (!ids.includes(item.id)) failed('clip.move: the clip is on a locked track')
    const delta = from - item.from
    const updates = ids.map((id) => ({
      id,
      from: requireItem(id).from + delta,
      ...(id === item.id && trackId ? { trackId } : {}),
    }))
    if (updates.some((update) => update.from < 0)) {
      failed('clip.move: a linked clip or caption would start before the timeline')
    }
    moveItems(updates)
    for (const update of updates) {
      const moved = requireItem(update.id)
      if (moved.from !== update.from || (update.trackId && moved.trackId !== update.trackId)) {
        failed('clip.move: the clips cannot move to the requested positions')
      }
    }
  },

  'clip.setTransform'(payload) {
    const item = requireItem(stringField(payload, 'clipId'))
    const intent = payload.transform
    if (!intent || typeof intent !== 'object') invalid('transform is required')
    setTransform(item.id, transformOf(item, intent as Record<string, unknown>))
  },

  'clip.setTransformParent'(payload) {
    const child = requireItem(stringField(payload, 'clipId'))
    const parentId = payload.parentId
    if (parentId !== null && parentId !== undefined && typeof parentId !== 'string')
      invalid('parentId must be a clip id or null')
    if (typeof parentId === 'string') requireItem(parentId, 'parentId')
    const ok = setTransformParent({
      childItemId: child.id,
      ...(typeof parentId === 'string' ? { parentItemId: parentId } : {}),
      frame: child.from,
      canvas: canvas(),
    })
    if (!ok) failed('clip.setTransformParent: the parent would create a cycle or is not allowed')
  },

  'clip.setTransition'(payload, { cadence }) {
    const item = requireItem(stringField(payload, 'clipId'))
    const existing = useTransitionsStore
      .getState()
      .transitions.find((transition) => transition.leftClipId === item.id)
    const intent = payload.transition
    if (intent === null) {
      if (existing) removeTransition(existing.id)
      return
    }
    if (!intent || typeof intent !== 'object') invalid('transition must be an object or null')
    const { type, duration } = intent as { type?: unknown; duration?: unknown }
    if (typeof type !== 'string') invalid('transition.type is required')
    const presentation = transitionPresentationOf(type as string)
    const frames = timeField({ duration }, 'duration', cadence)
    if (frames < 1) invalid('transition.duration must be at least one frame')
    if (existing) {
      updateTransition(existing.id, { durationInFrames: frames, presentation })
      const applied = useTransitionsStore
        .getState()
        .transitions.find((transition) => transition.id === existing.id)
      if (applied?.durationInFrames !== frames)
        failed('clip.setTransition: the clips do not have enough handle for that length')
      return
    }
    const next = nextOnTrack(item)
    if (!next) invalid('clip.setTransition: no clip follows this one on its track')
    if (!addTransition(item.id, next!.id, 'crossfade', frames, presentation)) {
      failed('clip.setTransition: the clips cannot share a transition')
    }
  },

  'clip.split'(payload, { cadence }) {
    const frame = timeField(payload, 'at', cadence)
    const ids = payload.clipIds
    if (payload.linkedSelectionEnabled !== undefined && typeof payload.linkedSelectionEnabled !== 'boolean') {
      invalid('linkedSelectionEnabled must be a boolean')
    }
    const previous = useEditorStore.getState().linkedSelectionEnabled
    useEditorStore.setState({ linkedSelectionEnabled: payload.linkedSelectionEnabled !== false })
    try {
      if (ids === undefined) {
        if (splitAllItemsAtFrame(frame) === 0) invalid('clip.split: nothing spans that time')
        return
      }
      if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== 'string'))
        invalid('clipIds must be clip ids')
      for (const id of ids as string[]) requireItem(id, 'clipIds')
      // splitItem already splits linked companions; choose anchors before it rewrites their groups.
      const anchors = payload.linkedSelectionEnabled !== false
        ? getUniqueLinkedItemAnchorIds(items(), ids as string[])
        : [...new Set(ids as string[])]
      for (const id of anchors) {
        if (!splitItem(id, frame)) invalid(`clip.split: "${id}" cannot be split there`)
      }
    } finally {
      useEditorStore.setState({ linkedSelectionEnabled: previous })
    }
  },

  'clip.trimStart'(payload, { cadence }) {
    const item = requireItem(stringField(payload, 'clipId'))
    const start = timeField(payload, 'start', cadence)
    const delta = start - item.from
    if (delta === 0) return
    if (start >= item.from + item.durationInFrames) invalid('start must be before the clip ends')
    if (payload.ripple === true) rippleTrimItem(item.id, 'start', delta)
    else trimItemStart(item.id, delta)
    if (requireItem(item.id).durationInFrames !== item.durationInFrames - delta)
      failed('clip.trimStart: the requested start exceeds the source or timeline limits')
  },

  'clip.trimEnd'(payload, { cadence }) {
    const item = requireItem(stringField(payload, 'clipId'))
    const end = timeField(payload, 'end', cadence)
    const delta = end - (item.from + item.durationInFrames)
    if (delta === 0) return
    if (end <= item.from) invalid('end must be after the clip starts')
    if (payload.ripple === true) rippleTrimItem(item.id, 'end', delta)
    else trimItemEnd(item.id, delta)
    if (requireItem(item.id).durationInFrames !== item.durationInFrames + delta)
      failed('clip.trimEnd: the requested end exceeds the source or timeline limits')
  },

  'clip.setAudio'(payload) {
    const item = requireItem(stringField(payload, 'clipId'))
    if (item.type !== 'video' && item.type !== 'audio')
      invalid('clip.setAudio applies to video and audio clips')
    for (const key of Object.keys(payload)) {
      if (!['clipId', 'volume', 'fadeIn', 'fadeOut', 'muted', 'pitchSemitones', 'pitchCents', 'eq'].includes(key))
        invalid(`clip.setAudio: unknown field "${key}"`)
    }
    const updates: Partial<TimelineItem> & Record<string, unknown> = {}
    const volume = optionalNumber(payload, 'volume')
    if (volume !== undefined) {
      if (volume < -60 || volume > 12) invalid('volume must be in -60..12 dB')
      updates.volume = volume
    }
    for (const [field, property] of [['fadeIn', 'audioFadeIn'], ['fadeOut', 'audioFadeOut']] as const) {
      const value = payload[field]
      if (value === undefined) continue
      if (!isRational(value)) invalid(`${field} must be an exact rational duration`)
      const time = value as Rational
      if (time.num < 0 || BigInt(time.num) > 5n * BigInt(time.den))
        invalid(`${field} must be in 0..5 seconds`)
      // Audio fades are stored in seconds; rounding them to video frames would lose short fades.
      updates[property] = time.num / time.den
    }
    for (const [field, property, min, max] of [
      ['pitchSemitones', 'audioPitchSemitones', AUDIO_PITCH_SEMITONES_MIN, AUDIO_PITCH_SEMITONES_MAX],
      ['pitchCents', 'audioPitchCents', AUDIO_PITCH_CENTS_MIN, AUDIO_PITCH_CENTS_MAX],
    ] as const) {
      const value = optionalNumber(payload, field)
      if (value === undefined) continue
      if (!Number.isInteger(value) || value < min || value > max) invalid(`${field} must be an integer in ${min}..${max}`)
      updates[property] = value
    }
    if (payload.eq !== undefined) {
      const eq = canonicalAudioEq(payload.eq)
      if (eq === undefined) {
        for (const key of Object.keys(getAudioEqSettings()))
          updates[`audioEq${key[0]!.toUpperCase()}${key.slice(1)}`] = undefined
      } else {
        Object.assign(updates, buildTimelineEqPatchFromResolvedSettings(eq), { audioEqEnabled: eq.enabled })
      }
    }
    if (payload.muted !== undefined) {
      if (typeof payload.muted !== 'boolean') invalid('muted must be a boolean')
      updates.muted = payload.muted
    }
    if (Object.keys(updates).length === 0) invalid('clip.setAudio needs volume, fadeIn, fadeOut, pitch, eq or muted')
    assertUnlocked([item.id], 'clip.setAudio')
    updateItem(item.id, updates)
  },

  'clip.update'(payload) {
    const item = requireItem(stringField(payload, 'clipId'))
    const patch = payload.patch
    if (!patch || typeof patch !== 'object') invalid('patch is required')
    const fields = patch as Record<string, unknown>
    const allowed = new Set([
      'name',
      'text',
      'style',
      'position',
      'animation',
      'volume',
      'muted',
      'transform',
    ])
    for (const key of Object.keys(fields))
      if (!allowed.has(key)) invalid(`patch: unknown field "${key}"`)
    const updates: Partial<TextItem> & Record<string, unknown> = {}
    if (fields.name !== undefined) updates.label = optionalString(fields, 'name')
    const isText = item.type === 'text'
    for (const key of ['text', 'style', 'position', 'animation'] as const) {
      if (fields[key] !== undefined && !isText) invalid(`patch.${key} applies to titles only`)
    }
    if (fields.text !== undefined) updates.text = optionalString(fields, 'text')
    if (fields.style !== undefined)
      Object.assign(updates, applyTitleStyle(item as TextItem, optionalString(fields, 'style')!))
    if (fields.position !== undefined)
      Object.assign(updates, titlePositionOf(optionalString(fields, 'position')!))
    if (fields.animation !== undefined)
      updates.textMotion = titleMotionOf(optionalString(fields, 'animation')!)
    if (fields.volume !== undefined) {
      if (item.type !== 'video' && item.type !== 'audio')
        invalid('patch.volume applies to video and audio clips')
      updates.volume = optionalNumber(fields, 'volume')
    }
    if (fields.muted !== undefined) {
      if (item.type !== 'video' && item.type !== 'audio') invalid('patch.muted applies to video and audio clips')
      if (typeof fields.muted !== 'boolean') invalid('patch.muted must be a boolean')
      assertUnlocked([item.id], 'clip.update')
      updates.muted = fields.muted
    }
    if (Object.keys(updates).length > 0) updateItem(item.id, updates as Partial<TimelineItem>)
    if (fields.transform !== undefined) {
      if (!fields.transform || typeof fields.transform !== 'object')
        invalid('patch.transform must be an object')
      setTransform(
        item.id,
        transformOf(requireItem(item.id), fields.transform as Record<string, unknown>),
      )
    }
  },

  'composition.add'(payload) {
    const name = stringField(payload, 'name')
    const ids = payload.clipIds
    if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== 'string')) {
      invalid('composition.add needs the clips to gather (clipIds)')
    }
    for (const id of ids as string[]) requireItem(id, 'clipIds')
    if (payload.trackId !== undefined || payload.at !== undefined) {
      invalid(
        'composition.add places the composition where its clips were; trackId and at are not accepted',
      )
    }
    if (!createPreComp(name, ids as string[]))
      failed('composition.add: these clips cannot form a composition')
  },

  'effect.add'(payload) {
    const item = requireItem(stringField(payload, 'clipId'))
    const gpuEffectType = stringField(payload, 'effect')
    if (!getGpuEffect(gpuEffectType)) invalid(`effect: unknown effect "${gpuEffectType}"`)
    const params = payload.params ?? {}
    if (!params || typeof params !== 'object' || Array.isArray(params))
      invalid('params must be an object')
    const before = (requireItem(item.id) as { effects?: Array<{ id: string }> }).effects ?? []
    addEffect(item.id, { type: 'gpu-effect', gpuEffectType, params } as never)
    const index = optionalNumber(payload, 'index')
    if (index !== undefined) {
      if (!Number.isInteger(index) || index < 0 || index > before.length)
        invalid('index is outside the effect stack')
      const after = [
        ...((requireItem(item.id) as { effects?: Array<{ id: string }> }).effects ?? []),
      ]
      const [added] = after.splice(after.length - 1, 1)
      after.splice(index, 0, added!)
      setItemEffects([{ itemId: item.id, effects: after as never }])
    }
  },

  'effect.remove'(payload) {
    const item = requireItem(stringField(payload, 'clipId'))
    const effectId = stringField(payload, 'effectId')
    const effects = (item as { effects?: Array<{ id: string }> }).effects ?? []
    if (!effects.some((effect) => effect.id === effectId))
      invalid(`effectId: "${effectId}" is not on this clip`)
    removeEffect(item.id, effectId)
  },

  'keyframe.add'(payload, { cadence }) {
    const item = requireItem(stringField(payload, 'clipId'))
    const property = stringField(payload, 'property') as AnimatableProperty
    if (isVectorProperty(property)) {
      const at = timeField(payload, 'at', cadence)
      if (at < item.from || at >= item.from + item.durationInFrames) invalid('at must fall inside the clip')
      const easing = optionalString(payload, 'easing') as EasingType | undefined
      if (easing !== undefined && !EASINGS.includes(easing)) invalid(`easing must be one of ${EASINGS.join(', ')}`)
      const id = upsertVectorKeyframe(item.id, property as never, {
        frame: at - item.from,
        value: vectorField(payload.value, 'value'),
        ...(easing ? { easing } : {}),
      })
      if (!id) failed('keyframe.add: keyframes cannot be placed inside a transition')
      return
    }
    const at = timeField(payload, 'at', cadence)
    const value = (payload.value as { value?: unknown } | undefined)?.value
    if (typeof value !== 'number' || !Number.isFinite(value))
      invalid('value must be { value: number }')
    const easing = optionalString(payload, 'easing') as EasingType | undefined
    if (at < item.from || at >= item.from + item.durationInFrames)
      invalid('at must fall inside the clip')
    // Freecut keyframes are addressed relative to the clip's start.
    if (!addKeyframe(item.id, property, at - item.from, value as number, easing)) {
      failed('keyframe.add: keyframes cannot be placed inside a transition')
    }
  },

  'keyframe.remove'(payload) {
    const item = requireItem(stringField(payload, 'clipId'))
    const property = stringField(payload, 'property') as AnimatableProperty
    const ids = payload.keyframeIds
    if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== 'string'))
      invalid('keyframeIds is required')
    if (isVectorProperty(property)) {
      for (const id of ids as string[]) requireVectorKeyframe(item, property, id)
      for (const id of ids as string[]) removeVectorKeyframe(item.id, property as never, id)
      return
    }
    const existing =
      useKeyframesStore
        .getState()
        .keyframesByItemId[item.id]?.properties.find((entry) => entry.property === property)
        ?.keyframes ?? []
    for (const id of ids as string[]) {
      if (!existing.some((keyframe) => keyframe.id === id))
        invalid(`keyframeIds: "${id}" is not on ${property}`)
    }
    for (const id of ids as string[]) removeKeyframe(item.id, property, id)
  },

  'keyframe.update'(payload, { cadence }) {
    const item = requireItem(stringField(payload, 'clipId'))
    const property = stringField(payload, 'property') as AnimatableProperty
    if (isVectorProperty(property)) {
      updateVectorKeyframeFrom(item, property, payload, cadence)
      return
    }
    if (payload.temporalEase !== undefined || payload.spatial !== undefined)
      invalid(`${property} keyframes take no velocity or path handles; position, scale and anchor do`)
    const keyframe = requireKeyframe(item, property, stringField(payload, 'keyframeId'))
    const updates: Partial<Omit<Keyframe, 'id'>> = {}
    if (payload.at !== undefined) {
      const at = timeField(payload, 'at', cadence)
      if (at < item.from || at >= item.from + item.durationInFrames) invalid('at must fall inside the clip')
      updates.frame = at - item.from
      const taken = keyframesOn(item, property).some((other) => other.id !== keyframe.id && other.frame === updates.frame)
      if (taken) invalid(`at: ${property} already has a keyframe there`)
    }
    if (payload.value !== undefined) {
      const value = (payload.value as { value?: unknown } | null)?.value
      if (typeof value !== 'number' || !Number.isFinite(value)) invalid('value must be { value: number }')
      updates.value = value as number
    }
    if (Object.keys(updates).length === 0) invalid('keyframe.update needs at or value')
    updateKeyframe(item.id, property, keyframe.id, updates)
    const after = keyframesOn(item, property).find((entry) => entry.id === keyframe.id)
    if (!after || (updates.frame !== undefined && after.frame !== updates.frame)) {
      failed('keyframe.update: keyframes cannot be moved inside a transition')
    }
  },

  'keyframe.setEasing'(payload) {
    const item = requireItem(stringField(payload, 'clipId'))
    const property = stringField(payload, 'property') as AnimatableProperty
    const ids = payload.keyframeIds
    if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== 'string'))
      invalid('keyframeIds is required')
    const vector = isVectorProperty(property)
    for (const id of ids as string[]) {
      if (vector) requireVectorKeyframe(item, property, id)
      else requireKeyframe(item, property, id)
    }
    const easing = stringField(payload, 'easing') as EasingType
    if (!EASINGS.includes(easing)) invalid(`easing must be one of ${EASINGS.join(', ')}`)
    let easingConfig: EasingConfig | undefined
    if (easing === 'cubic-bezier') {
      const bezier = payload.bezier as Record<string, unknown> | undefined
      const points = ['x1', 'y1', 'x2', 'y2'].map((key) => bezier?.[key])
      if (!points.every((value) => typeof value === 'number' && Number.isFinite(value)))
        invalid('bezier must be { x1, y1, x2, y2 } numbers for cubic-bezier')
      const [x1, y1, x2, y2] = points as number[]
      // The time axis of a curve cannot run backwards; the value axis may overshoot.
      if (x1! < 0 || x1! > 1 || x2! < 0 || x2! > 1) invalid('bezier x1 and x2 must lie in 0..1')
      easingConfig = { type: easing, bezier: { x1: x1!, y1: y1!, x2: x2!, y2: y2! } }
    } else if (easing === 'spring') {
      const spring = { ...DEFAULT_SPRING_PARAMS, ...((payload.spring as object | undefined) ?? {}) }
      const ranges = { tension: [0, 500], friction: [0, 100], mass: [0.1, 10] } as const
      for (const [key, [min, max]] of Object.entries(ranges)) {
        const value = (spring as Record<string, unknown>)[key]
        if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
          invalid(`spring.${key} must be a number in ${min}..${max}`)
      }
      easingConfig = { type: easing, spring }
    } else if (payload.bezier !== undefined || payload.spring !== undefined) {
      invalid(`${easing} takes no bezier or spring parameters`)
    }
    if (vector) {
      for (const keyframeId of ids as string[])
        updateVectorKeyframe(item.id, property as never, keyframeId, { easing, easingConfig })
      return
    }
    updateKeyframes(
      (ids as string[]).map((keyframeId) => ({
        itemId: item.id,
        property,
        keyframeId,
        updates: { easing, easingConfig },
      })),
    )
  },

  /* ---------------- Expressions and procedural motion (FL-100) ---------------- */

  'property.setExpression'(payload) {
    const item = requireItem(stringField(payload, 'clipId'))
    const property = stringField(payload, 'property')
    if (!isDirectLinkableProperty(property)) invalid(`property "${property}" cannot carry an expression`)
    const source = payload.expression
    if (source === null) {
      removePropertyExpression(item.id, property as never)
      return
    }
    if (typeof source !== 'string' || !source.trim()) invalid('expression must be a string or null')
    // Checked by the engine's own evaluator: its grammar has no statements, loops, calls into the
    // page or I/O, so a check run is a parse. References resolve to a value of the right kind here;
    // at render they resolve to the referenced layer, and an unresolvable one keeps the keyframed
    // value with the error reported in the inspector.
    const sample = isVectorProperty(property) ? { x: 1, y: 1 } : 1
    const check = evaluatePropertyExpression(source as string, {
      preValue: sample,
      globalFrame: 0,
      fps: projectCanvas.fps,
      resolveProperty: (_id, referenced) => (isVectorProperty(referenced) ? { x: 1, y: 1 } : 1),
    })
    if (check.error && !RUNTIME_ONLY_EXPRESSION_ERRORS.test(check.error)) invalid(`expression: ${check.error}`)
    if (!check.error && !isExpressionValueCompatible(property as never, check.value))
      invalid(`expression gives a ${typeof check.value === 'number' ? 'number' : 'vector'}; ${property} needs the other`)
    setPropertyExpression(item.id, { type: 'expression', targetProperty: property as never, source: source as string, enabled: true })
  },

  'property.setModifier'(payload) {
    const item = requireItem(stringField(payload, 'clipId'))
    const property = stringField(payload, 'property')
    if (payload.modifier === null) {
      const driving = (item.motionModifiers ?? []).filter((modifier) =>
        getActiveMotionModifierChannels(modifier).includes(property as never),
      )
      if (driving.length === 0) invalid(`no modifier drives ${property}`)
      updateItem(item.id, {
        motionModifiers: (item.motionModifiers ?? []).filter((modifier) => !driving.includes(modifier)),
      } as Partial<TimelineItem>)
      return
    }
    const modifier = modifierField(payload.modifier)
    if (!getActiveMotionModifierChannels(modifier).includes(property as never))
      invalid(`a ${modifier.type} modifier does not drive ${property}`)
    if (applyMotionModifierToItems([{ itemId: item.id, modifier }]) !== 1) failed('property.setModifier: the clip did not take the modifier')
  },

  'property.bakeModifier'(payload) {
    const item = requireItem(stringField(payload, 'clipId'))
    const property = stringField(payload, 'property')
    const modifierId = stringField(payload, 'modifierId')
    const modifier = (item.motionModifiers ?? []).find((entry) => entry.id === modifierId)
    if (!modifier) invalid(`modifierId: "${modifierId}" is not on this clip`)
    if (!modifier!.enabled) invalid('a disabled modifier contributes nothing to bake')
    if (!getActiveMotionModifierChannels(modifier!).includes(property as never))
      invalid(`a ${modifier!.type} modifier does not drive ${property}`)
    // Procedural motion composes (keyframes, then animation layers, then every modifier), so it is
    // baked together, as the editor's own Bake does: the keyframes then reproduce the pose.
    const plan = buildBakeMotionPlan({
      items: [item],
      keyframesByItemId: useKeyframesStore.getState().keyframesByItemId,
      fps: projectCanvas.fps,
      frameWidth: projectCanvas.width,
      frameHeight: projectCanvas.height,
      resolveBase: (entry) => resolveTransform(entry, projectCanvas, getSourceDimensions(entry)),
    })
    const planned = plan.reduce((sum, entry) => sum + entry.keyframes.length, 0)
    if (bakeMotionToKeyframes(plan) !== 1) failed('property.bakeModifier: nothing was baked')
    const baked = keyframeCount(item)
    if (baked < planned) failed('property.bakeModifier: keyframes cannot be placed inside a transition')
  },

  /* ---------------- Motion text, Compose and Ken Burns (FL-100) ---------------- */

  'text.setMotion'(payload) {
    const item = requireItem(stringField(payload, 'clipId'))
    if (item.type !== 'text') invalid('text.setMotion needs a text clip')
    if (payload.motion === null) {
      updateItem(item.id, { textMotion: undefined } as Partial<TimelineItem>)
      return
    }
    const motion = payload.motion as Record<string, unknown> | undefined
    if (!motion || typeof motion !== 'object' || Array.isArray(motion)) invalid('motion must be an object or null')
    const slots = Object.keys(motion!)
    if (slots.length === 0 || slots.some((slot) => !['in', 'out', 'loop'].includes(slot)))
      invalid('motion takes in, out and loop slots')
    const spec = sanitizeTextMotion(motion)
    // Every slot asked for must be a valid preset for that slot; nothing is dropped silently.
    for (const slot of slots) {
      if (motion![slot] !== undefined && !(spec as Record<string, unknown> | undefined)?.[slot])
        invalid(`motion.${slot} is not a valid ${slot} text motion`)
    }
    updateItem(item.id, { textMotion: spec } as Partial<TimelineItem>)
  },

  'clip.group'(payload) {
    const ids = payload.clipIds
    if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== 'string'))
      invalid('clip.group needs the clips to group (clipIds)')
    for (const id of ids as string[]) requireItem(id, 'clipIds')
    const name = optionalString(payload, 'name') ?? 'Group'
    // A group is a Compose composition: the clips keep their animation inside it, and the group is
    // one clip on the timeline that can be moved, animated and nested like any other.
    if (!createPreComp(name, ids as string[], { editorKind: 'composite-2d' }))
      failed('clip.group: these clips cannot form a group')
  },

  'clip.ungroup'(payload) {
    const group = requireItem(stringField(payload, 'groupId'), 'groupId')
    const composition = group.type === 'composition' ? useCompositionsStore.getState().getComposition(group.compositionId) : undefined
    if (composition?.editorKind !== 'composite-2d') invalid('groupId is not a group')
    if (!dissolvePreComp(group.id)) failed('clip.ungroup: the group could not be dissolved here')
  },

  'composition.setPublishedControls'(payload) {
    const compositionId = stringField(payload, 'compositionId')
    const composition = useCompositionsStore.getState().getComposition(compositionId)
    if (!composition) invalid(`compositionId: "${compositionId}" is not in the project`)
    if (composition!.editorKind !== 'composite-2d') invalid('only a Compose composition publishes controls')
    const controls = payload.controls
    if (!Array.isArray(controls)) invalid('controls must be a list')
    const requested = (controls as unknown[]).map((control, index) => {
      if (!control || typeof control !== 'object') invalid(`controls[${index}] must be an object`)
      const entry = control as Record<string, unknown>
      const property = entry.property
      return {
        id: typeof entry.id === 'string' && entry.id ? entry.id : crypto.randomUUID(),
        name: entry.name,
        targetItemId: entry.targetItemId,
        property,
        kind: property === 'text.text' ? 'text' : 'color',
        defaultValue: entry.defaultValue,
      }
    })
    const schema = sanitizeCompositionControlSchema({ version: COMPOSITION_CONTROLS_VERSION, controls: requested }, composition!.items)
    // Every control asked for must survive: a missing target, an unreadable property or a duplicate
    // is named, never dropped.
    if ((schema?.controls.length ?? 0) !== requested.length)
      invalid('controls: each needs a name, a layer of this composition and a property it can drive, once')
    useCompositionsStore.getState().updateComposition(compositionId, { compositionControls: schema })
  },

  'composition.setControlOverrides'(payload) {
    const instance = requireItem(stringField(payload, 'compositionClipId'), 'compositionClipId')
    if (instance.type !== 'composition') invalid('compositionClipId is not a composition')
    const composition = useCompositionsStore.getState().getComposition((instance as { compositionId: string }).compositionId)
    const controls = composition?.compositionControls?.controls ?? []
    const overrides = payload.overrides
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) invalid('overrides must be an object')
    for (const [controlId, value] of Object.entries(overrides as Record<string, unknown>)) {
      const control = controls.find((entry) => entry.id === controlId)
      if (!control) invalid(`overrides: "${controlId}" is not a published control of this composition`)
      if (typeof value !== 'string' || value.length > 2000) invalid(`overrides.${controlId} must be text`)
      if (control!.kind === 'color' && !CSS_COLOR.test((value as string).trim()))
        invalid(`overrides.${controlId} must be a colour`)
    }
    const next = Object.keys(overrides as object).length > 0 ? (overrides as Record<string, string>) : undefined
    updateItem(instance.id, { compositionControlOverrides: next } as Partial<TimelineItem>)
  },

  'clip.setKenBurns'(payload) {
    const item = requireItem(stringField(payload, 'clipId'))
    if (item.type !== 'image') invalid('Ken Burns moves a still photo')
    // The move's keyframes are the ones it recorded; replacing or removing it touches only those.
    const previous = (item as unknown as { frameleafKenBurns?: { keyframeIds?: string[] } }).frameleafKenBurns
    const ownedIds = new Set(previous?.keyframeIds ?? [])
    let move: { from: KenBurnsRect; to: KenBurnsRect } | null = null
    if (payload.kenBurns !== null) {
      const candidate = payload.kenBurns as { from?: unknown; to?: unknown } | undefined
      if (!candidate || typeof candidate !== 'object') invalid('kenBurns must be { from, to } or null')
      move = { from: kenBurnsRect(candidate!.from, 'from'), to: kenBurnsRect(candidate!.to, 'to') }
      const animatedElsewhere =
        keyframesOnItem(item).some(
          (entry) => KEN_BURNS_PROPERTIES.includes(entry.property) && entry.keyframes.some((keyframe) => !ownedIds.has(keyframe.id)),
        ) || ['position', 'scale'].some((property) => vectorKeyframesOn(item, property).length > 0)
      if (animatedElsewhere) invalid('the clip already animates its position or size; Ken Burns would replace that animation')
    }
    for (const entry of keyframesOnItem(item)) {
      for (const keyframe of entry.keyframes) {
        if (ownedIds.has(keyframe.id)) removeKeyframe(item.id, entry.property, keyframe.id)
      }
    }
    if (!move) {
      updateItem(item.id, { frameleafKenBurns: undefined } as unknown as Partial<TimelineItem>)
      return
    }
    const base = resolveTransform(item, projectCanvas, getSourceDimensions(item))
    const last = Math.max(1, item.durationInFrames - 1)
    const at = (rect: KenBurnsRect) => {
      // The visible region fills the frame: the photo scales by 1/w and moves the region's centre to
      // the frame's centre.
      const width = base.width / rect.w
      const height = base.height / rect.h
      return {
        width,
        height,
        x: base.x + (0.5 - (rect.x + rect.w / 2)) * width,
        y: base.y + (0.5 - (rect.y + rect.h / 2)) * height,
      }
    }
    const [start, end] = [at(move.from), at(move.to)]
    const payloads = (['x', 'y', 'width', 'height'] as const).flatMap((property) => [
      { itemId: item.id, property, frame: 0, value: start[property], easing: 'linear' as const },
      { itemId: item.id, property, frame: last, value: end[property], easing: 'linear' as const },
    ])
    const keyframeIds = addKeyframes(payloads)
    if (keyframeIds.length !== payloads.length) failed('clip.setKenBurns: keyframes cannot be placed inside a transition')
    updateItem(item.id, { frameleafKenBurns: { ...move, keyframeIds } } as unknown as Partial<TimelineItem>)
  },

  /* ---------------- Linked edit tools (FL-94) ---------------- */

  'clip.roll'(payload, { cadence }) {
    const left = requireItem(stringField(payload, 'clipId'))
    const right = adjacentOnTrack(left, 'right')
    if (!right) invalid('clip.roll: no clip starts where this one ends')
    const at = timeField(payload, 'at', cadence)
    const cut = left.from + left.durationInFrames
    const rightEnd = right!.from + right!.durationInFrames
    if (at === cut) return
    if (at <= left.from || at >= rightEnd) invalid('at must fall inside the two clips')
    assertUnlocked(linkedSet([left.id, right!.id]), 'clip.roll')
    withLinkedSelection(true, () => rollingTrimItems(left.id, right!.id, at - cut))
    const leftAfter = requireItem(left.id)
    const rightAfter = requireItem(right!.id)
    if (
      leftAfter.from !== left.from ||
      leftAfter.from + leftAfter.durationInFrames !== at ||
      rightAfter.from !== at ||
      rightAfter.from + rightAfter.durationInFrames !== rightEnd
    ) {
      failed('clip.roll: the source media, a transition or keyframes do not allow the cut there')
    }
  },

  'clip.slip'(payload, { fps }) {
    const item = requireItem(stringField(payload, 'clipId'))
    if (item.type !== 'video' && item.type !== 'audio' && item.type !== 'composition') {
      invalid('clip.slip applies to video, audio and composition clips')
    }
    if (item.sourceEnd === undefined) invalid('clip.slip: the clip has no source range to slip')
    // The delta is source time: the window moves through the source, whatever the clip's speed.
    const frames = signedFrames(payload, 'delta', item.sourceFps ?? fps)
    if (frames === 0) return
    assertUnlocked(linkedSet([item.id]), 'clip.slip')
    const start = item.sourceStart ?? 0
    withLinkedSelection(true, () => slipItem(item.id, frames))
    const after = requireItem(item.id)
    if (
      (after.sourceStart ?? 0) !== start + frames ||
      after.sourceEnd !== item.sourceEnd! + frames ||
      after.from !== item.from ||
      after.durationInFrames !== item.durationInFrames
    ) {
      failed('clip.slip: the source does not have that much media, or a transition needs it')
    }
  },

  'clip.slide'(payload, { cadence }) {
    const item = requireItem(stringField(payload, 'clipId'))
    const frames = signedFrames(payload, 'delta', cadence)
    if (frames === 0) return
    const left = adjacentOnTrack(item, 'left')
    const right = adjacentOnTrack(item, 'right')
    if (!left && !right) invalid('clip.slide: the clip has no neighbour to trim; move it instead')
    assertUnlocked(
      linkedSet([item.id, ...(left ? [left.id] : []), ...(right ? [right.id] : [])]),
      'clip.slide',
    )
    withLinkedSelection(true, () => slideItem(item.id, frames, left?.id ?? null, right?.id ?? null))
    // Freecut keeps a split A-B-C chain continuous by moving the slid clip's source window with it,
    // so only its place, its length and the neighbours meeting it are checked here.
    const after = requireItem(item.id)
    const leftAfter = left ? requireItem(left.id) : undefined
    const rightAfter = right ? requireItem(right.id) : undefined
    if (
      after.from !== item.from + frames ||
      after.durationInFrames !== item.durationInFrames ||
      (leftAfter && leftAfter.from + leftAfter.durationInFrames !== after.from) ||
      (rightAfter && rightAfter.from !== after.from + after.durationInFrames)
    ) {
      failed('clip.slide: a neighbour does not have enough media, or a transition blocks the slide')
    }
  },

  'clip.setSpeed'(payload, { cadence }) {
    const item = requireItem(stringField(payload, 'clipId'))
    if (item.type !== 'video' && item.type !== 'audio' && item.type !== 'composition') {
      invalid('clip.setSpeed applies to video, audio and composition clips')
    }
    const rate = payload.speed
    if (!isRational(rate) || (rate as Rational).num <= 0) invalid('speed must be a positive exact rate')
    const { num, den } = rate as Rational
    // Freecut's bounds, compared exactly: MIN_SPEED ≤ num/den ≤ MAX_SPEED.
    if (num * 10 < den * Math.round(MIN_SPEED * 10) || num > den * MAX_SPEED) {
      invalid(`speed must be between ${MIN_SPEED} and ${MAX_SPEED}`)
    }
    if (item.sourceEnd === undefined) invalid('clip.setSpeed: the clip has no bounded source range')
    const span = item.sourceEnd! - (item.sourceStart ?? 0)
    if (span < 1) invalid('clip.setSpeed: the clip has no source media to retime')
    // Timeline frames = span / sourceRate / speed × projectRate, exactly, to the nearest frame.
    const source = frameRateOf(item.sourceFps ?? projectCanvas.fps)
    const project = frameRateOf(cadence)
    const duration = roundQuotient(
      BigInt(span) * source.den * BigInt(den) * project.num,
      source.num * BigInt(num) * project.den,
    )
    if (duration < 1) invalid('speed is too fast for this clip')
    const linked = linkedSet([item.id])
    assertUnlocked(linked, 'clip.setSpeed')
    const before = new Map(linked.map((id) => [id, requireItem(id)]))
    withLinkedSelection(true, () => rateStretchItem(item.id, item.from, duration, num / den))
    const after = requireItem(item.id)
    if (after.from !== item.from || after.durationInFrames !== duration) {
      failed('clip.setSpeed: the clip cannot take that speed here')
    }
    // Synchronised companions (same start and length before) must have been retimed with it.
    for (const [id, previous] of before) {
      if (id === item.id || previous.from !== item.from || previous.durationInFrames !== item.durationInFrames) continue
      if (requireItem(id).durationInFrames !== duration) failed('clip.setSpeed: a linked clip was not retimed with it')
    }
    assertNoOverlap([...before.values()].map((entry) => entry.trackId), 'clip.setSpeed')
  },

  'clip.setLink'(payload) {
    const ids = payload.clipIds
    if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== 'string'))
      invalid('clipIds must be clip ids')
    if (typeof payload.linked !== 'boolean') invalid('linked must be a boolean')
    const unique = [...new Set(ids as string[])]
    for (const id of unique) requireItem(id, 'clipIds')
    if (payload.linked) {
      if (unique.length < 2) invalid('clip.setLink: linking needs at least two clips')
      if (!linkItems(unique)) failed('clip.setLink: these clips cannot be linked (they need audio and video from one source)')
      const group = requireItem(unique[0]!).linkedGroupId
      if (!group || unique.some((id) => requireItem(id).linkedGroupId !== group)) {
        failed('clip.setLink: the clips were not linked')
      }
      return
    }
    unlinkItems(unique)
    for (const id of unique) {
      const group = requireItem(id).linkedGroupId
      if (group && items().some((other) => other.id !== id && other.linkedGroupId === group)) {
        failed('clip.setLink: the clips are still linked')
      }
    }
  },

  'clip.reorder'(payload) {
    const track = requireTrack(stringField(payload, 'trackId'))
    const item = requireItem(stringField(payload, 'clipId'))
    if (item.trackId !== track.id) invalid('clipId is not on that track')
    if (track.locked) failed('clip.reorder: the track is locked')
    const index = payload.index
    if (typeof index !== 'number' || !Number.isInteger(index)) invalid('index must be an integer')
    const ordered = items()
      .filter((candidate) => candidate.trackId === track.id)
      .sort((a, b) => a.from - b.from)
    if ((index as number) < 0 || (index as number) >= ordered.length) invalid('index is outside the track')
    const origin = ordered[0]!.from
    const next = ordered.filter((candidate) => candidate.id !== item.id)
    next.splice(index as number, 0, item)
    // The track re-flows contiguously from its first clip, as the prototype's reorder does.
    let cursor = origin
    const shift = new Map<string, number>()
    for (const clip of next) {
      if (clip.from !== cursor) shift.set(clip.id, cursor - clip.from)
      cursor += clip.durationInFrames
    }
    if (shift.size === 0) return
    // Linked companions follow their clip by the same amount, keeping sync.
    const updates = new Map<string, number>()
    for (const [id, delta] of shift) {
      for (const linkedId of linkedSet([id])) {
        if (updates.has(linkedId)) continue
        const linkedItem = requireItem(linkedId)
        if (linkedItem.trackId !== track.id && trackOf(linkedItem)?.locked) {
          failed('clip.reorder: a linked clip is on a locked track')
        }
        updates.set(linkedId, linkedItem.from + (shift.get(linkedId) ?? delta))
      }
    }
    const moves = [...updates].map(([id, from]) => ({ id, from }))
    if (moves.some((move) => move.from < 0)) failed('clip.reorder: a linked clip would start before the timeline')
    moveItems(moves)
    for (const move of moves) {
      if (requireItem(move.id).from !== move.from) failed('clip.reorder: the clips cannot re-flow there')
    }
    assertNoOverlap(moves.map((move) => requireItem(move.id).trackId), 'clip.reorder')
  },

  'clip.insert'(payload, context) {
    const edit = buildSourceEdit(payload, context, 'clip.insert')
    const targets = new Set(edit.trackIds)
    splitTracksAt(targets, edit.at, 'clip.insert')
    // Everything on the destination tracks from the edit point on makes room.
    const onTargets = items()
      .filter((item) => targets.has(item.trackId) && item.from >= edit.at)
      .map((item) => item.id)
    // Sync-locked tracks open the same gap (Freecut's ripple rule); linked companions on unlocked
    // tracks without sync lock follow their clip so linked media never drifts out of sync.
    const syncLocked = new Set(
      tracks()
        .filter((track) => !targets.has(track.id) && isTrackSyncLockEnabled(track))
        .map((track) => track.id),
    )
    const companions = linkedSet(onTargets).filter((id) => {
      const item = requireItem(id)
      return (
        !targets.has(item.trackId) &&
        !syncLocked.has(item.trackId) &&
        !trackOf(item)?.locked &&
        item.from >= edit.at
      )
    })
    const moves = [...onTargets, ...companions].map((id) => ({
      id,
      from: requireItem(id).from + edit.durationInFrames,
    }))
    const propagated = propagateInsertedGapToSyncLockedTracks({
      editedTrackIds: targets,
      cutFrame: edit.at,
      amount: edit.durationInFrames,
    })
    if (moves.length > 0) moveItems(moves)
    applyTransitionRepairs([...moves.map((move) => move.id), ...propagated.affectedIds])
    for (const move of moves) {
      if (requireItem(move.id).from !== move.from) failed('clip.insert: later clips could not make room')
    }
    assertNoOverlap(tracks().map((track) => track.id), 'clip.insert')
    landSourceEdit(edit.placed, 'clip.insert')
  },

  'clip.overwrite'(payload, context) {
    const edit = buildSourceEdit(payload, context, 'clip.overwrite')
    const start = edit.at
    const end = edit.at + edit.durationInFrames
    const store = () => useItemsStore.getState()
    for (const trackId of new Set(edit.trackIds)) {
      const overlapping = items().filter(
        (item) => item.trackId === trackId && item.from < end && item.from + item.durationInFrames > start,
      )
      for (const original of overlapping) {
        // Freecut's overwrite: cut the covered part out of each clip; what is outside stays.
        let covered: TimelineItem = original
        if (covered.from < start) {
          const cut = store()._splitItem(covered.id, start)
          if (!cut) failed(`clip.overwrite: "${covered.id}" cannot be cut at the edit point`)
          covered = cut!.rightItem
        }
        if (covered.from + covered.durationInFrames > end) {
          const cut = store()._splitItem(covered.id, end)
          if (!cut) failed(`clip.overwrite: "${covered.id}" cannot be cut at the end of the edit`)
          covered = cut!.leftItem
        }
        // Only the covered part on this track goes; linked media on other tracks is left alone.
        withLinkedSelection(false, () => removeItems([covered.id]))
      }
    }
    applyTransitionRepairs(items().filter((item) => edit.trackIds.includes(item.trackId)).map((item) => item.id))
    assertNoOverlap(edit.trackIds, 'clip.overwrite')
    landSourceEdit(edit.placed, 'clip.overwrite')
  },

  'clip.join'(payload) {
    const ids = payload.clipIds
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) invalid('clipIds must be clip ids')
    const unique = [...new Set(ids as string[])]
    if (unique.length < 2) invalid('clip.join needs at least two clips')
    const chain = unique.map((id) => requireItem(id, 'clipIds')).sort((a, b) => a.from - b.from)
    if (!canJoinMultipleItems(chain)) {
      invalid('clip.join: the clips are not contiguous parts of one source at one speed')
    }
    assertUnlocked(linkedSet(unique), 'clip.join')
    const first = chain[0]!
    const last = chain.at(-1)!
    // Freecut joins a linked pair's counterparts only for two clips, so a longer chain is joined a
    // pair at a time; every step keeps the linked audio joined with its pictures.
    withLinkedSelection(true, () => {
      for (const next of chain.slice(1)) joinItems([first.id, next.id])
    })
    const joined = requireItem(first.id)
    if (
      joined.from !== first.from ||
      joined.durationInFrames !== last.from + last.durationInFrames - first.from ||
      chain.slice(1).some((part) => useItemsStore.getState().itemById[part.id])
    ) {
      failed('clip.join: the parts could not be joined')
    }
    for (const id of getLinkedItemIds(items(), first.id)) {
      if (requireItem(id).durationInFrames !== joined.durationInFrames) {
        failed('clip.join: a linked part was not joined with its clip')
      }
    }
  },

  'clip.push'(payload, { cadence }) {
    const anchor = requireItem(stringField(payload, 'clipId'))
    const frames = signedFrames(payload, 'delta', cadence)
    if (frames === 0) return
    // Freecut's track push moves every clip that starts at or after the anchor, on every track.
    const moving = items().filter((item) => item.from >= anchor.from)
    assertUnlocked(moving.map((item) => item.id), 'clip.push')
    if (moving.some((item) => item.from + frames < 0)) failed('clip.push: clips would start before the timeline')
    trackPushItems(anchor.id, frames)
    for (const item of moving) {
      if (requireItem(item.id).from !== item.from + frames) failed('clip.push: the clips could not move that far')
    }
    // A pull may not run into what is before the anchor.
    assertNoOverlap(moving.map((item) => item.trackId), 'clip.push')
  },

  /* ---------------- Tracks (FL-94) ---------------- */

  'track.closeGap'(payload, { cadence }) {
    const track = requireTrack(stringField(payload, 'trackId'))
    if (track.locked) failed('track.closeGap: the track is locked')
    const onTrack = () =>
      items()
        .filter((item) => item.trackId === track.id)
        .sort((a, b) => a.from - b.from)
    if (payload.at === undefined) {
      // Every gap, from the start of the timeline, with linked clips following their clip.
      const affected = linkedSet(onTrack().map((item) => item.id))
      assertUnlocked(affected, 'track.closeGap')
      // The engine clamps negative starts during movement. Validate its intended linked shifts
      // first, so an offset companion cannot be silently shortened or put out of sync.
      const shifts = new Map<string, number>()
      let end = 0
      for (const item of onTrack()) {
        const from = Math.min(item.from, end)
        if (item.from > from) shifts.set(item.id, item.from - from)
        end = from + item.durationInFrames
      }
      const moves = buildLinkedLeftShiftUpdates(items(), shifts, true)
      if (moves.some((move) => move.from < 0)) failed('track.closeGap: clips would start before the timeline')
      withLinkedSelection(true, () => closeAllGapsOnTrack(track.id))
      // Linked members can have intentional offsets, and their tracks can contain unrelated clips.
      // Closing the picture gaps must not send that sound/caption before zero or into another item.
      const changed = affected.map((id) => requireItem(id))
      assertNoOverlap(changed.map((item) => item.trackId), 'track.closeGap')
      let cursor = 0
      for (const item of onTrack()) {
        if (item.from !== cursor) failed('track.closeGap: a gap could not be closed')
        cursor += item.durationInFrames
      }
      return
    }
    const frame = timeField(payload, 'at', cadence)
    // The gap containing `frame`: from the end of the clip before it to the start of the next.
    let gapStart = 0
    let gapEnd: number | undefined
    for (const item of onTrack()) {
      if (frame >= gapStart && frame < item.from) {
        gapEnd = item.from
        break
      }
      gapStart = Math.max(gapStart, item.from + item.durationInFrames)
    }
    if (gapEnd === undefined || gapEnd <= gapStart) invalid('track.closeGap: there is no gap on the track at that time')
    const later = onTrack().filter((item) => item.from >= gapEnd!)
    const before = structuredClone(items())
    const beforeById = new Map(before.map((item) => [item.id, item]))
    const linked = linkedSet(later.map((item) => item.id))
    assertUnlocked(linked, 'track.closeGap')
    const moves = linked.map((id) => ({ id, from: beforeById.get(id)!.from - (gapEnd! - gapStart) }))
    if (moves.some((move) => move.from < 0)) failed('track.closeGap: clips would start before the timeline')
    const affectedTracks = new Set([
      ...linked.map((id) => beforeById.get(id)!.trackId),
      ...before.filter((item) => isTrackSyncLockEnabled(trackOf(item))).map((item) => item.trackId),
    ])
    closeGapAtPosition(track.id, frame)
    // Sync-lock propagation can split or remove a linked companion across the removed interval.
    // Refuse that destructive case rather than reconstructing its source window or bookkeeping.
    for (const id of linked) {
      const original = beforeById.get(id)!
      const current = useItemsStore.getState().itemById[id]
      if (!current || canonicalJson(current) !== canonicalJson({ ...original, from: current.from })) {
        failed('track.closeGap: sync lock would change a linked source window')
      }
    }
    // Use captured absolute positions: sync-locked companions may already have moved, whereas
    // linked sound/captions on tracks without sync lock still need the same shift as their clip.
    const corrections = moves.filter((move) => requireItem(move.id).from !== move.from)
    if (corrections.length > 0) {
      useItemsStore.getState()._moveItems(corrections)
      applyTransitionRepairs(corrections.map((move) => move.id))
    }
    for (const move of moves) {
      if (canonicalJson(requireItem(move.id)) !== canonicalJson({ ...beforeById.get(move.id)!, from: move.from })) {
        failed('track.closeGap: a linked item could not close the gap without changing its source data')
      }
    }
    assertNoOverlap(affectedTracks, 'track.closeGap')
    for (const item of later) {
      if (requireItem(item.id).from !== item.from - (gapEnd! - gapStart)) failed('track.closeGap: the gap could not be closed')
    }
  },

  'track.setAudio'(payload) {
    const track = requireTrack(stringField(payload, 'trackId'))
    if (track.isGroup) invalid('track.setAudio applies to media tracks, not organizational groups')
    for (const key of Object.keys(payload)) {
      if (!['trackId', 'gainDb', 'pan', 'eq'].includes(key)) invalid(`track.setAudio: unknown field "${key}"`)
    }
    const updates: Partial<TimelineTrack> = {}
    const gain = optionalNumber(payload, 'gainDb')
    if (gain !== undefined) {
      if (gain < -60 || gain > 12) invalid('gainDb must be in -60..12 dB')
      updates.volume = gain
    }
    if (payload.eq !== undefined) updates.audioEq = canonicalAudioEq(payload.eq)
    if (payload.pan !== undefined)
      throw new CommandRejection('not-implemented', 'track.setAudio.pan is not implemented')
    if (Object.keys(updates).length === 0) invalid('track.setAudio needs gainDb or eq')
    if (track.locked) failed('track.setAudio: the track is locked')
    setTracks(tracks().map((candidate) => candidate.id === track.id ? { ...candidate, ...updates } : candidate))
  },

  'track.set'(payload) {
    const track = requireTrack(stringField(payload, 'trackId'))
    const patch = payload.patch
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) invalid('patch is required')
    const fields = patch as Record<string, unknown>
    const allowed = ['name', 'muted', 'locked', 'solo', 'visible', 'syncLock', 'gain']
    for (const key of Object.keys(fields)) if (!allowed.includes(key)) invalid(`patch: unknown field "${key}"`)
    if (Object.keys(fields).length === 0) invalid('patch must change something')
    const updates: Record<string, unknown> = {}
    if (fields.name !== undefined) {
      const name = optionalString(fields, 'name')!
      if (!name.trim() || name.length > 80) invalid('patch.name must be 1 to 80 characters')
      updates.name = name
    }
    for (const key of ['muted', 'locked', 'solo', 'visible', 'syncLock'] as const) {
      if (fields[key] === undefined) continue
      if (typeof fields[key] !== 'boolean') invalid(`patch.${key} must be a boolean`)
      updates[key] = fields[key]
    }
    if (fields.gain !== undefined) {
      // The prototype's track gain is decibels, the unit of Freecut's track volume.
      const gain = optionalNumber(fields, 'gain')!
      if (gain < -60 || gain > 12) invalid('patch.gain must be between -60 and 12 dB')
      updates.volume = gain
    }
    setTracks(tracks().map((candidate) => (candidate.id === track.id ? { ...candidate, ...updates } : candidate)))
    const applied = requireTrack(track.id) as unknown as Record<string, unknown>
    for (const [key, value] of Object.entries(updates)) {
      if (applied[key] !== value) failed(`track.set: ${key} was not applied`)
    }
  },

  'track.remove'(payload) {
    const track = requireTrack(stringField(payload, 'trackId'))
    if (track.locked) failed('track.remove: the track is locked')
    const remaining = tracks().filter((candidate) => candidate.id !== track.id && !candidate.isGroup)
    if (remaining.length === 0) invalid('track.remove: a sequence keeps at least one track')
    const onTrack = items().filter((item) => item.trackId === track.id).map((item) => item.id)
    // The clips on the track go with it; linked media on other tracks stays.
    if (onTrack.length > 0) withLinkedSelection(false, () => removeItems(onTrack))
    setTracks(tracks().filter((candidate) => candidate.id !== track.id))
    if (items().some((item) => item.trackId === track.id)) failed('track.remove: clips remain on the track')
  },

  'track.reorder'(payload) {
    const track = requireTrack(stringField(payload, 'trackId'))
    const index = payload.index
    if (typeof index !== 'number' || !Number.isInteger(index)) invalid('index must be an integer')
    // Tracks reorder among their siblings: top-level tracks, or the children of one layer group.
    const siblings = tracks()
      .filter((candidate) => (candidate.parentTrackId ?? null) === (track.parentTrackId ?? null))
      .sort((a, b) => a.order - b.order)
    if ((index as number) < 0 || (index as number) >= siblings.length) invalid('index is outside the track list')
    const current = siblings.findIndex((candidate) => candidate.id === track.id)
    if (current === index) return
    const next = siblings.filter((candidate) => candidate.id !== track.id)
    next.splice(index as number, 0, track)
    // Siblings keep the set of order values they had, so tracks outside the group are untouched.
    const orders = siblings.map((candidate) => candidate.order)
    const reordered = new Map(next.map((candidate, position) => [candidate.id, orders[position]!]))
    setTracks(
      tracks().map((candidate) =>
        reordered.has(candidate.id) ? { ...candidate, order: reordered.get(candidate.id)! } : candidate,
      ),
    )
  },

  /* ---------------- Markers (FL-94) ---------------- */

  'marker.add'(payload, { cadence }) {
    const frame = timeField(payload, 'at', cadence)
    const colour = optionalString(payload, 'colour')
    if (colour !== undefined && !HEX_COLOUR.test(colour)) invalid('colour must be a #rrggbb colour')
    const name = optionalString(payload, 'name')
    if (name !== undefined && name.length > 120) invalid('name must be at most 120 characters')
    const before = useMarkersStore.getState().markers.length
    addMarker(frame, colour, name ?? '')
    if (useMarkersStore.getState().markers.length !== before + 1) failed('marker.add: the marker was not added')
  },

  'marker.update'(payload, { cadence }) {
    const markerId = stringField(payload, 'markerId')
    if (!useMarkersStore.getState().markers.some((marker) => marker.id === markerId)) {
      invalid(`markerId: marker "${markerId}" does not exist`)
    }
    const patch = payload.patch
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) invalid('patch is required')
    const fields = patch as Record<string, unknown>
    for (const key of Object.keys(fields)) {
      if (!['name', 'colour', 'at'].includes(key)) invalid(`patch: unknown field "${key}"`)
    }
    const updates: { label?: string; color?: string; frame?: number } = {}
    if (fields.name !== undefined) {
      const name = optionalString(fields, 'name')!
      if (name.length > 120) invalid('patch.name must be at most 120 characters')
      updates.label = name
    }
    if (fields.colour !== undefined) {
      const colour = optionalString(fields, 'colour')!
      if (!HEX_COLOUR.test(colour)) invalid('patch.colour must be a #rrggbb colour')
      updates.color = colour
    }
    if (fields.at !== undefined) updates.frame = timeField(fields, 'at', cadence)
    if (Object.keys(updates).length === 0) invalid('patch must change something')
    updateMarker(markerId, updates)
  },

  'marker.remove'(payload) {
    const markerId = stringField(payload, 'markerId')
    if (!useMarkersStore.getState().markers.some((marker) => marker.id === markerId)) {
      invalid(`markerId: marker "${markerId}" does not exist`)
    }
    removeMarker(markerId)
  },

  'project.setMasterAudio'(payload) {
    for (const key of Object.keys(payload)) {
      if (!['gainDb', 'muted', 'ducking'].includes(key)) invalid(`project.setMasterAudio: unknown field "${key}"`)
    }
    const gainDb = optionalNumber(payload, 'gainDb')
    if (gainDb !== undefined && (gainDb < -60 || gainDb > 12)) invalid('gainDb must be between -60 and 12 dB')
    if (payload.muted !== undefined && typeof payload.muted !== 'boolean') invalid('muted must be a boolean')
    if (payload.ducking !== undefined) {
      if (typeof payload.ducking !== 'boolean') invalid('ducking must be a boolean')
      throw new CommandRejection('not-implemented', 'ducking: the engine has no project-wide ducking switch')
    }
    if (gainDb === undefined && payload.muted === undefined) invalid('project.setMasterAudio needs gainDb or muted')
    const playback = usePlaybackStore.getState()
    if (gainDb !== undefined) playback.setMasterBusDb(gainDb)
    if (payload.muted !== undefined) playback.setMasterBusMuted(payload.muted as boolean)
  },

  async 'sequence.setSettings'(payload, context) {
    const sequenceId = stringField(payload, 'sequenceId')
    const settings = {
      rate: sequenceRate(payload),
      width: canvasSide(payload, 'width', 320, 7680),
      height: canvasSide(payload, 'height', 240, 4320),
    }
    if (!settings.rate && settings.width === undefined && settings.height === undefined) {
      invalid('sequence.setSettings needs fps, width or height')
    }
    await applySequenceSettings(context, sequenceId, settings, timingPolicy(payload))
  },

  async 'project.applyTemplate'(payload, context) {
    const templateId = stringField(payload, 'templateId')
    const template = PROJECT_TEMPLATES.find((entry) => entry.id === templateId)
    if (!template) invalid(`templateId: template "${templateId}" does not exist`)
    const rate = cadenceFromDecimal(template!.fps)!
    await applySequenceSettings(
      context,
      MAIN_SEQUENCE_ID,
      { rate, width: template!.width, height: template!.height },
      timingPolicy(payload),
    )
  },

  'title.add'(payload, { cadence }) {
    const text = stringField(payload, 'text')
    const from = timeField(payload, 'at', cadence)
    const duration = optionalTime(payload, 'duration', cadence) ?? secondsToFrames({ num: 3, den: 1 }, cadence)
    if (duration < 1) invalid('duration must be at least one frame')
    const track = tracks().find(
      (candidate) => !candidate.isGroup && (candidate.kind ?? 'video') === 'video',
    )
    if (!track) invalid('title.add: the project has no video track')
    const base: TextItem = {
      id: crypto.randomUUID(),
      type: 'text',
      trackId: track!.id,
      from,
      durationInFrames: duration,
      label: text.slice(0, 64),
      text,
      color: '#ffffff',
      fontSize: 80,
    } as TextItem
    const style = optionalString(payload, 'style')
    const position = optionalString(payload, 'position')
    const animation = optionalString(payload, 'animation')
    const item: TextItem = {
      ...base,
      ...(style ? applyTitleStyle(base, style) : {}),
      ...(position ? titlePositionOf(position) : {}),
      ...(animation ? { textMotion: titleMotionOf(animation) } : {}),
      text,
    }
    addItem(item)
  },

  'track.add'(payload) {
    const kind = stringField(payload, 'kind')
    if (kind !== 'video' && kind !== 'audio') invalid('kind must be video or audio')
    const all = tracks()
    const sorted = [...all].sort((a, b) => a.order - b.order)
    const index = optionalNumber(payload, 'index')
    if (index !== undefined && (!Number.isInteger(index) || index < 0 || index > sorted.length))
      invalid('index is outside the track list')
    const orders = all.map((track) => track.order)
    const order =
      index === undefined
        ? kind === 'video'
          ? Math.min(0, ...orders) - 1
          : Math.max(0, ...orders) + 1
        : index === 0
          ? (sorted[0]?.order ?? 0) - 1
          : index >= sorted.length
            ? (sorted.at(-1)?.order ?? 0) + 1
            : (sorted[index - 1]!.order + sorted[index]!.order) / 2
    const track = createClassicTrack({ tracks: all, kind, order })
    const name = optionalString(payload, 'name')
    setTracks([...all, name ? { ...track, name } : track])
  },
}

/* ------------------------------------------------------------------ */
/* Apply                                                                */
/* ------------------------------------------------------------------ */

export type ApplyOutcome =
  | { status: 'applied'; project: Project; digest: string }
  | { status: 'rejected'; index: number; reason: RejectionReason; detail: string }

const isProject = (value: unknown): value is Project =>
  !!value &&
  typeof value === 'object' &&
  typeof (value as Project).id === 'string' &&
  !!(value as Project).metadata &&
  typeof (value as Project).metadata.fps === 'number'

/**
 * Apply an ordered batch to a stored graph. The graph is Freecut's own project document; anything
 * else is refused rather than guessed at.
 */
export async function applyCanonicalCommands(
  graph: unknown,
  envelopes: readonly CanonicalEnvelope[],
  media: readonly MediaMetadata[],
): Promise<ApplyOutcome> {
  if (!isProject(graph)) {
    return {
      status: 'rejected',
      index: 0,
      reason: 'invalid',
      detail: 'The project has no editable graph yet',
    }
  }
  const { project } = migrateProject(structuredClone(graph))
  projectCanvas = {
    width: project.metadata.width || 1920,
    height: project.metadata.height || 1080,
    fps: project.metadata.fps || 30,
  }
  const fps = projectCanvas.fps
  // FL-93: payload times become frames on the exact project cadence, never on a rounded decimal.
  const cadence = projectCadenceOf(project.metadata)
  if (!cadence) {
    return {
      status: 'rejected',
      index: 0,
      reason: 'invalid',
      detail: 'The project frame rate has no exact reading',
    }
  }
  const mediaById = new Map(media.map((entry) => [entry.id, entry]))
  const context: BatchContext = { fps, cadence, media: mediaById, project }

  await hydrateTimelineStoresFromProject(project)
  useMediaLibraryStore.setState({
    mediaItems: [...media],
    mediaById: Object.fromEntries(mediaById),
  })

  for (const [index, envelope] of envelopes.entries()) {
    const handler = handlers[envelope.id]
    if (!handler) {
      return {
        status: 'rejected',
        index,
        reason: 'not-implemented',
        detail: `${envelope.id} is not an engine command`,
      }
    }
    try {
      // The clock is the envelope's own issue time, so a retried envelope stamps the same values.
      await withDeterminism(`${envelope.idempotencyKey}:${index}`, envelope.issuedAt ?? 0, () =>
        handler(envelope.payload ?? {}, context),
      )
    } catch (error) {
      if (error instanceof CommandRejection) {
        return { status: 'rejected', index, reason: error.reason, detail: error.message }
      }
      return {
        status: 'rejected',
        index,
        reason: 'failed',
        detail: error instanceof Error ? error.message : String(error),
      }
    }
  }

  const timeline = buildTimelineFromStores()
  // The stored graph carries its exact cadence from here on (FL-93), beside Freecut's own `fps`.
  const next: Project = { ...context.project, metadata: withProjectCadence(context.project.metadata), timeline }
  return { status: 'applied', project: next, digest: await graphDigest(next) }
}
