import { eventManager } from '$lib/managers/event-manager.svelte';
import { lang } from '$lib/stores/preferences.store';
import { convertBCP47, langs } from '$lib/utils/i18n';

class LanguageManager {
  constructor() {
    eventManager.on({
      AppInit: () => this.init(),
    });
  }

  initialized = $state(false);
  rtl = $state(false);

  init() {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    lang.subscribe((lang) => this.setLanguage(lang));
  }

  setLanguage(code: string) {
    const item = langs.find((item) => item.code === code);
    if (!item) {
      return;
    }

    this.rtl = item.rtl ?? false;

    const dir = item.rtl ? 'rtl' : 'ltr';
    document.body.setAttribute('dir', dir);
    // FL-139: the page's language and direction for assistive technology and the browser (WCAG 3.1.1);
    // the keys-only development language keeps English
    document.documentElement.lang = item.code === 'dev' ? 'en' : convertBCP47(item.code);
    document.documentElement.dir = dir;

    eventManager.emit('LanguageChange', item);
  }
}

export const languageManager = new LanguageManager();
