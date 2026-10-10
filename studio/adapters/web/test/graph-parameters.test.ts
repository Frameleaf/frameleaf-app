import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vite-plus/test'
import { GPU_EFFECT_REGISTRY } from '@/infrastructure/gpu-effects'
import { transitionRegistry } from '@/shared/timeline/transitions/registry'
import '@/shared/timeline/transitions'
import { BLEND_MODE_GROUPS, BLEND_MODE_INDEX } from '@/types/blend-modes'
import {
  DEFAULT_BEZIER_POINTS,
  DEFAULT_SPRING_PARAMS,
  PROPERTY_LABELS,
  isDirectLinkableProperty,
  isVectorAnimatableProperty,
} from '@/types/keyframe'
import { getActiveMotionModifierChannels } from '@/features/keyframes/utils/motion-modifier-eval'
import {
  TEXT_MOTION_IN_PRESET_IDS,
  TEXT_MOTION_LOOP_PRESET_IDS,
  TEXT_MOTION_OUT_PRESET_IDS,
} from '@/shared/typography/text-motion/text-motion-preset-ids'
import { createTextMotionEffect } from '@/shared/typography/text-motion/text-motion-presets'
import { TEXT_STYLE_PRESET_IDS } from '@/shared/typography/text-style-preset-ids'
import { buildTextScale, buildTextStylePresetUpdates } from '@/shared/typography/text-style-presets'
import { DEFAULT_TEXT_FONT_FAMILY, FONT_CATALOG } from '@/shared/typography/font-catalog'
import { PROJECT_TEMPLATES } from '@/features/projects/utils/validation'
import { isAllowedProjectFps } from '@/features/projects/utils/project-fps'
import {
  canonicalJson,
  EASINGS,
  MODIFIER_TYPES,
  prototypeTitleAnimations,
  prototypeTitleStyles,
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

/** Every canvas height `sequence.setSettings` accepts (14.6.1). */
const CANVAS_HEIGHTS = Array.from({ length: 4320 - 240 + 1 }, (_, index) => 240 + index)
const canvasOf = (height: number, width = 1920) => ({ width, height, fps: 30 })
const SIZE_TOKENS = ['title', 'display', 'badge'] as const

/**
 * FL-309: the title styles as rules a native client can compute. The engine sizes a title's font
 * from the canvas height through three size steps; everything else a style writes is constant. The
 * steps and each style's step and multiplier are measured from the engine over every canvas height
 * and must reproduce it exactly, so a change to a style or to the size steps changes the catalogue.
 */
function titleStyles() {
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
  const stepAt = (token: (typeof SIZE_TOKENS)[number], height: number) => buildTextScale(canvasOf(height)).sizes[token]
  const sizes = Object.fromEntries(
    SIZE_TOKENS.map((token) => {
      const min = Math.min(...CANVAS_HEIGHTS.map((height) => stepAt(token, height)))
      const max = Math.max(...CANVAS_HEIGHTS.map((height) => stepAt(token, height)))
      const fits = Array.from({ length: 999 }, (_, index) => (index + 1) / 1000).filter((factor) =>
        CANVAS_HEIGHTS.every((height) => clamp(Math.round(height * factor), min, max) === stepAt(token, height)),
      )
      if (fits.length !== 1) throw new Error(`title size step ${token}: ${fits.length} factors fit`)
      return [token, { heightFactor: fits[0]!, min, max }]
    }),
  ) as Record<(typeof SIZE_TOKENS)[number], { heightFactor: number; min: number; max: number }>

  const presets = TEXT_STYLE_PRESET_IDS.map((id) => {
    const at = (height: number, width?: number) =>
      JSON.parse(JSON.stringify(buildTextStylePresetUpdates(id, canvasOf(height, width)))) as Record<string, unknown>
    const { fontSize: _fontSize, ...fields } = at(1080)
    // Only the font size follows the canvas, and only its height.
    for (const [height, width] of [[240, 320], [1080, 1080], [2160, 3840], [4320, 7680]] as const) {
      const { fontSize: _size, ...other } = at(height, width)
      if (canonicalJson(other) !== canonicalJson(fields)) throw new Error(`title style ${id} depends on the canvas`)
      if (at(height, width).fontSize !== at(height).fontSize) throw new Error(`title style ${id} depends on the canvas width`)
    }
    const candidates = SIZE_TOKENS.flatMap((size) =>
      Array.from({ length: 2000 }, (_, index) => (index + 1) / 1000).map((multiplier) => ({ size, multiplier })),
    ).filter(({ size, multiplier }) =>
      CANVAS_HEIGHTS.every((height) => Math.round(stepAt(size, height) * multiplier) === at(height).fontSize),
    )
    if (candidates.length === 0) throw new Error(`title style ${id}: no size rule fits`)
    // Several rules may give the same sizes; the one nearest a multiplier of 1 is published.
    const [fontSize] = candidates.sort((a, b) => Math.abs(a.multiplier - 1) - Math.abs(b.multiplier - 1))
    return { id, fontSize: fontSize!, fields }
  })
  return { aliases: { ...prototypeTitleStyles }, sizes, presets }
}

function build() {
  const effects =[...GPU_EFFECT_REGISTRY.values()].map((effect) =>
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

  const scalarProperties = Object.keys(PROPERTY_LABELS)
  const vectorProperties = ['position', 'scale', 'anchor'].filter((property) => isVectorAnimatableProperty(property))

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
    // The properties keyframes, expressions and modifiers name (13.2.5).
    properties: {
      scalar: scalarProperties,
      vector: vectorProperties,
      expression: [...scalarProperties, ...vectorProperties].filter((property) => isDirectLinkableProperty(property)),
    },
    // Each modifier type with the channels it drives when every gain is at its default of 1.
    motionModifiers: MODIFIER_TYPES.map((type) => ({
      id: type,
      channels: getActiveMotionModifierChannels({
        id: type,
        type,
        enabled: true,
        amplitude: 1,
        frequency: 1,
        phaseFrames: 0,
        seed: 1,
      }),
    })),
    textMotion: {
      in: [...TEXT_MOTION_IN_PRESET_IDS],
      out: [...TEXT_MOTION_OUT_PRESET_IDS],
      loop: [...TEXT_MOTION_LOOP_PRESET_IDS],
      // FL-309: what a title animation writes for each preset (14.3.1), with seed 0.
      defaults: Object.fromEntries(
        [...TEXT_MOTION_IN_PRESET_IDS, ...TEXT_MOTION_OUT_PRESET_IDS, ...TEXT_MOTION_LOOP_PRESET_IDS].map((id) => {
          const { presetId: _presetId, seed: _seed, ...defaults } = createTextMotionEffect(id, 0)
          return [id, defaults]
        }),
      ),
    },
    // FL-309: title styles and animations (14.3.1), and project templates and rates (14.6).
    titleStyles: titleStyles(),
    // The font families a title may name (14.3.4, 14.3.5): the engine's font catalogue, with the
    // weights each family has. A family not listed here never resolves.
    fonts: {
      default: DEFAULT_TEXT_FONT_FAMILY,
      families: FONT_CATALOG.map((font) => ({ family: font.value, weights: [...font.weights] })),
    },
    titleAnimations: { aliases: Object.fromEntries(Object.entries(prototypeTitleAnimations).map(([alias, slots]) => [alias, { ...slots }])) },
    project: {
      templates: PROJECT_TEMPLATES.map((template) => ({
        id: template.id,
        width: template.width,
        height: template.height,
        fps: template.fps,
      })),
      rates: Array.from({ length: 240 }, (_, index) => index + 1).filter((fps) => isAllowedProjectFps(fps)),
      ntscRates: [24_000, 30_000, 48_000, 60_000, 120_000]
        .filter((num) => isAllowedProjectFps(num / 1000))
        .map((num) => ({ num, den: 1001 })),
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
