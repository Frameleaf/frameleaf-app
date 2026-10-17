import { readFileSync } from 'node:fs';
import { ThemePreference } from '../../../../packages/ui/dist/types.js';
import { clearPrivateBrowserState } from './private-browser-state';

const load = () => import('../../../../packages/ui/dist/services/theme-manager.svelte.js');
const locks = () => document.head.querySelectorAll('meta[name="darkreader-lock"]');
const boot = () => {
  const html = readFileSync('src/app.html', 'utf8');
  for (const [, script] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    if (script.includes('prefers-color-scheme: dark')) {
      new Function(script)();
      return;
    }
  }
  throw new Error('Theme bootstrap is missing');
};

describe('device theme runtime', () => {
  let previousClasses: string;

  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    previousClasses = document.documentElement.className;
    document.documentElement.className = 'dark';
    for (const lock of locks()) {
      lock.remove();
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
    document.documentElement.className = previousClasses;
    for (const lock of locks()) {
      lock.remove();
    }
  });

  it.each([
    ['"dark"', 'dark'],
    ['"light"', 'light'],
    ['"system"', 'system'],
    ['{"system":false,"value":"dark"}', 'dark'],
    ['{"system":false,"value":"light"}', 'light'],
    ['{"system":true,"value":"dark"}', 'system'],
    ['null', 'system'],
    ['not json', 'system'],
  ])('migrates saved display choice %s without losing it', async (saved, expected) => {
    localStorage.setItem('immich-ui-theme', saved);
    const { themeManager } = await load();
    expect(themeManager.preference).toBe(expected);
    expect(localStorage.getItem('frameleaf-ui-theme')).toBe(JSON.stringify(expected));
    expect(localStorage.getItem('immich-ui-theme')).toBeNull();
  });

  it('keeps the current preference ahead of an older saved choice', async () => {
    localStorage.setItem('frameleaf-ui-theme', '"light"');
    localStorage.setItem('immich-ui-theme', '"dark"');
    const { themeManager } = await load();
    expect(themeManager.preference).toBe('light');
    expect(themeManager.value).toBe('light');
  });

  it('uses the current preference before first paint', () => {
    localStorage.setItem('frameleaf-ui-theme', '"light"');
    localStorage.setItem('immich-ui-theme', '"dark"');
    boot();
    expect(document.documentElement).toHaveClass('light');
    expect(document.documentElement).not.toHaveClass('dark');
  });

  it('migrates an older explicit choice before first paint', () => {
    localStorage.setItem('immich-ui-theme', '{"system":false,"value":"dark"}');
    boot();
    expect(document.documentElement).toHaveClass('dark');
    expect(localStorage.getItem('frameleaf-ui-theme')).toBe('"dark"');
  });

  it('keeps one extension lock across repeated dark updates and removes every lock for light', async () => {
    const { themeManager } = await load();
    for (let index = 0; index < 10; index++) {
      themeManager.setPreference(ThemePreference.Dark);
    }
    expect(locks()).toHaveLength(1);
    const extra = document.createElement('meta');
    extra.name = 'darkreader-lock';
    document.head.append(extra);
    themeManager.setPreference(ThemePreference.Light);
    expect(locks()).toHaveLength(0);
    expect(document.documentElement).toHaveClass('light');
  });

  it('preserves display preferences at sign-out while clearing account data', async () => {
    const { themeManager } = await load();
    themeManager.setPreference(ThemePreference.Dark);
    localStorage.setItem('frameleaf:library:v1:user-1', '{"private":true}');
    clearPrivateBrowserState();
    expect(localStorage.getItem('frameleaf-ui-theme')).toBe('"dark"');
    expect(localStorage.getItem('frameleaf:library:v1:user-1')).toBeNull();
  });

  it('stores only a display choice in the device preference key', async () => {
    const { themeManager } = await load();
    Reflect.apply(themeManager.setPreference, themeManager, [{ private: 'must not be retained' }]);
    expect(themeManager.preference).toBe('system');
    expect(localStorage.getItem('frameleaf-ui-theme')).toBe('"system"');
  });

  it('keeps the old choice when writing its migration is blocked', async () => {
    localStorage.setItem('immich-ui-theme', '"dark"');
    const storage = localStorage;
    vi.stubGlobal('localStorage', {
      get length() {
        return storage.length;
      },
      key: storage.key.bind(storage),
      getItem: storage.getItem.bind(storage),
      removeItem: storage.removeItem.bind(storage),
      clear: storage.clear.bind(storage),
      setItem: () => {
        throw new DOMException('Storage blocked', 'SecurityError');
      },
    });
    const { themeManager } = await load();
    expect(themeManager.preference).toBe('dark');
    expect(localStorage.getItem('immich-ui-theme')).toBe('"dark"');
    expect(localStorage.getItem('frameleaf-ui-theme')).toBeNull();
    themeManager.setPreference(ThemePreference.Light);
    expect(themeManager.value).toBe('light');
    expect(localStorage.getItem('immich-ui-theme')).toBe('"dark"');
  });
});
