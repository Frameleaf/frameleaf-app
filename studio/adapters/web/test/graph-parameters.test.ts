import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vite-plus/test'
import { GPU_EFFECT_REGISTRY } from '@/infrastructure/gpu-effects'
import { transitionRegistry } from '@/shared/timeline/transitions/registry'
import '@/shared/timeline/transitions'
import { BLEND_MODE_GROUPS, BLEND_MODE_INDEX } from '@/types/blend-modes'
import { DEFAULT_BEZIER_POINTS, DEFAULT_SPRING_PARAMS } from '@/types/keyframe'
import {
  TEXT_MOTION_IN_PRESET_IDS,
  TEXT_MOTION_LOOP_PRESET_IDS,
  TEXT_MOTION_OUT_PRESET_IDS,
} from '@/shared/typography/text-motion/text-motion-preset-ids'
import {
  canonicalJson,
  EASINGS,
  MODIFIER_TYPES,
  prototypeTransitions,
  transitionPresentationOf,
} from '../src/canonical-commands'

/**
 * FL-308 (NAPI-019): the Studio graph protocol's parameter catalogue, generated from the engine's
 * own registries. `studio/graph-parameters-v1.json` lists every effect, transition and blend mode a
 * graph may name, with each parameter's name, type, range, options and default. This test rebuilds
 * the catalogue from the registries of the prepared engine and fails on any difference, so the
 * catalogue the native apps read cannot drift from the engine.
 *
 *   GRAPH_PARAMETERS_WRITE=1 node studio/tools/adapter.mjs test   # regenerate the catalogue
 *
 * Clean room: the catalogue carries ids, parameter names, types, numbers and option values. It
 * carries no engine source text: no shader, no display label and no description.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const cataloguePath = path.resolve(here, '../../../graph-parameters-v1.json')
const engineBuild = JSON.parse(readFileSync(path.resolve(here, '../../../engine-build.json'), 'utf8')) as {
  upstreamCommit: string
}
const WRITE = process.env.GRAPH_PARAMETERS_WRITE === '1'

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

/** Keys with no value are left out, so the catalogue never says `null` for "not declared". */
const compact = <T extends Record<string, unknown>>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T

/**
 * Graph fields that no engine command writes at this revision, and the catalogue command (when
 * there is one) that the engine refuses as not-implemented. The protocol's section 13.8 gives the
 * rule for each; this list is what a tool can check a native edit against.
 */
const DIRECT_EDITS = [
  {
    id: 'effect-parameters',
    command: 'effect.update',
    fields: ['timeline.items[].effects[].effect.params'],
    section: '13.8.1',
  },
  { id: 'effect-order', command: 'effect.reorder', fields: ['timeline.items[].effects'], section: '13.8.2' },
  { id: 'effect-enabled', command: null, fields: ['timeline.items[].effects[].enabled'], section: '13.8.3' },
  { id: 'blend-mode', command: 'clip.setBlendMode', fields: ['timeline.items[].blendMode'], section: '13.8.4' },
  {
    id: 'transition-settings',
    command: null,
    fields: [
      'timeline.transitions[].direction',
      'timeline.transitions[].timing',
      'timeline.transitions[].bezierPoints',
      'timeline.transitions[].properties',
    ],
    section: '13.8.5',
  },
] as const

function build() {
  const effects = [...GPU_EFFECT_REGISTRY.values()].map((effect) =>
    compact({
      id: effect.id,
      category: effect.category,
      // The effect animates on its own clock (13.2.2): its look depends on the frame.
      temporal: effect.temporal === true ? true : undefined,
      parameters: Object.entries(effect.params).map(([name, param]) =>
        compact({
          name,
          type: param.type,
          default: param.default,
          min: param.min,
          max: param.max,
          step: param.step,
          options: param.options?.map((option) => option.value),
          animatable: param.animatable === true,
        }),
      ),
    }),
  )

  const transitions = transitionRegistry.getIds().map((id) => {
    const definition = transitionRegistry.getDefinition(id)!
    return compact({
      id,
      category: definition.category,
      directions: definition.hasDirection ? [...(definition.directions ?? [])] : undefined,
      timings: [...definition.supportedTimings],
      // What the editor offers. `clip.setTransition` does not enforce this range (13.4.1).
      editorDuration: {
        default: definition.defaultDuration,
        min: definition.minDuration,
        max: definition.maxDuration,
      },
      parameters: (definition.parameters ?? []).map((parameter) =>
        compact({
          name: parameter.key,
          type: parameter.type,
          default: parameter.defaultValue,
          min: parameter.min,
          max: parameter.max,
          step: parameter.step,
          unit: parameter.unit,
          valueFormat: parameter.valueFormat,
        }),
      ),
    })
  })

  // Every alias must still name a registered presentation.
  const transitionAliases = Object.fromEntries(
    Object.keys(prototypeTransitions).map((alias) => [alias, transitionPresentationOf(alias)]),
  )

  const groupOf = new Map(BLEND_MODE_GROUPS.flatMap((group) => group.modes.map((mode) => [mode, group.label.toLowerCase()])))
  const blendModes = Object.entries(BLEND_MODE_INDEX)
    .sort(([, a], [, b]) => a - b)
    .map(([id, index]) => ({ id, index, group: groupOf.get(id as never) ?? null }))

  const catalogue = {
    format: 'frameleaf-studio-graph-parameters',
    version: 1,
    protocol: 'docs/docs/developer/studio-graph-protocol-v1.md',
    engine: { name: 'freecut', revision: engineBuild.upstreamCommit },
    generatedBy: 'studio/adapters/web/test/graph-parameters.test.ts (the engine registries; never edit by hand)',
    regenerate: 'GRAPH_PARAMETERS_WRITE=1 node studio/tools/adapter.mjs test',
    counts: { effects: effects.length, transitions: transitions.length, blendModes: blendModes.length },
    effects,
    transitions,
    transitionAliases,
    blendModes,
    easing: {
      types: [...EASINGS],
      bezierDefault: { ...DEFAULT_BEZIER_POINTS },
      springDefault: { ...DEFAULT_SPRING_PARAMS },
    },
    motionModifiers: { types: [...MODIFIER_TYPES] },
    textMotion: {
      in: [...TEXT_MOTION_IN_PRESET_IDS],
      out: [...TEXT_MOTION_OUT_PRESET_IDS],
      loop: [...TEXT_MOTION_LOOP_PRESET_IDS],
    },
    directEdits: DIRECT_EDITS.map((entry) => ({ ...entry, fields: [...entry.fields] })),
  }
  // The digest of everything above, so a hand edit is caught where the engine is not built.
  return { ...catalogue, contentSha256: sha256(canonicalJson(catalogue)) }
}

describe('Studio graph protocol v1 parameter catalogue (FL-308)', () => {
  it('matches the engine registries', () => {
    const generated = JSON.parse(JSON.stringify(build()))
    if (WRITE) {
      writeFileSync(cataloguePath, `${JSON.stringify(generated, null, 2)}\n`)
      return
    }
    const stored = JSON.parse(readFileSync(cataloguePath, 'utf8'))
    expect(generated.counts, 'registry sizes').toEqual(stored.counts)
    for (const kind of ['effects', 'transitions', 'blendModes'] as const) {
      const storedById = new Map((stored[kind] as Array<{ id: string }>).map((entry) => [entry.id, entry]))
      expect(generated[kind].map((entry: { id: string }) => entry.id), `${kind}: ids and order`).toEqual(
        stored[kind].map((entry: { id: string }) => entry.id),
      )
      for (const entry of generated[kind] as Array<{ id: string }>) {
        expect(entry, `${kind} ${entry.id}`).toEqual(storedById.get(entry.id))
      }
    }
    expect(generated).toEqual(stored)
  })

  it('is deterministic: a second build gives the same catalogue', () => {
    expect(canonicalJson(build())).toBe(canonicalJson(build()))
  })

  it('carries no engine text: no labels, descriptions or shader source', () => {
    const text = JSON.stringify(build())
    for (const key of ['"label"', '"description"', '"shader"', '"icon"', '"entryPoint"']) {
      expect(text.includes(key), key).toBe(false)
    }
  })
})
