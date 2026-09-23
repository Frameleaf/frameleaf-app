import { shouldIgnoreEvent } from '$lib/actions/shortcut';

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
