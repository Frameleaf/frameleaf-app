import { get } from 'svelte/store';

/** Which bundles were fetched, as `language/bundle`. */
const fetched = vi.hoisted(() => [] as string[]);

vi.mock('virtual:frameleaf-messages', () => {
  const bundle = (code: string, name: string) => () => {
    fetched.push(`${code}/${name}`);
    return Promise.resolve({ default: { [`${name}_key`]: `${code} ${name}` } });
  };
  const all = (code: string) =>
    Object.fromEntries(['core', 'settings', 'studio', 'rest'].map((name) => [name, bundle(code, name)]));
  return {
    areaRoutes: { settings: ['(user)/user-settings', 'admin'], studio: ['(user)/studio', 'studio'] },
    // German holds English for the keys it lacks; Japanese is a partial translation.
    merged: ['de', 'nb_NO'],
    loaders: { en: all('en'), de: all('de'), nb_NO: all('nb_NO'), ja: { core: bundle('ja', 'core') }, br: {} },
  };
});

/** A fresh copy of the loader and of the svelte-i18n it writes to, so no test sees another's bundles. */
const load = async () => {
  vi.resetModules();
  const { dictionary, init, locale } = await import('svelte-i18n');
  await init({ fallbackLocale: 'en', initialLocale: 'en' });
  return { ...(await import('./i18n')), dictionary, locale };
};

describe('messages in bundles (FL-1797)', () => {
  // The first import also compiles the module, which can outlast a test's own time.
  beforeAll(async () => {
    await import('./i18n');
  }, 60_000);

  beforeEach(() => {
    fetched.length = 0;
  });

  it('fetches only the core bundle of the chosen language at startup', async () => {
    const { loadMessages, dictionary } = await load();
    await loadMessages('core', 'en');
    expect(fetched).toEqual(['en/core']);
    expect(get(dictionary).en).toEqual({ core_key: 'en core' });
  });

  it('never fetches English beside a language that already holds it', async () => {
    const { loadMessages, dictionary } = await load();
    await loadMessages('core', 'de');
    await loadMessages('settings', 'de-AT');
    await loadMessages('core', 'nb-NO');
    expect(fetched).toEqual(['de/core', 'de/settings', 'nb_NO/core']);
    expect(get(dictionary)['nb-NO']).toEqual({ core_key: 'nb_NO core' });
  });

  it('reads English beside a partial translation, and alone for a language with no file', async () => {
    const { loadMessages } = await load();
    await loadMessages('core', 'ja');
    await loadMessages('settings', 'ja');
    await loadMessages('core', 'xx');
    expect(fetched).toEqual(['ja/core', 'en/core', 'en/settings']);
  });

  it('fetches nothing for the keys-only development language', async () => {
    const { loadMessages } = await load();
    await loadMessages('core', 'dev');
    expect(fetched).toEqual([]);
  });

  it('fetches a bundle once, and again after a failed fetch', async () => {
    const { loadMessages } = await load();
    await Promise.all([loadMessages('core', 'en'), loadMessages('core', 'en')]);
    await loadMessages('core', 'en');
    expect(fetched).toEqual(['en/core']);

    const messages = await import('virtual:frameleaf-messages');
    const studio = messages.loaders.en.studio;
    messages.loaders.en.studio = () => Promise.reject(new Error('offline'));
    await expect(loadMessages('studio', 'en')).rejects.toThrow('offline');
    messages.loaders.en.studio = studio;
    await loadMessages('studio', 'en');
    expect(fetched).toEqual(['en/core', 'en/studio']);
  });

  it('gives sign-in and Photos only the core messages, and an area its own when a route of it opens', async () => {
    const { areaForRoute, loadRouteMessages } = await load();
    for (const route of ['/auth/login', '/(user)/photos/[[assetId=id]]', '/', '/(user)/studio-projects', null]) {
      expect(areaForRoute(route), String(route)).toBeUndefined();
      await loadRouteMessages(route);
    }
    expect(fetched).toEqual([]);

    expect(areaForRoute('/admin/users')).toBe('settings');
    expect(areaForRoute('/(user)/studio')).toBe('studio');
    await loadRouteMessages('/(user)/user-settings');
    expect(fetched).toEqual(['en/settings']);
  });

  it('changes language once the bundles in use are there in the new one', async () => {
    const { loadMessages, setLanguage, locale } = await load();
    await loadMessages('core', 'en');
    await loadMessages('settings', 'en');
    fetched.length = 0;

    const switched = setLanguage('de');
    expect(get(locale)).toBe('en');
    await switched;
    expect(get(locale)).toBe('de');
    expect(fetched.sort()).toEqual(['de/core', 'de/settings']);
  });

  it('repairs a missing key in the background: first the unused keys, then every area, then nothing', async () => {
    const { handleMissingMessage } = await load();
    handleMissingMessage({ id: 'somewhere_else' });
    // A second miss while the first fetch is under way starts nothing more.
    handleMissingMessage({ id: 'another' });
    await vi.waitFor(() => expect(fetched).toEqual(['en/rest']));
    await vi.waitFor(() => {
      handleMissingMessage({ id: 'somewhere_else' });
      expect(fetched).toEqual(['en/rest', 'en/settings', 'en/studio']);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    handleMissingMessage({ id: 'nowhere' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetched).toHaveLength(3);
  });
});
