import { generateKeyPairSync } from 'node:crypto';
import { UserPreferencesUpdateDto } from 'src/dtos/user-preferences.dto.js';
import { PushEventType, UserMetadataKey } from 'src/enum.js';
import { buildPushPayload, pushSendRequestSchema } from 'src/utils/frameleaf-push.js';
import {
  NOTIFICATION_CATALOGS,
  type NotificationCatalogs,
  type SystemNotificationTemplate,
  notificationLocaleOf,
  renderSystemNotification,
} from 'src/utils/notification-locale.js';
import { getPreferences, getPreferencesPartial } from 'src/utils/preferences.js';
import { openPushEnvelope, sealPushEnvelope } from 'src/utils/push-crypto.js';
import fixtures from 'test/fixtures/system-notification-locale.json' with { type: 'json' };

const catalogs = { ...NOTIFICATION_CATALOGS, ...fixtures.catalogs } as NotificationCatalogs;
const sessionId = '11111111-1111-4111-8111-111111111111';

describe('shipped notification translations', () => {
  const locales = ['fr', 'es', 'de', 'it', 'pt', 'nl', 'pl', 'sv', 'da', 'nb-NO'];
  const placeholders = ({ title, body }: { title: string; body: string }) =>
    [...new Set(Array.from(`${title}${body}`.matchAll(/\{(\w+)\}/g), ([, name]) => name))].sort();

  it.each(locales)('%s covers every version-1 template without changing placeholders', (locale) => {
    const catalogue = NOTIFICATION_CATALOGS[locale];
    expect(catalogue?.version).toBe(NOTIFICATION_CATALOGS.en.version);
    expect(Object.keys(catalogue.messages).sort()).toEqual(Object.keys(NOTIFICATION_CATALOGS.en.messages).sort());
    for (const [key, english] of Object.entries(NOTIFICATION_CATALOGS.en.messages)) {
      const translated = catalogue.messages[key as SystemNotificationTemplate['key']]!;
      expect(translated.title.trim(), `${locale}.${key}.title`).not.toBe('');
      expect(translated.body.trim(), `${locale}.${key}.body`).not.toBe('');
      expect(placeholders(translated), `${locale}.${key}`).toEqual(placeholders(english));
      expect(`${translated.title}${translated.body}`.replaceAll(/\{\w+\}/g, '')).not.toMatch(/[{}]/);
    }
  });

  it.each(locales)('%s renders supplied values verbatim without parsing them again', (locale) => {
    const senderName = '<script>{albumName}</script> $&';
    const albumName = "{senderName} <b>Album</b> $'";
    const template: SystemNotificationTemplate = { version: 1, key: 'album-invite', args: { senderName, albumName } };
    const fallback = { title: 'Fallback title', body: 'Fallback body' };
    const actual = renderSystemNotification(template, locale, fallback);
    expect(actual).not.toEqual(fallback);
    expect(actual.body).toContain(senderName);
    expect(actual.body).toContain(albumName);
  });

  it('keeps exact locale fallback and supplied prose unchanged', () => {
    const fallback = { title: 'My title', body: 'My supplied message' };
    const template: SystemNotificationTemplate = {
      version: 1,
      key: 'album-invite',
      args: { senderName: 'A', albumName: 'B' },
    };
    expect(renderSystemNotification(template, 'fr-CA', fallback)).toEqual(fallback);
    expect(renderSystemNotification(undefined, 'fr', fallback)).toEqual(fallback);
    expect(notificationLocaleOf({ notifications: { locale: 'nb-NO' } })).toBe('nb-NO');
  });
});

describe('origin-only system notification contract (FL-329)', () => {
  it.each(fixtures.cases)('$name', ({ template, locale, fallback, expected }) => {
    const text = renderSystemNotification(template, locale, fallback, catalogs);
    expect(text).toEqual(expected);
    expect(renderSystemNotification(template, 'en', fallback)).toEqual(fallback);
    // Native consumers display these supplied fields; no template/version/arguments go over the wire.
    const { publicKey, privateKey } = generateKeyPairSync('x25519');
    const payload = buildPushPayload(
      { type: PushEventType.SharedActivity, ...text },
      {
        id: 'fixture',
        sentAt: '2026-10-06T00:00:00.000Z',
        safeAssetIds: new Set(),
      },
    );
    const request = pushSendRequestSchema.parse({
      platform: 'fcm',
      token: 'fixture-token-'.repeat(4),
      type: 'alert',
      priority: 'high',
      ttlSec: 86_400,
      payload: sealPushEnvelope(publicKey.export({ format: 'jwk' }).x!, Buffer.from(JSON.stringify(payload))),
    });
    const opened = JSON.parse(
      openPushEnvelope(privateKey, publicKey.export({ format: 'jwk' }).x!, request.payload!).toString(),
    );
    expect(opened).toMatchObject({ v: 1, ...expected });
    expect(Object.keys(opened).sort()).toEqual([
      'assetIds',
      'body',
      'data',
      'id',
      'preview',
      'sentAt',
      'title',
      'type',
      'v',
    ]);
    expect(request).not.toHaveProperty('title');
    expect(request).not.toHaveProperty('body');
  });

  it('renders the longest administrator notice in the recipient language (FL-406)', () => {
    const template: SystemNotificationTemplate = { version: 1, key: 'cloud-identity-key-damaged', args: {} };
    const english = NOTIFICATION_CATALOGS.en.messages['cloud-identity-key-damaged']!;
    expect(renderSystemNotification(template, 'en', { title: '', body: '' })).toEqual(english);
    expect(renderSystemNotification(template, 'en-XA', english, catalogs)).toEqual({
      title: `[Fixture ${english.title}]`,
      body: `[Fixture ${english.body}]`,
    });
  });

  it('uses session overrides only for push, keeps account authority for web, and persists changes through existing preferences', () => {
    const notifications = { locale: 'en-XA', devices: [{ sessionId, locale: 'en-XB' }] };
    const dto = UserPreferencesUpdateDto.schema.parse({ notifications });
    const first = getPreferences([{ key: UserMetadataKey.Preferences, value: dto }]);
    expect(notificationLocaleOf(first)).toBe('en-XA');
    expect(notificationLocaleOf(first, sessionId)).toBe('en-XB');
    expect(notificationLocaleOf(first, 'revoked-session')).toBe('en-XA');
    const changed = getPreferencesPartial({
      ...first,
      notifications: { ...notifications, devices: [{ sessionId, locale: 'en' }] },
    });
    const restored = getPreferences([{ key: UserMetadataKey.Preferences, value: changed }]);
    expect(notificationLocaleOf(restored, sessionId)).toBe('en');
    expect(notificationLocaleOf({ notifications: { locale: 'not_a_locale' } })).toBe('en');
    expect(() =>
      UserPreferencesUpdateDto.schema.parse({
        notifications: { devices: [...notifications.devices, ...notifications.devices] },
      }),
    ).toThrow();
  });

  it('falls back for absent arguments, extra arguments and mistranslated placeholders', () => {
    const fallback = { title: 'Shared with you', body: 'Zoë shared an item with you' };
    const template: SystemNotificationTemplate = { version: 1, key: 'item-share-one', args: { senderName: 'Zoë' } };
    expect(renderSystemNotification({ ...template, args: {} }, 'en-XA', fallback, catalogs)).toEqual(fallback);
    expect(
      renderSystemNotification(
        { ...template, args: { senderName: 'Zoë', message: 'private' } },
        'en-XA',
        fallback,
        catalogs,
      ),
    ).toEqual(fallback);
    for (const body of ['Missing name', 'Unknown {message}', '{senderName} {message}']) {
      expect(
        renderSystemNotification(template, 'en-XA', fallback, {
          'en-XA': { version: 1, messages: { 'item-share-one': { title: 'Shared', body } } },
        }),
      ).toEqual(fallback);
    }
  });
});
