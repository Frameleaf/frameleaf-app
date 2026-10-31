/**
 * The theme snapshot the host hands the engine (FL-88).
 *
 * React and Svelte must not share a global CSS scope, so the engine does not import
 * `tokens.css` and does not read the host's stylesheet. The host reads the resolved values
 * once per theme change from its own `.frameleaf` element and passes them across as data;
 * the engine writes them onto its own root inside its own subtree.
 *
 * The token list is the contract. It is spelled out rather than discovered by walking the
 * stylesheet so that adding a token to `tokens.css` does not silently change what the
 * editor is given, and so the list can be read against
 * `design/frameleaf/template/src/studio.css`.
 */
import type { StudioThemeTokens } from './host-contract';

export const studioThemeTokenNames = [
  '--fl-accent',
  '--fl-accent-text',
  '--fl-blue',
  '--fl-blue-text',
  '--fl-border',
  '--fl-canvas',
  '--fl-danger',
  '--fl-danger-text',
  '--fl-muted',
  '--fl-panel',
  '--fl-raised',
  '--fl-shadow-1',
  '--fl-shadow-2',
  '--fl-teal',
  '--fl-teal-text',
  '--fl-text',
  '--fl-warning',
  '--fl-warning-text',
  // The editor's monitor is viewer chrome: a frame is judged against a neutral dark
  // surround in both themes, exactly as the asset viewer does.
  '--fl-viewer-border',
  '--fl-viewer-canvas',
  '--fl-viewer-focus',
  '--fl-viewer-muted',
  '--fl-viewer-panel',
  '--fl-viewer-raised',
  '--fl-viewer-text',
] as const;

/**
 * Read the listed tokens from `element`. Missing tokens are omitted rather than defaulted,
 * so an engine can tell "not themed yet" from "themed to an empty value" and fall back to
 * its own neutral styling instead of rendering invisible text.
 */
export const readStudioThemeTokens = (theme: 'dark' | 'light', element: Element | null): StudioThemeTokens => {
  const tokens: Record<string, string> = {};

  if (element && typeof getComputedStyle === 'function') {
    const computed = getComputedStyle(element);
    for (const name of studioThemeTokenNames) {
      const value = computed.getPropertyValue(name).trim();
      if (value) {
        tokens[name] = value;
      }
    }
  }

  return { theme, tokens };
};
