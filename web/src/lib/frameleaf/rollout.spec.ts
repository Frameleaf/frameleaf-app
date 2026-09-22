import { get } from 'svelte/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('Frameleaf shell rollout flag', () => {
  beforeEach(() => {
    // persisted(...) reads localStorage when the module is first evaluated, so reset
    // the module registry and storage to assert the true default.
    vi.resetModules();
    localStorage.clear();
  });

  it('serves the legacy shell until a browser opts in', async () => {
    const { frameleafShell } = await import('$lib/frameleaf/rollout');

    expect(get(frameleafShell)).toBe(false);
  });

  it('reads an opted-in browser from its own storage key', async () => {
    const { FRAMELEAF_SHELL_STORAGE_KEY } = await import('$lib/frameleaf/rollout');
    localStorage.setItem(FRAMELEAF_SHELL_STORAGE_KEY, 'true');
    vi.resetModules();

    const { frameleafShell } = await import('$lib/frameleaf/rollout');

    expect(get(frameleafShell)).toBe(true);
  });

  it('reverts to the legacy shell when the preference is turned off again', async () => {
    const { FRAMELEAF_SHELL_STORAGE_KEY, frameleafShell } = await import('$lib/frameleaf/rollout');

    frameleafShell.set(true);
    expect(localStorage.getItem(FRAMELEAF_SHELL_STORAGE_KEY)).toBe('true');

    frameleafShell.set(false);
    expect(get(frameleafShell)).toBe(false);
    expect(localStorage.getItem(FRAMELEAF_SHELL_STORAGE_KEY)).toBe('false');
  });
});
