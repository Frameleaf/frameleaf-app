import { languageManager } from '$lib/managers/language-manager.svelte';

/**
 * FL-139: a horizontal arrow key as the page reads it. In a right-to-left page ← moves forward and →
 * back, so a handler written for left-to-right (→ next, ← previous) works in both once its key goes
 * through here. Keys that are not horizontal arrows pass unchanged.
 */
export const readingKey = (key: string): string => {
  if (!languageManager.rtl) {
    return key;
  }
  return key === 'ArrowLeft' ? 'ArrowRight' : key === 'ArrowRight' ? 'ArrowLeft' : key;
};

/** Whether a horizontal arrow key moves forward in the page's reading direction. */
export const isForwardKey = (key: 'ArrowLeft' | 'ArrowRight') => readingKey(key) === 'ArrowRight';
