import { shouldIgnoreEvent } from '$lib/actions/shortcut';
import type { DiscoveryFilterSection } from '$lib/components/discovery/query';
import { isMacPlatform } from '$lib/frameleaf/library-shortcuts';

/**
 * The prototype's search keys (App.jsx keydown handler and `shortcuts.mjs` `focus-search`):
 * Ctrl/Cmd+K opens search (or the settings search on a settings page) and "/" does the same outside
 * a field. They belong to the Frameleaf search entry only.
 *
 * `@immich/ui`'s `commandPaletteManager.enable()` also binds Ctrl/Cmd+K and "/" on `document.body`
 * to open the upstream Immich command palette. The manager has to stay enabled because it
 * dispatches every registered action shortcut (the viewer's F, I, Delete and so on), but its
 * palette is not part of the product. This capture listener on `window` runs before the body
 * handler, stops the key from reaching it and hands it to the search entry instead.
 */
export const SEARCH_SHORTCUT_EVENT = 'frameleaf:search-shortcut';

/**
 * FL-71 CC-7: the search hint names the platform's modifier, as the prototype's "⌘ K"
 * (`CommandCenter.jsx:706`) does on a Mac; elsewhere it reads "Ctrl K". Both work (`isSearchShortcut`).
 */
export const searchShortcutHintKey = (mac = isMacPlatform()) =>
  mac ? 'frameleaf_search_shortcut_hint_mac' : 'frameleaf_search_shortcut_hint';

export const isSearchShortcut = (event: KeyboardEvent): boolean => {
  if (event.altKey || event.shiftKey) {
    return false;
  }
  const key = event.key.toLowerCase();
  if (key === 'k') {
    return event.ctrlKey || event.metaKey;
  }
  if (key === '/') {
    return !event.ctrlKey && !event.metaKey && !shouldIgnoreEvent(event);
  }
  return false;
};

export const installSearchShortcuts = (
  target: Pick<Window, 'addEventListener' | 'removeEventListener' | 'dispatchEvent'> = globalThis,
) => {
  const onKeydown = (event: KeyboardEvent) => {
    if (!isSearchShortcut(event)) {
      return;
    }
    event.stopPropagation();
    // Leave the key alone while a dialog owns the keyboard, as the prototype does.
    if (document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) {
      return;
    }
    event.preventDefault();
    target.dispatchEvent(new CustomEvent(SEARCH_SHORTCUT_EVENT));
  };
  target.addEventListener('keydown', onKeydown, { capture: true });
  return () => target.removeEventListener('keydown', onKeydown, { capture: true });
};

/**
 * The results toolbar's Filter control (prototype `App.jsx` `openFilters`) opens the filter panel at
 * a section. The panel is the search palette's Advanced view (September 24), which the top bar's one
 * search entry owns, so the toolbar asks for it with this event rather than mounting a second panel.
 */
export const FILTER_PANEL_EVENT = 'frameleaf:open-filters';

export type FilterPanelRequest = { section: DiscoveryFilterSection };

export const requestFilterPanel = (
  section: DiscoveryFilterSection,
  target: Pick<Window, 'dispatchEvent'> = globalThis,
) => target.dispatchEvent(new CustomEvent<FilterPanelRequest>(FILTER_PANEL_EVENT, { detail: { section } }));

/** The search entry says whether the filter panel it opened for the toolbar is showing. */
export const FILTER_PANEL_STATE_EVENT = 'frameleaf:filters-state';
/** The toolbar's Filter asks the open filter panel to close (prototype Filter toggles the panel). */
export const FILTER_PANEL_CLOSE_EVENT = 'frameleaf:close-filters';

export type FilterPanelState = { open: boolean };

export const announceFilterPanel = (open: boolean, target: Pick<Window, 'dispatchEvent'> = globalThis) =>
  target.dispatchEvent(new CustomEvent<FilterPanelState>(FILTER_PANEL_STATE_EVENT, { detail: { open } }));

export const requestFilterPanelClose = (target: Pick<Window, 'dispatchEvent'> = globalThis) =>
  target.dispatchEvent(new CustomEvent(FILTER_PANEL_CLOSE_EVENT));
