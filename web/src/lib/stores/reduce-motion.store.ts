import { persisted } from 'svelte-persisted-store';
import { browser } from '$app/env';

/**
 * ACCOUNT-P3 "Use less movement" (Look & playback): fewer animations on this device, on top of the
 * device's own reduced-motion setting. `mediaQueryManager.reducedMotion` reads both, and tokens.css and
 * app.css clamp CSS motion while `<html>` carries `data-reduce-motion`.
 *
 * Its own module, not preferences.store: media-query-manager reads it, and specs that mock
 * preferences.store must not have to know about it.
 */
export const reduceMotion = persisted<boolean>('frameleaf-reduce-motion', false, {});
if (browser) {
  reduceMotion.subscribe((on) => document.documentElement.toggleAttribute('data-reduce-motion', on));
}
