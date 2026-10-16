import { addMessages, init, t } from 'svelte-i18n';
import { get } from 'svelte/store';
import { beforeAll, describe, expect, it } from 'vitest';
import en from '../../../../i18n/en.json';
import { describeChange, hasWords, PREFERENCE_WORDS, SERVER_WORDS, settingPage } from './setting-words';
import { PREFERENCE_LEAF_COVERAGE, SETTINGS_LEAF_COVERAGE } from './settings-coverage';

describe('setting words (FL-368)', () => {
  beforeAll(async () => {
    addMessages('en', en);
    await init({ fallbackLocale: 'en', initialLocale: 'en' });
  });
  const $t = () => get(t);

  it('says a switch as turned on or off, under the label on its page', () => {
    expect(describeChange($t(), 'preference', { path: 'ratings.enabled', before: false, after: true })).toMatchObject({
      label: 'Star ratings',
      before: 'Off',
      after: 'On',
      said: 'Star ratings turned on',
      page: { area: 'preferences', section: 'feature' },
    });
    expect(describeChange($t(), 'server', { path: 'map.enabled', before: true, after: false }).said).toBe(
      'Show photos on a map turned off',
    );
  });

  it('says a choice in the words of its options, and a number with its unit', () => {
    expect(describeChange($t(), 'server', { path: 'logging.level', before: 'log', after: 'debug' }).said).toBe(
      'How much to record: Normal activity → Detail for finding a fault',
    );
    expect(
      // D5: decimal GB; a size saved in binary bytes before D5 reads as what it is
      describeChange($t(), 'preference', { path: 'download.archiveSize', before: 4 * 1024 ** 3, after: 10 * 1000 ** 3 })
        .said,
    ).toBe('Split big downloads into files of: 4.29 GB → 10 GB');
    expect(describeChange($t(), 'preference', { path: 'memories.duration', before: 5, after: 8 }).after).toBe(
      '8 seconds',
    );
  });

  it('never shows a secret, an empty value as nothing, or a schedule as its expression', () => {
    const password = describeChange($t(), 'server', {
      path: 'notifications.smtp.transport.password',
      before: '',
      after: 'hunter2',
    });
    expect(password).toMatchObject({ label: 'Password', before: 'Not set', after: 'Saved (never shown)' });
    expect(describeChange($t(), 'server', { path: 'server.name', before: '', after: 'Home' }).before).toBe('Empty');
    expect(
      describeChange($t(), 'server', { path: 'library.scan.cronExpression', before: '0 0 * * *', after: '0 2 * * *' }),
    ).toMatchObject({ label: 'Schedule', before: 'A custom schedule', after: 'A custom schedule' });
  });

  it('names the page a setting lives on, with moved settings on their new page', () => {
    expect(settingPage('server', 'newVersionCheck.enabled')).toEqual({ area: 'server', section: 'version-check' });
    expect(settingPage('server', 'server.publicUsers')).toEqual({ area: 'sharing' });
    expect(settingPage('preference', 'emailNotifications.albumInvite')).toEqual({
      area: 'notifications',
      section: 'email-preferences',
    });
  });

  it('has a string for every label and option in the table', () => {
    const messages = en as Record<string, unknown>;
    for (const words of [...Object.values(SERVER_WORDS), ...Object.values(PREFERENCE_WORDS)]) {
      expect(messages[words.label], words.label).toBeTypeOf('string');
      if (words.values && typeof words.values !== 'function') {
        for (const key of Object.values(words.values)) {
          expect(messages[key], key).toBeTypeOf('string');
        }
      }
    }
  });

  // The pages rebuilt in plain words so far have their own words. The numbers fall as the next
  // settings stories add their lines; a rise means a setting was added without words.
  it('counts the settings still described from their name', () => {
    const without = (kind: 'server' | 'preference', rows: typeof SETTINGS_LEAF_COVERAGE) =>
      rows.filter((row) => row.kind === 'control' && !row.pattern.includes('*') && !hasWords(kind, row.pattern)).length;
    expect({
      server: without('server', SETTINGS_LEAF_COVERAGE),
      preference: without('preference', PREFERENCE_LEAF_COVERAGE),
    }).toMatchInlineSnapshot(`
      {
        "preference": 7,
        "server": 178,
      }
    `);
  });
});
