import { browser } from '$app/environment';
import { MediaQuery } from 'svelte/reactivity';
import { PersistedBase } from '../state/persisted.js';
import { Theme, ThemePreference } from '../types.js';

const THEME_KEY = 'frameleaf-ui-theme';
const LEGACY_THEME_KEY = 'immich-ui-theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';
const LOCK_SELECTOR = 'head > meta[name="darkreader-lock"]';

function parsePreference(saved) {
  try {
    let value = JSON.parse(saved);
    if (value && typeof value === 'object') value = value.system ? ThemePreference.System : value.value;
    return value === ThemePreference.Light || value === ThemePreference.Dark ? value : ThemePreference.System;
  } catch {
    return ThemePreference.System;
  }
}

function writePreference(_key, value) {
  if (!browser) return;
  try {
    localStorage.setItem(THEME_KEY, JSON.stringify(value));
    localStorage.removeItem(LEGACY_THEME_KEY);
  } catch {
    // Keep the in-memory choice and the previous saved value when storage is blocked.
  }
}

function readPreference() {
  if (!browser) return;
  try {
    const current = localStorage.getItem(THEME_KEY);
    if (current !== null) return parsePreference(current);
    const previous = localStorage.getItem(LEGACY_THEME_KEY);
    if (previous === null) return;
    const preference = parsePreference(previous);
    writePreference(THEME_KEY, preference);
    return preference;
  } catch {
    return;
  }
}

class ThemeManager {
  #darkModeUser = new MediaQuery(DARK_QUERY);
  #theme = new PersistedBase(THEME_KEY, ThemePreference.System, { read: readPreference, write: writePreference });

  get prefersDark() {
    return this.#darkModeUser.current;
  }

  get preference() {
    return this.#theme.current;
  }

  get value() {
    const preference = this.preference;
    if (preference === ThemePreference.System) return this.prefersDark ? Theme.Dark : Theme.Light;
    return preference === ThemePreference.Light ? Theme.Light : Theme.Dark;
  }

  constructor() {
    if (!browser) return;
    matchMedia(DARK_QUERY).addEventListener(
      'change',
      () => {
        if (this.preference === ThemePreference.System) this.#syncToDom();
      },
      { passive: true },
    );
    this.#syncToDom();
  }

  toggle() {
    this.setPreference(this.value === Theme.Dark ? ThemePreference.Light : ThemePreference.Dark);
  }

  setPreference(preference) {
    this.#theme.current =
      preference === ThemePreference.Light || preference === ThemePreference.Dark ? preference : ThemePreference.System;
    this.#syncToDom();
  }

  #syncToDom() {
    if (!browser) return;
    const element = document.querySelector('html');
    if (!element) return;
    const dark = this.value === Theme.Dark;
    element.classList.toggle('dark', dark);
    element.classList.toggle('light', !dark);
    const locks = document.querySelectorAll(LOCK_SELECTOR);
    if (dark && locks.length === 0) {
      const lock = document.createElement('meta');
      lock.name = 'darkreader-lock';
      document.head.append(lock);
    }
    for (let index = dark ? 1 : 0; index < locks.length; index++) locks[index].remove();
  }
}

export const themeManager = new ThemeManager();
