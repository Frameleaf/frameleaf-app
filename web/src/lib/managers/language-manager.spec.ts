import { languageManager } from '$lib/managers/language-manager.svelte';

/** FL-139: the root element carries the chosen language and direction (WCAG 3.1.1 Language of Page). */
describe('languageManager.setLanguage', () => {
  it('sets lang and dir on the page for a left-to-right language', () => {
    languageManager.setLanguage('pt_BR');
    expect(document.documentElement.lang).toBe('pt-BR');
    expect(document.documentElement.dir).toBe('ltr');
    expect(document.body.getAttribute('dir')).toBe('ltr');
  });

  it('sets dir="rtl" for a right-to-left language', () => {
    languageManager.setLanguage('ar');
    expect(document.documentElement.lang).toBe('ar');
    expect(document.documentElement.dir).toBe('rtl');
    expect(languageManager.rtl).toBe(true);
  });

  it('keeps English for the keys-only development language', () => {
    languageManager.setLanguage('dev');
    expect(document.documentElement.lang).toBe('en');
  });
});
