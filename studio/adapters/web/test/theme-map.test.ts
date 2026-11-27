import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vite-plus/test'
import { studioThemeTokenNames } from '@frameleaf/host/theme'
import { engineThemeVariables, themedEngineVariables } from '../src/theme-map'
import brand from '../../../../web/src/lib/frameleaf/brand-tokens.json'

// The adapter's tests run from the prepared engine workspace (`studio/tools/adapter.mjs`).
const engineCss = ['src/index.css', 'src/features/timeline/theme.css'].map((file) => readFileSync(file, 'utf8')).join('\n')

/** The upstream accent as the engine writes it: oklch hue 45 at chroma 0.19, or Tailwind's orange. */
const UPSTREAM_ACCENT = /^\s*(--[\w-]+):\s*(?:oklch\(0\.68 0\.19 45\)|#f97316|#fb923c)/gm

const tokens = (theme: 'dark' | 'light') => ({
  theme,
  tokens: Object.fromEntries(studioThemeTokenNames.map((name) => [name, `value-of(${name})`])),
})

describe('FL-1822 the engine wears Frameleaf tokens', () => {
  it('leaves no engine variable on the upstream accent', () => {
    const upstream = [...engineCss.matchAll(UPSTREAM_ACCENT)].map((match) => match[1])
    expect(upstream.length).toBeGreaterThan(5)
    expect(upstream.filter((name) => !themedEngineVariables.includes(name))).toEqual([])
  })

  it('sets every themed variable when the host sends its whole token list', () => {
    for (const theme of ['dark', 'light'] as const) {
      const variables = engineThemeVariables(tokens(theme))
      expect(Object.keys(variables).toSorted()).toEqual([...themedEngineVariables].toSorted())
    }
  })

  it("takes the host's live accent and signals in the dark theme", () => {
    const variables = engineThemeVariables(tokens('dark'))
    expect(variables['--primary']).toBe('value-of(--fl-accent)')
    expect(variables['--color-timeline-playhead']).toBe('value-of(--fl-accent)')
  })

  it('keeps the dark accent and signals in the light theme, where the chrome is still dark', () => {
    // The light set is chosen to read on white; on the dark chrome it falls under 4.5:1.
    const variables = engineThemeVariables(tokens('light'))
    expect(variables['--primary']).toBe(brand.color.dark.accent)
    expect(variables['--ring']).toBe(brand.color.dark.accent)
    expect(variables['--destructive']).toBe(brand.color.dark.danger)
    expect(variables['--color-timeline-marker']).toBe(brand.color.dark.blue)
    expect(variables['--color-timeline-in']).toBe(brand.color.dark.teal)
    expect(variables['--color-timeline-io-range-fill']).toContain(brand.color.dark.blue)
    for (const value of Object.values(variables)) expect(value).not.toMatch(/value-of\(--fl-(?!viewer-)/)
  })

  it('follows the app in the dark theme and stays on the viewer set in the light one', () => {
    expect(engineThemeVariables(tokens('dark'))['--card']).toBe('value-of(--fl-panel)')
    expect(engineThemeVariables(tokens('light'))['--card']).toBe('value-of(--fl-viewer-panel)')
    expect(engineThemeVariables(tokens('light'))['--background']).toBe('value-of(--fl-viewer-canvas)')
  })

  it('leaves a variable alone when the host did not send its token', () => {
    const variables = engineThemeVariables({ theme: 'dark', tokens: { '--fl-accent': '#22c55e' } })
    expect(variables['--primary']).toBe('#22c55e')
    expect('--card' in variables).toBe(false)
    expect('--color-timeline-io-range-fill' in variables).toBe(false)
  })
})
