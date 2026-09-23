import { ForbiddenException } from '@nestjs/common';
import { get, isEqual, set } from 'lodash-es';
import { UserPreferencesUpdateDto } from 'src/dtos/user-preferences.dto.js';
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
 */
export const restrictPreferencesUpdate = (
  current: FrameleafUserPreferences,
  dto: UserPreferencesUpdateDto,
  editor: PreferencesEditor,
): UserPreferencesUpdateDto => {
  if (!dto.cast) {
    return dto;
  }

  const cast = { ...dto.cast };

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

  return { ...dto, cast };
};

export const mergePreferences = (
  preferences: FrameleafUserPreferences,
  dto: UserPreferencesUpdateDto,
  editor: PreferencesEditor,
) => {
  const update = restrictPreferencesUpdate(preferences, dto, editor);
  for (const key of getKeysDeep(update)) {
    set(preferences, key, get(update, key));
  }

  return preferences;
};
