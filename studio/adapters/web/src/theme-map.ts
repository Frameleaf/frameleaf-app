/**
 * Frameleaf's look for the editor, as values for the engine's own CSS variables (FL-1822).
 *
 * The engine styles itself through custom properties (`src/index.css`, `src/features/timeline/theme.css`).
 * Everything a variable reaches is themed here, in the adapter, with no engine patch: surfaces, text,
 * the accent, the timeline's playhead, guides, markers and clip colours, and the corner radius.
 * Classes and literals the engine hard-codes are not reachable from here; they change by patch.
 */
import type { StudioThemeTokens } from '@frameleaf/host/host-contract'

/**
 * Engine variable to host token. `chrome` follows the app's dark theme, as the approved Studio does
 * (`studio.css`: `.fls` on `--fl-canvas`, `--fl-panel`, `--fl-raised`).
 */
const CHROME: Record<string, string> = {
  '--background': '--fl-canvas',
  '--foreground': '--fl-text',
  '--card': '--fl-panel',
  '--card-foreground': '--fl-text',
  '--popover': '--fl-raised',
  '--popover-foreground': '--fl-text',
  '--secondary': '--fl-raised',
  '--secondary-foreground': '--fl-text',
  '--muted': '--fl-raised',
  '--muted-foreground': '--fl-muted',
  '--accent': '--fl-raised',
  '--accent-foreground': '--fl-text',
  '--border': '--fl-border',
  '--input': '--fl-border',
  '--panel-bg': '--fl-panel',
  '--panel-header': '--fl-panel',
  '--timeline-bg': '--fl-canvas',
  '--sidebar': '--fl-panel',
  '--sidebar-foreground': '--fl-text',
  '--sidebar-accent': '--fl-raised',
  '--sidebar-accent-foreground': '--fl-text',
  '--sidebar-border': '--fl-border',
}

/**
 * The same variables on the viewer set. The engine still hard-codes dark classes, so in the light
 * theme its chrome stays on the viewer's dark tokens until those classes are patched out.
 */
const VIEWER_CHROME: Record<string, string> = Object.fromEntries(
  Object.entries(CHROME).map(([engineName, hostName]) => [
    engineName,
    hostName.replace('--fl-canvas', '--fl-viewer-canvas').replace(/^--fl-(panel|raised|text|muted|border)$/, '--fl-viewer-$1'),
  ]),
)

/** The same in both themes: the accent, status colours and the timeline's signals. */
const SIGNALS: Record<string, string> = {
  '--primary': '--fl-accent',
  '--primary-foreground': '--fl-accent-text',
  '--ring': '--fl-accent',
  '--sidebar-primary': '--fl-accent',
  '--sidebar-primary-foreground': '--fl-accent-text',
  '--sidebar-ring': '--fl-accent',
  '--destructive': '--fl-danger',
  '--destructive-foreground': '--fl-danger-text',
  '--color-timeline-playhead': '--fl-accent',
  '--color-timeline-snap': '--fl-accent',
  '--color-timeline-join': '--fl-accent',
  '--color-timeline-marker': '--fl-blue',
  '--color-timeline-in': '--fl-teal',
  '--color-timeline-out': '--fl-danger',
  '--color-timeline-io-handle': '--fl-blue',
  '--color-video-preview-background': '--fl-viewer-canvas',
}

/**
 * Clip colours by kind, from the approved Studio (`studio.css` `--fls-clip-*`, dark). They are not
 * host tokens: the timeline is the only place they are used.
 */
const CLIP_COLOURS: Record<string, string> = {
  '--color-timeline-video': '#2a4d66',
  '--color-timeline-image': '#2f5a4a',
  '--color-timeline-audio': '#1f5a4a',
  '--color-timeline-text': '#4f3f75',
  '--color-timeline-shape': '#34506b',
}

/** Frameleaf's control corner (`--fl-radius-control`); the engine derives its smaller radii from it. */
const RADIUS = '9px'

/** Every engine variable the adapter sets, for the test that no upstream accent is left unmapped. */
export const themedEngineVariables: readonly string[] = [
  ...Object.keys(CHROME),
  ...Object.keys(SIGNALS),
  ...Object.keys(CLIP_COLOURS),
  '--color-timeline-io-range-fill',
  '--color-timeline-io-range-border',
  '--color-timeline-io-range-glow',
  '--radius',
]

/**
 * Values for the engine's variables from the host's theme snapshot. A token the host did not send is
 * left out, so the engine keeps its own value for that variable instead of an empty one.
 */
export function engineThemeVariables(theme: StudioThemeTokens): Record<string, string> {
  const variables: Record<string, string> = { ...CLIP_COLOURS, '--radius': RADIUS }
  const map = { ...(theme.theme === 'dark' ? CHROME : VIEWER_CHROME), ...SIGNALS }
  for (const [engineName, hostName] of Object.entries(map)) {
    const value = theme.tokens[hostName]
    if (value) variables[engineName] = value
  }
  const blue = theme.tokens['--fl-blue']
  if (blue) {
    variables['--color-timeline-io-range-fill'] = `color-mix(in srgb, ${blue} 32%, transparent)`
    variables['--color-timeline-io-range-border'] = `color-mix(in srgb, ${blue} 80%, transparent)`
    variables['--color-timeline-io-range-glow'] = `color-mix(in srgb, ${blue} 24%, transparent)`
  }
  return variables
}
