import { flushSync } from 'svelte';
import {
  PersistedBase,
  PersistedLocalStorage as SharedPersistedLocalStorage,
} from '../../../../packages/ui/dist/state/persisted.js';
import { PersistedLocalStorage } from './persisted';

const blockStorage = (operation: 'getItem' | 'setItem') => {
  const storage = localStorage;
  vi.stubGlobal('localStorage', {
    get length() {
      return storage.length;
    },
    key: storage.key.bind(storage),
    getItem: storage.getItem.bind(storage),
    setItem: storage.setItem.bind(storage),
    removeItem: storage.removeItem.bind(storage),
    clear: storage.clear.bind(storage),
    [operation]: () => {
      throw new DOMException('Storage blocked', 'SecurityError');
    },
  });
};

describe.each([
  { name: 'web', Store: PersistedLocalStorage },
  { name: 'shared UI', Store: SharedPersistedLocalStorage },
])('$name persisted preferences', ({ Store }) => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it.each(['false', '0', '""', 'null', '[1,2]', '{"onlyFavorites":true}'])('preserves saved JSON %s', (saved) => {
    localStorage.setItem('preference', saved);
    const store = new Store<unknown>('preference', 'default');
    expect(store.current).toEqual(JSON.parse(saved));
    expect(localStorage.getItem('preference')).toBe(saved);
  });

  it('defaults damaged JSON without removing the saved entry', () => {
    localStorage.setItem('preference', 'broken json');
    const store = new Store('preference', false);
    expect(store.current).toBe(false);
    expect(localStorage.getItem('preference')).toBe('broken json');
    store.current = true;
    expect(localStorage.getItem('preference')).toBe('true');
  });

  it('keeps working when storage cannot be read', () => {
    blockStorage('getItem');
    const store = new Store('preference', false);
    expect(store.current).toBe(false);
    store.current = true;
    expect(store.current).toBe(true);
  });

  it('keeps an unsaved choice in memory when storage cannot be written', () => {
    localStorage.setItem('preference', 'false');
    blockStorage('setItem');
    const store = new Store('preference', false);
    store.current = true;
    expect(store.current).toBe(true);
    expect(localStorage.getItem('preference')).toBe('false');
  });

  it('validates a saved value before upgrading it', () => {
    localStorage.setItem('preference', '"wrong type"');
    const store = new Store('preference', 4, {
      valid: (value): value is number => typeof value === 'number',
      upgrade: () => {
        throw new Error('invalid values must not be upgraded');
      },
    });
    expect(store.current).toBe(4);
    expect(localStorage.getItem('preference')).toBe('"wrong type"');
  });

  it('merges newly added defaults without losing an older explicit choice', () => {
    localStorage.setItem('preference', '{"onlyFavorites":true}');
    const defaults = { showUpcoming: true, onlyFavorites: false };
    const store = new Store('preference', defaults, { upgrade: 'merge' });
    expect(store.current).toEqual({ showUpcoming: true, onlyFavorites: true });
    expect(defaults).toEqual({ showUpcoming: true, onlyFavorites: false });
  });

  it('uses a caller-supplied serializer and upgrade', () => {
    localStorage.setItem('preference', '12');
    const store = new Store('preference', 0, {
      serializer: { parse: Number, stringify: String },
      upgrade: (value) => value + 1,
    });
    expect(store.current).toBe(13);
    store.current = 17;
    expect(localStorage.getItem('preference')).toBe('17');
  });

  it('propagates a custom parser failure instead of silently replacing the saved value', () => {
    localStorage.setItem('preference', 'custom input');
    const failure = new Error('custom parser failed');
    expect(
      () =>
        new Store('preference', false, {
          serializer: {
            parse: () => {
              throw failure;
            },
            stringify: JSON.stringify,
          },
        }),
    ).toThrow(failure);
    expect(localStorage.getItem('preference')).toBe('custom input');
  });

  it('calls validation and upgrade callbacks without changing their receiver', () => {
    localStorage.setItem('preference', '12');
    const store = new Store('preference', 0, {
      valid(this: undefined, value): value is number {
        expect(this).toBeUndefined();
        return typeof value === 'number';
      },
      upgrade(this: undefined, value) {
        expect(this).toBeUndefined();
        return value + 2;
      },
    });
    expect(store.current).toBe(14);
  });

  it('notifies Svelte only when primitive preferences change while still restoring cleared storage', () => {
    const store = new Store('preference', false);
    const observations: boolean[] = [];
    const stop = $effect.root(() => {
      $effect(() => {
        observations.push(store.current);
      });
    });
    try {
      flushSync();
      for (let index = 0; index < 10; index++) {
        store.current = false;
        flushSync();
      }
      expect(observations).toEqual([false]);
      store.current = true;
      flushSync();
      expect(observations).toEqual([false, true]);
      localStorage.removeItem('preference');
      store.current = true;
      expect(localStorage.getItem('preference')).toBe('true');
    } finally {
      stop();
    }
  });

  it('still notifies for a mutated object assigned back to the store', () => {
    const store = new Store('preference', { count: 0 });
    const observations: number[] = [];
    const stop = $effect.root(() => {
      $effect(() => {
        observations.push(store.current.count);
      });
    });
    try {
      flushSync();
      const value = store.current;
      value.count = 2;
      store.current = value;
      flushSync();
      expect(observations).toEqual([0, 2]);
      expect(localStorage.getItem('preference')).toBe('{"count":2}');
    } finally {
      stop();
    }
  });

  it('propagates serializer bugs and leaves the previous current value intact', () => {
    const store = new Store('preference', false, {
      serializer: {
        parse: JSON.parse,
        stringify: () => {
          throw new Error('cannot serialize');
        },
      },
    });
    expect(() => (store.current = true)).toThrow('cannot serialize');
    expect(store.current).toBe(false);
    expect(localStorage.getItem('preference')).toBeNull();
  });
});

it('keeps custom persistence write failures observable without publishing a new value', () => {
  const store = new PersistedBase<number>('preference', 3, {
    read: () => undefined,
    write: () => {
      throw new Error('failed persistence');
    },
  });
  expect(() => (store.current = 7)).toThrow('failed persistence');
  expect(store.current).toBe(3);
});
