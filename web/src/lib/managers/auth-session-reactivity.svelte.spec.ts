import { flushSync } from 'svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';

it('keeps async session guards untracked while display guards explicitly observe session changes', () => {
  const guard = authManager.captureSession();
  const reactiveGuard = authManager.captureSession({ reactive: true });
  let captured = guard;
  let captureRuns = 0;
  let guardRuns = 0;
  let displayCurrent = false;
  const cleanup = $effect.root(() => {
    $effect(() => {
      captureRuns++;
      captured = authManager.captureSession();
    });
    $effect(() => {
      guardRuns++;
      guard();
    });
    $effect(() => {
      displayCurrent = reactiveGuard();
    });
  });
  try {
    flushSync();
    expect(displayCurrent).toBe(true);
    authManager.reset();
    flushSync();
    expect(captureRuns).toBe(1);
    expect(guardRuns).toBe(1);
    expect(captured()).toBe(false);
    expect(guard()).toBe(false);
    expect(displayCurrent).toBe(false);
  } finally {
    cleanup();
  }
});
