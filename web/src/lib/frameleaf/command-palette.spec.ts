import {
  buildCommandIndex,
  COMMANDS_KEY,
  commandGroups,
  foldText,
  groupCommands,
  isCommandQuery,
  loadRecentCommands,
  navigationCommands,
  parseRecentCommands,
  RECENT_COMMAND_LIMIT,
  recentCommands,
  rememberCommand,
  saveRecentCommands,
  scoreCommand,
  searchCommands,
  serializeRecentCommands,
  shortcutKeys,
  stripCommandPrefix,
  type CommandItem,
} from '$lib/frameleaf/command-palette';

const index = () =>
  buildCommandIndex({
    actions: [{ id: 'theme', title: 'Theme', run: () => {} }],
    pages: [
      { id: 'photos', title: 'Photos', subtitle: 'Page', href: '/photos' },
      { id: 'places', title: 'Places', subtitle: 'Page', href: '/places' },
    ],
    settings: [
      { id: 'app', title: 'App settings', subtitle: 'Settings', keywords: ['manage the app'], href: '/user-settings' },
    ],
    people: [{ id: 'p1', title: 'Ada Lovelace', href: '/people/p1' }],
    collections: [{ id: 'a1', title: 'Iceland 2026', href: '/albums/a1' }],
    places: [{ id: 'city:Banff', title: 'Banff', href: '/search' }],
  });

const find = (items: CommandItem[], id: string) => items.find((item) => item.id === id) as CommandItem;

describe('buildCommandIndex', () => {
  it('namespaces ids by group and keeps every supplied group', () => {
    const items = index();
    expect(items.map((item) => item.id)).toEqual([
      'actions:theme',
      'pages:photos',
      'pages:places',
      'settings:app',
      'people:p1',
      'collections:a1',
      'places:city:Banff',
    ]);
  });

  it('drops entries without an id, a title or a destination', () => {
    const items = buildCommandIndex({
      pages: [
        { id: '', title: 'No id', href: '/a' },
        { id: 'b', title: '', href: '/b' },
        // A command with neither an href nor a run would be an offer the palette cannot honour.
        { id: 'c', title: 'No destination' },
        { id: 'd', title: 'Fine', href: '/d' },
      ],
    });
    expect(items.map((item) => item.title)).toEqual(['Fine']);
  });

  it('keeps the first of two entries sharing an id', () => {
    const items = buildCommandIndex({
      pages: [
        { id: 'x', title: 'First', href: '/first' },
        { id: 'x', title: 'Second', href: '/second' },
      ],
    });
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('First');
  });

  it('tolerates an empty input', () => {
    expect(buildCommandIndex()).toEqual([]);
    expect(buildCommandIndex({})).toEqual([]);
  });
});

describe('scoreCommand', () => {
  it('ranks an exact title above a prefix, a word start and a fuzzy match', () => {
    const items = index();
    const photos = find(items, 'pages:photos');
    expect(scoreCommand(photos, 'photos')).toBeGreaterThan(scoreCommand(photos, 'phot'));
    expect(scoreCommand(photos, 'phot')).toBeGreaterThan(scoreCommand(photos, 'pts'));
  });

  it('requires every term to match', () => {
    const app = find(index(), 'settings:app');
    expect(scoreCommand(app, 'app settings')).toBeGreaterThan(0);
    expect(scoreCommand(app, 'app nonsense')).toBe(0);
  });

  it('matches keywords on word starts but not fuzzily', () => {
    const app = find(index(), 'settings:app');
    expect(scoreCommand(app, 'manage')).toBeGreaterThan(0);
    expect(scoreCommand(app, 'mnge')).toBe(0);
  });

  it('scores nothing for an empty query', () => {
    expect(scoreCommand(find(index(), 'pages:photos'), ' '.repeat(3))).toBe(0);
  });

  it('folds diacritics and case', () => {
    const [item] = buildCommandIndex({ pages: [{ id: 'z', title: 'Zürich', href: '/z' }] });
    expect(scoreCommand(item, 'zurich')).toBeGreaterThan(0);
    expect(foldText('Zürich')).toBe('zurich');
  });
});

describe('searchCommands', () => {
  it('returns nothing for an empty query, so callers can show recents instead', () => {
    expect(searchCommands(index(), '')).toEqual([]);
    expect(searchCommands(index(), '>  ')).toEqual([]);
  });

  it('strips the command prefix before matching', () => {
    expect(searchCommands(index(), '> photos').map((item) => item.id)).toEqual(['pages:photos']);
  });

  it('breaks a score tie on group order', () => {
    const items = buildCommandIndex({
      people: [{ id: 'p', title: 'Banff', href: '/people/p' }],
      pages: [{ id: 'b', title: 'Banff', href: '/banff' }],
    });
    expect(searchCommands(items, 'banff').map((item) => item.group)).toEqual(['pages', 'people']);
  });

  it('honours the limit', () => {
    expect(searchCommands(index(), 'a', 2)).toHaveLength(2);
  });
});

describe('groupCommands and navigationCommands', () => {
  it('groups in the canonical order and skips empty groups', () => {
    const grouped = groupCommands(index());
    expect(grouped.map((group) => group.id)).toEqual(commandGroups.map((group) => group.id));
    expect(groupCommands([])).toEqual([]);
  });

  it('limits the Go-to list to pages, settings and actions', () => {
    expect(new Set(navigationCommands(index()).map((item) => item.group))).toEqual(
      new Set(['pages', 'settings', 'actions']),
    );
  });
});

describe('command prefix', () => {
  it('detects and strips a leading ">"', () => {
    expect(isCommandQuery('>settings')).toBe(true);
    expect(isCommandQuery('  > settings')).toBe(true);
    expect(isCommandQuery('settings')).toBe(false);
    expect(stripCommandPrefix('  >  settings ')).toBe('settings');
  });
});

describe('recent commands', () => {
  it('moves a repeated id to the front and bounds the list', () => {
    let recent: string[] = [];
    for (let i = 0; i < RECENT_COMMAND_LIMIT + 4; i++) {
      recent = rememberCommand(recent, `id-${i}`);
    }
    expect(recent).toHaveLength(RECENT_COMMAND_LIMIT);
    recent = rememberCommand(recent, 'id-5');
    expect(recent[0]).toBe('id-5');
    expect(recent.filter((id) => id === 'id-5')).toHaveLength(1);
  });

  it('ignores an empty id', () => {
    expect(rememberCommand(['a'], '')).toEqual(['a']);
  });

  it('rejects malformed, oversized and wrong-version payloads', () => {
    expect(parseRecentCommands('not json')).toEqual([]);
    expect(parseRecentCommands(JSON.stringify({ version: 2, recent: ['a'] }))).toEqual([]);
    expect(parseRecentCommands(JSON.stringify({ version: 1, recent: 'a' }))).toEqual([]);
    expect(parseRecentCommands('"' + 'x'.repeat(20_001) + '"')).toEqual([]);
    expect(parseRecentCommands(JSON.stringify({ version: 1, recent: [1, null, 'a', 'a'] }))).toEqual(['a']);
  });

  it('round-trips through storage and survives a throwing storage', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };
    expect(saveRecentCommands(storage, ['a', 'b'])).toBe(true);
    expect(store.get(COMMANDS_KEY)).toBe(serializeRecentCommands(['a', 'b']));
    expect(loadRecentCommands(storage)).toEqual(['a', 'b']);

    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(loadRecentCommands(broken)).toEqual([]);
    expect(saveRecentCommands(broken, ['a'])).toBe(false);
    expect(loadRecentCommands(null)).toEqual([]);
  });

  it('drops recent ids whose command no longer exists', () => {
    const items = index();
    expect(recentCommands(items, ['pages:photos', 'collections:gone']).map((item) => item.id)).toEqual([
      'pages:photos',
    ]);
  });
});

describe('shortcutKeys', () => {
  it('renders platform-appropriate modifiers', () => {
    expect(shortcutKeys('mod+shift+p', true)).toEqual(['⌘', '⇧', 'P']);
    expect(shortcutKeys('mod+shift+p', false)).toEqual(['Ctrl', 'Shift', 'P']);
    expect(shortcutKeys('', true)).toEqual([]);
    expect(shortcutKeys(undefined)).toEqual([]);
  });
});
