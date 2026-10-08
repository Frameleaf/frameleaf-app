import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const media = vi.hoisted(() => ({ reducedMotion: false }));
vi.mock('$lib/stores/media-query-manager.svelte', () => ({
  mediaQueryManager: {
    get reducedMotion() {
      return media.reducedMotion;
    },
  },
}));

const {
  HERO_PAGE_ATTRIBUTE,
  HERO_SHARED_ATTRIBUTE,
  SECTION_TRANSITION_ATTRIBUTE,
  armHero,
  heroNavigation,
  installHeroIntent,
  routeSection,
  sectionCrossfade,
  REDUCED_MOTION_FADE_MS,
  REVEAL_MS,
  animateFlip,
  canAnimate,
  countUp,
  dock,
  leave,
  pop,
  reveal,
  sheet,
  springEasing,
  motionFade,
  motionFlip,
  motionFly,
  motionScale,
  motionScrollBehavior,
  motionSlide,
  prefersReducedMotion,
  withViewTransition,
} = await import('$lib/frameleaf/motion');

const rect = (left: number, top: number, width: number) =>
  ({ left, top, width, height: width, right: left + width, bottom: top + width, x: left, y: top }) as DOMRect;

describe('Frameleaf motion', () => {
  beforeEach(() => {
    media.reducedMotion = false;
    Reflect.deleteProperty(document, 'startViewTransition');
  });

  it('scrolls smoothly, and jumps under Reduce Motion (FL-139)', () => {
    expect(motionScrollBehavior()).toBe('smooth');
    media.reducedMotion = true;
    expect(motionScrollBehavior()).toBe('auto');
  });

  it('reads Reduce Motion from the shared media query manager', () => {
    expect(prefersReducedMotion()).toBe(false);
    media.reducedMotion = true;
    expect(prefersReducedMotion()).toBe(true);
  });

  for (const [name, transition, params] of [
    ['fly', motionFly, { x: -100, duration: 350 }],
    ['slide', motionSlide, { axis: 'x', duration: 250 }],
    ['scale', motionScale, { duration: 250, start: 0.5 }],
  ] as const) {
    it(`moves with ${name} normally and crossfades under Reduce Motion`, () => {
      const node = document.createElement('div');
      document.body.append(node);
      const moving = transition(node, params as never);
      expect(moving.duration).toBe(params.duration);
      // The moving transition changes geometry at the half-way point; a crossfade only opacity.
      expect(moving.css?.(0.5, 0.5)).toMatch(/transform|width|height/);

      media.reducedMotion = true;
      const reduced = transition(node, { ...params, delay: 40 } as never);
      expect(reduced.duration).toBe(REDUCED_MOTION_FADE_MS);
      expect(reduced.delay).toBe(40);
      expect(reduced.css?.(0.5, 0.5)).toMatch(/^opacity: [\d.]+$/);
      node.remove();
    });
  }

  it('fades with its own timing normally and with the shared crossfade under Reduce Motion', () => {
    const node = document.createElement('div');
    document.body.append(node);
    const fading = motionFade(node, { duration: 400 });
    expect(fading.duration).toBe(400);
    expect(fading.css?.(0.5, 0.5)).toMatch(/^opacity: [\d.]+$/);

    media.reducedMotion = true;
    const reduced = motionFade(node, { duration: 400, delay: 20 });
    expect(reduced.duration).toBe(REDUCED_MOTION_FADE_MS);
    expect(reduced.delay).toBe(20);
    node.remove();
  });

  it('flips list items normally and places them at once under Reduce Motion', () => {
    const node = document.createElement('li');
    document.body.append(node);
    const boxes = { from: rect(0, 0, 100), to: rect(0, 50, 100) };
    expect(motionFlip(node, boxes, { duration: 400 }).duration).toBe(400);
    media.reducedMotion = true;
    expect(motionFlip(node, boxes, { duration: 400 })).toEqual({ duration: 0 });
    node.remove();
  });

  it('runs the update directly without view transition support or under Reduce Motion', async () => {
    const update = vi.fn();
    await withViewTransition(update);
    expect(update).toHaveBeenCalledTimes(1);

    const start = vi.fn();
    Object.defineProperty(document, 'startViewTransition', { configurable: true, value: start });
    media.reducedMotion = true;
    await withViewTransition(update);
    expect(update).toHaveBeenCalledTimes(2);
    expect(start).not.toHaveBeenCalled();
  });

  it('wraps the update in a view transition when motion is allowed', async () => {
    const update = vi.fn();
    const start = vi.fn((callback: () => Promise<void>) => void callback());
    Object.defineProperty(document, 'startViewTransition', { configurable: true, value: start });
    await withViewTransition(update);
    expect(start).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('applies a second change at once while a transition is running, and never leaves a rejection unhandled', async () => {
    let finish: () => void = () => {};
    const finished = new Promise<void>((resolve) => (finish = resolve));
    // A skipped transition rejects `ready`; nothing here may surface it.
    const ready = Promise.reject(new DOMException('skipped', 'AbortError'));
    const start = vi.fn((callback: () => Promise<void>) => {
      void callback();
      return { ready, finished, updateCallbackDone: Promise.resolve() };
    });
    Object.defineProperty(document, 'startViewTransition', { configurable: true, value: start });
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);

    const first = vi.fn();
    const second = vi.fn();
    await withViewTransition(first);
    // Still running: the next change does not start another transition and cut this one short.
    await withViewTransition(second);
    expect(start).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const third = vi.fn();
    await withViewTransition(third);
    expect(start).toHaveBeenCalledTimes(2);
    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('still applies the change, once, when the browser refuses to start a transition', async () => {
    const update = vi.fn();
    Object.defineProperty(document, 'startViewTransition', {
      configurable: true,
      value: () => {
        throw new Error('busy');
      },
    });
    await withViewTransition(update);
    expect(update).toHaveBeenCalledTimes(1);
    // And the guard is released for the next one.
    const start = vi.fn((callback: () => Promise<void>) => void callback());
    Object.defineProperty(document, 'startViewTransition', { configurable: true, value: start });
    await withViewTransition(update);
    expect(start).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('passes on an error thrown by the update itself', async () => {
    const start = vi.fn((callback: () => Promise<void>) => void callback().catch(() => {}));
    Object.defineProperty(document, 'startViewTransition', { configurable: true, value: start });
    await expect(
      withViewTransition(() => {
        throw new Error('no');
      }),
    ).rejects.toThrow('no');
  });

  describe('animateFlip', () => {
    const setup = () => {
      const container = document.createElement('div');
      const tile = document.createElement('div');
      tile.dataset.assetId = 'a';
      container.append(tile);
      document.body.append(container);
      let box = rect(0, 0, 100);
      vi.spyOn(tile, 'getBoundingClientRect').mockImplementation(() => box);
      const animate = vi.fn();
      tile.animate = animate;
      const apply = vi.fn(() => {
        box = rect(50, 20, 200);
      });
      return { container, animate, apply };
    };

    it('slides each tile from its old box to its new one', () => {
      const { container, animate, apply } = setup();
      animateFlip(container, apply);
      expect(apply).toHaveBeenCalledTimes(1);
      expect(animate).toHaveBeenCalledTimes(1);
      const [frames, options] = animate.mock.calls[0];
      expect(frames[0].transform).toBe('translate(-50px, -20px) scale(0.5)');
      expect(frames[1].transform).toBe('none');
      expect(options.duration).toBe(420);
      container.remove();
    });

    it('applies the change instantly under Reduce Motion', () => {
      media.reducedMotion = true;
      const { container, animate, apply } = setup();
      animateFlip(container, apply);
      expect(apply).toHaveBeenCalledTimes(1);
      expect(animate).not.toHaveBeenCalled();
      container.remove();
    });

    it('still applies the change without a container', () => {
      const apply = vi.fn();
      animateFlip(undefined, apply);
      expect(apply).toHaveBeenCalledTimes(1);
    });
  });

  describe('motion vocabulary', () => {
    const node = () => {
      const element = document.createElement('div');
      document.body.append(element);
      return element;
    };

    it('follows the spring: overshoots once and settles on 1', () => {
      expect(springEasing(0)).toBe(0);
      expect(springEasing(1)).toBe(1);
      expect(springEasing(-1)).toBe(0);
      expect(springEasing(2)).toBe(1);
      const samples = Array.from({ length: 101 }, (_, index) => springEasing(index / 100));
      expect(Math.max(...samples)).toBeGreaterThan(1.1);
      expect(Math.max(...samples)).toBeLessThan(1.2);
      expect(samples.every((value) => Number.isFinite(value))).toBe(true);
    });

    for (const [name, transition, enterMs, exitMs, moves] of [
      ['pop', pop, 320, 120, /scale: 0\.9/],
      ['sheet', sheet, 480, 180, /translate: 0 40px; scale: 0\.96/],
      ['dock', dock, 420, 200, /translate: 0 12px/],
    ] as const) {
      it(`${name}: springs in, leaves faster without the spring, and crossfades under Reduce Motion`, () => {
        const element = node();
        const entering = transition(element, {}, { direction: 'in' });
        expect(entering.duration).toBe(enterMs);
        // Starts transparent and displaced, ends opaque and at rest.
        expect(entering.css?.(0, 1)).toMatch(/opacity: 0;/);
        expect(entering.css?.(0, 1)).toMatch(moves);
        expect(entering.css?.(1, 0)).toMatch(/opacity: 1;/);
        // The fade is done well before the spring settles.
        expect(entering.css?.(0.5, 0.5)).toMatch(/opacity: 1;/);

        const leaving = transition(element, {}, { direction: 'out' });
        expect(leaving.duration).toBe(exitMs);
        expect(leaving.css?.(0, 1)).toMatch(/opacity: 0/);

        media.reducedMotion = true;
        for (const direction of ['in', 'out'] as const) {
          const reduced = transition(element, { delay: 30 }, { direction });
          expect(reduced.duration).toBe(REDUCED_MOTION_FADE_MS);
          expect(reduced.delay).toBe(30);
          expect(reduced.css?.(0.5, 0.5)).toMatch(/^opacity: [\d.]+$/);
        }
        element.remove();
      });
    }

    it('pop grows from the corner it is given; dock travels the distance it is given', () => {
      const element = node();
      expect(pop(element, { origin: 'top right' }, { direction: 'in' }).css?.(0, 1)).toMatch(
        /^transform-origin: top right; /,
      );
      expect(dock(element, { y: -16 }, { direction: 'in' }).css?.(0, 1)).toMatch(/translate: 0 -16px/);
      element.remove();
    });

    it('reveal fades in 180ms and staggers at most eight items', () => {
      const element = node();
      expect(REVEAL_MS).toBe(180);
      const first = reveal(element, {}, { direction: 'in' });
      expect(first.duration).toBe(180);
      expect(first.delay).toBe(0);
      expect(first.css?.(0.5, 0.5)).toBe('opacity: 0.5');
      expect(reveal(element, { index: 3 }, { direction: 'in' }).delay).toBe(90);
      expect(reveal(element, { index: 40 }, { direction: 'in' }).delay).toBe(240);
      media.reducedMotion = true;
      // One crossfade, no stagger.
      expect(reveal(element, { index: 3 }, { direction: 'in' }).delay ?? 0).toBe(0);
      expect(reveal(element, { index: 3 }, { direction: 'in' }).duration).toBe(REDUCED_MOTION_FADE_MS);
      element.remove();
    });

    describe('leave', () => {
      const animatable = () => {
        const element = node();
        let finish: () => void = () => {};
        const animation = {
          cancel: vi.fn(),
          finished: new Promise<void>((resolve) => (finish = resolve)),
        };
        const animate = vi.fn(() => animation);
        element.animate = animate as never;
        element.getAnimations = (() => []) as never;
        return { element, animate, animation, finish: () => finish() };
      };

      it('finishes at once where nothing can animate, so callers keep their instant close', () => {
        const element = node();
        // The unit-test setup gives every element an `animate` that finishes at once, and says so.
        expect(typeof element.animate).toBe('function');
        expect(typeof element.getAnimations).toBe('function');
        expect(canAnimate(element)).toBe(false);
        const done = vi.fn();
        leave(element, 'sheet', done);
        expect(done).toHaveBeenCalledTimes(1);
        leave(undefined, 'pop', done);
        expect(done).toHaveBeenCalledTimes(2);
        element.remove();
      });

      it('gives unit tests animations that finish at once, so exits and list moves complete', async () => {
        // src/test-data/setup.ts: Svelte removes an `out:` element when `onfinish` runs, and
        // `animate:` asks for running animations first.
        const element = node();
        const animation = element.animate([], 200);
        const finished = vi.fn();
        animation.onfinish = finished;
        expect(finished).not.toHaveBeenCalled();
        await Promise.resolve();
        expect(finished).toHaveBeenCalledOnce();
        await expect(animation.finished).resolves.toBeUndefined();
        expect(element.getAnimations()).toEqual([]);
        // A handler replaced before the microtask runs is the one that is called.
        const first = vi.fn();
        const second = vi.fn();
        const other = element.animate([], 200);
        other.onfinish = first;
        other.onfinish = second;
        await Promise.resolve();
        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalledOnce();
        element.remove();
      });

      it('plays the pattern exit, then reports', async () => {
        const { element, animate, finish } = animatable();
        const done = vi.fn();
        leave(element, 'sheet', done, { backdrop: true });
        expect(done).not.toHaveBeenCalled();
        const [[frames, timing], [backdropFrames, backdropTiming]] = animate.mock.calls as unknown as [
          [Keyframe[], KeyframeAnimationOptions],
          [Keyframe[], KeyframeAnimationOptions],
        ];
        expect(frames.at(-1)).toEqual({ opacity: 0, translate: '0 12px', scale: 0.98 });
        expect(timing.duration).toBe(180);
        expect(timing.fill).toBe('forwards');
        expect(backdropFrames.at(-1)).toEqual({ opacity: 0 });
        expect(backdropTiming.pseudoElement).toBe('::backdrop');
        finish();
        await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1));
        element.remove();
      });

      it('fades without moving under Reduce Motion', () => {
        media.reducedMotion = true;
        const { element, animate } = animatable();
        leave(element, 'dock', vi.fn());
        const [frames, timing] = animate.mock.calls[0] as unknown as [Keyframe[], KeyframeAnimationOptions];
        expect(frames.at(-1)).toEqual({ opacity: 0 });
        expect(timing.duration).toBe(REDUCED_MOTION_FADE_MS);
        element.remove();
      });

      it('can be cancelled for a surface reopened mid-exit, without reporting', async () => {
        const { element, animation, finish } = animatable();
        const done = vi.fn();
        const cancel = leave(element, 'pop', done);
        cancel();
        expect(animation.cancel).toHaveBeenCalledTimes(1);
        finish();
        await Promise.resolve();
        await Promise.resolve();
        expect(done).not.toHaveBeenCalled();
        element.remove();
      });
    });

    describe('countUp', () => {
      it('reports the value at once under Reduce Motion', () => {
        media.reducedMotion = true;
        const onValue = vi.fn();
        countUp(0, 1200, onValue);
        expect(onValue).toHaveBeenCalledExactlyOnceWith(1200);
      });

      it('eases from the old value to the new one and can be stopped', () => {
        const frames: FrameRequestCallback[] = [];
        const request = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
          frames.push(callback);
          return frames.length;
        });
        const cancelFrame = vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
        const values: number[] = [];
        const stop = countUp(
          100,
          200,
          (value) => {
            values.push(value);
          },
          { duration: 1000 },
        );
        frames.shift()?.(0);
        frames.shift()?.(500);
        frames.shift()?.(1000);
        expect(values[0]).toBe(100);
        // Ease-out: past half-way at half time.
        expect(values[1]).toBeGreaterThan(150);
        expect(values[1]).toBeLessThan(200);
        expect(values[2]).toBe(200);
        expect(frames).toHaveLength(0);
        stop();
        expect(cancelFrame).toHaveBeenCalled();
        request.mockRestore();
        cancelFrame.mockRestore();
      });
    });
  });

  describe('heroNavigation: a card that opens a page', () => {
    const onScreen = (element: HTMLElement) => {
      element.getBoundingClientRect = () => rect(10, 10, 100);
      return element;
    };
    const mark = (key: string, page = false) => {
      const element = onScreen(document.createElement('img'));
      element.setAttribute(HERO_SHARED_ATTRIBUTE, key);
      if (page) {
        element.setAttribute(HERO_PAGE_ATTRIBUTE, '');
      }
      return element;
    };
    const startable = () => {
      let finish: () => void = () => {};
      const finished = new Promise<void>((resolve) => (finish = resolve));
      let updated: Promise<void> = Promise.resolve();
      const start = vi.fn((update: () => Promise<void>) => {
        updated = update();
        return { finished, ready: Promise.resolve() };
      });
      Object.defineProperty(document, 'startViewTransition', { configurable: true, value: start });
      return { start, finish: () => finish(), updated: () => updated };
    };
    let removeIntent: () => void = () => {};

    beforeEach(() => {
      document.body.replaceChildren();
      removeIntent();
      removeIntent = installHeroIntent();
      Object.defineProperties(globalThis, {
        innerWidth: { configurable: true, value: 1200 },
        innerHeight: { configurable: true, value: 800 },
      });
    });

    it('pairs the pressed card with the same key on the page that arrives', async () => {
      const { start, finish, updated } = startable();
      const link = document.createElement('a');
      const cover = mark('album:1');
      link.append(cover);
      document.body.append(link);
      // A press anywhere inside the link arms the card's key.
      link.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      let arrive: () => void = () => {};
      const complete = new Promise<void>((resolve) => (arrive = resolve));
      const pending = heroNavigation({ complete });
      expect(pending).toBeInstanceOf(Promise);
      expect(cover.style.getPropertyValue('view-transition-name')).toBe('fl-hero');
      expect(document.documentElement.getAttribute(SECTION_TRANSITION_ATTRIBUTE)).toBe('shared');
      await pending;
      expect(start).toHaveBeenCalledTimes(1);

      // The album page renders with the same key on its header.
      const header = mark('album:1', true);
      document.body.replaceChildren(header);
      arrive();
      await updated();
      expect(cover.style.getPropertyValue('view-transition-name')).toBe('');
      expect(header.style.getPropertyValue('view-transition-name')).toBe('fl-hero');

      finish();
      await vi.waitFor(() => expect(document.documentElement.hasAttribute(SECTION_TRANSITION_ATTRIBUTE)).toBe(false));
      expect(header.style.getPropertyValue('view-transition-name')).toBe('');
    });

    it('goes back from the element the page marked as its own', async () => {
      const { start, finish, updated } = startable();
      const header = mark('person:7', true);
      document.body.append(header, mark('person:8'));
      const pending = heroNavigation({ complete: Promise.resolve() });
      expect(header.style.getPropertyValue('view-transition-name')).toBe('fl-hero');
      await pending;
      await updated();
      expect(start).toHaveBeenCalledTimes(1);
      finish();
      await vi.waitFor(() => expect(document.documentElement.hasAttribute(SECTION_TRANSITION_ATTRIBUTE)).toBe(false));
    });

    it('leaves every other navigation alone', () => {
      const { start } = startable();
      // Cards on the page, none pressed, none marked as the page: nothing to pair.
      document.body.append(mark('album:1'), mark('album:2'));
      expect(heroNavigation({ complete: Promise.resolve() })).toBeUndefined();
      // An armed key whose card is not on screen.
      armHero('album:404');
      expect(heroNavigation({ complete: Promise.resolve() })).toBeUndefined();
      // Reduce Motion.
      armHero('album:1');
      media.reducedMotion = true;
      expect(heroNavigation({ complete: Promise.resolve() })).toBeUndefined();
      media.reducedMotion = false;
      // The press was spent on the navigation above, so the next one is not paired either.
      expect(heroNavigation({ complete: Promise.resolve() })).toBeUndefined();
      expect(start).not.toHaveBeenCalled();
      expect(document.documentElement.hasAttribute(SECTION_TRANSITION_ATTRIBUTE)).toBe(false);
    });

    it('does nothing without the View Transitions API', () => {
      Object.defineProperty(document, 'startViewTransition', { configurable: true, value: undefined });
      document.body.append(mark('album:1'));
      armHero('album:1');
      expect(heroNavigation({ complete: Promise.resolve() })).toBeUndefined();
    });
  });

  describe('sectionCrossfade', () => {
    const navigation = (from: string | null, to: string | null) => ({
      from: from ? { route: { id: from } } : null,
      to: to ? { route: { id: to } } : null,
      complete: Promise.resolve(),
    });
    const startable = () => {
      let finish: () => void = () => {};
      const finished = new Promise<void>((resolve) => (finish = resolve));
      const start = vi.fn((update: () => Promise<void>) => {
        void update();
        return { finished };
      });
      Object.defineProperty(document, 'startViewTransition', { configurable: true, value: start });
      return { start, finish: () => finish() };
    };

    it('names the section of a route, ignoring layout groups', () => {
      expect(routeSection('/(user)/albums/[albumId=id]/[[photos=photos]]/[[assetId=id]]')).toBe('albums');
      expect(routeSection('/(user)/photos/[[assetId=id]]')).toBe('photos');
      expect(routeSection('/admin/system-settings')).toBe('admin');
      expect(routeSection('/')).toBe('');
      expect(routeSection(null)).toBe('');
    });

    it('crossfades between sections and clears its mark when the transition ends', async () => {
      const { start, finish } = startable();
      const pending = sectionCrossfade(navigation('/(user)/photos/[[assetId=id]]', '/(user)/albums'));
      expect(pending).toBeInstanceOf(Promise);
      await pending;
      expect(start).toHaveBeenCalledTimes(1);
      expect(document.documentElement.getAttribute(SECTION_TRANSITION_ATTRIBUTE)).toBe('section');
      finish();
      await vi.waitFor(() => expect(document.documentElement.hasAttribute(SECTION_TRANSITION_ATTRIBUTE)).toBe(false));
    });

    it('stays instant within a section, on first load, under Reduce Motion and without the API', () => {
      expect(sectionCrossfade(navigation('/(user)/photos', '/(user)/albums'))).toBeUndefined();
      const { start } = startable();
      expect(
        sectionCrossfade(navigation('/(user)/albums', '/(user)/albums/[albumId=id]/[[photos=photos]]/[[assetId=id]]')),
      ).toBeUndefined();
      expect(sectionCrossfade(navigation(null, '/(user)/albums'))).toBeUndefined();
      media.reducedMotion = true;
      expect(sectionCrossfade(navigation('/(user)/photos', '/(user)/albums'))).toBeUndefined();
      expect(start).not.toHaveBeenCalled();
      expect(document.documentElement.hasAttribute(SECTION_TRANSITION_ATTRIBUTE)).toBe(false);
    });

    it('lets the navigation go ahead if the transition cannot start', async () => {
      Object.defineProperty(document, 'startViewTransition', {
        configurable: true,
        value: () => {
          throw new Error('busy');
        },
      });
      await expect(sectionCrossfade(navigation('/(user)/photos', '/(user)/people'))).resolves.toBeUndefined();
      expect(document.documentElement.hasAttribute(SECTION_TRANSITION_ATTRIBUTE)).toBe(false);
    });
  });

  it('routes every Svelte transition and flip in the app through this one helper (FL-29)', () => {
    const helper = join('src', 'lib', 'frameleaf', 'motion.ts');
    const offenders: string[] = [];
    for (const entry of readdirSync('src', { recursive: true, encoding: 'utf8' })) {
      const file = join('src', entry);
      if (!/\.(svelte|ts)$/.test(entry) || /\.spec\.ts$/.test(entry) || file === helper) {
        continue;
      }
      const source = readFileSync(file, 'utf8');
      if (
        /from\s*['"]svelte\/transition['"]/.test(
          source.replaceAll(/import\s+type\s*{[^}]*}\s*from\s*['"]svelte\/transition['"];?/g, ''),
        )
      ) {
        offenders.push(`${file}: svelte/transition`);
      }
      const animate = /import\s*{([^}]*)}\s*from\s*['"]svelte\/animate['"]/.exec(source)?.[1] ?? '';
      if (/\bflip\b/.test(animate)) {
        offenders.push(`${file}: svelte/animate flip`);
      }
      if (/matchMedia\(\s*['"`]\(prefers-reduced-motion/.test(source)) {
        offenders.push(`${file}: matchMedia reduced motion`);
      }
      // FL-139: a smooth programmatic scroll is motion the CSS kill-switch cannot stop
      if (/behavior:\s*['"]smooth['"]/.test(source)) {
        offenders.push(`${file}: smooth scroll (use motionScrollBehavior())`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
