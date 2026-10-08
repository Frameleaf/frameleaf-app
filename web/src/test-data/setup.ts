import '@testing-library/jest-dom';
import { init } from 'svelte-i18n';

/**
 * happy-dom has no Web Animations API. This stand-in finishes every animation at once, which is
 * what a unit test wants: Svelte removes an element with an `out:` transition only when the
 * animation's `onfinish` runs, and `animate:` asks an element for its running animations before
 * moving it. So `onfinish` is called in a microtask as soon as it is set, `finished` is already
 * resolved, and `getAnimations()` reports none running.
 *
 * `finishesAtOnce` tells `$lib/frameleaf/motion` `canAnimate()` there is no exit to wait for, so
 * `leave()`, Dialog and Menu close synchronously here, as they do without the API. A spec that
 * wants to observe an exit replaces `animate` with its own double (which has no such mark).
 *
 * A plain function, not `vi.fn()`: a spec's `vi.resetAllMocks()` would otherwise strip the
 * implementation and every later animation (toasts, transitions) would get `undefined` back.
 */
const animateAtOnce = Object.assign(
  function animate(): Animation {
    let handler: ((event: AnimationPlaybackEvent) => void) | null = null;
    return {
      cancel: () => {},
      finish: () => {},
      pause: () => {},
      play: () => {},
      finished: Promise.resolve(),
      ready: Promise.resolve(),
      currentTime: 0,
      playState: 'finished',
      get onfinish() {
        return handler;
      },
      set onfinish(next: ((event: AnimationPlaybackEvent) => void) | null) {
        handler = next;
        if (next) {
          queueMicrotask(() => {
            if (handler === next) {
              next({} as AnimationPlaybackEvent);
            }
          });
        }
      },
    } as unknown as Animation;
  },
  { finishesAtOnce: true },
);

const installAnimations = () => {
  Element.prototype.animate = animateAtOnce;
  Element.prototype.getAnimations ??= () => [];
};
installAnimations();

beforeAll(async () => {
  await init({ fallbackLocale: 'dev' });
  // Again for each file: a spec may have replaced `animate` with its own double.
  installAnimations();
});

if (!('part' in HTMLElement.prototype)) {
  class PartShim {
    declare getAttribute: HTMLElement['getAttribute'];
    declare setAttribute: HTMLElement['setAttribute'];

    get part() {
      const getParts = () => new Set((this.getAttribute('part') ?? '').split(/\s+/).filter(Boolean));
      const setParts = (parts: Set<string>) => this.setAttribute('part', [...parts].join(' '));

      return {
        add: (...tokens: string[]) => {
          const parts = getParts();
          for (const token of tokens) {
            parts.add(token);
          }
          setParts(parts);
        },
        remove: (...tokens: string[]) => {
          const parts = getParts();
          for (const token of tokens) {
            parts.delete(token);
          }
          setParts(parts);
        },
        contains: (token: string) => getParts().has(token),
      };
    }
  }

  const partDescriptor = Object.getOwnPropertyDescriptor(PartShim.prototype, 'part');
  if (partDescriptor) {
    Object.defineProperty(HTMLElement.prototype, 'part', { configurable: true, get: partDescriptor.get });
  }
}

Object.defineProperty(globalThis, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(function (query) {
    return {
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    };
  }),
});

vi.mock('$env/dynamic/public', () => {
  return {
    env: {
      PUBLIC_IMMICH_HOSTNAME: '',
    },
  };
});

// happy-dom's `:checked` never matches a selected <option>, and Svelte's `bind:value` on a
// <select> reads the chosen option through `select.querySelector(':checked')`, so every bound
// select would read back its first option. Answer that one query from the element's real
// selectedness; every other selector goes to happy-dom unchanged.
const nativeSelectQuery = HTMLSelectElement.prototype.querySelector;
const nativeSelectQueryAll = HTMLSelectElement.prototype.querySelectorAll;
HTMLSelectElement.prototype.querySelector = function (this: HTMLSelectElement, selector: string) {
  if (selector === ':checked') {
    return [...this.options].find((option) => option.selected) ?? null;
  }
  return nativeSelectQuery.call(this, selector);
} as typeof HTMLSelectElement.prototype.querySelector;
HTMLSelectElement.prototype.querySelectorAll = function (this: HTMLSelectElement, selector: string) {
  if (selector === ':checked') {
    return [...this.options].filter((option) => option.selected) as unknown as NodeListOf<HTMLOptionElement>;
  }
  return nativeSelectQueryAll.call(this, selector);
} as typeof HTMLSelectElement.prototype.querySelectorAll;
