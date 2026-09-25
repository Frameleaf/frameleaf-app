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
 * - **Exact time.** Payload times are FL-93 rationals in seconds. They become frames at the
 *   project's frame rate with exact integer arithmetic, rounding to the nearest frame.
 * - **Lossless.** Freecut serialises its stores back into the project it was given, so fields this
 *   module does not touch round-trip unchanged.
 *
 * Undo and redo are not engine operations: the host keeps the graph each accepted batch replaced
 * and restores it as a new revision (history is append-only, FL-89).
 */
import type { Project } from '@/types/project'
import type { TimelineItem, TextItem } from '@/types/timeline'
import type { MediaMetadata } from '@/types/storage'
import type { AnimatableProperty, EasingType } from '@/types/keyframe'
import type { TransformProperties } from '@/types/transform'
import type { TransitionPresentation } from '@/types/transition'
import { migrateProject } from '@/shared/projects/migrations'
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
  moveItem,
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
  updateTransition,
} from '@/features/timeline/stores/timeline-actions'
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
  'composition.add': ['command.addClip'],
  'effect.add': ['command.addEffect'],
  'effect.remove': ['command.removeEffect'],
  'keyframe.add': ['command.addKeyframe'],
  'keyframe.remove': ['command.removeKeyframes'],
  'music.add': ['command.addItem'],
  'title.add': ['command.addText'],
  'track.add': ['command.addTrack'],
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

/** The project's frame rate as an exact fraction (Freecut stores 29.97 as a decimal). */
export const frameRateOf = (fps: number): { num: bigint; den: bigint } => {
  if (!Number.isFinite(fps) || fps <= 0) return { num: 30n, den: 1n }
  if (Number.isInteger(fps)) return { num: BigInt(fps), den: 1n }
  return { num: BigInt(Math.round(fps * 1000)), den: 1000n }
}

/** Seconds (exact) to the nearest frame; halves round up. */
export const secondsToFrames = (time: Rational, fps: number): number => {
  const rate = frameRateOf(fps)
  const numerator = BigInt(time.num) * rate.num
  const denominator = BigInt(time.den) * rate.den
  const doubled = 2n * numerator + denominator
  const twice = 2n * denominator
  // floor((2n + d) / 2d) for either sign.
  const quotient = doubled >= 0n ? doubled / twice : -((-doubled + twice - 1n) / twice)
  const frames = Number(quotient)
  if (!Number.isSafeInteger(frames)) invalid('The time is out of range')
  return frames
}

const timeField = (payload: Record<string, unknown>, name: string, fps: number): number => {
  const value = payload[name]
  if (!isRational(value)) invalid(`${name} must be an exact rational time`)
  const frames = secondsToFrames(value as Rational, fps)
  if (frames < 0) invalid(`${name} must not be negative`)
  return frames
}

const optionalTime = (
  payload: Record<string, unknown>,
  name: string,
  fps: number,
): number | undefined => (payload[name] === undefined ? undefined : timeField(payload, name, fps))

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
/* Vocabulary mappings                                                  */
/* ------------------------------------------------------------------ */

/** The prototype's transition names (`studio-project.mjs` `transitionTypes`) as Freecut presentations. */
const prototypeTransitions: Record<string, TransitionPresentation> = {
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
const prototypeTitleStyles: Record<string, TextStylePresetId | 'plain' | 'bold'> = {
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
const prototypeTitleAnimations: Record<string, { in: string; out?: string }> = {
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

type Handler = (
  payload: Record<string, unknown>,
  context: { fps: number; media: Map<string, MediaMetadata> },
) => void

const handlers: Record<string, Handler> = {
  'clip.add'(payload, { fps, media }) {
    const assetId = stringField(payload, 'assetId')
    const track = requireTrack(stringField(payload, 'trackId'))
    const from = timeField(payload, 'at', fps)
    const duration = optionalTime(payload, 'duration', fps)
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

  'clip.move'(payload, { fps }) {
    const item = requireItem(stringField(payload, 'clipId'))
    const from = timeField(payload, 'start', fps)
    const trackId = optionalString(payload, 'trackId')
    if (trackId) requireTrack(trackId)
    moveItem(item.id, from, trackId)
    const moved = requireItem(item.id)
    if (moved.from !== from || (trackId && moved.trackId !== trackId)) {
      failed('clip.move: the clip cannot go there (it would overlap another clip)')
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

  'clip.setTransition'(payload, { fps }) {
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
    const frames = timeField({ duration }, 'duration', fps)
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

  'clip.split'(payload, { fps }) {
    const frame = timeField(payload, 'at', fps)
    const ids = payload.clipIds
    if (ids === undefined) {
      if (splitAllItemsAtFrame(frame) === 0) invalid('clip.split: nothing spans that time')
      return
    }
    if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== 'string'))
      invalid('clipIds must be clip ids')
    for (const id of ids as string[]) {
      requireItem(id, 'clipIds')
      if (!splitItem(id, frame)) invalid(`clip.split: "${id}" cannot be split there`)
    }
  },

  'clip.trimStart'(payload, { fps }) {
    const item = requireItem(stringField(payload, 'clipId'))
    const start = timeField(payload, 'start', fps)
    const delta = start - item.from
    if (delta === 0) return
    if (start >= item.from + item.durationInFrames) invalid('start must be before the clip ends')
    if (payload.ripple === true) rippleTrimItem(item.id, 'start', delta)
    else trimItemStart(item.id, delta)
    if (requireItem(item.id).durationInFrames === item.durationInFrames)
      failed('clip.trimStart: the source has no more media there')
  },

  'clip.trimEnd'(payload, { fps }) {
    const item = requireItem(stringField(payload, 'clipId'))
    const end = timeField(payload, 'end', fps)
    const delta = end - (item.from + item.durationInFrames)
    if (delta === 0) return
    if (end <= item.from) invalid('end must be after the clip starts')
    if (payload.ripple === true) rippleTrimItem(item.id, 'end', delta)
    else trimItemEnd(item.id, delta)
    if (requireItem(item.id).durationInFrames === item.durationInFrames)
      failed('clip.trimEnd: the source has no more media there')
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
      // Freecut mutes tracks, not clips (`TimelineTrack.muted`); a clip has only its gain.
      throw new CommandRejection(
        'not-implemented',
        'patch.muted: Freecut clips have no mute; mute the track or set the volume',
      )
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

  'keyframe.add'(payload, { fps }) {
    const item = requireItem(stringField(payload, 'clipId'))
    const property = stringField(payload, 'property') as AnimatableProperty
    const at = timeField(payload, 'at', fps)
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

  'title.add'(payload, { fps }) {
    const text = stringField(payload, 'text')
    const from = timeField(payload, 'at', fps)
    const duration = optionalTime(payload, 'duration', fps) ?? 3 * Math.round(fps)
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
  const mediaById = new Map(media.map((entry) => [entry.id, entry]))

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
        handler(envelope.payload ?? {}, { fps, media: mediaById }),
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
  const next: Project = { ...project, timeline }
  return { status: 'applied', project: next, digest: await graphDigest(next) }
}
