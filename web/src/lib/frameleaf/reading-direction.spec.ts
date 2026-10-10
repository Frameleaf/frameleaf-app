import { isForwardKey, readingKey } from '$lib/frameleaf/reading-direction';
import { languageManager } from '$lib/managers/language-manager.svelte';

describe('reading direction (FL-139)', () => {
  afterEach(() => {
    languageManager.setLanguage('en');
  });

  it('reads the horizontal arrows as they are in a left-to-right page', () => {
    languageManager.setLanguage('en');
    expect(readingKey('ArrowRight')).toBe('ArrowRight');
    expect(isForwardKey('ArrowRight')).toBe(true);
    expect(isForwardKey('ArrowLeft')).toBe(false);
  });

  it('swaps them in a right-to-left page, and leaves every other key alone', () => {
    languageManager.setLanguage('ar');
    expect(readingKey('ArrowLeft')).toBe('ArrowRight');
    expect(readingKey('ArrowRight')).toBe('ArrowLeft');
    expect(readingKey('ArrowUp')).toBe('ArrowUp');
    expect(readingKey('Home')).toBe('Home');
    expect(isForwardKey('ArrowLeft')).toBe(true);
  });
});
