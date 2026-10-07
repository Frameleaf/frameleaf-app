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
