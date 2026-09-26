import {
  installSearchShortcuts,
  isSearchShortcut,
  SEARCH_SHORTCUT_EVENT,
  searchShortcutHintKey,
} from '$lib/frameleaf/search-shortcuts';

const press = (init: KeyboardEventInit, target: EventTarget = document.body) => {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
};

describe('search shortcuts', () => {
  let cleanup: () => void;
  let opened: number;
  let reachedBody: number;
  const onOpen = () => opened++;
  const onBody = () => reachedBody++;

  beforeEach(() => {
    opened = 0;
    reachedBody = 0;
    cleanup = installSearchShortcuts(globalThis);
    addEventListener(SEARCH_SHORTCUT_EVENT, onOpen);
    document.body.addEventListener('keydown', onBody);
  });

  afterEach(() => {
    cleanup();
    removeEventListener(SEARCH_SHORTCUT_EVENT, onOpen);
    document.body.removeEventListener('keydown', onBody);
    document.body.replaceChildren();
  });

  it('recognises Ctrl+K, Cmd+K and a bare slash only', () => {
    expect(isSearchShortcut(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))).toBe(true);
    expect(isSearchShortcut(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))).toBe(true);
    expect(isSearchShortcut(new KeyboardEvent('keydown', { key: '/' }))).toBe(true);
    expect(isSearchShortcut(new KeyboardEvent('keydown', { key: 'k' }))).toBe(false);
    expect(isSearchShortcut(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isSearchShortcut(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, shiftKey: true }))).toBe(false);
  });

  it('opens Frameleaf search and keeps the key from the upstream palette on the body', () => {
    const event = press({ key: 'k', ctrlKey: true });
    expect(opened).toBe(1);
    expect(reachedBody).toBe(0);
    expect(event.defaultPrevented).toBe(true);

    press({ key: '/' });
    expect(opened).toBe(2);
    expect(reachedBody).toBe(0);
  });

  it('lets a slash typed in a field through', () => {
    const input = document.createElement('input');
    document.body.append(input);
    press({ key: '/' }, input);
    expect(opened).toBe(0);
    expect(reachedBody).toBe(1);
  });

  it('does not open search over an open dialog, and still never opens the upstream palette', () => {
    const dialog = document.createElement('dialog');
    dialog.setAttribute('open', '');
    document.body.append(dialog);
    const event = press({ key: 'k', metaKey: true });
    expect(opened).toBe(0);
    expect(reachedBody).toBe(0);
    expect(event.defaultPrevented).toBe(false);
  });

  it('passes other keys through', () => {
    press({ key: 'f' });
    expect(opened).toBe(0);
    expect(reachedBody).toBe(1);
  });
});

describe('searchShortcutHintKey (FL-71 CC-7)', () => {
  it('names the platform modifier', () => {
    expect(searchShortcutHintKey(true)).toBe('frameleaf_search_shortcut_hint_mac');
    expect(searchShortcutHintKey(false)).toBe('frameleaf_search_shortcut_hint');
  });
});
