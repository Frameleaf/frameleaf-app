/**
 * One table from each setting to the words on its page (FL-368): its on-screen label, how its
 * options read, and the page it lives on. Change history, "Review changes" before a save and
 * Copy settings all describe a change through `describeChange`, so a change reads the same
 * everywhere: "Star ratings turned on", "Look for updates: Never → Every day", never
 * "Ratings › Enabled: false → true".
 *
 * A page that is rebuilt in plain words adds one line per setting to `SERVER_WORDS` or
 * `PREFERENCE_WORDS`. A setting without a line yet still reads in words (On, Off, Empty, a secret
 * is never shown), under a label made from its name; `settings without words` in the spec lists
 * them so the next stories can see what is left.
 */
import type { MessageFormatter, Translations } from 'svelte-i18n';
import { presentedArea, SETTINGS_AREAS, type SettingsAreaId } from '$lib/frameleaf/settings-areas';
import {
  configPathLabel,
  isSecretConfigPath,
  reviewValue,
  sectionForConfigPath,
} from '$lib/frameleaf/system-config-draft';

export type SettingKind = 'server' | 'preference';

type Words = {
  label: Translations;
  /** How a stored value reads: its option's words by stored value, or a function for numbers with a unit. */
  values?: Record<string, Translations> | (($t: MessageFormatter, value: unknown) => string | undefined);
};

const GIB = 1024 ** 3;
const count =
  (key: Translations) =>
  ($t: MessageFormatter, value: unknown): string | undefined =>
    typeof value === 'number' ? $t(key, { values: { count: value } }) : undefined;

const LEVELS = Object.fromEntries(
  ['fatal', 'error', 'warn', 'log', 'debug', 'verbose'].map((level) => [
    level,
    `frameleaf_srvadv_trouble_level_${level}` as Translations,
  ]),
);

/** Server settings, by their path in the saved settings. */
export const SERVER_WORDS: Readonly<Record<string, Words>> = Object.freeze({
  // People & sharing
  'server.publicUsers': { label: 'frameleaf_sharing_find_label' },
  // Server & updates › Server name & welcome
  'server.name': { label: 'frameleaf_server_identity_name' },
  'server.loginPageMessage': { label: 'frameleaf_server_identity_welcome' },
  'server.lanDiscovery': { label: 'frameleaf_server_identity_lan' },
  // Server & updates › Updates
  'newVersionCheck.enabled': { label: 'frameleaf_server_updates_look' },
  'newVersionCheck.frequency': {
    label: 'frameleaf_words_updates_frequency',
    values: { daily: 'frameleaf_server_updates_look_daily', weekly: 'frameleaf_server_updates_look_weekly' },
  },
  'newVersionCheck.channel': {
    label: 'frameleaf_server_updates_early',
    values: { stable: 'frameleaf_kit_off', 'release-candidate': 'frameleaf_kit_on' },
  },
  // Server & updates › Maps & places
  'map.enabled': { label: 'frameleaf_server_maps_show' },
  'map.lightStyle': { label: 'frameleaf_server_maps_style_light' },
  'map.darkStyle': { label: 'frameleaf_server_maps_style_dark' },
  'reverseGeocoding.enabled': { label: 'frameleaf_server_maps_name' },
  // Server & updates › Troubleshooting
  'logging.enabled': { label: 'frameleaf_srvadv_trouble_keep' },
  'logging.level': { label: 'frameleaf_srvadv_trouble_amount', values: LEVELS },
  'analytics.enabled': { label: 'frameleaf_srvadv_trouble_analytics_keep' },
  'analytics.historyDays': {
    label: 'frameleaf_srvadv_trouble_analytics_for',
    values: count('frameleaf_srvadv_trouble_analytics_days'),
  },
  // Server & updates › Custom styling
  'theme.customCss': { label: 'frameleaf_srvadv_styling_sheet' },
  'theme.customCssEnabled': { label: 'frameleaf_srvadv_styling_use' },
  // Notifications › Email delivery
  'notifications.smtp.enabled': { label: 'frameleaf_notify_delivery_send' },
  'notifications.smtp.from': { label: 'frameleaf_notify_delivery_sender' },
  'notifications.smtp.replyTo': { label: 'frameleaf_notify_delivery_reply' },
  'notifications.smtp.transport.host': { label: 'frameleaf_notify_delivery_host' },
  'notifications.smtp.transport.port': { label: 'frameleaf_notify_delivery_port' },
  'notifications.smtp.transport.username': { label: 'frameleaf_notify_delivery_account' },
  'notifications.smtp.transport.password': { label: 'frameleaf_notify_delivery_password' },
  'notifications.smtp.transport.secure': { label: 'frameleaf_notify_delivery_secure' },
  'notifications.smtp.transport.ignoreCert': { label: 'frameleaf_notify_delivery_ignore_cert' },
  'templates.email.welcomeTemplate': { label: 'frameleaf_notify_wording_welcome' },
  'templates.email.albumInviteTemplate': { label: 'frameleaf_notify_wording_invite' },
  'templates.email.albumUpdateTemplate': { label: 'frameleaf_notify_wording_update' },
});

const TOOLS: Record<string, string> = {
  folders: 'folders',
  memories: 'memories',
  people: 'people',
  sharedLinks: 'shared_links',
  tags: 'tags',
  ratings: 'ratings',
  recentlyAdded: 'recent',
};
const toolWords = Object.fromEntries(
  Object.entries(TOOLS).flatMap(([path, id]) => [
    [`${path}.enabled`, { label: `frameleaf_prefs_tools_${id}` as Translations }],
    [`${path}.sidebarWeb`, { label: `frameleaf_words_sidebar_${id}` as Translations }],
  ]),
) as Record<string, Words>;

/** Personal preferences, by their path in the account's preferences. */
export const PREFERENCE_WORDS: Readonly<Record<string, Words>> = Object.freeze({
  ...toolWords,
  'cast.gCastEnabled': { label: 'frameleaf_prefs_tools_cast' },
  'memories.duration': {
    label: 'frameleaf_prefs_tools_memories_duration',
    values: count('frameleaf_prefs_tools_seconds'),
  },
  'people.minimumFaces': {
    label: 'frameleaf_prefs_tools_people_minimum',
    values: count('frameleaf_prefs_tools_photos'),
  },
  'albums.defaultAssetOrder': {
    label: 'frameleaf_prefs_look_albums',
    values: { desc: 'newest_first', asc: 'oldest_first' },
  },
  'download.archiveSize': {
    label: 'frameleaf_prefs_downloads_split',
    values: ($t, value) =>
      typeof value === 'number'
        ? $t('frameleaf_prefs_downloads_size_gb', { values: { size: Math.round((value / GIB) * 100) / 100 } })
        : undefined,
  },
  'download.includeEmbeddedVideos': { label: 'frameleaf_prefs_downloads_motion_label' },
  'emailNotifications.enabled': { label: 'frameleaf_notify_yours_send' },
  'emailNotifications.albumInvite': { label: 'frameleaf_notify_yours_shares' },
  'emailNotifications.albumUpdate': { label: 'frameleaf_notify_yours_updates' },
  'avatar.color': { label: 'frameleaf_prefs_colour' },
  'purchase.showSupportBadge': { label: 'frameleaf_words_support_badge' },
});

/** The page a personal preference lives on, by the first part of its path. */
const PREFERENCE_PAGES: Record<string, { area: SettingsAreaId; section: string }> = {
  albums: { area: 'preferences', section: 'app-settings' },
  download: { area: 'preferences', section: 'download-settings' },
  emailNotifications: { area: 'notifications', section: 'email-preferences' },
  avatar: { area: 'preferences', section: 'account' },
  purchase: { area: 'preferences', section: 'user-purchase-settings' },
  cast: { area: 'preferences', section: 'feature' },
  ...Object.fromEntries(Object.keys(TOOLS).map((path) => [path, { area: 'preferences', section: 'feature' }])),
};

export type SettingPage = { area: SettingsAreaId; section?: string };

/** The page a setting lives on, where the app knows it. */
export const settingPage = (kind: SettingKind, path: string): SettingPage | undefined => {
  if (kind === 'preference') {
    return PREFERENCE_PAGES[path.split('.', 1)[0]];
  }
  if (path === 'server.publicUsers') {
    return { area: 'sharing' };
  }
  const section = sectionForConfigPath(path);
  const area = section ? SETTINGS_AREAS.find((item) => item.sections.includes(section))?.id : undefined;
  return area && section ? { area: presentedArea(area, section), section } : undefined;
};

const wordsFor = (kind: SettingKind, path: string) => (kind === 'server' ? SERVER_WORDS : PREFERENCE_WORDS)[path];

/** Whether a setting has its own line in the table (the spec lists the ones that do not yet). */
export const hasWords = (kind: SettingKind, path: string) => wordsFor(kind, path) !== undefined;

/** The label of a setting as its page says it. */
export const settingLabel = ($t: MessageFormatter, kind: SettingKind, path: string) => {
  const words = wordsFor(kind, path);
  if (words) {
    return $t(words.label);
  }
  // A schedule is stored as an expression; nobody is shown that word.
  if (path.endsWith('.cronExpression')) {
    return $t('frameleaf_words_schedule');
  }
  return configPathLabel(kind === 'preference' ? `preferences.${path}` : path);
};

/** One stored value in words. A secret is never shown. */
export const settingValue = ($t: MessageFormatter, kind: SettingKind, path: string, value: unknown): string => {
  if (kind === 'server' && isSecretConfigPath(path)) {
    return value ? $t('frameleaf_words_secret_saved') : $t('frameleaf_words_not_set');
  }
  const words = wordsFor(kind, path);
  if (words?.values && value !== null && value !== undefined && value !== '') {
    const said =
      typeof words.values === 'function'
        ? words.values($t, value)
        : words.values[String(value)] && $t(words.values[String(value)]);
    if (said) {
      return said;
    }
  }
  if (path.endsWith('.cronExpression') && value) {
    return $t('frameleaf_words_schedule_custom');
  }
  const shown = reviewValue(kind === 'server' ? path : '', value);
  switch (shown.kind) {
    case 'secret': {
      return $t('frameleaf_words_secret_saved');
    }
    case 'empty': {
      return $t('frameleaf_words_empty');
    }
    case 'on': {
      return $t('frameleaf_kit_on');
    }
    case 'off': {
      return $t('frameleaf_kit_off');
    }
    default: {
      return shown.text;
    }
  }
};

export type ChangeWords = {
  label: string;
  before: string;
  after: string;
  /** The change as one sentence: "Star ratings turned on", "Look for updates: Never → Every day". */
  said: string;
  page?: SettingPage;
};

/** A change in the words on the page it came from. */
export const describeChange = (
  $t: MessageFormatter,
  kind: SettingKind,
  change: { path: string; before: unknown; after: unknown },
): ChangeWords => {
  const label = settingLabel($t, kind, change.path);
  const before = settingValue($t, kind, change.path, change.before);
  const after = settingValue($t, kind, change.path, change.after);
  const said =
    typeof change.after === 'boolean' && !hasOptionWords(kind, change.path)
      ? $t(change.after ? 'frameleaf_words_turned_on' : 'frameleaf_words_turned_off', { values: { label } })
      : $t('frameleaf_words_changed', { values: { label, before, after } });
  return { label, before, after, said, page: settingPage(kind, change.path) };
};

const hasOptionWords = (kind: SettingKind, path: string) => wordsFor(kind, path)?.values !== undefined;
