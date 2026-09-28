import type { Translations } from 'svelte-i18n';

/**
 * Command index and ranking for the Frameleaf command palette and the search dialog's
 * "Go to" section (FL-49).
 *
 * Ported from `design/frameleaf/template/src/command-palette.mjs`, which the prototype-to-
 * production plan names as the specification for this behaviour. Everything here is pure:
 * the caller supplies already-translated titles and subtitles and the real destinations,
 * so nothing in this module knows about routes, the SDK or `svelte-i18n`. The live index is
 * assembled in `command-index.ts` from the production APIs.
 *
 * Two deliberate departures from the prototype:
 *
 * - Titles and subtitles arrive translated. The prototype hard-codes English ("Page",
 *   "Settings · …"); production builds those strings from `i18n/en.json` before calling in.
 * - A command carries an explicit `href` or `run` instead of a `payload` the coordinator
 *   re-interprets. The palette must only ever offer destinations that exist, so the caller
 *   proves the destination when it builds the entry.
 */

export const COMMANDS_KEY = 'frameleaf:commands:v1';
export const RECENT_COMMAND_LIMIT = 8;

export type CommandGroupId = 'actions' | 'pages' | 'settings' | 'people' | 'collections' | 'places';

export interface CommandGroup {
  id: CommandGroupId;
  /** Key in `i18n/en.json` for the group heading. */
  labelKey: Translations;
}

/** Canonical group order. Ties in the ranking fall back to it. */
export const commandGroups: readonly CommandGroup[] = Object.freeze([
  { id: 'actions', labelKey: 'frameleaf_search_group_actions' },
  { id: 'pages', labelKey: 'frameleaf_search_group_pages' },
  { id: 'settings', labelKey: 'frameleaf_search_group_settings' },
  { id: 'people', labelKey: 'people' },
  { id: 'collections', labelKey: 'albums' },
  { id: 'places', labelKey: 'places' },
] as const);

const groupOrder = new Map(commandGroups.map((group, index) => [group.id, index]));

/** What choosing a command does. Exactly one of `href` and `run` is set. */
export interface CommandTarget {
  /** An in-app destination, already resolved through `Route`. */
  href?: string;
  /** A side effect the caller owns (toggle the theme, open the upload dialog, …). */
  run?: () => void | Promise<void>;
}

export interface CommandInput extends CommandTarget {
  /** Stable within its group; the full id is namespaced by the group. */
  id: string;
  /** Already translated. */
  title: string;
  /** Already translated; the secondary line. */
  subtitle?: string;
  icon?: string;
  /** Shortcut in the prototype's `mod+shift+p` notation, for display only. */
  shortcut?: string;
  /** Extra already-translated match terms. */
  keywords?: string | string[];
}

export interface CommandItem extends Required<Pick<CommandInput, 'id' | 'title'>>, CommandTarget {
  group: CommandGroupId;
  subtitle: string;
  icon: string;
  shortcut: string;
  keywords: string;
  /** Folded subtitle + keywords, matched on word starts only. */
  haystack: string;
  /** Folded title, matched exactly, by prefix, by word start and fuzzily. */
  folded: string;
}

export interface RankedCommand extends CommandItem {
  score: number;
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const string = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const list = <T>(value: T[] | undefined | null): T[] => (Array.isArray(value) ? value.filter((item) => !!item) : []);

export const foldText = (value: unknown): string =>
  String(value ?? '')
    .normalize('NFKD')
    .replaceAll(/\p{M}/gu, '')
    .toLowerCase();

const words = (value: unknown): string[] =>
  foldText(value)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

const keywordText = (value: CommandInput['keywords']) =>
  Array.isArray(value)
    ? value
        .map((item) => string(item))
        .filter(Boolean)
        .join(' ')
    : string(value);

const DEFAULT_ICONS: Record<CommandGroupId, string> = {
  // Filled in by the caller from `@mdi/js`; a blank icon simply renders no glyph.
  actions: '',
  pages: '',
  settings: '',
  people: '',
  collections: '',
  places: '',
};

const command = (group: CommandGroupId, id: string, input: CommandInput): CommandItem => {
  const subtitle = string(input.subtitle);
  const keywords = keywordText(input.keywords);
  return {
    id,
    group,
    title: input.title.trim(),
    subtitle,
    icon: string(input.icon) || DEFAULT_ICONS[group],
    shortcut: string(input.shortcut),
    keywords,
    href: input.href,
    run: input.run,
    haystack: foldText(`${subtitle} ${keywords}`),
    folded: foldText(input.title),
  };
};

export interface CommandIndexInput {
  actions?: CommandInput[];
  pages?: CommandInput[];
  settings?: CommandInput[];
  people?: CommandInput[];
  collections?: CommandInput[];
  places?: CommandInput[];
}

/**
 * Build the flat command list. Every group is optional, so a palette opened before the
 * people or album requests have answered still ranks pages, settings and actions.
 * Entries without an id or a title are dropped, and the first entry wins a duplicate id.
 */
export const buildCommandIndex = (input: CommandIndexInput = {}): CommandItem[] => {
  const source: CommandIndexInput = record(input) ? input : {};
  const result: CommandItem[] = [];
  const groups: [CommandGroupId, CommandInput[]][] = [
    ['actions', list(source.actions)],
    ['pages', list(source.pages)],
    ['settings', list(source.settings)],
    ['people', list(source.people)],
    ['collections', list(source.collections)],
    ['places', list(source.places)],
  ];

  for (const [group, items] of groups) {
    for (const item of items) {
      const id = string(item.id);
      const title = string(item.title);
      if (!id || !title || (!item.href && !item.run)) {
        continue;
      }
      result.push(command(group, `${group}:${id}`, item));
    }
  }

  const seen = new Set<string>();
  return result.filter((item) => {
    if (seen.has(item.id)) {
      return false;
    }
    seen.add(item.id);
    return true;
  });
};

/* -------------------------------------------------------------------------- */
/* Ranking                                                                     */
/* -------------------------------------------------------------------------- */

/** Scoring tiers. Higher wins; ties fall back to group order and then the title. */
const tiers = {
  exact: 1000,
  prefix: 900,
  wordStart: 800,
  fuzzy: 600,
  keywordPrefix: 500,
  keywordWordStart: 400,
};

/** Every needle character appears in order; tighter runs score higher. */
const subsequenceScore = (haystack: string, needle: string): number => {
  let index = 0;
  let gaps = 0;
  let previous = -1;
  for (const character of needle) {
    const found = haystack.indexOf(character, index);
    if (found === -1) {
      return 0;
    }
    if (previous >= 0) {
      gaps += found - previous - 1;
    }
    previous = found;
    index = found + 1;
  }
  return Math.max(1, 100 - Math.min(99, gaps));
};

const termScore = (item: CommandItem, term: string): number => {
  if (!term) {
    return 0;
  }
  const title = item.folded;
  if (title === term) {
    return tiers.exact;
  }
  if (title.startsWith(term)) {
    return tiers.prefix + Math.max(0, 60 - title.length);
  }
  if (words(title).some((word) => word.startsWith(term))) {
    return tiers.wordStart + Math.max(0, 60 - title.length);
  }
  const fuzzy = subsequenceScore(title, term);
  if (fuzzy) {
    return tiers.fuzzy - 100 + fuzzy;
  }
  const keywords = item.haystack;
  if (!keywords) {
    return 0;
  }
  if (keywords.startsWith(term)) {
    return tiers.keywordPrefix;
  }
  // Keywords and subtitles match on word starts only; fuzzy matching there surfaces too
  // many unrelated commands.
  return words(keywords).some((word) => word.startsWith(term)) ? tiers.keywordWordStart : 0;
};

/** Zero unless every term in the query matches; the result is the mean term score. */
export const scoreCommand = (item: CommandItem, query: string): number => {
  const terms = words(query);
  if (terms.length === 0 || !record(item)) {
    return 0;
  }
  let total = 0;
  for (const term of terms) {
    const score = termScore(item, term);
    if (!score) {
      return 0;
    }
    total += score;
  }
  return Math.round(total / terms.length);
};

const compareCommands = (a: RankedCommand, b: RankedCommand) =>
  b.score - a.score ||
  (groupOrder.get(a.group) ?? 99) - (groupOrder.get(b.group) ?? 99) ||
  a.title.localeCompare(b.title, undefined, { numeric: true });

/** Ranked matches for a query. An empty query returns nothing; callers show recents instead. */
export const searchCommands = (index: CommandItem[], query: string, limit = 12): RankedCommand[] => {
  const items = Array.isArray(index) ? index : [];
  const text = stripCommandPrefix(query);
  if (words(text).length === 0) {
    return [];
  }
  const max = Number.isSafeInteger(limit) && limit > 0 ? limit : 12;
  return items
    .map((item) => ({ ...item, score: scoreCommand(item, text) }))
    .filter((item) => item.score > 0)
    .sort(compareCommands)
    .slice(0, max);
};

export interface CommandGroupResult extends CommandGroup {
  commands: CommandItem[];
}

/** Group ranked commands in the canonical group order, skipping empty groups. */
export const groupCommands = (commands: CommandItem[]): CommandGroupResult[] => {
  const items = Array.isArray(commands) ? commands : [];
  return commandGroups
    .map((group) => ({ ...group, commands: items.filter((item) => item.group === group.id) }))
    .filter((group) => group.commands.length > 0);
};

/** Only groups that make sense as a "Go to" list inside the library search. */
export const navigationCommands = (index: CommandItem[]): CommandItem[] =>
  (Array.isArray(index) ? index : []).filter((item) => ['pages', 'settings', 'actions'].includes(item.group));

export const isCommandQuery = (text: unknown): boolean => /^\s*>/.test(String(text ?? ''));

export const stripCommandPrefix = (text: unknown): string =>
  String(text ?? '')
    .replace(/^\s*>\s*/, '')
    .trim();

/* -------------------------------------------------------------------------- */
/* Recents                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Recent command IDs persist as a bounded string list. They are a browser-local convenience
 * and never a record of what the account can reach: {@link recentCommands} resolves them
 * against the live index, so an id whose destination is gone — a deleted album, a settings
 * area the account may no longer open — simply disappears rather than being offered.
 */
export const parseRecentCommands = (raw: unknown): string[] => {
  let source: unknown = raw;
  if (typeof source === 'string') {
    if (source.length > 20_000) {
      return [];
    }
    try {
      source = JSON.parse(source);
    } catch {
      return [];
    }
  }
  if (!record(source) || source.version !== 1 || !Array.isArray(source.recent)) {
    return [];
  }
  const result: string[] = [];
  for (const id of source.recent.slice(0, RECENT_COMMAND_LIMIT * 2)) {
    if (typeof id !== 'string' || !id || id.length > 200 || result.includes(id)) {
      continue;
    }
    result.push(id);
    if (result.length >= RECENT_COMMAND_LIMIT) {
      break;
    }
  }
  return result;
};

export const rememberCommand = (recent: string[], id: string): string[] => {
  const current = Array.isArray(recent) ? recent : [];
  if (typeof id !== 'string' || !id) {
    return current;
  }
  return [id, ...current.filter((item) => item !== id)].slice(0, RECENT_COMMAND_LIMIT);
};

export const serializeRecentCommands = (recent: string[]): string =>
  JSON.stringify({ version: 1, recent: (Array.isArray(recent) ? recent : []).slice(0, RECENT_COMMAND_LIMIT) });

export const loadRecentCommands = (storage: Pick<Storage, 'getItem'> | null | undefined): string[] => {
  try {
    return parseRecentCommands(storage?.getItem(COMMANDS_KEY));
  } catch {
    return [];
  }
};

export const saveRecentCommands = (storage: Pick<Storage, 'setItem'> | null | undefined, recent: string[]): boolean => {
  try {
    storage?.setItem(COMMANDS_KEY, serializeRecentCommands(recent));
    return true;
  } catch {
    return false;
  }
};

/** Resolve stored IDs against the live index, dropping commands that no longer exist. */
export const recentCommands = (index: CommandItem[], recent: string[]): CommandItem[] => {
  const items = Array.isArray(index) ? index : [];
  return (Array.isArray(recent) ? recent : [])
    .map((id) => items.find((item) => item.id === id))
    .filter((item): item is CommandItem => !!item);
};

/** `"mod+shift+p"` → `["⌘", "⇧", "P"]` on Apple platforms, `["Ctrl", "Shift", "P"]` elsewhere. */
export const shortcutKeys = (shortcut: string | undefined, apple = false): string[] => {
  const parts = string(shortcut).toLowerCase().split('+').filter(Boolean);
  const names: Record<string, string> = {
    mod: apple ? '⌘' : 'Ctrl',
    cmd: apple ? '⌘' : 'Ctrl',
    ctrl: apple ? '⌃' : 'Ctrl',
    shift: apple ? '⇧' : 'Shift',
    alt: apple ? '⌥' : 'Alt',
    enter: '↩',
    escape: 'Esc',
    esc: 'Esc',
    up: '↑',
    down: '↓',
    left: '←',
    right: '→',
    space: 'Space',
  };
  return parts.map((part) => names[part] || part.toUpperCase());
};
