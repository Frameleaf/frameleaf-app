/**
 * The moment after the PIN is accepted (design review finding 90): Locked items that come into
 * view because of the unlock arrive out of focus and sharpen, so the eye sees what the PIN just
 * revealed. The top bar marks the unlock; a tile for a Locked item that is drawn inside the window
 * plays the move once. Items already on the page, and every later visit, are untouched.
 */
export const LOCK_REVEAL_WINDOW_MS = 4000;

let revealUntil = 0;

const clock = () => (typeof performance === 'undefined' ? Date.now() : performance.now());

/** The session was just unlocked with the PIN: Locked tiles drawn from now on sharpen into view. */
export const markLocksRevealed = (now = clock()) => {
  revealUntil = now + LOCK_REVEAL_WINDOW_MS;
};

/** The session was locked again, or the window should end early. */
export const clearLocksRevealed = () => {
  revealUntil = 0;
};

export const isRevealingLocks = (now = clock()) => now < revealUntil;
