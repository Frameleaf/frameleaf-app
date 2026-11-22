import { persisted } from 'svelte-persisted-store';
import { browser } from '$app/env';

/**
 * FL-983 "Use system font" (Look & playback): this device's own font instead of Frameleaf's. `<html>`
 * carries `data-font="system"` while it is on, and app.css swaps the font stack. app.html reads the same
 * key before first paint, so the page never flashes the other font.
 *
 * Its own module, as reduce-motion.store is: specs that mock preferences.store need not know about it.
 */
export const systemFont = persisted<boolean>('frameleaf-system-font', false, {});
if (browser) {
  systemFont.subscribe((on) => {
    if (on) {
      document.documentElement.dataset.font = 'system';
    } else {
      delete document.documentElement.dataset.font;
    }
  });
}
