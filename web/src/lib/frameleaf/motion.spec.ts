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
  REDUCED_MOTION_FADE_MS,
  animateFlip,
  motionFlip,
  motionFly,
  motionScale,
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

  it('leaves no ungated moving transition or ad-hoc Reduce Motion query in Frameleaf, viewer or route code', () => {
    const roots = [
      'src/lib/components/frameleaf',
      'src/lib/components/asset-viewer',
      'src/lib/components/shared-components',
      'src/lib/components/album-page',
      'src/routes',
    ];
    const offenders: string[] = [];
    for (const root of roots) {
      for (const entry of readdirSync(root, { recursive: true, encoding: 'utf8' })) {
        if (!entry.endsWith('.svelte')) {
          continue;
        }
        const source = readFileSync(join(root, entry), 'utf8');
        const imported = /import\s*{([^}]*)}\s*from\s*['"]svelte\/transition['"]/.exec(source)?.[1] ?? '';
        if (/\b(fly|slide|scale)\b/.test(imported)) {
          offenders.push(`${root}/${entry}: svelte/transition ${imported.trim()}`);
        }
        const animate = /import\s*{([^}]*)}\s*from\s*['"]svelte\/animate['"]/.exec(source)?.[1] ?? '';
        if (/\bflip\b/.test(animate)) {
          offenders.push(`${root}/${entry}: svelte/animate flip`);
        }
        if (/matchMedia\(\s*['"`]\(prefers-reduced-motion/.test(source)) {
          offenders.push(`${root}/${entry}: matchMedia reduced motion`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
