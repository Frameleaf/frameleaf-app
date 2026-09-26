/**
 * Account preference rules for the Frameleaf account preferences editor (FL-77).
 *
 * Ported from the design template's `account-preferences.mjs`, `account-preference-settings.mjs`
 * and `AccountPreferences.jsx`. These are account preferences, not administrator-enforced module
 * permissions: a feature switch only decides which tools and navigation an account sees and never
 * denies API access. The one administrator-enforced value is `cast.adminDisabled`, which only the
 * admin endpoint accepts.
 *
 * The draft is a flat record keyed by `group.field`, so a change, a comparison and the partial
 * update sent to the server all work on the same keys. Only changed keys are ever sent, which is
 * what keeps unrelated groups (and the account's private Locked choices) untouched.
 */
import { AssetOrder, type UserPreferencesResponseDto, type UserPreferencesUpdateDto } from '@immich/sdk';

/** One GiB is 1,073,741,824 bytes. Archive sizes are stored as exact byte counts. */
export const GIB = 1024 ** 3;

/** The server stores "show the support reminder now" as the epoch. */
export const REMINDER_ALLOWED_NOW = new Date(0).toISOString();

export type AccountPreferencesDraft = {
  'albums.defaultAssetOrder': AssetOrder;
  'folders.enabled': boolean;
  'folders.sidebarWeb': boolean;
  'memories.enabled': boolean;
  'memories.sidebarWeb': boolean;
  /** Seconds; `null` while the field is empty. */
  'memories.duration': number | null;
  'people.enabled': boolean;
  'people.sidebarWeb': boolean;
  /** `null` while the field is empty. */
  'people.minimumFaces': number | null;
  'sharedLinks.enabled': boolean;
  'sharedLinks.sidebarWeb': boolean;
  'tags.enabled': boolean;
  'tags.sidebarWeb': boolean;
  'ratings.enabled': boolean;
  'cast.gCastEnabled': boolean;
  /** Administrator only. */
  'cast.adminDisabled': boolean;
  'recentlyAdded.sidebarWeb': boolean;
  'emailNotifications.enabled': boolean;
  'emailNotifications.albumInvite': boolean;
  'emailNotifications.albumUpdate': boolean;
  /** Exact bytes; `null` while the field is empty or does not resolve to a byte count. */
  'download.archiveSize': number | null;
  'download.includeEmbeddedVideos': boolean;
  'purchase.showSupportBadge': boolean;
  'purchase.hideBuyButtonUntil': string;
};

export type AccountPreferenceKey = keyof AccountPreferencesDraft;
export type AccountPreferencesSection = 'features' | 'preferences' | 'notifications';
/** Who is editing: an administrator editing an account, or the signed-in account itself. */
export type AccountPreferencesEditorRole = 'admin' | 'self';

export type AccountFeatureId = 'folders' | 'memories' | 'people' | 'sharedLinks' | 'tags' | 'ratings' | 'cast';
export type AccountFeature = {
  id: AccountFeatureId;
  enabledKey: AccountPreferenceKey;
  sidebarKey?: AccountPreferenceKey;
};

/** The template's `ACCOUNT_FEATURES`, in its order. */
export const ACCOUNT_FEATURES: readonly AccountFeature[] = [
  { id: 'folders', enabledKey: 'folders.enabled', sidebarKey: 'folders.sidebarWeb' },
  { id: 'memories', enabledKey: 'memories.enabled', sidebarKey: 'memories.sidebarWeb' },
  { id: 'people', enabledKey: 'people.enabled', sidebarKey: 'people.sidebarWeb' },
  { id: 'sharedLinks', enabledKey: 'sharedLinks.enabled', sidebarKey: 'sharedLinks.sidebarWeb' },
  { id: 'tags', enabledKey: 'tags.enabled', sidebarKey: 'tags.sidebarWeb' },
  { id: 'ratings', enabledKey: 'ratings.enabled' },
  { id: 'cast', enabledKey: 'cast.gCastEnabled' },
];

export const ACCOUNT_PREFERENCES_SECTIONS: readonly AccountPreferencesSection[] = [
  'features',
  'preferences',
  'notifications',
];

/** The keys each editor page shows, matching the template's `PAGE_GROUPS`. */
export const SECTION_KEYS: Record<AccountPreferencesSection, readonly AccountPreferenceKey[]> = {
  features: [
    'folders.enabled',
    'folders.sidebarWeb',
    'memories.enabled',
    'memories.sidebarWeb',
    'memories.duration',
    'people.enabled',
    'people.sidebarWeb',
    'people.minimumFaces',
    'sharedLinks.enabled',
    'sharedLinks.sidebarWeb',
    'tags.enabled',
    'tags.sidebarWeb',
    'ratings.enabled',
    'cast.gCastEnabled',
    'cast.adminDisabled',
    'recentlyAdded.sidebarWeb',
  ],
  preferences: [
    'albums.defaultAssetOrder',
    'download.archiveSize',
    'download.includeEmbeddedVideos',
    'purchase.showSupportBadge',
    'purchase.hideBuyButtonUntil',
  ],
  notifications: ['emailNotifications.enabled', 'emailNotifications.albumInvite', 'emailNotifications.albumUpdate'],
};

export const ALL_PREFERENCE_KEYS: readonly AccountPreferenceKey[] = ACCOUNT_PREFERENCES_SECTIONS.flatMap(
  (section) => SECTION_KEYS[section],
);

/** Only the admin endpoint accepts these; the account's own editor never sends them. */
const ADMIN_ONLY_KEYS: ReadonlySet<AccountPreferenceKey> = new Set(['cast.adminDisabled']);

/** An administrator decision, not an account preference: "Reset this page" leaves it alone. */
const RESET_EXCLUDED_KEYS: ReadonlySet<AccountPreferenceKey> = new Set(['cast.adminDisabled']);

/** The server's defaults (`server/src/utils/preferences.ts`), as the template's `createAccountPreferences`. */
export const createDefaultDraft = (): AccountPreferencesDraft => ({
  'albums.defaultAssetOrder': AssetOrder.Desc,
  'folders.enabled': false,
  'folders.sidebarWeb': false,
  'memories.enabled': true,
  'memories.sidebarWeb': false,
  'memories.duration': 5,
  'people.enabled': true,
  'people.sidebarWeb': false,
  'people.minimumFaces': 3,
  'sharedLinks.enabled': true,
  'sharedLinks.sidebarWeb': false,
  'tags.enabled': false,
  'tags.sidebarWeb': false,
  'ratings.enabled': false,
  'cast.gCastEnabled': false,
  'cast.adminDisabled': false,
  'recentlyAdded.sidebarWeb': false,
  'emailNotifications.enabled': true,
  'emailNotifications.albumInvite': true,
  'emailNotifications.albumUpdate': true,
  'download.archiveSize': 4 * GIB,
  'download.includeEmbeddedVideos': false,
  'purchase.showSupportBadge': true,
  'purchase.hideBuyButtonUntil': new Date(2022, 1, 12).toISOString(),
});

export const draftFromPreferences = (preferences: UserPreferencesResponseDto): AccountPreferencesDraft => ({
  'albums.defaultAssetOrder': preferences.albums.defaultAssetOrder,
  'folders.enabled': preferences.folders.enabled,
  'folders.sidebarWeb': preferences.folders.sidebarWeb,
  'memories.enabled': preferences.memories.enabled,
  'memories.sidebarWeb': preferences.memories.sidebarWeb,
  'memories.duration': preferences.memories.duration,
  'people.enabled': preferences.people.enabled,
  'people.sidebarWeb': preferences.people.sidebarWeb,
  'people.minimumFaces': preferences.people.minimumFaces ?? 3,
  'sharedLinks.enabled': preferences.sharedLinks.enabled,
  'sharedLinks.sidebarWeb': preferences.sharedLinks.sidebarWeb,
  'tags.enabled': preferences.tags.enabled,
  'tags.sidebarWeb': preferences.tags.sidebarWeb,
  'ratings.enabled': preferences.ratings.enabled,
  'cast.gCastEnabled': preferences.cast.gCastEnabled,
  'cast.adminDisabled': preferences.cast.adminDisabled,
  'recentlyAdded.sidebarWeb': preferences.recentlyAdded.sidebarWeb,
  'emailNotifications.enabled': preferences.emailNotifications.enabled,
  'emailNotifications.albumInvite': preferences.emailNotifications.albumInvite,
  'emailNotifications.albumUpdate': preferences.emailNotifications.albumUpdate,
  'download.archiveSize': preferences.download.archiveSize,
  'download.includeEmbeddedVideos': preferences.download.includeEmbeddedVideos,
  'purchase.showSupportBadge': preferences.purchase.showSupportBadge,
  'purchase.hideBuyButtonUntil': preferences.purchase.hideBuyButtonUntil,
});

export const changedPreferenceKeys = (
  baseline: AccountPreferencesDraft,
  draft: AccountPreferencesDraft,
  keys: readonly AccountPreferenceKey[] = ALL_PREFERENCE_KEYS,
): AccountPreferenceKey[] => keys.filter((key) => !Object.is(draft[key], baseline[key]));

export const isDraftDirty = (
  baseline: AccountPreferencesDraft,
  draft: AccountPreferencesDraft,
  keys: readonly AccountPreferenceKey[] = ALL_PREFERENCE_KEYS,
) => changedPreferenceKeys(baseline, draft, keys).length > 0;

const isPositiveWholeNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;

export type AccountPreferencesValidationError = 'minimum_faces' | 'memory_duration' | 'archive_size';

/**
 * The template's save checks, in its order. Only changed values are checked: an unchanged value is
 * never sent, so an older stored value can never block saving something else.
 */
export const validateDraft = (
  baseline: AccountPreferencesDraft,
  draft: AccountPreferencesDraft,
  keys: readonly AccountPreferenceKey[] = ALL_PREFERENCE_KEYS,
): AccountPreferencesValidationError | null => {
  const changed = new Set(changedPreferenceKeys(baseline, draft, keys));
  if (changed.has('people.minimumFaces') && !isPositiveWholeNumber(draft['people.minimumFaces'])) {
    return 'minimum_faces';
  }
  if (changed.has('memories.duration') && !isPositiveWholeNumber(draft['memories.duration'])) {
    return 'memory_duration';
  }
  if (changed.has('download.archiveSize') && !isPositiveWholeNumber(draft['download.archiveSize'])) {
    return 'archive_size';
  }
  return null;
};

/**
 * The partial update for the changed keys only. The account's own editor never sends the
 * administrator's casting decision, and nobody sends the casting choice while casting is turned
 * off (the server keeps the account's stored choice for when it is allowed again).
 */
export const preferencesPatch = (
  baseline: AccountPreferencesDraft,
  draft: AccountPreferencesDraft,
  role: AccountPreferencesEditorRole,
  keys: readonly AccountPreferenceKey[] = ALL_PREFERENCE_KEYS,
): UserPreferencesUpdateDto => {
  const patch: Record<string, Record<string, unknown>> = {};
  for (const key of changedPreferenceKeys(baseline, draft, keys)) {
    if (role === 'self' && ADMIN_ONLY_KEYS.has(key)) {
      continue;
    }
    if (key === 'cast.gCastEnabled' && draft['cast.adminDisabled']) {
      continue;
    }
    const [group, field] = key.split('.', 2);
    patch[group] ??= {};
    patch[group][field] = draft[key];
  }
  return patch as UserPreferencesUpdateDto;
};

/** Turning email off also turns off album invitations and updates, as in the template. */
export const withEmailNotifications = (draft: AccountPreferencesDraft, enabled: boolean): AccountPreferencesDraft => ({
  ...draft,
  'emailNotifications.enabled': enabled,
  ...(!enabled && { 'emailNotifications.albumInvite': false, 'emailNotifications.albumUpdate': false }),
});

/** "Reset this page": the page's defaults go into the draft; nothing is saved until Save. */
export const resetSection = (
  draft: AccountPreferencesDraft,
  section: AccountPreferencesSection,
  keys: readonly AccountPreferenceKey[] = SECTION_KEYS[section],
): AccountPreferencesDraft => {
  const defaults = createDefaultDraft();
  const next = { ...draft };
  for (const key of keys) {
    if (RESET_EXCLUDED_KEYS.has(key)) {
      continue;
    }
    (next as Record<AccountPreferenceKey, unknown>)[key] = defaults[key];
  }
  return next;
};

/** Bytes shown as GiB in the size field. GiB is a power of two, so this is exact. */
export const archiveSizeToGib = (bytes: number | null): number | null => (bytes === null ? null : bytes / GIB);

/** A GiB value from the size field, rounded to a whole number of bytes (`null` when empty). */
export const gibToArchiveSize = (gib: number | null | undefined): number | null =>
  typeof gib === 'number' && Number.isFinite(gib) ? Math.round(gib * GIB) : null;

/** The support reminder date field: blank means "allow it now". */
export const reminderDateInput = (value: string): string =>
  !value || value === REMINDER_ALLOWED_NOW || !/^\d{4}-\d{2}-\d{2}/.test(value) ? '' : value.slice(0, 10);

export const reminderDateFromInput = (value: string): string =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : REMINDER_ALLOWED_NOW;

export type AccountPreferencesDraftState = {
  baseline: AccountPreferencesDraft;
  draft: AccountPreferencesDraft;
  /** The revision the baseline was loaded at, sent back as `expectedRevision`. */
  revision: string;
  /** Set when the account changed while this draft had unsaved changes. */
  stale: boolean;
};

export const createDraftState = (preferences: UserPreferencesResponseDto): AccountPreferencesDraftState => {
  const baseline = draftFromPreferences(preferences);
  return { baseline, draft: { ...baseline }, revision: preferences.revision, stale: false };
};

/**
 * Newer preferences arrived (a reload, another editor on this page, or a save elsewhere).
 * - Same revision: nothing to do.
 * - No unsaved changes: take them.
 * - Unsaved changes: the draft is never replaced. With `rebaseUnrelated` (an account's own
 *   settings groups, each editing a few keys) the draft moves onto the new revision when none of
 *   its keys changed; otherwise it is marked stale and the next save would be refused, until the
 *   editor loads the latest preferences. The administrator editor follows the template: any
 *   newer revision marks an unsaved draft stale.
 */
export const followLatestPreferences = (
  state: AccountPreferencesDraftState,
  latest: UserPreferencesResponseDto,
  options: { keys?: readonly AccountPreferenceKey[]; rebaseUnrelated?: boolean } = {},
): AccountPreferencesDraftState => {
  const { keys = ALL_PREFERENCE_KEYS, rebaseUnrelated = false } = options;
  if (latest.revision === state.revision) {
    return state;
  }

  const latestDraft = draftFromPreferences(latest);
  if (!isDraftDirty(state.baseline, state.draft, keys)) {
    return { baseline: latestDraft, draft: { ...latestDraft }, revision: latest.revision, stale: false };
  }

  if (rebaseUnrelated && !state.stale && !isDraftDirty(state.baseline, latestDraft, keys)) {
    const draft = { ...latestDraft };
    for (const key of keys) {
      (draft as Record<AccountPreferenceKey, unknown>)[key] = state.draft[key];
    }
    return { baseline: latestDraft, draft, revision: latest.revision, stale: false };
  }

  return { ...state, stale: true };
};
