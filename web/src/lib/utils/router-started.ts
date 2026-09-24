/**
 * FL-34: whether SvelteKit's router has completed its first navigation. A component the session
 * privacy gate mounts later misses that `afterNavigate` call; it checks this on mount instead, so it
 * initializes exactly as it would have (ported from PR131 8c6bf6bb31).
 */
let started = false;

export const markRouterStarted = () => {
  started = true;
};

export const hasRouterStarted = () => started;
