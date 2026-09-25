import { describe, expect, it } from 'vitest';
import {
  formatShortcutKeys,
  isMacPlatform,
  isTypingTarget,
  libraryShortcutGroups,
  libraryShortcuts,
  matchLibraryShortcut,
  type LibraryShortcut,
} from './library-shortcuts';

const press = (key: string, modifiers: Partial<KeyboardEvent> = {}) =>
  ({
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    repeat: false,
    isComposing: false,
    target: null,
    ...modifiers,
  }) as unknown as KeyboardEvent;

describe('library shortcut table', () => {
  it('has unique ids and a surface for every entry', () => {
    const ids = libraryShortcuts.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of libraryShortcuts) {
      expect(entry.surfaces.length).toBeGreaterThan(0);
      expect(entry.keys.length).toBeGreaterThan(0);
      expect(entry.key ?? entry.mouse).toBeTruthy();
    }
  });

  it('is one map: the timeline and the viewer both read from it', () => {
    const surfaces = new Set(libraryShortcuts.flatMap((entry) => entry.surfaces));
    expect([...surfaces].sort()).toEqual(['timeline', 'viewer']);
    expect(libraryShortcuts.some((entry) => entry.surfaces.length === 2)).toBe(true);
  });
});

describe('matchLibraryShortcut', () => {
  it('matches single letters case-insensitively', () => {
    expect(matchLibraryShortcut(press('f'))?.id).toBe('favorite');
    expect(matchLibraryShortcut(press('F'))?.id).toBe('favorite');
  });

  it('refuses to fire while the user is typing', () => {
    const target = { tagName: 'INPUT', type: 'text' };
    expect(matchLibraryShortcut(press('f', { target } as unknown as Partial<KeyboardEvent>))).toBeNull();
    expect(matchLibraryShortcut(press('f'), { typing: true })).toBeNull();
  });

  it('still fires over checkboxes and other non-text inputs', () => {
    const target = { tagName: 'INPUT', type: 'checkbox' };
    expect(matchLibraryShortcut(press('f', { target } as unknown as Partial<KeyboardEvent>))?.id).toBe('favorite');
  });

  it('ignores composition and auto-repeat unless repeat is allowed', () => {
    expect(matchLibraryShortcut(press('f', { isComposing: true }))).toBeNull();
    expect(matchLibraryShortcut(press('f', { repeat: true }))).toBeNull();
    expect(matchLibraryShortcut(press('f', { repeat: true }), { allowRepeat: true })?.id).toBe('favorite');
  });

  it('distinguishes the modifier variants that share a letter', () => {
    expect(matchLibraryShortcut(press('a'), { surface: 'timeline' })).toBeNull();
    expect(matchLibraryShortcut(press('a', { metaKey: true }))?.id).toBe('select-all');
    expect(matchLibraryShortcut(press('a', { ctrlKey: true }))?.id).toBe('select-all');
    expect(matchLibraryShortcut(press('a', { shiftKey: true }))?.id).toBe('archive');
    expect(matchLibraryShortcut(press('d', { metaKey: true }))?.id).toBe('clear-selection');
    expect(matchLibraryShortcut(press('d', { shiftKey: true }))?.id).toBe('download');
  });

  it('routes a shared key to the right surface', () => {
    expect(matchLibraryShortcut(press('d'), { surface: 'timeline' })?.id).toBe('group-days');
    expect(matchLibraryShortcut(press('d'), { surface: 'viewer' })?.id).toBe('previous-or-next-day');
    expect(matchLibraryShortcut(press(' '), { surface: 'timeline' })).toBeNull();
    expect(matchLibraryShortcut(press(' '), { surface: 'viewer' })?.id).toBe('play-pause');
  });

  it('accepts either delete key and tolerates shift for permanent delete', () => {
    expect(matchLibraryShortcut(press('Delete'))?.id).toBe('delete');
    expect(matchLibraryShortcut(press('Backspace'))?.id).toBe('delete');
    expect(matchLibraryShortcut(press('Delete', { shiftKey: true }))?.id).toBe('delete');
  });

  it('never matches a pointer-only entry from the keyboard', () => {
    const rangeEntry = libraryShortcuts.find((entry) => entry.id === 'select-range') as LibraryShortcut;
    expect(rangeEntry.mouse).toBe(true);
    expect(matchLibraryShortcut(press('Shift'))).toBeNull();
  });

  it('carries the star value for rating keys', () => {
    expect(matchLibraryShortcut(press('3'))?.value).toBe(3);
    expect(matchLibraryShortcut(press('0'))?.value).toBe(0);
  });

  it('rejects keys held with an unlisted modifier', () => {
    expect(matchLibraryShortcut(press('f', { altKey: true }))).toBeNull();
    expect(matchLibraryShortcut(press('f', { metaKey: true }))).toBeNull();
  });
});

describe('isTypingTarget', () => {
  it('recognises text fields and content-editable regions', () => {
    expect(isTypingTarget({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isTypingTarget({ tagName: 'SELECT' })).toBe(true);
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isTypingTarget({ tagName: 'DIV' })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe('help content', () => {
  const translate = (key: string) => `t:${key}`;

  it('renders the platform modifier', () => {
    const entry = libraryShortcuts.find((item) => item.id === 'select-all') as LibraryShortcut;
    expect(formatShortcutKeys(entry, { mac: true })).toEqual(['⌘', 'A']);
    expect(formatShortcutKeys(entry, { mac: false })).toEqual(['Ctrl', 'A']);
    expect(isMacPlatform({ platform: 'MacIntel' })).toBe(true);
    expect(isMacPlatform({ platform: 'Win32', userAgent: 'Windows' })).toBe(false);
    expect(isMacPlatform(null)).toBe(false);
  });

  it('folds duplicate rows away and keeps both groups', () => {
    const groups = libraryShortcutGroups(translate, { mac: false });
    expect(groups.general.length).toBeGreaterThan(0);
    expect(groups.actions.length).toBeGreaterThan(0);
    const ratingRows = groups.actions.filter((row) => row.action === 't:rate_asset');
    expect(ratingRows).toHaveLength(1);
    expect(ratingRows[0].key).toEqual(['1-5']);
    expect(ratingRows[0].info).toBe('t:zero_to_clear_rating');
    expect(groups.general.some((row) => row.key.join('') === '←→')).toBe(true);
  });

  it('lists only the current surface when one is given', () => {
    const timeline = libraryShortcutGroups(translate, { surface: 'timeline', mac: false });
    const viewer = libraryShortcutGroups(translate, { surface: 'viewer', mac: false });
    expect(timeline.general.some((row) => row.action === 't:frameleaf_library_shortcut_group_days')).toBe(true);
    expect(viewer.general.some((row) => row.action === 't:frameleaf_library_shortcut_group_days')).toBe(false);
    expect(viewer.actions.some((row) => row.action === 't:play_or_pause_video')).toBe(true);
    expect(timeline.actions.some((row) => row.action === 't:play_or_pause_video')).toBe(false);
    // The pointer gesture is documented even though no key press can match it.
    expect(timeline.general.some((row) => row.key.includes('Click'))).toBe(true);
  });

  it('uses the timeline wording where a shared key does something else there', () => {
    const timeline = libraryShortcutGroups(translate, { surface: 'timeline', mac: false });
    const viewer = libraryShortcutGroups(translate, { surface: 'viewer', mac: false });
    const arrows = (groups: typeof timeline) => groups.general.find((row) => row.id === 'navigate-previous');
    expect(arrows(timeline)?.action).toBe('t:frameleaf_library_shortcut_move_focus');
    expect(arrows(viewer)?.action).toBe('t:previous_or_next_photo');
    expect(timeline.general.find((row) => row.id === 'go-to-date')?.action).toBe(
      't:frameleaf_library_shortcut_go_to_date',
    );
    // Shift+Delete deletes permanently only in the viewer.
    expect(timeline.actions.find((row) => row.id === 'delete')?.info).toBeUndefined();
    expect(viewer.actions.find((row) => row.id === 'delete')?.info).toBe('t:shift_to_permanent_delete');
  });
});
