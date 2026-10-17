import { describe, expect, it } from 'vitest';
import {
  clearLocksRevealed,
  isRevealingLocks,
  LOCK_REVEAL_WINDOW_MS,
  markLocksRevealed,
} from '$lib/components/timeline/lock-reveal';

describe('lock reveal window', () => {
  it('is open for a few seconds after an unlock and closed otherwise', () => {
    clearLocksRevealed();
    expect(isRevealingLocks(1000)).toBe(false);
    markLocksRevealed(1000);
    expect(isRevealingLocks(1001)).toBe(true);
    expect(isRevealingLocks(1000 + LOCK_REVEAL_WINDOW_MS - 1)).toBe(true);
    expect(isRevealingLocks(1000 + LOCK_REVEAL_WINDOW_MS)).toBe(false);
  });

  it('closes at once when the session is locked again', () => {
    markLocksRevealed(1000);
    clearLocksRevealed();
    expect(isRevealingLocks(1001)).toBe(false);
  });
});
