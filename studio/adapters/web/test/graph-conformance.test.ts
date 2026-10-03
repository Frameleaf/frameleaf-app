import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vite-plus/test'
import type { MediaMetadata } from '@/types/storage'
import { useEditorStore } from '@/shared/state/editor'
import {
  applyCanonicalCommands,
  canonicalJson,
  deterministicUuids,
  secondsToFrames,
  type CanonicalEnvelope,
  type Rational,
} from '../src/canonical-commands'
import { createStudioEngineCommandHandlers, createStudioGraphHistory } from '@frameleaf/host/engine-commands'
import type { StudioCommandEnvelope } from '@frameleaf/host/commands'
import { frameRatio, scaleFrame } from '@/features/timeline/utils/project-retime'
import catalogue from '../../../frameleaf-studio-commands.json'

/**
 * FL-306 (NAPI-017): the Studio graph protocol's conformance fixtures, replayed through the real
 * engine. `studio/graph-conformance-v1.json` holds the inputs (media, seed graphs, bases, cases and
 * history scripts) and the engine's answers. This test recomputes every answer and fails on any
 * difference, so the protocol the native apps implement cannot silently drift from the engine.
 * FL-307 (NAPI-018) added the cases of the clip, timeline-edit, track and marker commands, and
 * FL-308 (NAPI-019) those of the effect, transition, keyframe, expression, modifier, text motion
 * and Ken Burns commands. FL-309 (NAPI-020) added those of the composition, group, published
 * control, title, sequence settings and template commands, and the retime vectors.
 *
 *   GRAPH_CONFORMANCE_WRITE=1 node studio/tools/adapter.mjs test   # regenerate the answers
 *
 * Answers are only ever written by this test; a hand-edited answer fails the next check.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const fixturePath = path.resolve(here, '../../../graph-conformance-v1.json')
const engineBuild = JSON.parse(readFileSync(path.resolve(here, '../../../engine-build.json'), 'utf8')) as {
  upstreamCommit: string
}
const WRITE = process.env.GRAPH_CONFORMANCE_WRITE === '1'

/** How many identities of each envelope's stream are searched for in the result. */
const DRAW_WINDOW = 64

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

interface Base {
  seed: string
  media: string
  setup: CanonicalEnvelope[]
  graph?: Json
  digest?: string
}

interface Draw {
  draw: number
  id: string
  at: string[]
}

type CaseExpectation =
  | {
      status: 'applied'
      digest: string
      envelopeDigest: string
      fixedPoint: boolean
      clockIndependent: boolean
      draws: Draw[][]
      graph: Json
      /** FL-309: what one load makes of `graph`, for a case that settles on load. */
      settled?: { digest: string; envelopeDigest: string; fixedPoint: boolean }
    }
  | { status: 'rejected'; index: number; reason: string; detail: string }

interface Case {
  id: string
  story: string
  covers: string[]
  summary: string
  base: string
  media?: string
  /**
   * FL-307: the engine accepts this batch but its result is not in normal form (`fixedPoint` is
   * false). Declared by hand; the recorded answer must agree, in both directions.
   */
  outsideNormalForm?: boolean
  /**
   * FL-308: the answer holds values from floating-point functions the protocol does not fix (sine,
   * arctangent, keyframe interpolation). Declared by hand; it changes nothing in the replay.
   */
  engineArithmetic?: boolean
  /**
   * FL-309: the engine's own result is one load short of normal form: the next load completes it,
   * and nothing a person made changes (14.2.3). The answer records the settled digest too, and that
   * the settled graph is a fixed point. Declared by hand; the recorded answer must agree.
   */
  settlesOnLoad?: boolean
  envelopes: CanonicalEnvelope[]
  /** Authored input requirement, checked before recording an answer; never a fabricated receipt. */
  admission?: { status: 'applied' | 'rejected'; reason?: string; index?: number }
  expect: CaseExpectation | null
}

type HistoryStep =
  | { command: CanonicalEnvelope }
  | { undo: { toRevision?: number } }
  | { redo: { toRevision?: number } }

interface HistoryOutcome {
  outcome: 'accepted' | 'rejected'
  reason?: string
  digest: string
  /** The earliest state (0 is the base, n is after step n) with the same graph. */
  sameAs: number
  depth: { undo: number; redo: number }
}

interface HistoryScript {
  id: string
  story: string
  summary: string
  base: string
  media?: string
  steps: HistoryStep[]
  expect: HistoryOutcome[] | null
}

interface Fixtures {
  format: string
  version: number
  protocol: string
  engine: { name: string; revision: string }
  generatedBy: string
  regenerate: string
  media: Record<string, MediaMetadata[]>
  seeds: Record<string, Json>
  bases: Record<string, Base>
  vectors: {
    canonicalJson: Array<{ value: Json; canonical?: string; sha256?: string }>
    uuids: Array<{ seed: string; count: number; uuids?: string[] }>
    frames: Array<{ time: Rational; rate: Rational; frames?: number | null }>
    retime?: Array<{ frame: number; from: number; to: number; scaled?: number }>
  }
  cases: Case[]
  history: HistoryScript[]
  /** FL-309: `section` is the section of the protocol page that holds the command's rule. */
  commandStatus: Record<string, { status: string; story: string; section: string; note?: string }>
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
const graphDigestOf = (graph: unknown) => sha256(canonicalJson(graph))
const envelopeDigestOf = (graph: unknown) =>
  sha256(canonicalJson({ schemaVersion: 1, engine: 'freecut', engineRevision: engineBuild.upstreamCommit, graph }))

/**
 * Every JSON path, in canonical key order, whose string value is `id`, or `track-` + `id`: the form
 * of the id of a track a command creates.
 */
const pathsOf = (value: unknown, id: string, at = '', found: string[] = []): string[] => {
  if (typeof value === 'string') {
    if (value === id || value === `track-${id}`) found.push(at)
  } else if (Array.isArray(value)) {
    value.forEach((entry, index) => pathsOf(entry, id, `${at}[${index}]`, found))
  } else if (value && typeof value === 'object') {
    for (const key of Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
      pathsOf((value as Record<string, unknown>)[key], id, at ? `${at}.${key}` : key, found)
    }
  }
  return found
}

/**
 * The identities each envelope drew, found in the result: draw n of envelope i's stream (seeded with
 * `idempotencyKey:i`) and every path that holds it, up to the last draw that landed anywhere.
 */
const drawsOf = (graph: unknown, envelopes: readonly CanonicalEnvelope[]): Draw[][] =>
  envelopes.map((envelope, index) => {
    const next = deterministicUuids(`${envelope.idempotencyKey}:${index}`)
    const draws = Array.from({ length: DRAW_WINDOW }, (_, draw) => {
      const id = next()
      return { draw, id, at: pathsOf(graph, id) }
    })
    const last = draws.findLastIndex((entry) => entry.at.length > 0)
    return draws.slice(0, last + 1)
  })

/** The command runtime is a fresh document: its linked-selection toggle starts at the default. */
const resetRuntime = () => useEditorStore.setState({ linkedSelectionEnabled: true })

const apply = async (graph: unknown, envelopes: readonly CanonicalEnvelope[], media: readonly MediaMetadata[]) => {
  resetRuntime()
  return applyCanonicalCommands(structuredClone(graph), envelopes, media)
}

const load = (): Fixtures => JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixtures

const mediaOf = (fixtures: Fixtures, name: string | undefined, fallback: string) => {
  const media = fixtures.media[name ?? fallback]
  if (!media) throw new Error(`unknown media set ${name ?? fallback}`)
  return media
}

async function buildBase(fixtures: Fixtures, name: string, base: Base): Promise<{ graph: Json; digest: string }> {
  const seed = fixtures.seeds[base.seed]
  if (!seed) throw new Error(`base ${name}: unknown seed ${base.seed}`)
  const outcome = await apply(seed, base.setup, mediaOf(fixtures, base.media, base.media))
  if (outcome.status !== 'applied') throw new Error(`base ${name}: ${outcome.reason} at ${outcome.index}: ${outcome.detail}`)
  const graph = JSON.parse(JSON.stringify(outcome.project)) as Json
  return { graph, digest: graphDigestOf(graph) }
}

async function runCase(fixtures: Fixtures, entry: Case): Promise<CaseExpectation> {
  const base = fixtures.bases[entry.base]
  if (!base?.graph) throw new Error(`${entry.id}: base ${entry.base} has no graph`)
  const media = mediaOf(fixtures, entry.media, base.media)
  const outcome = await apply(base.graph, entry.envelopes, media)
  if (entry.admission) expect(outcome, `${entry.id}: required admission`).toMatchObject(entry.admission)
  if (outcome.status === 'rejected') {
    return { status: 'rejected', index: outcome.index, reason: outcome.reason, detail: outcome.detail }
  }
  const graph = JSON.parse(JSON.stringify(outcome.project)) as Json
  const digest = graphDigestOf(graph)
  expect(outcome.digest, `${entry.id}: the engine's own digest`).toBe(digest)
  const again = await apply(graph, [], media)
  const fixedPoint = again.status === 'applied' && graphDigestOf(again.project) === digest
  // The same batch issued at another time must give the same graph: no command writes the clock.
  const later = await apply(
    base.graph,
    entry.envelopes.map((envelope) => ({ ...envelope, issuedAt: envelope.issuedAt + 86_400_000 })),
    media,
  )
  const clockIndependent = later.status === 'applied' && graphDigestOf(later.project) === digest
  if (entry.admission?.status === 'applied') {
    expect(fixedPoint, `${entry.id}: admitted graph survives reload`).toBe(true)
    expect(clockIndependent, `${entry.id}: admitted graph is clock independent`).toBe(true)
  }
  // FL-309: a case that settles on load records what the load makes of it, and that it then holds.
  let settled: { digest: string; envelopeDigest: string; fixedPoint: boolean } | undefined
  if (entry.settlesOnLoad && again.status === 'applied') {
    const loaded = JSON.parse(JSON.stringify(again.project)) as Json
    const once = await apply(loaded, [], media)
    settled = {
      digest: graphDigestOf(loaded),
      envelopeDigest: envelopeDigestOf(loaded),
      fixedPoint: once.status === 'applied' && graphDigestOf(once.project) === graphDigestOf(loaded),
    }
  }
  return {
    status: 'applied',
    digest,
    envelopeDigest: envelopeDigestOf(graph),
    fixedPoint,
    clockIndependent,
    draws: drawsOf(graph, entry.envelopes),
    graph,
    ...(settled ? { settled } : {}),
  }
}

/** Undo and redo as the web host answers them, over one session's graph history. */
async function runHistory(fixtures: Fixtures, script: HistoryScript): Promise<HistoryOutcome[]> {
  const base = fixtures.bases[script.base]
  if (!base?.graph) throw new Error(`${script.id}: base ${script.base} has no graph`)
  const media = mediaOf(fixtures, script.media, base.media)
  let graph: unknown = structuredClone(base.graph)
  // Each staged graph is modelled as one stored revision; revision 1 is the base.
  const revisions: unknown[] = [graph]
  const history = createStudioGraphHistory()
  const handlers = createStudioEngineCommandHandlers({
    graph: () => graph,
    revision: () => revisions.length,
    assets: () => [],
    history,
    stage: (next) => {
      graph = next
      revisions.push(next)
      return 'staged'
    },
    restore: async (revision) => {
      const stored = revisions[revision - 1]
      if (stored === undefined) return false
      graph = stored
      revisions.push(stored)
      return true
    },
    engine: async () => ({
      dispose() {},
      async apply(current, envelopes) {
        // The host sends one envelope per call, so its stream is always seeded with index 0.
        const outcome = await apply(current, envelopes as CanonicalEnvelope[], media)
        return outcome.status === 'applied'
          ? { status: 'applied', graph: JSON.parse(JSON.stringify(outcome.project)), digest: outcome.digest }
          : outcome
      },
    }),
  })
  const states = [graphDigestOf(graph)]
  const outcomes: HistoryOutcome[] = []
  for (const [index, step] of script.steps.entries()) {
    const envelope: StudioCommandEnvelope =
      'command' in step
        ? (step.command as unknown as StudioCommandEnvelope)
        : ({
            id: 'undo' in step ? 'history.undo' : 'history.redo',
            payload: 'undo' in step ? step.undo : step.redo,
            revision: revisions.length,
            idempotencyKey: `${script.id}:history:${index}`,
            issuedAt: 1_758_800_000_000,
          } as StudioCommandEnvelope)
    const handler = handlers[envelope.id]
    if (!handler) throw new Error(`${script.id}: no handler for ${envelope.id}`)
    let outcome: HistoryOutcome['outcome'] = 'accepted'
    let reason: string | undefined
    try {
      await handler(envelope)
    } catch (error) {
      outcome = 'rejected'
      reason = (error as { reason?: string }).reason ?? 'failed'
    }
    const digest = graphDigestOf(graph)
    states.push(digest)
    outcomes.push({
      outcome,
      ...(reason ? { reason } : {}),
      digest,
      sameAs: states.indexOf(digest),
      depth: { ...history.depth },
    })
  }
  return outcomes
}

function vectors(fixtures: Fixtures): Fixtures['vectors'] {
  return {
    canonicalJson: fixtures.vectors.canonicalJson.map(({ value }) => {
      const canonical = canonicalJson(value)
      return { value, canonical, sha256: sha256(canonical) }
    }),
    uuids: fixtures.vectors.uuids.map(({ seed, count }) => {
      const next = deterministicUuids(seed)
      return { seed, count, uuids: Array.from({ length: count }, () => next()) }
    }),
    frames: fixtures.vectors.frames.map(({ time, rate }) => {
      let frames: number | null
      try {
        frames = secondsToFrames(time, rate)
      } catch {
        frames = null
      }
      return { time, rate, frames }
    }),
    // FL-309: a frame count carried from one frame rate to another by a keep-time retime.
    retime: (fixtures.vectors.retime ?? []).map(({ frame, from, to }) => ({
      frame,
      from,
      to,
      scaled: scaleFrame(frame, frameRatio(from, to)),
    })),
  }
}

async function generate(fixtures: Fixtures): Promise<Fixtures> {
  const next: Fixtures = structuredClone(fixtures)
  next.engine = { name: 'freecut', revision: engineBuild.upstreamCommit }
  for (const [name, base] of Object.entries(next.bases)) {
    Object.assign(base, await buildBase(next, name, base))
  }
  next.vectors = vectors(next)
  for (const entry of next.cases) entry.expect = await runCase(next, entry)
  for (const script of next.history) script.expect = await runHistory(next, script)
  return next
}

const mutating = (catalogue as { commands: Array<{ id: string; mutatesGraph: boolean }> }).commands
  .filter((command) => command.mutatesGraph)
  .map((command) => command.id)
  .sort()

/**
 * Each case is applied three times (the batch, an empty batch, the batch at another time), and
 * FL-307 added several hundred cases. The suite's 30 s default is too tight on a busy runner.
 */
const REPLAY_TIMEOUT = 300_000

/** The drift test's run, kept so that the determinism test replays the fixtures once, not twice. */
let firstRun: Fixtures | undefined

describe('Studio graph protocol v1 conformance (FL-306 to FL-309)', () => {
  it('replays every fixture through the engine without drift', { timeout: REPLAY_TIMEOUT }, async () => {
    const stored = load()
    const generated = await generate(stored)
    firstRun = generated
    if (WRITE) {
      writeFileSync(fixturePath, `${JSON.stringify(generated, null, 2)}\n`)
      return
    }
    for (const entry of stored.cases) expect(entry.expect, `${entry.id} has no recorded answer`).not.toBeNull()
    for (const script of stored.history) expect(script.expect, `${script.id} has no recorded answer`).not.toBeNull()
    expect(generated.engine).toEqual(stored.engine)
    for (const [name, base] of Object.entries(generated.bases)) {
      expect(base.digest, `base ${name}`).toBe(stored.bases[name]!.digest)
      expect(base.graph, `base ${name}`).toEqual(stored.bases[name]!.graph)
    }
    expect(generated.vectors).toEqual(stored.vectors)
    generated.cases.forEach((entry, index) => expect(entry.expect, entry.id).toEqual(stored.cases[index]!.expect))
    // A result outside normal form is declared, never discovered by accident.
    for (const entry of generated.cases) {
      if (entry.expect?.status !== 'applied') continue
      const declared = entry.outsideNormalForm === true || entry.settlesOnLoad === true
      expect(entry.expect.fixedPoint, `${entry.id}: outsideNormalForm or settlesOnLoad`).toBe(!declared)
      // A case that settles reaches normal form with one load, and is never also one to refuse.
      if (entry.settlesOnLoad) {
        expect(entry.outsideNormalForm, `${entry.id}: both marks`).not.toBe(true)
        expect(entry.expect.settled?.fixedPoint, `${entry.id}: settles in one load`).toBe(true)
      }
    }
    generated.history.forEach((script, index) => expect(script.expect, script.id).toEqual(stored.history[index]!.expect))
  })

  it('is deterministic: a second run gives the same answers', { timeout: REPLAY_TIMEOUT }, async () => {
    const stored = load()
    const first = firstRun ?? (await generate(stored))
    const second = await generate(stored)
    expect(canonicalJson(second)).toBe(canonicalJson(first))
  })

  it('cites only commands of the published catalogue, and every case names one', () => {
    const fixtures = load()
    const known = new Set((catalogue as { commands: Array<{ id: string }> }).commands.map((command) => command.id))
    for (const entry of fixtures.cases) {
      expect(entry.covers.length, entry.id).toBeGreaterThan(0)
      for (const id of entry.covers) expect(known.has(id), `${entry.id} covers ${id}`).toBe(true)
      for (const envelope of entry.envelopes) expect(known.has(envelope.id), `${entry.id} sends ${envelope.id}`).toBe(true)
    }
    for (const id of Object.keys(fixtures.commandStatus)) expect(mutating, `commandStatus ${id}`).toContain(id)
  })
})
