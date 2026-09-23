import { ConflictException, ForbiddenException } from '@nestjs/common';
import { get, isEqual, set } from 'lodash-es';
import { createHash } from 'node:crypto';
import type { UserPreferencesUpdateDto } from 'src/dtos/user-preferences.dto.js';
import { AssetOrder, UserMetadataKey } from 'src/enum.js';
import { DeepPartial, UserMetadataItem, UserPreferences } from 'src/types.js';
import { HumanReadableSize } from 'src/utils/bytes.js';
import { emptySuppressionPreferences } from 'src/utils/hidden-content.js';
import { getKeysDeep } from 'src/utils/misc.js';

/**
 * FL-77: preferences plus the Frameleaf admin-enforced casting permission.
 *
 * `cast.adminDisabled` is written only through the admin user-preferences endpoint. While it
 * is true the user's own `cast.gCastEnabled` choice is kept in storage but is reported as
 * false everywhere (see `mapPreferences`) and the user cannot turn it back on. Clearing it
 * lets the user's own choice apply again.
 */
export type FrameleafUserPreferences = UserPreferences & {
  cast: {
    adminDisabled: boolean;
  };
};

export type PreferencesEditor = 'user' | 'admin';

export const CAST_DISABLED_BY_ADMIN_MESSAGE = 'Casting has been turned off by your administrator';
export const PREFERENCES_CHANGED_MESSAGE =
  'These preferences changed after they were loaded. Load the latest preferences and try again.';

const getDefaultPreferences = (): FrameleafUserPreferences => {
  return {
    albums: {
      defaultAssetOrder: AssetOrder.Desc,
    },
    folders: {
      enabled: false,
      sidebarWeb: false,
    },
    memories: {
      enabled: true,
      duration: 5,
      sidebarWeb: false,
    },
    people: {
      enabled: true,
      sidebarWeb: false,
      minimumFaces: 3,
    },
    sharedLinks: {
      enabled: true,
      sidebarWeb: false,
    },
    ratings: {
      enabled: false,
    },
    tags: {
      enabled: false,
      sidebarWeb: false,
    },
    emailNotifications: {
      enabled: true,
      albumInvite: true,
      albumUpdate: true,
    },
    download: {
      archiveSize: HumanReadableSize.GiB * 4,
      includeEmbeddedVideos: false,
    },
    purchase: {
      showSupportBadge: true,
      hideBuyButtonUntil: new Date(2022, 1, 12).toISOString(),
    },
    cast: {
      gCastEnabled: false,
      adminDisabled: false,
    },
    privacy: {
      suppression: emptySuppressionPreferences(),
    },
    recentlyAdded: {
      sidebarWeb: false,
    },
  };
};

export const getPreferences = (metadata: UserMetadataItem[]): FrameleafUserPreferences => {
  const preferences = getDefaultPreferences();
  const item = metadata.find(({ key }) => key === UserMetadataKey.Preferences);
  const partial = item?.value || {};
  for (const property of getKeysDeep(partial)) {
    set(preferences, property, get(partial, property));
  }

  return preferences;
};

export const getPreferencesPartial = (newPreferences: UserPreferences) => {
  const defaultPreferences = getDefaultPreferences();
  const partial: DeepPartial<UserPreferences> = {};
  for (const property of getKeysDeep(defaultPreferences)) {
    const newValue = get(newPreferences, property);
    const isEmpty = [undefined, null, ''].includes(newValue);
    const defaultValue = get(defaultPreferences, property);
    const matchesDefault = newValue === defaultValue || isEqual(newValue, defaultValue);

    if (isEmpty || matchesDefault) {
      continue;
    }

    set(partial, property, newValue);
  }

  return partial;
};

/**
 * FL-77: enforce who may change what before an update is merged.
 * - A user can never set `cast.adminDisabled`; it is dropped from their update.
 * - While casting is turned off by an administrator, a user cannot turn casting on (403), and
 *   a request that sends it as off leaves their stored choice untouched so it applies again
 *   when the administrator allows casting.
 * - An administrator may set `cast.adminDisabled`; while it is (or becomes) true, the user's
 *   own `cast.gCastEnabled` choice is preserved rather than overwritten.
 * - An administrator never rewrites the account's private Locked choices (`privacy`); that
 *   group is dropped from an administrator's update.
 */
export const restrictPreferencesUpdate = (
  current: FrameleafUserPreferences,
  dto: UserPreferencesUpdateDto,
  editor: PreferencesEditor,
): UserPreferencesUpdateDto => {
  // Locked people, pets and tags are the account owner's private choices.
  const { privacy: _privacy, ...withoutPrivacy } = dto;
  const allowed = editor === 'admin' && dto.privacy !== undefined ? withoutPrivacy : dto;

  if (!allowed.cast) {
    return allowed;
  }

  const cast = { ...allowed.cast };

  if (editor === 'user') {
    delete cast.adminDisabled;
    if (current.cast.adminDisabled) {
      if (cast.gCastEnabled === true) {
        throw new ForbiddenException(CAST_DISABLED_BY_ADMIN_MESSAGE);
      }
      delete cast.gCastEnabled;
    }
  } else {
    const adminDisabled = cast.adminDisabled ?? current.cast.adminDisabled;
    if (adminDisabled) {
      delete cast.gCastEnabled;
    }
  }

  return { ...allowed, cast };
};

/** Serialises a value with object keys sorted, so equal preferences always hash the same way. */
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }

  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(',')}}`;
  }

  return JSON.stringify(value) ?? 'null';
};

/**
 * FL-77: a digest of the preferences exactly as they are stored (the partial that
 * `getPreferencesPartial` writes), reported to clients as `revision`. It changes whenever a
 * stored value changes, including values a response does not show as stored (the user's own
 * casting choice while an administrator has turned casting off, or Locked choices hidden from
 * administrators), so an editor can tell that the account changed since it loaded it. No
 * schema change is needed: user_metadata keeps one JSON value per key.
 */
export const getPreferencesRevision = (preferences: FrameleafUserPreferences): string =>
  createHash('sha256')
    .update(canonicalJson(getPreferencesPartial(preferences)))
    .digest('hex')
    .slice(0, 32);

/** FL-77: reject an update made against preferences that have since changed (409). */
export const assertPreferencesRevision = (current: FrameleafUserPreferences, expectedRevision?: string) => {
  if (expectedRevision !== undefined && expectedRevision !== getPreferencesRevision(current)) {
    throw new ConflictException(PREFERENCES_CHANGED_MESSAGE);
  }
};

/**
 * Merges an update into the current preferences. When the update carries `expectedRevision`
 * it is applied only if the stored preferences still match that revision; the field itself is
 * never stored. Only the groups and fields the update names change, so unrelated groups are
 * preserved.
 */
export const mergePreferences = (
  preferences: FrameleafUserPreferences,
  dto: UserPreferencesUpdateDto,
  editor: PreferencesEditor,
) => {
  const { expectedRevision, ...changes } = dto;
  assertPreferencesRevision(preferences, expectedRevision);
  const update = restrictPreferencesUpdate(preferences, changes, editor);
  for (const key of getKeysDeep(update)) {
    set(preferences, key, get(update, key));
  }

  return preferences;
};
