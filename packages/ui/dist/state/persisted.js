import { browser } from '$app/environment';
import { createSubscriber } from 'svelte/reactivity';

export class PersistedBase {
  #value;
  #subscribe;
  #update = () => {};
  #write;

  constructor(key, defaultValue, options) {
    const saved = options.read(key);
    this.#value = saved === undefined ? defaultValue : saved;
    this.#write = (value) => options.write(key, value);
    this.#subscribe = createSubscriber((update) => {
      this.#update = update;
      return () => {
        this.#update = () => {};
      };
    });
  }

  get current() {
    this.#subscribe();
    return this.#value;
  }

  set current(value) {
    // Even an unchanged choice may need saving after browser storage was cleared.
    this.#write(value);
    if (Object.is(value, this.#value) && (value === null || (typeof value !== 'object' && typeof value !== 'function')))
      return;
    this.#value = value;
    this.#update();
  }
}

export class PersistedLocalStorage extends PersistedBase {
  constructor(key, defaultValue, options = {}) {
    const serializer = options.serializer || JSON;
    const valid = options.valid;
    const upgrade = options.upgrade;
    super(key, defaultValue, {
      read: (key) => {
        if (!browser) return;
        let saved;
        try {
          saved = localStorage.getItem(key);
        } catch {
          return;
        }
        if (saved === null) return;
        let parsed;
        if (serializer === JSON) {
          try {
            parsed = serializer.parse(saved);
          } catch {
            // Keep damaged JSON until the user changes the preference.
            return;
          }
        } else {
          parsed = serializer.parse(saved);
        }
        if (valid && !valid(parsed)) return;
        if (upgrade === 'merge') {
          return typeof parsed === 'object' ? { ...defaultValue, ...parsed } : parsed;
        }
        return upgrade ? upgrade(parsed) : parsed;
      },
      write: (key, value) => {
        if (!browser) return;
        const saved = serializer.stringify(value);
        try {
          localStorage.setItem(key, saved);
        } catch {
          // Blocked browser storage must not prevent an in-memory preference change.
        }
      },
    });
  }
}
