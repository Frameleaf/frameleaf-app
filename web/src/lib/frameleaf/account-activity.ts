import { AdminAuditAction, type AccountEventResponseDto, type UserAdminHistoryEventResponseDto } from '@frameleaf/sdk';
import {
  mdiAccountCogOutline,
  mdiAccountMultipleOutline,
  mdiAlertCircleOutline,
  mdiCalendarCheckOutline,
  mdiCellphoneKey,
  mdiDialpad,
  mdiFingerprint,
  mdiHistory,
  mdiKeyOutline,
  mdiLinkVariant,
  mdiLinkVariantOff,
  mdiLoginVariant,
  mdiLogoutVariant,
  mdiPuzzleOutline,
  mdiPuzzleRemoveOutline,
  mdiShareVariantOutline,
  mdiShieldKeyOutline,
} from '@mdi/js';
import { DateTime } from 'luxon';
import type { MessageFormatter, Translations } from 'svelte-i18n';
import { describeAdminEvent } from '$lib/frameleaf/account-history';
import { sessionDeviceName } from '$lib/frameleaf/personal-access';

/**
 * Account activity in plain words (FL-824, after the approved prototype's `src/account-activity.mjs`).
 * The server records these events (FL-808: `GET /users/me/activity`, `GET /admin/activity`,
 * `AccountEventAction`); this turns one event into the sentence, the line under it and the icon the
 * two pages show. `action` is plain text on purpose, so an action this page does not know yet gets a
 * general sentence instead of failing.
 */

export type ActivityEvent = AccountEventResponseDto;

/** How long the server keeps activity (`ACCOUNT_EVENT_RETENTION_DAYS`). */
export const ACTIVITY_KEPT_DAYS = 400;
/** Events fetched per page. */
export const ACTIVITY_PAGE_SIZE = 50;
/** How many earlier pages a page may load by itself before it leaves "Show earlier activity" to the person. */
export const ACTIVITY_AUTO_PAGES = 3;
/** The most sign-ins that did not work the household log asks for, to count the last day's. */
export const ACTIVITY_FAILURES_TAKE = 200;
const DAY_MS = 86_400_000;

/** The filter chips, in order. `other` has no chip: it shows under All only. */
export const ACTIVITY_CHIPS = ['all', 'signins', 'security', 'sharing', 'apps'] as const;
export type ActivityChip = (typeof ACTIVITY_CHIPS)[number];
export type ActivityKind = Exclude<ActivityChip, 'all'> | 'other';

/** Every action the server records for an account, with the chip it belongs to. */
const ACTION_KINDS: Record<string, ActivityKind> = {
  'signed-in': 'signins',
  'sign-in-failed': 'signins',
  'signed-out': 'signins',
  'session-revoked': 'signins',
  'password-changed': 'security',
  'pin-changed': 'security',
  'two-factor-changed': 'security',
  'passkey-added': 'security',
  'passkey-removed': 'security',
  'passkeys-removed-by-admin': 'security',
  'api-key-created': 'apps',
  'api-key-deleted': 'apps',
  'shared-link-created': 'sharing',
  'shared-link-removed': 'sharing',
  'partner-added': 'sharing',
  'partner-removed': 'sharing',
  'item-shared': 'sharing',
  'dates-fixed': 'other',
  'app-connected': 'apps',
  'app-disconnected': 'apps',
  'app-denied': 'apps',
  'app-used': 'apps',
};

const isAdminEvent = (event: Pick<ActivityEvent, 'source'>) => event.source === 'admin';

/** What an administrator did to an account (`source: admin`) is always a security row. */
export const activityKind = (event: Pick<ActivityEvent, 'action' | 'source'>): ActivityKind =>
  isAdminEvent(event) ? 'security' : (ACTION_KINDS[event.action] ?? 'other');

/**
 * Rows that offer "This wasn't me" on your own page: sign-ins, failed sign-ins and security changes
 * you made. Signing out is not one (owner, 2026-11-12: there is nothing to undo), and neither is a
 * change an administrator made for you, which was never you.
 */
const WASNT_ME: ReadonlySet<string> = new Set([
  'signed-in',
  'sign-in-failed',
  'password-changed',
  'pin-changed',
  'two-factor-changed',
  'passkey-added',
  'passkey-removed',
]);
export const offersWasntMe = (event: Pick<ActivityEvent, 'action' | 'source' | 'detail' | 'actorId'>) =>
  !isAdminEvent(event) && !event.actorId && event.detail !== 'admin-reset' && WASNT_ME.has(event.action);

/**
 * Whose picture a household-log row shows: whoever did it. That is the administrator for what they
 * did to someone else's account, and otherwise the person the row is about (a failed sign-in for
 * Morgan shows Morgan, as does an app using Morgan's library).
 */
export const pictureOf = (event: Pick<ActivityEvent, 'actorId' | 'userId'>) => event.actorId ?? event.userId;

export type ActivityRow = {
  text: string;
  note?: string;
  icon: string;
  kind: ActivityKind;
  /** A failed sign-in, or an app cut off for safety. */
  warn?: 'didnt-get-in' | 'cut-off';
  wasntMe: boolean;
};

export type DescribeOptions = {
  /** The account's name: the sentence is then about someone else ("Morgan signed in…"), for the household log. */
  name?: string;
  formatBytes?: (bytes: number) => string;
};

const ICONS: Record<ActivityKind, string> = {
  signins: mdiLoginVariant,
  security: mdiShieldKeyOutline,
  sharing: mdiShareVariantOutline,
  apps: mdiPuzzleOutline,
  other: mdiHistory,
};

/** How a sign-in was made (`detail`), as the line under it; a passkey has one wording for everyone. */
const SIGNED_IN_WITH: ReadonlyMap<string, string> = new Map([
  ['password', 'frameleaf_account_activity_note_with_password'],
  ['two-factor', 'frameleaf_account_activity_note_with_two_step'],
  ['oauth', 'frameleaf_account_activity_note_with_provider'],
  ['frameleaf', 'frameleaf_account_activity_note_with_frameleaf'],
]);

const WRITES = /write|upload|create|edit|update|delete/i;

/** "Safari on a Mac", "Frameleaf app on an iPhone", or "" when the server does not know. */
export const activityDevice = ($t: MessageFormatter, event: Pick<ActivityEvent, 'deviceType' | 'deviceOS'>): string => {
  const deviceOS = event.deviceOS?.trim() ?? '';
  const deviceType = event.deviceType?.trim() ?? '';
  if (!deviceOS && !deviceType) {
    return '';
  }
  return sessionDeviceName({ deviceOS, deviceType }, (key, options) => $t(key as Translations, options));
};

/** `home`, `away` (direct or through the relay), or `unknown` when the server does not say. */
export const activityPlace = (via: string | null | undefined): 'home' | 'away' | 'unknown' =>
  via === 'home' ? 'home' : via ? 'away' : 'unknown';

/** The values a sentence with a device and a place takes. */
const whereValues = ($t: MessageFormatter, event: ActivityEvent) => {
  const device = activityDevice($t, event);
  return { device, hasDevice: device ? 'yes' : 'no', place: activityPlace(event.via) };
};

/** A count the server wrote as text; anything else counts as one. */
const countOf = (detail: string | null) => {
  const count = Number(detail);
  return Number.isSafeInteger(count) && count > 0 ? count : 1;
};

/** The device a "signed out a device" row names: the server joins the system and the client with " · ". */
const revokedDevice = ($t: MessageFormatter, subject: string) => {
  const [deviceOS = '', deviceType = ''] = subject.split(' · ', 2);
  return deviceType || /^(ios|ipados|android|mac ?os|os x|windows|linux|chrom)/i.test(deviceOS)
    ? activityDevice($t, { deviceOS, deviceType })
    : subject;
};

/** What an administrator did to an account (the administrator history, FL-76), for the household log. */
const describeAdminRow = (
  $t: MessageFormatter,
  event: ActivityEvent,
  name: string,
  formatBytes: (bytes: number) => string,
): Pick<ActivityRow, 'text' | 'note'> => {
  const actor = event.actorName || $t('frameleaf_account_activity_log_administrator');
  const values = { actor, name };
  const { detail } = event;
  switch (event.action as AdminAuditAction) {
    case AdminAuditAction.AccountCreated: {
      if (!detail) {
        return { text: $t('frameleaf_account_activity_admin_account_created', { values }) };
      }
      break;
    }
    case AdminAuditAction.AccountUpdated: {
      if (detail === 'two-factor-reset') {
        return { text: $t('frameleaf_account_activity_admin_two_step_off', { values }) };
      }
      if (!detail) {
        return { text: $t('frameleaf_account_activity_admin_account_updated', { values }) };
      }
      break;
    }
    case AdminAuditAction.AdminGranted: {
      return { text: $t('frameleaf_account_activity_admin_granted', { values }) };
    }
    case AdminAuditAction.AdminRevoked: {
      return { text: $t('frameleaf_account_activity_admin_revoked', { values }) };
    }
    case AdminAuditAction.QuotaChanged: {
      const bytes = detail === null ? NaN : Number(detail);
      return {
        text: Number.isFinite(bytes)
          ? $t('frameleaf_account_activity_admin_quota', { values: { ...values, size: formatBytes(bytes) } })
          : $t('frameleaf_account_activity_admin_quota_none', { values }),
      };
    }
    case AdminAuditAction.PasswordReset: {
      return { text: $t('frameleaf_account_activity_admin_password_reset', { values }) };
    }
    case AdminAuditAction.PinReset: {
      return { text: $t('frameleaf_account_activity_admin_pin_reset', { values }) };
    }
    case AdminAuditAction.SessionRevoked: {
      return {
        text: detail
          ? $t('frameleaf_account_activity_admin_session_revoked', {
              values: { ...values, device: revokedDevice($t, detail) },
            })
          : $t('frameleaf_account_activity_admin_session_revoked_unknown', { values }),
      };
    }
    default: {
      break;
    }
  }
  // Everything else the administrator history records keeps its own sentence, with whose account and who.
  return {
    text: describeAdminEvent(
      { action: event.action as UserAdminHistoryEventResponseDto['action'], detail },
      $t,
      formatBytes,
    ),
    note: $t('frameleaf_account_activity_admin_other_note', { values }),
  };
};

/**
 * The row for one event. With `name`, the sentence is about someone else ("Morgan signed in…"), for
 * the household log; without it, it is about you ("Signed in…").
 */
export const describeActivity = (
  $t: MessageFormatter,
  event: ActivityEvent,
  { name, formatBytes = String }: DescribeOptions = {},
): ActivityRow => {
  const kind = activityKind(event);
  const you = name === undefined;
  const { subject, detail } = event;
  /** The sentence for you, or its `_named` twin for someone else. */
  const say = (key: string, values: Record<string, string | number> = {}) =>
    $t((you ? key : `${key}_named`) as Translations, { values: { ...values, name: name ?? '' } });
  const row = (text: string, rest: Partial<ActivityRow> = {}): ActivityRow => ({
    text,
    icon: ICONS[kind],
    kind,
    wasntMe: you && offersWasntMe(event),
    ...rest,
  });

  if (isAdminEvent(event)) {
    return row('', {
      ...describeAdminRow($t, event, name ?? subject, formatBytes),
      icon: mdiAccountCogOutline,
      wasntMe: false,
    });
  }

  switch (event.action) {
    case 'signed-in': {
      const how = SIGNED_IN_WITH.get(detail ?? '');
      return row(say('frameleaf_account_activity_signed_in', whereValues($t, event)), {
        note: detail === 'passkey' ? $t('frameleaf_account_activity_note_with_passkey') : how ? say(how) : undefined,
      });
    }
    case 'sign-in-failed': {
      const step = detail === 'two-factor' ? 'two_step' : detail === 'passkey' ? 'passkey' : 'password';
      return row(say(`frameleaf_account_activity_failed_${step}`, whereValues($t, event)), {
        icon: mdiAlertCircleOutline,
        warn: 'didnt-get-in',
        note: detail === 'two-factor' ? $t('frameleaf_account_activity_note_password_right') : undefined,
      });
    }
    case 'signed-out': {
      return row(say('frameleaf_account_activity_signed_out', whereValues($t, event)), { icon: mdiLogoutVariant });
    }
    case 'session-revoked': {
      const from = activityDevice($t, event);
      return row(say('frameleaf_account_activity_session_revoked', { device: revokedDevice($t, subject) }), {
        icon: mdiLogoutVariant,
        note: from ? $t('frameleaf_account_activity_note_from_device', { values: { device: from } }) : undefined,
      });
    }
    case 'password-changed': {
      return row(say('frameleaf_account_activity_password_changed'));
    }
    case 'pin-changed': {
      const verb = detail === 'set' || detail === 'reset' ? detail : 'changed';
      return row(say(`frameleaf_account_activity_pin_${verb}`), { icon: mdiDialpad });
    }
    case 'two-factor-changed': {
      const what =
        detail === 'admin-reset' ? 'admin' : detail === 'moved' ? 'moved' : detail === 'disabled' ? 'off' : 'on';
      return row(say(`frameleaf_account_activity_two_step_${what}`), { icon: mdiCellphoneKey });
    }
    case 'passkey-added': {
      return row(say('frameleaf_account_activity_passkey_added', { subject }), { icon: mdiFingerprint });
    }
    case 'passkey-removed': {
      return row(say('frameleaf_account_activity_passkey_removed', { subject }), { icon: mdiFingerprint });
    }
    case 'passkeys-removed-by-admin': {
      return row(say('frameleaf_account_activity_passkeys_removed_admin', { count: countOf(detail) }), {
        icon: mdiFingerprint,
      });
    }
    case 'api-key-created': {
      return row(say('frameleaf_account_activity_api_key_created', { subject }), { icon: mdiKeyOutline });
    }
    case 'api-key-deleted': {
      return row(say('frameleaf_account_activity_api_key_deleted', { subject }), { icon: mdiKeyOutline });
    }
    case 'shared-link-created': {
      return row(
        subject
          ? say('frameleaf_account_activity_link_created', { subject })
          : say('frameleaf_account_activity_link_created_unnamed'),
        {
          icon: mdiLinkVariant,
          note:
            detail?.toLowerCase() === 'album'
              ? $t('frameleaf_account_activity_note_link_album')
              : $t('frameleaf_account_activity_note_link_photos'),
        },
      );
    }
    case 'shared-link-removed': {
      return row(
        subject
          ? say('frameleaf_account_activity_link_removed', { subject })
          : say('frameleaf_account_activity_link_removed_unnamed'),
        { icon: mdiLinkVariantOff, note: $t('frameleaf_account_activity_note_link_gone') },
      );
    }
    case 'partner-added': {
      return row(say('frameleaf_account_activity_partner_added', { subject }), { icon: mdiAccountMultipleOutline });
    }
    case 'partner-removed': {
      return row(say('frameleaf_account_activity_partner_removed', { subject }), { icon: mdiAccountMultipleOutline });
    }
    case 'item-shared': {
      return row(say('frameleaf_account_activity_item_shared', { subject, count: countOf(detail) }));
    }
    case 'dates-fixed': {
      return row(say('frameleaf_account_activity_dates_fixed', { count: countOf(detail) }), {
        icon: mdiCalendarCheckOutline,
      });
    }
    case 'app-connected': {
      return row(say('frameleaf_account_activity_app_connected', { subject }), {
        note: detail
          ? say(
              WRITES.test(detail)
                ? 'frameleaf_account_activity_note_app_can_add'
                : 'frameleaf_account_activity_note_app_can_look',
            )
          : undefined,
      });
    }
    case 'app-disconnected': {
      if (detail === 'token-reused') {
        return row(say('frameleaf_account_activity_app_cut_off', { subject }), {
          icon: mdiAlertCircleOutline,
          warn: 'cut-off',
          note: say('frameleaf_account_activity_note_app_cut_off'),
        });
      }
      if (detail === 'app-signed-out') {
        return row(say('frameleaf_account_activity_app_signed_out', { subject }), { icon: mdiPuzzleRemoveOutline });
      }
      return row(
        say(
          detail === 'app-deleted'
            ? 'frameleaf_account_activity_app_deleted'
            : 'frameleaf_account_activity_app_disconnected',
          { subject },
        ),
        { icon: mdiPuzzleRemoveOutline, note: say('frameleaf_account_activity_note_app_closed') },
      );
    }
    case 'app-denied': {
      return row(say('frameleaf_account_activity_app_denied', { subject }), {
        icon: mdiPuzzleRemoveOutline,
        note: $t('frameleaf_account_activity_note_app_denied'),
      });
    }
    case 'app-used': {
      return row(say('frameleaf_account_activity_app_used', { subject }), {
        note: $t(
          WRITES.test(detail ?? '')
            ? 'frameleaf_account_activity_note_app_added'
            : 'frameleaf_account_activity_note_app_looked',
        ),
      });
    }
    default: {
      // An action this page does not know yet: say something true instead of failing.
      return row(say('frameleaf_account_activity_other'));
    }
  }
};

const startOfDay = (value: Date | string) =>
  (typeof value === 'string' ? DateTime.fromISO(value) : DateTime.fromJSDate(value)).startOf('day');

/** Whole days between an event and now: 0 today, 1 yesterday. */
export const daysAgo = (createdAt: string, now: Date) =>
  Math.round(startOfDay(now).diff(startOfDay(createdAt), 'days').days);

/** "Today", "Yesterday", "Tuesday 10 November", or "19 June 2025" for another year. */
export const activityDay = ($t: MessageFormatter, createdAt: string, now: Date, locale?: string) => {
  const days = daysAgo(createdAt, now);
  if (days <= 0) {
    return $t('frameleaf_words_history_today');
  }
  if (days === 1) {
    return $t('frameleaf_words_history_yesterday');
  }
  const date = DateTime.fromISO(createdAt).setLocale(locale ?? 'en');
  return date.toLocaleString(
    date.year === now.getFullYear() ? { weekday: 'long', day: 'numeric', month: 'long' } : DateTime.DATE_FULL,
  );
};

/** "8:14 AM", as the viewer's language writes a time. */
export const activityTime = (createdAt: string, locale?: string) =>
  DateTime.fromISO(createdAt)
    .setLocale(locale ?? 'en')
    .toLocaleString(DateTime.TIME_SIMPLE);

/** The events as they came (newest first), as `[{ day, events }]` in that order. */
export const groupByDay = <T extends Pick<ActivityEvent, 'createdAt'>>(
  events: T[],
  dayOf: (createdAt: string) => string,
): { day: string; events: T[] }[] => {
  const days: { day: string; events: T[] }[] = [];
  for (const event of events) {
    const day = dayOf(event.createdAt);
    const last = days.at(-1);
    if (last?.day === day) {
      last.events.push(event);
    } else {
      days.push({ day, events: [event] });
    }
  }
  return days;
};

/** The rows a chip shows: everything under All, else its own kind. */
export const filterActivity = <T extends Pick<ActivityEvent, 'action' | 'source'>>(events: T[], chip: ActivityChip) =>
  chip === 'all' ? events : events.filter((event) => activityKind(event) === chip);

/**
 * "Something to look at": sign-ins that did not work in the last day, among the rows loaded. In the
 * household log the tries are counted for the one account with the most.
 */
export const recentFailures = <T extends Pick<ActivityEvent, 'action' | 'source' | 'createdAt' | 'userId' | 'detail'>>(
  events: T[],
  now: Date,
): { events: T[]; passwordOnly: boolean } | undefined => {
  const since = now.getTime() - DAY_MS;
  const byAccount = new Map<string, T[]>();
  for (const event of events) {
    if (!isAdminEvent(event) && event.action === 'sign-in-failed' && Date.parse(event.createdAt) >= since) {
      const tries = byAccount.get(event.userId);
      if (tries) {
        tries.push(event);
      } else {
        byAccount.set(event.userId, [event]);
      }
    }
  }
  let most: T[] | undefined;
  for (const tries of byAccount.values()) {
    if (!most || tries.length > most.length) {
      most = tries;
    }
  }
  return most
    ? { events: most, passwordOnly: most.every((event) => !event.detail || event.detail === 'password') }
    : undefined;
};

/**
 * Whether the rows loaded hold everything from the last day: either there is nothing earlier on the
 * server, or the oldest row loaded is already more than a day old. Until then a count of the last
 * day's rows is only "so far".
 */
export const coversLastDay = (events: Pick<ActivityEvent, 'createdAt'>[], hasMore: boolean, now: Date) => {
  const oldest = events.at(-1);
  return !hasMore || (oldest !== undefined && Date.parse(oldest.createdAt) < now.getTime() - DAY_MS);
};

/** The newest sign-in that worked, among the rows loaded. */
export const lastSignIn = <T extends Pick<ActivityEvent, 'action' | 'source'>>(events: T[]) =>
  events.find((event) => !isAdminEvent(event) && event.action === 'signed-in');
