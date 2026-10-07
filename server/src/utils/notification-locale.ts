import z from 'zod';
import type { UserPreferences } from 'src/types.js';

/** Origin-only descriptors. These never enter NotificationDto or the encrypted push wire payload. */
const name = z.string();
const count = z.int().nonnegative();
const argumentsOf = {
  'job-failed': z.object({ jobName: name, error: name }).strict(),
  'item-share-one': z.object({ senderName: name }).strict(),
  'item-share-many': z.object({ senderName: name, count }).strict(),
  'cluster-request': z.object({ senderName: name }).strict(),
  'space-mention': z.object({ senderName: name, albumName: name }).strict(),
  'space-reply': z.object({ senderName: name, albumName: name }).strict(),
  'album-invite': z.object({ senderName: name, albumName: name }).strict(),
  'album-update': z.object({ albumName: name }).strict(),
  'push-album-invite': z.object({ senderName: name, albumName: name }).strict(),
  'push-album-update': z.object({ albumName: name }).strict(),
  'push-space-reply': z.object({ senderName: name, albumName: name }).strict(),
  'access-removed': z.object({ albumName: name }).strict(),
  'access-removed-unknown': z.object({}).strict(),
} as const;

type TemplateKey = keyof typeof argumentsOf;
export type SystemNotificationTemplate = {
  [K in TemplateKey]: { version: 1; key: K; args: z.infer<(typeof argumentsOf)[K]> };
}[TemplateKey];
export type NotificationText = { title: string; body: string };
export type NotificationCatalogs = Record<
  string,
  { version: number; messages: Partial<Record<TemplateKey, NotificationText>> }
>;

/** Add exact locale catalogs only after FC-109 decisions and FC-110 source-version signoff. */
export const NOTIFICATION_CATALOGS: NotificationCatalogs = {
  en: {
    version: 1,
    messages: {
      'job-failed': { title: 'Job Failed', body: 'Job {jobName} failed with error: {error}' },
      'item-share-one': { title: 'Shared with you', body: '{senderName} shared an item with you' },
      'item-share-many': { title: 'Shared with you', body: '{senderName} shared {count} items with you' },
      'cluster-request': { title: 'Cluster Group Request', body: '{senderName} asked you to join their cluster group' },
      'space-mention': { title: 'Mentioned in a shared space', body: '{senderName} mentioned you in {albumName}' },
      'space-reply': { title: 'Reply in a shared space', body: '{senderName} replied to your comment in {albumName}' },
      'album-invite': { title: 'Shared Album Invitation', body: '{senderName} shared an album ({albumName}) with you' },
      'album-update': { title: 'Shared Album Update', body: 'New media has been added to the album ({albumName})' },
      'push-album-invite': { title: 'Shared with you', body: '{senderName} shared {albumName} with you' },
      'push-album-update': { title: '{albumName}', body: 'New items were added to {albumName}' },
      'push-space-reply': { title: 'New reply', body: '{senderName} replied to your comment in {albumName}' },
      'access-removed': { title: 'Access changed', body: 'You no longer have access to {albumName}' },
      'access-removed-unknown': { title: 'Access changed', body: 'You no longer have access to an album' },
    },
  },
};

/** Valid BCP-47, including currently unsupported locales; no implicit regional/dialect substitution. */
export const NotificationLocaleSchema = z
  .string()
  .max(64)
  .refine((value) => {
    try {
      return Intl.getCanonicalLocales(value).length === 1;
    } catch {
      return false;
    }
  }, 'Invalid notification locale');

export const NotificationLocalePreferencesSchema = z.object({
  locale: NotificationLocaleSchema.optional(),
  devices: z
    .array(z.object({ sessionId: z.uuid(), locale: NotificationLocaleSchema }))
    .max(100)
    .refine(
      (devices) => new Set(devices.map(({ sessionId }) => sessionId)).size === devices.length,
      'Duplicate notification device session',
    )
    .optional(),
});
export type NotificationLocalePreferences = z.infer<typeof NotificationLocalePreferencesSchema>;

/** Device override, then account preference, then English. Revoked/unknown sessions never match a target. */
export const notificationLocaleOf = (
  preferences: Pick<UserPreferences, 'notifications'>,
  sessionId?: string,
): string => {
  const parsed = NotificationLocalePreferencesSchema.safeParse(preferences.notifications ?? {});
  if (!parsed.success) {
    return 'en';
  }
  const chosen =
    (sessionId && parsed.data.devices?.find((device) => device.sessionId === sessionId)?.locale) ||
    parsed.data.locale ||
    'en';
  return Intl.getCanonicalLocales(chosen)[0];
};

/** Never translate supplied prose. An unknown descriptor/version or invalid arguments preserves its fallback. */
export const renderSystemNotification = (
  template: unknown,
  locale: string,
  fallback: NotificationText,
  catalogs: NotificationCatalogs = NOTIFICATION_CATALOGS,
): NotificationText => {
  const header = z
    .object({ version: z.literal(1), key: z.enum(Object.keys(argumentsOf) as TemplateKey[]), args: z.unknown() })
    .strict()
    .safeParse(template);
  if (!header.success) {
    return fallback;
  }
  const args = argumentsOf[header.data.key].safeParse(header.data.args);
  if (!args.success) {
    return fallback;
  }
  const localeResult = NotificationLocaleSchema.safeParse(locale);
  const catalog = catalogs[localeResult.success ? Intl.getCanonicalLocales(locale)[0] : 'en'];
  const message = catalog?.version === 1 ? catalog.messages[header.data.key] : undefined;
  if (!message) {
    return fallback;
  }
  // Check placeholders before substitution; values containing braces, HTML or $ sequences stay verbatim.
  const keys = new Set(Object.keys(args.data));
  const placeholders = Array.from(`${message.title}${message.body}`.matchAll(/\{(\w+)\}/g), (match) => match[1]);
  if (placeholders.some((key) => !keys.has(key)) || [...keys].some((key) => !placeholders.includes(key))) {
    return fallback;
  }
  const values = args.data as Record<string, string | number>;
  const render = (text: string) => text.replaceAll(/\{(\w+)\}/g, (_match, key: string) => String(values[key]));
  return { title: render(message.title), body: render(message.body) };
};
