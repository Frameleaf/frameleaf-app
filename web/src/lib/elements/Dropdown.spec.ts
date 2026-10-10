import { fireEvent, render, screen } from '@testing-library/svelte';
import type { TransitionConfig } from 'svelte/transition';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * FL-29: the settings dropdown menu (SettingDropdown uses this element) goes through the shared
 * Reduce Motion gate in `$lib/frameleaf/motion`. It slides in normally and crossfades in place
 * under Reduce Motion, in the style of `motion.spec.ts`.
 */
const media = vi.hoisted(() => ({ reducedMotion: false }));
vi.mock('$lib/stores/media-query-manager.svelte', () => ({
  mediaQueryManager: {
    get reducedMotion() {
      return media.reducedMotion;
    },
  },
}));

const transitions = vi.hoisted(() => [] as TransitionConfig[]);
vi.mock('$lib/frameleaf/motion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/frameleaf/motion')>();
  return {
    ...actual,
    motionFly: (node: Element, params?: Parameters<typeof actual.motionFly>[1]) => {
      const config = actual.motionFly(node, params);
      transitions.push(config);
      return config;
    },
  };
});

const { REDUCED_MOTION_FADE_MS } = await import('$lib/frameleaf/motion');
const { default: Dropdown } = await import('$lib/elements/Dropdown.svelte');

const options = [
  { title: 'Small', value: 's' },
  { title: 'Large', value: 'l' },
];

const openMenu = async () => {
  render(Dropdown, {
    options,
    selectedOption: options[0],
    onSelect: vi.fn(),
    render: (option: { title: string }) => ({ title: option.title }),
  });
  await fireEvent.click(screen.getByRole('button', { name: 'Small' }));
  expect(screen.getByRole('button', { name: 'Large' })).toBeInTheDocument();
  expect(transitions).toHaveLength(1);
  return transitions[0];
};

describe('Dropdown motion (FL-29)', () => {
  beforeEach(() => {
    media.reducedMotion = false;
    transitions.length = 0;
  });

  it('slides the menu down 30px when motion is allowed', async () => {
    const config = await openMenu();
    expect(config.duration).toBe(250);
    expect(config.css?.(0.5, 0.5)).toMatch(/transform: .*translate\(0px, -15px\)/);
  });

  it('crossfades the menu in place under Reduce Motion', async () => {
    media.reducedMotion = true;
    const config = await openMenu();
    expect(config.duration).toBe(REDUCED_MOTION_FADE_MS);
    expect(config.css?.(0.5, 0.5)).toMatch(/^opacity: [\d.]+$/);
  });
});
