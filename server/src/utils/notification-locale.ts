import z from 'zod';
import type { UserPreferences } from 'src/types.js';

/** Origin-only descriptors. These never enter NotificationDto or the encrypted push wire payload. */
const name = z.string();
const count = z.int().nonnegative();
const activationArguments = z.object({ step: z.int().positive(), total: z.int().positive() }).strict();
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
  'reconciliation-missing-one': z.object({}).strict(),
  'reconciliation-missing-many': z.object({ count }).strict(),
  'memories-one': z.object({}).strict(),
  'memories-many': z.object({ count }).strict(),
  'partner-added': z.object({ senderName: name }).strict(),
  'partner-removed': z.object({ senderName: name }).strict(),
  'album-role-editor': z.object({ albumName: name }).strict(),
  'album-role-owner': z.object({ albumName: name }).strict(),
  'album-role-viewer': z.object({ albumName: name }).strict(),
  'studio-export-ready': z.object({}).strict(),
  'studio-export-ready-named': z.object({ label: name }).strict(),
  'studio-export-failed': z.object({}).strict(),
  'studio-export-failed-named': z.object({ label: name }).strict(),
  'backup-stale-one': z.object({ deviceName: name }).strict(),
  'backup-stale-many': z.object({ deviceName: name, count }).strict(),
  'activation-plan-active': activationArguments,
  'activation-server-notified': activationArguments,
  'activation-preparing-storage': activationArguments,
  'activation-first-backup-complete': activationArguments,
  'activation-first-backup-failed': activationArguments,
  'activation-first-backup-running': activationArguments,
  'activation-first-backup-scheduled': activationArguments,
  'album-invite-anonymous': z.object({ albumName: name }).strict(),
  'cloud-heartbeat-failed': z.object({ count, error: name }).strict(),
  'license-grace': z.object({ until: z.iso.date() }).strict(),
  'license-expired': z.object({}).strict(),
  'buddy-backup-stale': z.object({}).strict(),
  'buddy-backup-first-stale': z.object({}).strict(),
  'buddy-storage-low': z.object({}).strict(),
  'buddy-pairing-ended': z.object({ readUntil: z.iso.datetime() }).strict(),
  'buddy-access-blocked': z.object({}).strict(),
  // FL-406: the remaining system notices (FL-329 residue)
  'cloud-ml-migration': z.object({}).strict(),
  'cloud-ml-migration-removed-one': z.object({ names: name }).strict(),
  'cloud-ml-migration-removed-many': z.object({ names: name }).strict(),
  'cloud-ml-migration-jobs-one': z.object({}).strict(),
  'cloud-ml-migration-jobs-many': z.object({ count }).strict(),
  'cloud-ml-migration-workers-one': z.object({}).strict(),
  'cloud-ml-migration-workers-many': z.object({ count }).strict(),
  'admin-granted': z.object({ name }).strict(),
  'cloud-description-budget': z.object({ budget: name }).strict(),
  'buddy-backup-incomplete': z.object({ error: name }).strict(),
  'relay-disconnected': z.object({ since: name }).strict(),
  'relay-disconnected-error': z.object({ since: name, error: name }).strict(),
  'edge-certificate-address': z.object({ error: name, nextAttemptAt: name }).strict(),
  'edge-certificate-address-expiring': z.object({ error: name, nextAttemptAt: name, until: name }).strict(),
  'edge-certificate-domain': z.object({ error: name, nextAttemptAt: name }).strict(),
  'edge-certificate-domain-expiring': z.object({ error: name, nextAttemptAt: name, until: name }).strict(),
  'cloud-region-mismatch': z.object({}).strict(),
  'cloud-clone-suspected': z.object({}).strict(),
  'mail-needs-sign-in': z.object({ provider: name }).strict(),
  'cloud-linked': z.object({ account: name }).strict(),
  'cloud-linked-unnamed': z.object({}).strict(),
  'cloud-unlinked': z.object({}).strict(),
  'cloud-revoked': z.object({ reason: name }).strict(),
  'cloud-message': z.object({ message: name }).strict(),
  'cloud-hostname-failing': z.object({ host: name, problem: name }).strict(),
  'cloud-relink-key': z.object({}).strict(),
  'cloud-relink-command': z.object({}).strict(),
  'cloud-identity-key-damaged': z.object({}).strict(),
  'cloud-identity-key-expired': z.object({}).strict(),
  'plan-tier-asked': z.object({ current: name, suggested: name }).strict(),
  'plan-tier-accepted': z.object({ suggested: name }).strict(),
  'plan-tier-declined': z.object({ current: name }).strict(),
  'plan-tier-declined-paused': z.object({ current: name }).strict(),
  'plan-full-upgrade': z.object({}).strict(),
  'plan-full-ask-organiser': z.object({}).strict(),
  'cloud-backup-failed': z.object({ error: name }).strict(),
  'cloud-backup-key-locked': z.object({}).strict(),
  'cloud-backup-check-problems': z.object({ missing: count, damaged: count, incomplete: count }).strict(),
  'cloud-backup-check-failed': z.object({ error: name }).strict(),
  'cloud-backup-cleanup-failed': z.object({ error: name }).strict(),
  'cloud-restore-failed': z.object({ error: name }).strict(),
  'studio-export-cancelled': z.object({}).strict(),
  'studio-export-cancelled-named': z.object({ label: name }).strict(),
  'studio-render-progress': z.object({ percent: count }).strict(),
  'studio-render-progress-named': z.object({ label: name, percent: count }).strict(),
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
      'reconciliation-missing-one': {
        title: 'Backup needs attention',
        body: 'One item on this device is not on your server yet',
      },
      'reconciliation-missing-many': {
        title: 'Backup needs attention',
        body: '{count} items on this device are not on your server yet',
      },
      'memories-one': { title: 'Memories', body: 'A new memory is ready' },
      'memories-many': { title: 'Memories', body: '{count} new memories are ready' },
      'partner-added': { title: 'Access changed', body: '{senderName} shared their library with you' },
      'partner-removed': { title: 'Access changed', body: '{senderName} stopped sharing their library with you' },
      'album-role-editor': { title: 'Access changed', body: 'Your role in {albumName} is now editor' },
      'album-role-owner': { title: 'Access changed', body: 'Your role in {albumName} is now owner' },
      'album-role-viewer': { title: 'Access changed', body: 'Your role in {albumName} is now viewer' },
      'studio-export-ready': { title: 'Render finished', body: 'Your Studio export is ready' },
      'studio-export-ready-named': { title: 'Render finished', body: '{label} is ready' },
      'studio-export-failed': { title: 'Render failed', body: 'Your Studio export could not be finished' },
      'studio-export-failed-named': { title: 'Render failed', body: '{label} could not be finished' },
      'backup-stale-one': { title: 'Backup is out of date', body: '{deviceName} has not backed up for 1 day' },
      'backup-stale-many': { title: 'Backup is out of date', body: '{deviceName} has not backed up for {count} days' },
      'activation-plan-active': { title: 'Cloud Backup setup', body: '{step} of {total} · Activating your plan' },
      'activation-server-notified': { title: 'Cloud Backup setup', body: '{step} of {total} · Notifying your server' },
      'activation-preparing-storage': { title: 'Cloud Backup setup', body: '{step} of {total} · Preparing storage' },
      'activation-first-backup-complete': {
        title: 'Cloud Backup setup',
        body: '{step} of {total} · First backup complete',
      },
      'activation-first-backup-failed': {
        title: 'Cloud Backup setup',
        body: '{step} of {total} · First backup needs attention',
      },
      'activation-first-backup-running': {
        title: 'Cloud Backup setup',
        body: '{step} of {total} · First backup running',
      },
      'activation-first-backup-scheduled': {
        title: 'Cloud Backup setup',
        body: '{step} of {total} · First backup scheduled',
      },
      'album-invite-anonymous': {
        title: 'Shared Album Invitation',
        body: 'An album ({albumName}) was shared with you',
      },
      'cloud-heartbeat-failed': {
        title: 'This server cannot reach Frameleaf Cloud',
        body: 'The last {count} check-ins failed ({error}). Cloud features may pause; local features keep working.',
      },
      'license-grace': {
        title: 'Your Frameleaf Cloud renewal did not go through',
        body: 'Remote access and cloud backup keep working until {until}. Update your payment method in your Frameleaf account to avoid a pause. Local features are not affected.',
      },
      'license-expired': {
        title: 'Your Frameleaf Cloud plan has ended',
        body: 'Remote access and cloud backup are paused. Everything else on this server, including every photo, keeps working.',
      },
      'buddy-backup-stale': {
        title: 'Buddy Backup is out of date',
        body: 'Your last complete restore point is more than three days old. Check the sending status.',
      },
      'buddy-backup-first-stale': {
        title: 'Buddy Backup is out of date',
        body: 'Buddy Backup has not completed its first restore point after three days. Check the sending status.',
      },
      'buddy-storage-low': {
        title: 'Buddy storage is running low',
        body: 'Increase the hosting capacity or free space on the volume. Retained backups will not be deleted to make room.',
      },
      'buddy-pairing-ended': {
        title: 'Your Buddy pairing has ended',
        body: 'Recover your backup before {readUntil}. New backups have stopped.',
      },
      'buddy-access-blocked': {
        title: 'Buddy access was blocked',
        body: 'The hosted encrypted vault remains on disk. Contact your buddy to arrange recovery.',
      },
      // FL-406: the remaining system notices (FL-329 residue)
      'cloud-ml-migration': {
        title: 'Cloud processing moved to Frameleaf Cloud',
        body: 'Frameleaf Cloud replaces the previous cloud processing service. The work that used it is not sent anywhere else. Choose where it runs under Processing destinations, or add Frameleaf Cloud.',
      },
      'cloud-ml-migration-removed-one': {
        title: 'Cloud processing moved to Frameleaf Cloud',
        body: 'The cloud processing destination {names} was removed: Frameleaf Cloud replaces the previous cloud processing service. The work that used it is not sent anywhere else. Choose where it runs under Processing destinations, or add Frameleaf Cloud.',
      },
      'cloud-ml-migration-removed-many': {
        title: 'Cloud processing moved to Frameleaf Cloud',
        body: 'The cloud processing destinations {names} were removed: Frameleaf Cloud replaces the previous cloud processing service. The work that used it is not sent anywhere else. Choose where it runs under Processing destinations, or add Frameleaf Cloud.',
      },
      'cloud-ml-migration-jobs-one': {
        title: 'Cloud processing moved to Frameleaf Cloud',
        body: '1 unfinished job stopped and can be started again.',
      },
      'cloud-ml-migration-jobs-many': {
        title: 'Cloud processing moved to Frameleaf Cloud',
        body: '{count} unfinished jobs stopped and can be started again.',
      },
      'cloud-ml-migration-workers-one': {
        title: 'Cloud processing moved to Frameleaf Cloud',
        body: '1 render worker was signed out.',
      },
      'cloud-ml-migration-workers-many': {
        title: 'Cloud processing moved to Frameleaf Cloud',
        body: '{count} render workers were signed out.',
      },
      'admin-granted': {
        title: 'New administrator',
        body: '{name} became an administrator through Frameleaf Cloud',
      },
      'cloud-description-budget': {
        title: 'Automatic descriptions paused for today',
        body: "Describing new photos with Frameleaf Cloud reached today's budget of ${budget}. New photos wait and are described from tomorrow; nothing is sent to another destination.",
      },
      'buddy-backup-incomplete': {
        title: 'Buddy Backup needs attention',
        body: '{error}',
      },
      'relay-disconnected': {
        title: 'Remote access relay disconnected',
        body: 'This server has not been connected to the Frameleaf relay since {since}. It keeps trying; at home it works as before.',
      },
      'relay-disconnected-error': {
        title: 'Remote access relay disconnected',
        body: 'This server has not been connected to the Frameleaf relay since {since}. It keeps trying; at home it works as before. The last problem was: {error}',
      },
      'edge-certificate-address': {
        title: 'Remote access certificate could not be renewed',
        body: 'The certificate for this server’s Frameleaf address could not be issued ({error}). It is retried automatically, next at {nextAttemptAt}.',
      },
      'edge-certificate-address-expiring': {
        title: 'Remote access certificate could not be renewed',
        body: 'The certificate for this server’s Frameleaf address could not be issued ({error}). It is retried automatically, next at {nextAttemptAt}. The current certificate works until {until}.',
      },
      'edge-certificate-domain': {
        title: 'Remote access certificate could not be renewed',
        body: 'The certificate for your custom domain could not be issued ({error}). It is retried automatically, next at {nextAttemptAt}.',
      },
      'edge-certificate-domain-expiring': {
        title: 'Remote access certificate could not be renewed',
        body: 'The certificate for your custom domain could not be issued ({error}). It is retried automatically, next at {nextAttemptAt}. The current certificate works until {until}.',
      },
      'cloud-region-mismatch': {
        title: 'Cloud processing is using the wrong region',
        body: 'Frameleaf Cloud refused cloud processing because this server is using another region than its Frameleaf account’s data region, even after reading Frameleaf Cloud’s service list and this server’s link again. Cloud processing stays off until this is fixed: check that FRAMELEAF_CLOUD_URL points to Frameleaf Cloud, then link the server again in Administration > Frameleaf Cloud.',
      },
      'cloud-clone-suspected': {
        title: 'Two servers are using this server’s identity',
        body: 'Frameleaf Cloud saw this server’s key start from two places. If you copied this server, give the copy its own identity folder. Cloud backup and cloud processing pause until this is resolved: the account owner can confirm this server in the Frameleaf account, or it clears on its own after 24 hours without a restart.',
      },
      'mail-needs-sign-in': {
        title: 'Email stopped: sign in to {provider} again',
        body: '{provider} is asking you to sign in again, because the account’s password changed or Frameleaf’s access was removed. Emails are not sent until you do; invitations and album updates appear in the app only. Open Settings > Notifications > Email delivery and choose Sign in again.',
      },
      'cloud-linked': {
        title: 'Server linked to Frameleaf',
        body: 'This server is linked to {account}. Cloud features you turn on use this link.',
      },
      'cloud-linked-unnamed': {
        title: 'Server linked to Frameleaf',
        body: 'This server is linked to a Frameleaf account. Cloud features you turn on use this link.',
      },
      'cloud-unlinked': {
        title: 'Server unlinked from Frameleaf',
        body: 'Cloud features on this server stopped. Local photos, accounts and sign-in are unchanged.',
      },
      'cloud-revoked': {
        title: 'Frameleaf Cloud ended this server’s link',
        body: '{reason} Cloud features stopped; local photos, accounts and sign-in are unchanged. Link again from Settings → Frameleaf Cloud.',
      },
      'cloud-message': {
        title: 'Message from Frameleaf Cloud',
        body: '{message}',
      },
      'cloud-hostname-failing': {
        title: 'Custom hostname needs attention',
        body: '{host} is not fully verified by Frameleaf Cloud. {problem}',
      },
      'cloud-relink-key': {
        title: 'Link this server to Frameleaf again',
        body: 'Frameleaf Cloud no longer accepts this server’s key. Open Settings → Frameleaf Cloud → Account & link, unlink and link again. Nothing on this server is removed.',
      },
      'cloud-relink-command': {
        title: 'Link this server to Frameleaf again',
        body: 'Frameleaf Cloud asked for this server to be linked again. Open Settings → Frameleaf Cloud → Account & link, unlink and link again. Nothing on this server is removed.',
      },
      'cloud-identity-key-damaged': {
        title: 'This server’s new identity key could not be read',
        body: 'The key Frameleaf Cloud accepted in the last key rotation could not be read, so it was set aside and this server keeps using its previous key. A new rotation is under way. If it does not finish before the previous key expires (within a day of that rotation), the link to Frameleaf Cloud stops working and this server must be linked again. This rotation runs whatever the cloud command permissions are set to.',
      },
      'cloud-identity-key-expired': {
        title: 'Link this server to Frameleaf again',
        body: 'This server’s identity key could not be replaced before its previous key expired, so Frameleaf Cloud no longer accepts it. Open Settings → Frameleaf Cloud → Account & link, unlink and link again. Nothing on this server is removed.',
      },
      'plan-tier-asked': {
        title: 'Your backups have outgrown your plan',
        body: 'Your backups no longer fit the {current} plan. Open the Frameleaf app to move to {suggested}.',
      },
      'plan-tier-accepted': {
        title: 'Your Frameleaf plan was upgraded',
        body: 'Your plan is now {suggested}. Backups carry on with the room it gives them.',
      },
      'plan-tier-declined': {
        title: 'Your plan stays the same',
        body: 'Your plan stays at {current}. Backups that do not fit wait until the plan is upgraded.',
      },
      'plan-tier-declined-paused': {
        title: 'Backups are paused: plan full',
        body: 'Your backups no longer fit the {current} plan, so new items wait. Upgrade in the Frameleaf app to back them up.',
      },
      'plan-full-upgrade': {
        title: 'Backups are paused: plan full',
        body: 'Backups no longer fit the Frameleaf plan, so new items wait until it is upgraded. Your library is untouched and restores keep working.',
      },
      'plan-full-ask-organiser': {
        title: 'Backups are paused: plan full',
        body: "Your family's plan is full. Ask your family organiser to upgrade.",
      },
      'cloud-backup-failed': {
        title: 'Cloud backup failed',
        body: 'The last cloud backup stopped: {error}',
      },
      'cloud-backup-key-locked': {
        title: 'Cloud backup is waiting for its key',
        body: 'This server does not keep the backup key. Load it in Settings › Frameleaf Cloud › Cloud backup.',
      },
      'cloud-backup-check-problems': {
        title: 'Cloud backup check found problems',
        body: '{missing} backed-up files are missing and {damaged} are damaged. The next backup uploads them again from this server; {incomplete} earlier backups are marked incomplete.',
      },
      'cloud-backup-check-failed': {
        title: 'Cloud backup check failed',
        body: '{error}',
      },
      'cloud-backup-cleanup-failed': {
        title: 'Cloud backup clean-up failed',
        body: '{error}',
      },
      'cloud-restore-failed': {
        title: 'Restore from cloud backup failed',
        body: '{error}',
      },
      'studio-export-cancelled': {
        title: 'Render cancelled',
        body: 'Your Studio export was cancelled',
      },
      'studio-export-cancelled-named': {
        title: 'Render cancelled',
        body: '{label} was cancelled',
      },
      'studio-render-progress': {
        title: 'Rendering',
        body: 'Your Studio export · {percent}%',
      },
      'studio-render-progress-named': {
        title: 'Rendering',
        body: '{label} · {percent}%',
      },
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
