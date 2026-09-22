import { get } from 'svelte/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('Frameleaf shell rollout flag', () => {
  beforeEach(() => {
    // persisted(...) reads localStorage when the module is first evaluated, so reset
    // the module registry and storage to assert the true default.
    vi.resetModules();
    localStorage.clear();
  });

  it('serves the Frameleaf shell until a browser opts out', async () => {
    const { frameleafShell } = await import('$lib/frameleaf/rollout');

    expect(get(frameleafShell)).toBe(true);
  });

  it('reads an opted-out browser from its own storage key', async () => {
    const { FRAMELEAF_SHELL_STORAGE_KEY } = await import('$lib/frameleaf/rollout');
    localStorage.setItem(FRAMELEAF_SHELL_STORAGE_KEY, 'false');
    vi.resetModules();

    const { frameleafShell } = await import('$lib/frameleaf/rollout');

    expect(get(frameleafShell)).toBe(false);
  });

  it('reverts to the Frameleaf shell when the preference is turned on again', async () => {
    const { FRAMELEAF_SHELL_STORAGE_KEY, frameleafShell } = await import('$lib/frameleaf/rollout');

    frameleafShell.set(false);
    expect(localStorage.getItem(FRAMELEAF_SHELL_STORAGE_KEY)).toBe('false');

    frameleafShell.set(true);
    expect(get(frameleafShell)).toBe(true);
    expect(localStorage.getItem(FRAMELEAF_SHELL_STORAGE_KEY)).toBe('true');
  });
});
