import type { Translations } from 'svelte-i18n';

/**
 * The one library key map. Ported for FL-33 from the approved prototype
 * `design/frameleaf/template/src/shortcuts.mjs`, merged with the keys the production viewer and
 * shortcuts modal already document.
 *
 * September 22, 2026 revision: "One shortcut map serves timeline and viewer and is listed in the
 * shortcuts help." Entries therefore declare the surfaces they act on instead of each surface
 * keeping a private table, and the help dialog is generated from this table rather than written
 * out by hand.
 *
 * `key` is compared against `KeyboardEvent.key` (case-insensitively for single characters). `mod`
 * means Cmd on Apple platforms and Ctrl elsewhere. A modifier that is not listed must NOT be held,
 * except where `shift` is `'any'`.
 */
export type LibrarySurface = 'timeline' | 'viewer';
export type LibraryShortcutGroup = 'general' | 'actions';

export type LibraryShortcut = {
  id: string;
  /** The `KeyboardEvent.key` values that trigger this entry. Omitted for pointer-only entries. */
  key?: string | readonly string[];
  /** Pointer gesture documented in the help but never matched from a keyboard event. */
  mouse?: boolean;
  mod?: boolean;
  alt?: boolean;
  shift?: boolean | 'any';
  /** Display keys; `Mod` is substituted per platform. */
  keys: readonly string[];
  /** i18n key for the description shown in the help. */
  label: Translations;
  /** i18n key for the secondary note shown beside the description. */
  info?: Translations;
  group: LibraryShortcutGroup;
  surfaces: readonly LibrarySurface[];
  /** Rating shortcuts carry the star value they apply. */
  value?: number;
  /** Matched, but folded into a sibling row in the help (for example the second arrow key). */
  helpHidden?: boolean;
  /**
   * The timeline's own wording where a shared key does something else there (prototype
   * `shortcuts.mjs`: ← → move focus in the timeline and step photos in the viewer). `info: null`
   * drops a note that only holds in the viewer.
   */
  timeline?: { label?: Translations; info?: Translations | null };
};

const BOTH: readonly LibrarySurface[] = ['timeline', 'viewer'];
const TIMELINE: readonly LibrarySurface[] = ['timeline'];
const VIEWER: readonly LibrarySurface[] = ['viewer'];

export const libraryShortcuts: readonly LibraryShortcut[] = [
  {
    id: 'select',
    key: 'x',
    keys: ['X'],
    label: 'select',
    group: 'general',
    surfaces: BOTH,
    timeline: { label: 'frameleaf_library_shortcut_select_focused' },
  },
  {
    id: 'navigate-previous',
    key: 'ArrowLeft',
    keys: ['←', '→'],
    label: 'previous_or_next_photo',
    group: 'general',
    surfaces: BOTH,
    timeline: { label: 'frameleaf_library_shortcut_move_focus' },
  },
  {
    id: 'navigate-next',
    key: 'ArrowRight',
    keys: ['→'],
    label: 'previous_or_next_photo',
    group: 'general',
    surfaces: BOTH,
    helpHidden: true,
  },
  {
    id: 'focus-up',
    key: 'ArrowUp',
    keys: ['↑', '↓'],
    label: 'frameleaf_library_shortcut_move_focus_row',
    group: 'general',
    surfaces: TIMELINE,
  },
  {
    id: 'focus-down',
    key: 'ArrowDown',
    keys: ['↓'],
    label: 'frameleaf_library_shortcut_move_focus_row',
    group: 'general',
    surfaces: TIMELINE,
    helpHidden: true,
  },
  {
    id: 'select-range',
    mouse: true,
    keys: ['⇧', 'Click'],
    label: 'frameleaf_library_shortcut_select_range',
    group: 'general',
    surfaces: TIMELINE,
  },
  {
    id: 'select-all',
    key: 'a',
    mod: true,
    keys: ['Mod', 'A'],
    label: 'select_all',
    group: 'general',
    surfaces: TIMELINE,
  },
  {
    id: 'clear-selection',
    key: 'd',
    mod: true,
    keys: ['Mod', 'D'],
    label: 'frameleaf_library_shortcut_clear_selection',
    group: 'general',
    surfaces: TIMELINE,
  },
  {
    id: 'group-days',
    key: 'd',
    keys: ['D'],
    label: 'frameleaf_library_shortcut_group_days',
    group: 'general',
    surfaces: TIMELINE,
  },
  {
    id: 'group-months',
    key: 'm',
    keys: ['M'],
    label: 'frameleaf_library_shortcut_group_months',
    group: 'general',
    surfaces: TIMELINE,
  },
  {
    id: 'group-years',
    key: 'y',
    keys: ['Y'],
    label: 'frameleaf_library_shortcut_group_years',
    group: 'general',
    surfaces: TIMELINE,
  },
  {
    id: 'previous-or-next-day',
    key: 'd',
    keys: ['D'],
    label: 'previous_or_next_day',
    group: 'general',
    surfaces: VIEWER,
  },
  {
    id: 'previous-or-next-month',
    key: 'm',
    keys: ['M'],
    label: 'previous_or_next_month',
    group: 'general',
    surfaces: VIEWER,
  },
  {
    id: 'previous-or-next-year',
    key: 'y',
    keys: ['Y'],
    label: 'previous_or_next_year',
    group: 'general',
    surfaces: VIEWER,
  },
  {
    id: 'go-to-date',
    key: 'g',
    keys: ['G'],
    label: 'navigate_to_time',
    group: 'general',
    surfaces: BOTH,
    timeline: { label: 'frameleaf_library_shortcut_go_to_date' },
  },
  { id: 'focus-search', key: '/', keys: ['/'], label: 'search_your_photos', group: 'general', surfaces: BOTH },
  { id: 'close', key: 'Escape', keys: ['Esc'], label: 'back_close_deselect', group: 'general', surfaces: BOTH },
  { id: 'help', key: '?', shift: 'any', keys: ['?'], label: 'keyboard_shortcuts', group: 'general', surfaces: BOTH },

  {
    id: 'rate-1',
    key: '1',
    keys: ['1-5'],
    label: 'rate_asset',
    info: 'zero_to_clear_rating',
    group: 'actions',
    surfaces: BOTH,
    value: 1,
  },
  {
    id: 'rate-2',
    key: '2',
    keys: ['2'],
    label: 'rate_asset',
    group: 'actions',
    surfaces: BOTH,
    value: 2,
    helpHidden: true,
  },
  {
    id: 'rate-3',
    key: '3',
    keys: ['3'],
    label: 'rate_asset',
    group: 'actions',
    surfaces: BOTH,
    value: 3,
    helpHidden: true,
  },
  {
    id: 'rate-4',
    key: '4',
    keys: ['4'],
    label: 'rate_asset',
    group: 'actions',
    surfaces: BOTH,
    value: 4,
    helpHidden: true,
  },
  {
    id: 'rate-5',
    key: '5',
    keys: ['5'],
    label: 'rate_asset',
    group: 'actions',
    surfaces: BOTH,
    value: 5,
    helpHidden: true,
  },
  {
    id: 'rate-clear',
    key: '0',
    keys: ['0'],
    label: 'rate_asset',
    group: 'actions',
    surfaces: BOTH,
    value: 0,
    helpHidden: true,
  },
  { id: 'favorite', key: 'f', keys: ['F'], label: 'favorite_or_unfavorite_photo', group: 'actions', surfaces: BOTH },
  { id: 'info', key: 'i', keys: ['I'], label: 'show_or_hide_info', group: 'actions', surfaces: BOTH },
  { id: 'edit', key: 'e', keys: ['E'], label: 'edit', group: 'actions', surfaces: BOTH },
  { id: 'stack', key: 's', keys: ['S'], label: 'stack_selected_photos', group: 'actions', surfaces: BOTH },
  { id: 'add-to-album', key: 'l', keys: ['L'], label: 'add_to_album', group: 'actions', surfaces: BOTH },
  { id: 'tag', key: 't', keys: ['T'], label: 'tag_assets', group: 'actions', surfaces: BOTH },
  { id: 'tag-people', key: 'p', keys: ['P'], label: 'tag_people', group: 'actions', surfaces: BOTH },
  {
    id: 'archive',
    key: 'a',
    shift: true,
    keys: ['⇧', 'A'],
    label: 'archive_or_unarchive_photo',
    group: 'actions',
    surfaces: BOTH,
  },
  { id: 'download', key: 'd', shift: true, keys: ['⇧', 'D'], label: 'download', group: 'actions', surfaces: BOTH },
  { id: 'play-pause', key: ' ', keys: ['Space'], label: 'play_or_pause_video', group: 'actions', surfaces: VIEWER },
  {
    id: 'delete',
    key: ['Delete', 'Backspace'],
    shift: 'any',
    keys: ['Del'],
    label: 'trash_delete_asset',
    info: 'shift_to_permanent_delete',
    group: 'actions',
    surfaces: BOTH,
    // In the timeline Delete moves the focused item or the selection to the trash; Shift adds nothing.
    timeline: { info: null },
  },
];

const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
const NON_TEXT_INPUT_TYPES = new Set(['checkbox', 'radio', 'button', 'submit', 'range']);

/** True when key presses belong to a text field, so shortcuts must stay quiet. */
export const isTypingTarget = (target: unknown): boolean => {
  if (!target || typeof target !== 'object') {
    return false;
  }
  const element = target as { tagName?: unknown; type?: unknown; isContentEditable?: unknown };
  const tag = String(element.tagName ?? '').toUpperCase();
  if (TYPING_TAGS.has(tag)) {
    const type = String(element.type ?? '').toLowerCase();
    return !(tag === 'INPUT' && NON_TEXT_INPUT_TYPES.has(type));
  }
  return Boolean(element.isContentEditable);
};

const keyMatches = (entryKey: LibraryShortcut['key'], eventKey: string) => {
  const wanted = typeof entryKey === 'string' ? [entryKey] : (entryKey ?? []);
  return wanted.some((key) => (key.length === 1 ? key.toLowerCase() === eventKey.toLowerCase() : key === eventKey));
};

export type MatchShortcutOptions = {
  /** Only consider entries acting on this surface. */
  surface?: LibrarySurface;
  /** Override the typing test, for callers that already know the focus context. */
  typing?: boolean;
  allowRepeat?: boolean;
  table?: readonly LibraryShortcut[];
};

/** The shortcut an event triggers, or null. Typing contexts never match. */
export const matchLibraryShortcut = (
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'> &
    Partial<Pick<KeyboardEvent, 'isComposing' | 'repeat' | 'target'>>,
  options: MatchShortcutOptions = {},
): LibraryShortcut | null => {
  if (!event || typeof event.key !== 'string' || event.isComposing) {
    return null;
  }
  if (event.repeat && !options.allowRepeat) {
    return null;
  }
  const typing = typeof options.typing === 'boolean' ? options.typing : isTypingTarget(event.target);
  if (typing) {
    return null;
  }
  const mod = event.metaKey || event.ctrlKey;
  const shift = event.shiftKey;
  const alt = event.altKey;
  for (const entry of options.table ?? libraryShortcuts) {
    if (entry.mouse || !entry.key) {
      continue;
    }
    if (options.surface && !entry.surfaces.includes(options.surface)) {
      continue;
    }
    if (!keyMatches(entry.key, event.key)) {
      continue;
    }
    if (Boolean(entry.mod) !== mod || Boolean(entry.alt) !== alt) {
      continue;
    }
    if (entry.shift !== 'any' && Boolean(entry.shift) !== shift) {
      continue;
    }
    return entry;
  }
  return null;
};

/** True on Apple platforms, where Mod renders as ⌘. */
export const isMacPlatform = (nav: { platform?: string; userAgent?: string } | null | undefined = navigator) =>
  /Mac|iPhone|iPad|iPod/i.test(`${nav?.platform ?? ''} ${nav?.userAgent ?? ''}`);

/** Display keys for an entry, substituting the platform modifier. */
export const formatShortcutKeys = (entry: LibraryShortcut, { mac = isMacPlatform() }: { mac?: boolean } = {}) =>
  entry.keys.map((key) => (key === 'Mod' ? (mac ? '⌘' : 'Ctrl') : key));

export type ShortcutHelpEntry = { id: string; key: string[]; action: string; info?: string };
export type ShortcutHelpGroups = { general: ShortcutHelpEntry[]; actions: ShortcutHelpEntry[] };

/**
 * The help content, grouped as the shortcuts sheet lists it (prototype `shortcutGroups`).
 * `translate` is the caller's `$t`, so the table stays free of display strings.
 */
export const libraryShortcutGroups = (
  translate: (key: Translations) => string,
  {
    surface,
    mac = isMacPlatform(),
    table = libraryShortcuts,
  }: { surface?: LibrarySurface; mac?: boolean; table?: readonly LibraryShortcut[] } = {},
): ShortcutHelpGroups => {
  const groups: ShortcutHelpGroups = { general: [], actions: [] };
  for (const entry of table) {
    if (entry.helpHidden || (surface && !entry.surfaces.includes(surface))) {
      continue;
    }
    const override = surface === 'timeline' ? entry.timeline : undefined;
    const label = override?.label ?? entry.label;
    const info = override && 'info' in override ? override.info : entry.info;
    groups[entry.group].push({
      id: entry.id,
      key: formatShortcutKeys(entry, { mac }),
      action: translate(label),
      ...(info && { info: translate(info) }),
    });
  }
  return groups;
};
