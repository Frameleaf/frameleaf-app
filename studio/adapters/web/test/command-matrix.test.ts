import { readFileSync } from 'node:fs'
import path from 'node:path'
import { writeFile } from 'node:fs/promises'
import { afterAll, describe, expect, it, vi } from 'vite-plus/test'
import type { Project, ProjectTimeline } from '@/types/project'
import type { MediaMetadata } from '@/types/storage'
import type { TimelineItem } from '@/types/timeline'
import { setWorkspaceRoot } from '@/infrastructure/storage/workspace-fs/root'
import { createProject, getProject } from '@/infrastructure/storage'
import { loadTimeline, saveTimeline } from '@/features/timeline/stores/timeline-persistence'
import { applyCanonicalCommands, canonicalJson } from '../src/canonical-commands'
import { VirtualWorkspace } from '../src/virtual-workspace'
import { createStudioBridge } from '@frameleaf/host/bridge'
import {
  createStudioEngineCommandHandlers,
  createStudioGraphHistory,
  studioEngineCommandIds,
  type StudioEngineCommandId,
} from '@frameleaf/host/engine-commands'
import {
  createStudioCommandEnvelope,
  studioCommandDefinition,
  studioCommandIds,
  type StudioCommandEnvelope,
  type StudioCommandId,
  type StudioCommandResult,
} from '@frameleaf/host/commands'
import type { StudioCapabilities } from '@frameleaf/host/host-contract'

// jsdom's Blob predates `text()` and `arrayBuffer()`; browsers have both.
if (!Blob.prototype.arrayBuffer) {
  Blob.prototype.arrayBuffer = function (this: Blob) {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as ArrayBuffer)
      reader.onerror = () => reject(reader.error)
      reader.readAsArrayBuffer(this)
    })
  }
}
if (!Blob.prototype.text) {
  Blob.prototype.text = async function (this: Blob) {
    return new TextDecoder().decode(await this.arrayBuffer())
  }
}

vi.mock('@/infrastructure/storage/handles-db', () => ({
  getHandle: vi.fn(async () => undefined),
  saveHandle: vi.fn(async () => undefined),
  deleteHandle: vi.fn(async () => undefined),
}))

/**
 * FL-112 command and graph axes, measured on the real command path: the host's command bridge
 * (access, connectivity, lease, revision, idempotency), the host's engine command handlers and
 * graph history, and the Freecut engine that applies each command.
 *
 * Every catalogue command is submitted through the bridge. For each one the matrix records:
 *
 * - `access`: a session that lost the project is refused (`forbidden`), and nothing changes.
 * - `lease`: a graph command from a session without the write lease is refused (`lease-lost`).
 * - `revision`: an envelope for an older revision is refused (`stale-revision`, with the current
 *   revision to reconcile against), and nothing changes.
 * - `idempotence`: the same envelope submitted twice answers the same and applies once.
 * - `undo`: the host's undo restores the graph exactly, and redo restores the edit.
 * - `save` and `reopen`: the edited graph is stored and reopened through Freecut's own
 *   persistence, and reopening it again changes nothing.
 * - `unknown-fields`: fields the engine does not know, on the project and on an item, survive.
 * - `normal`: the canonical payload applies and changes the graph.
 * - `invalid`: the same payload made impossible (ids that name nothing, times with no exact
 *   reading, NaN numbers, wrong-typed names) is refused as `invalid`, the refusal is settled, and
 *   nothing changes. Commands outside the engine table are measured at the envelope instead: a
 *   malformed envelope naming them is refused as `invalid` before any gate.
 *
 * The same run measures five FL-112 `authorizationFailure` scenarios per engine command, written to
 * AUTHORIZATION_FAILURE_REPORT in the same shape, alongside the normal/invalid outcomes
 * already measured above (including failures, never inferred from the authorization cases):
 *
 * - `deleted`: the project is deleted (the server answers 404, and the Studio page takes the
 *   session's access away) while the engine applies the command. It is refused as `forbidden`,
 *   nothing is staged or recorded in history, the same envelope gets the same answer, and a next
 *   command is refused without reaching the engine.
 * - `unsupported`: this browser cannot start the engine. The command is refused by name, still in
 *   the vocabulary, and nothing changes; a retry gets the same answer.
 * - `cancel`: the session closes while the engine works. The result is not kept, so the command is
 *   refused rather than reported as applied, and the history is untouched.
 * - `restart`: after a restart (a fresh bridge on the stored revision), the editor replays an
 *   envelope sent before it. It is refused as `stale-revision` with the current revision, and the
 *   graph and history are unchanged: nothing applies twice.
 * - `stale-result`: the engine's result arrives after the graph was replaced. It is refused as
 *   `stale-revision` without being settled, the newer graph stands, and the same intent sent again
 *   applies to the newer graph.
 *
 * Other catalogue commands answer `unsupported` at the gate: a missing worker capability is refused
 * as `capability-missing`, a row no story implements as `not-implemented`.
 *
 * A case is `passed` or `failed` from what was measured, or `not-applicable` with its reason (a
 * command that edits no graph has no lease, revision or undo). Cases this matrix does not measure
 * (bundles, and commands whose handler is a host service rather than the engine) are left out, so
 * they stay unproven rather than claimed.
 */

const ASSET = '0198a1c2-0000-7000-8000-00000000c001'
const STILL = '0198a1c2-0000-7000-8000-00000000c002'

const media: MediaMetadata[] = [
  {
    id: ASSET,
    storageType: 'workspace',
    fileName: 'surf.mp4',
    fileSize: 1,
    mimeType: 'video/mp4',
    duration: 8,
    width: 1920,
    height: 1080,
    fps: 30,
    codec: 'avc1.64002a',
    audioCodec: 'mp4a.40.2',
    bitrate: 1,
    tags: [],
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: STILL,
    storageType: 'workspace',
    fileName: 'summit.jpg',
    fileSize: 1,
    mimeType: 'image/jpeg',
    duration: 0,
    width: 4000,
    height: 3000,
    fps: 0,
    codec: 'unknown',
    bitrate: 0,
    tags: [],
    createdAt: 0,
    updatedAt: 0,
  },
]

const seconds = (num: number, den = 1) => ({ num, den })
const track = (id: string, kind: 'video' | 'audio', order: number) => ({
  id,
  name: id.toUpperCase(),
  kind,
  height: 60,
  locked: false,
  visible: true,
  muted: false,
  solo: false,
  order,
})

const emptyProject = (): Project =>
  ({
    id: 'fl-matrix',
    name: 'Command matrix',
    description: '',
    createdAt: 0,
    updatedAt: 0,
    duration: 0,
    schemaVersion: 15,
    metadata: { width: 1920, height: 1080, fps: 30 },
    // A field no engine version knows: it must survive every command.
    frameleafFuture: { keep: true },
    timeline: {
      tracks: [track('v1', 'video', 0), track('a1', 'audio', 1)],
      items: [],
      transitions: [],
      keyframes: [],
      currentFrame: 0,
      zoomLevel: 1,
      scrollPosition: 0,
    } as unknown as ProjectTimeline,
  }) as unknown as Project

let keySequence = 0
const engineEnvelope = (id: string, payload: Record<string, unknown>) => ({
  id,
  payload,
  revision: 1,
  idempotencyKey: `matrix-setup-${++keySequence}`,
  issuedAt: 1_758_800_000_000,
})

const applied = async (graph: unknown, envelopes: ReturnType<typeof engineEnvelope>[]) => {
  const outcome = await applyCanonicalCommands(graph, envelopes, media)
  if (outcome.status !== 'applied') throw new Error(`${outcome.reason}: ${outcome.detail}`)
  return outcome.project
}

const itemsOf = (graph: Project) => (graph.timeline?.items ?? []) as unknown as TimelineItem[]

/** The fixture every command acts on: a clip cut in three with its sound, a title, a marker, an
 * effect and a keyframe on the first part, a spare track, and fields the engine does not know. */
async function buildFixture() {
  let graph = await applied(emptyProject(), [
    engineEnvelope('clip.add', { trackId: 'v1', assetId: ASSET, at: seconds(0) }),
  ])
  graph = await applied(graph, [engineEnvelope('clip.split', { at: seconds(4) })])
  graph = await applied(graph, [engineEnvelope('clip.split', { at: seconds(6) })])
  const parts = itemsOf(graph)
    .filter((item) => item.trackId === 'v1')
    .sort((a, b) => a.from - b.from)
  const [left, middle, right] = parts.map((item) => item.id) as [string, string, string]
  graph = await applied(graph, [
    engineEnvelope('title.add', { text: 'Title', at: seconds(1), duration: seconds(1) }),
    engineEnvelope('marker.add', { at: seconds(2) }),
    engineEnvelope('effect.add', { clipId: left, effect: 'gpu-sepia', params: { amount: 0.5 } }),
    engineEnvelope('keyframe.add', { clipId: left, property: 'opacity', at: seconds(1), value: { value: 0.25 } }),
    engineEnvelope('track.add', { kind: 'video', name: 'Spare' }),
  ])
  // An item field no engine version knows.
  const title = itemsOf(graph).find((item) => item.type === 'text')!
  ;(title as unknown as Record<string, unknown>).frameleafFuture = { keep: true }
  const leftItem = itemsOf(graph).find((item) => item.id === left) as unknown as {
    effects: Array<{ id: string }>
  }
  const keyframe = graph.timeline!.keyframes![0]!.properties[0]!.keyframes[0]!.id
  const spare = graph.timeline!.tracks.find((entry) => entry.name === 'Spare')!.id
  // FL-100: the fixture grouped into Compose with a published control, and a still photo, each as its
  // own graph so the other commands act on the plain fixture.
  const grouped = await applied(graph, [engineEnvelope('clip.group', { clipIds: [title.id], name: 'Lower third' })])
  const group = itemsOf(grouped).find((item) => item.type === 'composition')!
  const composition = (grouped.timeline as unknown as { compositions: Array<{ id: string; items: Array<{ id: string }> }> })
    .compositions.find((entry) => entry.id === (group as unknown as { compositionId: string }).compositionId)!
  const titleInside = composition.items[0]!.id
  const published = await applied(grouped, [
    engineEnvelope('composition.setPublishedControls', {
      compositionId: composition.id,
      controls: [{ id: 'headline', name: 'Headline', targetItemId: titleInside, property: 'text.text' }],
    }),
  ])
  const stillGraph = await applied(graph, [
    engineEnvelope('clip.add', { trackId: spare, assetId: STILL, at: seconds(0), duration: seconds(2) }),
  ])
  const still = itemsOf(stillGraph).find((item) => item.type === 'image')!.id
  return {
    compose: { graph: grouped, published, group: group.id, composition: composition.id, titleInside },
    stillGraph,
    still,
    graph,
    left,
    middle,
    right,
    title: title.id,
    marker: graph.timeline!.markers![0]!.id,
    effect: leftItem.effects[0]!.id,
    keyframe,
    spare,
  }
}

type Fixture = Awaited<ReturnType<typeof buildFixture>>

/** A valid payload for each engine command on the fixture, and the graph it acts on when that
 * is not the fixture itself. */
const ENGINE_CASES: Record<
  StudioEngineCommandId,
  (f: Fixture) => { payload: Record<string, unknown>; graph?: () => Promise<Project> }
> = {
  'clip.add': () => ({ payload: { trackId: 'v1', assetId: STILL, at: seconds(10), duration: seconds(1) } }),
  'clip.delete': (f) => ({ payload: { clipId: f.title } }),
  'clip.insert': () => ({
    payload: { trackId: 'v1', assetId: ASSET, at: seconds(4), sourceIn: seconds(0), sourceOut: seconds(1) },
  }),
  'clip.join': (f) => ({ payload: { clipIds: [f.left, f.middle] } }),
  'clip.move': (f) => ({ payload: { clipId: f.title, start: seconds(3) } }),
  'clip.overwrite': () => ({
    payload: { trackId: 'v1', assetId: ASSET, at: seconds(4), sourceIn: seconds(0), sourceOut: seconds(1) },
  }),
  'clip.push': (f) => ({ payload: { clipId: f.right, delta: seconds(1) } }),
  'clip.reorder': (f) => ({ payload: { trackId: 'v1', clipId: f.right, index: 0 } }),
  'clip.roll': (f) => ({ payload: { clipId: f.left, at: seconds(3) } }),
  'clip.setLink': (f) => ({ payload: { clipIds: [f.left], linked: false } }),
  'clip.setSpeed': (f) => ({ payload: { clipId: f.right, speed: { num: 2, den: 1 } } }),
  'clip.setTransform': (f) => ({ payload: { clipId: f.left, transform: { x: 10 } } }),
  'clip.setTransformParent': (f) => ({ payload: { clipId: f.title, parentId: f.left } }),
  'clip.setTransition': (f) => ({
    payload: { clipId: f.left, transition: { type: 'Cross dissolve', duration: seconds(1, 2) } },
  }),
  'clip.slide': (f) => ({ payload: { clipId: f.middle, delta: seconds(1, 3) } }),
  'clip.slip': (f) => ({ payload: { clipId: f.middle, delta: seconds(1, 2) } }),
  'clip.split': () => ({ payload: { at: seconds(1) } }),
  'clip.trimEnd': (f) => ({ payload: { clipId: f.right, end: seconds(7) } }),
  'clip.trimStart': (f) => ({ payload: { clipId: f.right, start: seconds(7) } }),
  'clip.update': (f) => ({ payload: { clipId: f.title, patch: { text: 'Hello' } } }),
  'composition.add': (f) => ({ payload: { name: 'Group', clipIds: [f.title] } }),
  'effect.add': (f) => ({ payload: { clipId: f.right, effect: 'gpu-sepia', params: { amount: 0.5 } } }),
  'effect.remove': (f) => ({ payload: { clipId: f.left, effectId: f.effect } }),
  'keyframe.add': (f) => ({
    payload: { clipId: f.right, property: 'opacity', at: seconds(7), value: { value: 0.5 } },
  }),
  'keyframe.remove': (f) => ({ payload: { clipId: f.left, property: 'opacity', keyframeIds: [f.keyframe] } }),
  'keyframe.update': (f) => ({
    payload: { clipId: f.left, property: 'opacity', keyframeId: f.keyframe, at: seconds(2), value: { value: 0.75 } },
  }),
  'property.setExpression': (f) => ({
    payload: { clipId: f.title, property: 'opacity', expression: 'clamp(0.5 + sin(time) * 0.25, 0, 1)' },
  }),
  'property.setModifier': (f) => ({
    payload: {
      clipId: f.right,
      property: 'rotation',
      modifier: { type: 'sway', amplitude: 1, frequency: 0.5, phaseFrames: 0, seed: 1 },
    },
  }),
  'property.bakeModifier': (f) => ({
    payload: { clipId: f.right, property: 'rotation', modifierId: 'sway-1' },
    graph: () =>
      applied(f.graph, [
        engineEnvelope('property.setModifier', {
          clipId: f.right,
          property: 'rotation',
          modifier: { id: 'sway-1', type: 'sway', amplitude: 1, frequency: 0.5, phaseFrames: 0, seed: 1 },
        }),
      ]),
  }),
  'text.setMotion': (f) => ({
    payload: {
      clipId: f.title,
      motion: { in: { presetId: 'fade-up', durationFrames: 12, staggerFrames: 2, intensity: 1, unit: 'character' } },
    },
  }),
  'clip.group': (f) => ({ payload: { clipIds: [f.title], name: 'Lower third' } }),
  'clip.ungroup': (f) => ({ payload: { groupId: f.compose.group }, graph: async () => f.compose.graph }),
  'composition.setPublishedControls': (f) => ({
    payload: {
      compositionId: f.compose.composition,
      controls: [{ id: 'headline', name: 'Headline', targetItemId: f.compose.titleInside, property: 'text.text' }],
    },
    graph: async () => f.compose.graph,
  }),
  'composition.setControlOverrides': (f) => ({
    payload: { compositionClipId: f.compose.group, overrides: { headline: 'Chapter two' } },
    graph: async () => f.compose.published,
  }),
  'clip.setKenBurns': (f) => ({
    payload: { clipId: f.still, kenBurns: { from: { x: 0, y: 0, w: 1, h: 1 }, to: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } } },
    graph: async () => f.stillGraph,
  }),
  'keyframe.setEasing': (f) => ({
    payload: {
      clipId: f.left,
      property: 'opacity',
      keyframeIds: [f.keyframe],
      easing: 'cubic-bezier',
      bezier: { x1: 0.2, y1: 0, x2: 0.3, y2: 1.2 },
    },
  }),
  'marker.add': () => ({ payload: { at: seconds(5) } }),
  'marker.remove': (f) => ({ payload: { markerId: f.marker } }),
  'marker.update': (f) => ({ payload: { markerId: f.marker, patch: { name: 'Chorus' } } }),
  'music.add': () => ({ payload: { musicId: 'ambient-1', at: seconds(0) } }),
  'project.applyTemplate': () => ({ payload: { templateId: 'vertical-9-16' } }),
  'project.setMasterAudio': () => ({ payload: { gainDb: -6, muted: true } }),
  'sequence.setSettings': () => ({ payload: { sequenceId: 'main', width: 1280, height: 720 } }),
  'title.add': () => ({ payload: { text: 'Second title', at: seconds(5) } }),
  'track.add': () => ({ payload: { kind: 'video', name: 'Added' } }),
  'track.closeGap': (f) => ({
    payload: { trackId: 'v1' },
    // A gap to close: the last part pushed a second later first.
    graph: () => applied(f.graph, [engineEnvelope('clip.push', { clipId: f.right, delta: seconds(1) })]),
  }),
  'track.remove': (f) => ({ payload: { trackId: f.spare } }),
  'track.reorder': () => ({ payload: { trackId: 'a1', index: 0 } }),
  'track.set': () => ({ payload: { trackId: 'a1', patch: { muted: true } } }),
}

/** Every worker present: the capability gate is not what this matrix measures. */
const capabilities: StudioCapabilities = {
  analysisWorker: true,
  generationWorker: true,
  gpuWorker: true,
  renderWorker: true,
  restorationWorker: true,
  transcriptionWorker: true,
}

/** One Studio session around a graph, as the Studio page wires it (`+page.svelte`). */
function session(
  initial: Project,
  overrides: Partial<{ hasAccess: boolean; hasLease: boolean; revision: number; engineUp: boolean }> = {},
) {
  const state = {
    graph: initial as unknown,
    revision: 5,
    hasAccess: true,
    hasLease: true,
    // The project session keeps what it is given (`staged`), or not (`ignored`: deleted or closed).
    keeps: true,
    engineUp: true,
    // While set, the engine waits for it before answering.
    gate: null as Promise<void> | null,
    engineCalls: 0,
    ...overrides,
  }
  const history = createStudioGraphHistory()
  const handlers = createStudioEngineCommandHandlers({
    graph: () => state.graph,
    revision: () => state.revision,
    assets: () => [],
    restore: async () => false,
    history,
    stage: (graph) => {
      if (!state.keeps) return 'ignored'
      state.graph = graph
      state.revision += 1
      return 'staged'
    },
    engine: async () => (state.engineUp ? {
      dispose() {},
      async apply(current, envelopes) {
        state.engineCalls += 1
        if (state.gate) await state.gate
        const outcome = await applyCanonicalCommands(current, envelopes, media)
        return outcome.status === 'applied'
          ? { status: 'applied', graph: outcome.project, digest: outcome.digest }
          : outcome
      },
    } : null),
  })
  const bridge = createStudioBridge({
    context: () => ({
      revision: state.revision,
      hasLease: state.hasLease,
      hasAccess: state.hasAccess,
      online: true,
      capabilities,
    }),
    handlers,
  })
  const submit = async (envelope: StudioCommandEnvelope) => (await bridge.submit([envelope]))[0]!
  const envelope = (id: StudioCommandId, payload: Record<string, unknown>, revision = state.revision) =>
    createStudioCommandEnvelope(id as never, payload as never, revision)
  /** Holds the engine until `release()`, so the session can change while the command is in flight. */
  const hold = () => {
    let release = () => {}
    state.gate = new Promise<void>((resolve) => (release = resolve))
    return () => {
      state.gate = null
      release()
    }
  }
  return { state, history, submit, envelope, hold }
}

/** Rows the Studio page (`routes/(user)/studio/+page.svelte`) serves with a host service. */
const HOST_SERVICE_COMMANDS = new Set<string>([
  'preview.request',
  'preview.release',
  'project.exportBundle',
  'project.importBundle',
  'job.enqueueRestoration',
  'job.enqueueInterpolation',
])

/** The manifest rows each catalogue command implements (`studio/frameleaf-studio-commands.json`). */
const catalogue = JSON.parse(
  readFileSync(path.join(__dirname, '../../../frameleaf-studio-commands.json'), 'utf8'),
) as { commands: Array<{ id: string; manifestIds: string[] }> }
const manifestIdsOf = (id: string) => catalogue.commands.find((entry) => entry.id === id)?.manifestIds ?? []

type CaseResult = { case: string; result: 'passed' | 'failed' | 'not-applicable'; reason?: string }
const report: {
  commands: Array<{ id: string; manifestIds: string[]; implementedBy: string; cases: CaseResult[] }>
} = { commands: [] }
const authorizationReport: typeof report = { commands: [] }

const check = (name: string, pass: boolean, reason: string): CaseResult =>
  pass ? { case: name, result: 'passed' } : { case: name, result: 'failed', reason }

const rejectedAs = (result: StudioCommandResult | undefined, reason: string) =>
  result?.status === 'rejected' && result.reason === reason

/** The gate cases every command answers the same way, before any handler runs. */
async function gateCases(id: StudioCommandId, fixture: Project, payload: Record<string, unknown>) {
  const definition = studioCommandDefinition(id)
  const cases: CaseResult[] = []

  const denied = session(fixture, { hasAccess: false })
  const before = canonicalJson(denied.state.graph)
  cases.push(
    check(
      'access',
      rejectedAs(await denied.submit(denied.envelope(id, payload)), 'forbidden') &&
        canonicalJson(denied.state.graph) === before,
      'a session without access was not refused, or the graph changed',
    ),
  )

  if (!definition.mutatesGraph) {
    const reason = `${id} does not edit the project graph`
    cases.push({ case: 'lease', result: 'not-applicable', reason })
    cases.push({ case: 'revision', result: 'not-applicable', reason })
    return cases
  }

  const reader = session(fixture, { hasLease: false })
  cases.push(
    check(
      'lease',
      rejectedAs(await reader.submit(reader.envelope(id, payload)), 'lease-lost') &&
        canonicalJson(reader.state.graph) === before,
      'a session without the write lease was not refused, or the graph changed',
    ),
  )

  const behind = session(fixture)
  const stale = await behind.submit(behind.envelope(id, payload, behind.state.revision - 1))
  cases.push(
    check(
      'revision',
      rejectedAs(stale, 'stale-revision') &&
        stale?.status === 'rejected' &&
        stale.revision === behind.state.revision &&
        canonicalJson(behind.state.graph) === before,
      'an envelope for an older revision was not refused with the current revision, or the graph changed',
    ),
  )
  return cases
}

/**
 * The canonical payload with what it points at made impossible: every id names nothing in the
 * graph, every time has no exact reading, every count and name is the wrong type. An engine
 * command must refuse it by name (`invalid`) rather than guess.
 */
const invalidPayload = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(invalidPayload)
  if (!value || typeof value !== 'object') return value
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 2 && 'num' in (value as object) && 'den' in (value as object)) return { num: 1, den: 0 }
  return Object.fromEntries(
    entries.map(([key, field]) => {
      if (typeof field === 'string' && /id$|Id$|Ids$/.test(key)) return [key, `missing-${key}`]
      if (Array.isArray(field) && /Ids$/.test(key)) return [key, field.map(() => `missing-${key}`)]
      if (typeof field === 'number') return [key, Number.NaN]
      if (typeof field === 'string' && (key === 'kind' || key === 'text' || key === 'name' || key === 'effect'))
        return [key, { not: 'a string' }]
      return [key, invalidPayload(field)]
    }),
  )
}

/**
 * `normal` and `invalid` input for one engine command. `normal`: the canonical payload applies and
 * changes the graph. `invalid`: the impossible payload is refused as `invalid`, the refusal is
 * settled (a retry answers the same without reaching the engine), and nothing changes.
 */
async function inputCases(id: StudioCommandId, start: Project, payload: Record<string, unknown>): Promise<CaseResult[]> {
  const before = canonicalJson(start)
  const s = session(start)
  const applied = await s.submit(s.envelope(id, payload))
  const normal = check(
    'normal',
    applied?.status === 'accepted' && canonicalJson(s.state.graph) !== before,
    `the canonical payload answered ${JSON.stringify(applied)}, or changed nothing`,
  )
  const t = session(start)
  const envelope = t.envelope(id, invalidPayload(payload) as Record<string, unknown>)
  const refused = await t.submit(envelope)
  const calls = t.state.engineCalls
  const again = await t.submit(envelope)
  const invalid = check(
    'invalid',
    rejectedAs(refused, 'invalid') &&
      JSON.stringify(again) === JSON.stringify(refused) &&
      t.state.engineCalls === calls &&
      canonicalJson(t.state.graph) === before &&
      t.history.depth.undo === 0,
    `an impossible payload ${JSON.stringify(envelope.payload)} answered ${JSON.stringify(refused)}, or something changed`,
  )
  return [normal, invalid]
}

/** `invalid` at the envelope, for a command outside the engine table: a payload that is not an object. */
async function malformedEnvelope(id: StudioCommandId, graph: Project): Promise<CaseResult> {
  const s = session(graph)
  const before = canonicalJson(s.state.graph)
  const malformed = { ...s.envelope(id, {}), payload: 'not a payload' } as unknown as StudioCommandEnvelope
  const result = await s.submit(malformed)
  return check(
    'invalid',
    rejectedAs(result, 'invalid') && canonicalJson(s.state.graph) === before,
    `a malformed ${id} envelope answered ${JSON.stringify(result)}`,
  )
}

/** The five `authorizationFailure` scenarios for one engine command (see the header). */
async function authorizationFailureCases(
  id: StudioCommandId,
  start: Project,
  payload: Record<string, unknown>,
  applies: boolean,
): Promise<CaseResult[]> {
  const cases: CaseResult[] = []
  const before = canonicalJson(start)

  // deleted: the project goes while the engine works.
  {
    const s = session(start)
    const release = s.hold()
    const envelope = s.envelope(id, payload)
    const pending = s.submit(envelope)
    await Promise.resolve()
    s.state.hasAccess = false
    s.state.keeps = false
    release()
    const result = await pending
    const again = await s.submit(envelope)
    const calls = s.state.engineCalls
    const next = await s.submit(s.envelope(id, payload))
    cases.push(
      check(
        'deleted',
        rejectedAs(result, 'forbidden') &&
          JSON.stringify(again) === JSON.stringify(result) &&
          rejectedAs(next, 'forbidden') &&
          s.state.engineCalls === calls &&
          canonicalJson(s.state.graph) === before &&
          s.history.depth.undo === 0,
        `a command in flight when the project was deleted was not refused cleanly: ${JSON.stringify(result)}`,
      ),
    )
  }

  // unsupported: this browser cannot start the engine.
  {
    const s = session(start, { engineUp: false })
    const envelope = s.envelope(id, payload)
    const result = await s.submit(envelope)
    const again = await s.submit(envelope)
    cases.push(
      check(
        'unsupported',
        rejectedAs(result, 'failed') &&
          JSON.stringify(again) === JSON.stringify(result) &&
          (studioCommandIds as readonly string[]).includes(id) &&
          canonicalJson(s.state.graph) === before &&
          s.history.depth.undo === 0,
        `a command with no engine was not refused by name, or something changed: ${JSON.stringify(result)}`,
      ),
    )
  }

  // cancel: the session closes while the engine works.
  {
    const s = session(start)
    const release = s.hold()
    const pending = s.submit(s.envelope(id, payload))
    await Promise.resolve()
    s.state.keeps = false
    release()
    const result = await pending
    cases.push(
      check(
        'cancel',
        result?.status === 'rejected' && canonicalJson(s.state.graph) === before && s.history.depth.undo === 0,
        `a command whose session closed was reported as ${JSON.stringify(result)}, or the history moved`,
      ),
    )
  }

  if (!applies) {
    const reason = `${id} did not apply on the fixture, so there is no earlier envelope to replay or result to go stale`
    cases.push({ case: 'restart', result: 'failed', reason }, { case: 'stale-result', result: 'failed', reason })
    return cases
  }

  // restart: an envelope from before the restart, replayed into a fresh bridge on the stored revision.
  {
    const first = session(start)
    const envelope = first.envelope(id, payload)
    const accepted = await first.submit(envelope)
    const stored = canonicalJson(first.state.graph)
    const restarted = session(first.state.graph as Project, { revision: first.state.revision })
    const replay = await restarted.submit(envelope)
    cases.push(
      check(
        'restart',
        accepted?.status === 'accepted' &&
          rejectedAs(replay, 'stale-revision') &&
          replay?.status === 'rejected' &&
          replay.revision === restarted.state.revision &&
          canonicalJson(restarted.state.graph) === stored &&
          restarted.history.depth.undo === 0 &&
          restarted.state.engineCalls === 0,
        `a replay after the restart answered ${JSON.stringify(replay)}, or applied again`,
      ),
    )
  }

  // stale-result: the graph is replaced while the engine works on the older one.
  {
    const s = session(start)
    const release = s.hold()
    const envelope = s.envelope(id, payload)
    const pending = s.submit(envelope)
    await Promise.resolve()
    // The editor's newer draft: an equal graph, but a different document.
    const newer = structuredClone(start)
    s.state.graph = newer
    release()
    const result = await pending
    const retried = await s.submit(envelope)
    cases.push(
      check(
        'stale-result',
        rejectedAs(result, 'stale-revision') &&
          s.history.depth.undo === 1 &&
          retried?.status === 'accepted' &&
          canonicalJson(s.history.undo(s.state.graph)) === canonicalJson(newer),
        `a result computed from a replaced graph answered ${JSON.stringify(result)}, or its retry did not apply to the newer graph (${JSON.stringify(retried)})`,
      ),
    )
  }
  return cases
}

/**
 * `unsupported` for a command outside the engine table, measured at the gate: a missing worker is
 * refused as `capability-missing`; a row no story implements is refused as `not-implemented`.
 * Host services other than the capability gate are answered by the Studio page, not measured here.
 */
async function unsupportedAtGate(
  id: StudioCommandId,
  graph: Project,
  implementedBy: string,
): Promise<CaseResult | null> {
  const needs = studioCommandDefinition(id).requiresCapability
  const s = session(graph)
  const before = canonicalJson(s.state.graph)
  if (needs) {
    const bridge = createStudioBridge({
      context: () => ({
        revision: s.state.revision,
        hasLease: true,
        hasAccess: true,
        online: true,
        capabilities: { ...capabilities, [needs]: false },
      }),
    })
    const [result] = await bridge.submit([s.envelope(id, {})])
    return check(
      'unsupported',
      rejectedAs(result, 'capability-missing') && canonicalJson(s.state.graph) === before,
      `without ${needs} the command answered ${JSON.stringify(result)}`,
    )
  }
  if (implementedBy !== 'none') return null
  const result = await s.submit(s.envelope(id, {}))
  return check(
    'unsupported',
    rejectedAs(result, 'not-implemented') && canonicalJson(s.state.graph) === before,
    `a row no story implements answered ${JSON.stringify(result)}`,
  )
}

describe('FL-112 command and graph matrix, on the real command path', () => {
  const workspace = new VirtualWorkspace()
  setWorkspaceRoot(workspace.handle())

  afterAll(async () => {
    setWorkspaceRoot(null)
    workspace.dispose()
    if (process.env.COMMAND_MATRIX_REPORT) {
      await writeFile(process.env.COMMAND_MATRIX_REPORT, JSON.stringify(report, null, 2))
    }
    if (process.env.AUTHORIZATION_FAILURE_REPORT) {
      await writeFile(process.env.AUTHORIZATION_FAILURE_REPORT, JSON.stringify(authorizationReport, null, 2))
    }
  })

  it.each([...studioEngineCommandIds])('%s', async (id) => {
    const fixture = await buildFixture()
    const { payload, graph } = ENGINE_CASES[id](fixture)
    const start = graph ? await graph() : fixture.graph
    const cases = [...(await gateCases(id, start, payload)), ...(await inputCases(id, start, payload))]

    // Idempotence: the same envelope twice answers the same and applies once.
    const live = session(start)
    const envelope = live.envelope(id, payload)
    const first = await live.submit(envelope)
    const afterFirst = canonicalJson(live.state.graph)
    const second = await live.submit(envelope)
    const appliedOnce = first?.status === 'accepted'
    cases.push(
      check(
        'idempotence',
        appliedOnce &&
          JSON.stringify(second) === JSON.stringify(first) &&
          canonicalJson(live.state.graph) === afterFirst &&
          live.history.depth.undo === 1,
        appliedOnce
          ? 'a replayed envelope answered differently or applied again'
          : `the command did not apply: ${JSON.stringify(first)}`,
      ),
    )

    if (!appliedOnce) {
      const reason = `the command did not apply on the fixture: ${JSON.stringify(first)}`
      for (const name of ['undo', 'save', 'reopen', 'unknown-fields']) cases.push({ case: name, result: 'failed', reason })
    } else {
      // Undo and redo through the host's history.
      const undone = await live.submit(live.envelope('history.undo', {}))
      const restored = canonicalJson(live.state.graph) === canonicalJson(start)
      const redone = await live.submit(live.envelope('history.redo', {}))
      cases.push(
        check(
          'undo',
          undone?.status === 'accepted' && restored && redone?.status === 'accepted' &&
            canonicalJson(live.state.graph) === afterFirst,
          'undo did not restore the graph exactly, or redo did not restore the edit',
        ),
      )

      // Unknown fields survive the edit.
      const edited = live.state.graph as Project & { frameleafFuture?: unknown }
      // Inside a composition too: grouping moves the item, and its unknown fields go with it.
      const everyItem = [
        ...itemsOf(edited),
        ...((edited.timeline as unknown as { compositions?: Array<{ items?: TimelineItem[] }> }).compositions ?? []).flatMap(
          (composition) => composition.items ?? [],
        ),
      ]
      const future = everyItem.find(
        (item) => (item as unknown as { frameleafFuture?: unknown }).frameleafFuture !== undefined,
      )
      const itemRemoved = id === 'clip.delete' || id === 'composition.add'
      cases.push(
        check(
          'unknown-fields',
          JSON.stringify(edited.frameleafFuture) === '{"keep":true}' && (itemRemoved || future !== undefined),
          'a field the engine does not know was dropped',
        ),
      )

      // Save and reopen through Freecut's own persistence.
      const projectId = `fl-matrix-${id.replace('.', '-')}`
      await createProject({ ...(edited as Project), id: projectId })
      await loadTimeline(projectId)
      await saveTimeline(projectId)
      const saved = (await getProject(projectId))!
      const savedTimeline = canonicalJson(saved.timeline)
      await loadTimeline(projectId)
      await saveTimeline(projectId)
      const reopened = (await getProject(projectId))!
      const itemIds = (timeline: ProjectTimeline | undefined) =>
        ((timeline?.items ?? []) as Array<{ id: string }>).map((item) => item.id).sort()
      cases.push(
        check(
          'save',
          JSON.stringify(itemIds(saved.timeline)) === JSON.stringify(itemIds(edited.timeline)) &&
            (saved as unknown as { frameleafFuture?: unknown }).frameleafFuture !== undefined,
          'the stored project lost clips or unknown fields of the edited graph',
        ),
      )
      cases.push(
        check(
          'reopen',
          canonicalJson(reopened.timeline) === savedTimeline,
          'reopening the stored project and saving it again changed it',
        ),
      )
    }

    report.commands.push({ id, manifestIds: manifestIdsOf(id), implementedBy: 'engine', cases })
    const failures = await authorizationFailureCases(id, start, payload, appliedOnce)
    authorizationReport.commands.push({
      id,
      manifestIds: manifestIdsOf(id),
      implementedBy: 'engine',
      cases: [
        ...cases.filter((entry) => entry.case === 'normal' || entry.case === 'invalid'),
        ...failures,
      ],
    })
    // The authorization axis also requires the canonical inputs measured by this same run.
    for (const input of cases.filter(
      (entry) => entry.case === 'normal' || entry.case === 'invalid',
    )) {
      expect(authorizationReport.commands.at(-1)?.cases).toContainEqual(input)
    }
    // music.add never applies (FL-86 rights), so it has nothing to replay or to go stale.
    expect(failures.filter((entry) => entry.result === 'failed').map((entry) => entry.case)).toEqual(
      id === 'music.add' ? ['restart', 'stale-result'] : [],
    )
    const failed = cases.filter((entry) => entry.result === 'failed')
    // music.add is refused on purpose: the music catalogue is rights-blocked (FL-86).
    if (id === 'music.add') {
      // Refused before its payload is read, so an impossible payload is refused as `failed` too.
      expect(failed.map((entry) => entry.case).sort()).toEqual(
        ['idempotence', 'invalid', 'normal', 'reopen', 'save', 'undo', 'unknown-fields'].sort(),
      )
    } else {
      expect(failed).toEqual([])
    }
  })

  it('answers the gate for every other catalogue command, and says which the engine does not implement', async () => {
    const fixture = await buildFixture()
    const engineIds = new Set<string>(studioEngineCommandIds)
    for (const id of studioCommandIds) {
      if (engineIds.has(id) || id === 'history.undo' || id === 'history.redo') continue
      const cases = await gateCases(id, fixture.graph, {})
      // Outside the engine table, the Studio page serves a row with its own service (preview,
      // bundles, restoration) or not at all (a typed extension point it rejects as
      // `not-implemented`); this matrix measures only the shared gate for them.
      const implementedBy = HOST_SERVICE_COMMANDS.has(id) ? 'host-service' : 'none'
      cases.push(await malformedEnvelope(id, fixture.graph))
      report.commands.push({ id, manifestIds: manifestIdsOf(id), implementedBy, cases })
      expect(cases.filter((entry) => entry.result === 'failed')).toEqual([])
      const unsupported = await unsupportedAtGate(id, fixture.graph, implementedBy)
      if (unsupported) {
        authorizationReport.commands.push({ id, manifestIds: manifestIdsOf(id), implementedBy, cases: [unsupported] })
        expect(unsupported.result).not.toBe('failed')
      }
    }
    // history.undo and history.redo are measured by every engine command's undo case.
    for (const id of ['history.undo', 'history.redo'] as const) {
      const engine = report.commands.filter((entry) => entry.implementedBy === 'engine')
      const undo = engine.every((entry) =>
        entry.cases.some((c) => c.case === 'undo' && (c.result === 'passed' || entry.id === 'music.add')),
      )
      report.commands.push({
        id,
        manifestIds: manifestIdsOf(id),
        implementedBy: 'engine',
        cases: [check('undo', undo, 'an engine command failed undo/redo')],
      })
    }
  })
})
