import { BadRequestException } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';

export type SuppressionScope = 'owned' | 'visible';

export type SuppressionPreferences = {
  tagIds: string[];
  personIds: string[];
  /** FL-58: the owner's own pets; an asset is suppressed when the owner confirmed one of them in it */
  petIds: string[];
  scope: SuppressionScope;
};

export type HiddenContentFilter = SuppressionPreferences & {
  userId: string;
  includeNsfw: boolean;
};

export type HiddenContentQueryOptions = {
  excludeNsfw?: boolean;
  hiddenContent?: HiddenContentFilter;
  onlyHiddenContent?: HiddenContentFilter;
};

export const emptySuppressionPreferences = (): SuppressionPreferences => ({
  tagIds: [],
  personIds: [],
  petIds: [],
  scope: 'owned',
});

export const hasHiddenContentFilter = (filter?: HiddenContentFilter): filter is HiddenContentFilter => {
  return (
    !!filter &&
    (filter.includeNsfw || filter.tagIds.length > 0 || filter.personIds.length > 0 || filter.petIds.length > 0)
  );
};

export const hasSuppressionPreferences = (
  preferences?: SuppressionPreferences,
): preferences is SuppressionPreferences => {
  return (
    !!preferences &&
    (preferences.tagIds.length > 0 || preferences.personIds.length > 0 || preferences.petIds.length > 0)
  );
};

export const getHiddenContentQueryOptions = (auth: AuthDto): HiddenContentQueryOptions => {
  if (auth.hiddenContent) {
    return { hiddenContent: auth.hiddenContent };
  }

  return auth.hideNsfwAssets ? { excludeNsfw: true } : {};
};

export type SuppressibleEntity = 'person' | 'pet' | 'tag';

const suppressedIdsFor = (filter: HiddenContentFilter, entity: SuppressibleEntity) =>
  entity === 'person' ? filter.personIds : entity === 'pet' ? filter.petIds : filter.tagIds;

/**
 * Owner decision (September 22, 2026): while the session is not unlocked, a person, pet or tag the
 * owner suppressed answers exactly like one that does not exist. `auth.hiddenContent` is only set
 * for such a session, so an unlocked one always sees its suppressed entities. This checks the id
 * itself; a tag nested under a suppressed tag is caught in SQL (`tagIsSuppressed`).
 */
export const isSuppressedWhileLocked = (auth: AuthDto, entity: SuppressibleEntity, id: string): boolean => {
  return !!auth.hiddenContent && suppressedIdsFor(auth.hiddenContent, entity).includes(id);
};

export const getSuppressedOnlyQueryOptions = (auth: AuthDto): HiddenContentQueryOptions => {
  return { onlyHiddenContent: auth.suppressedContent ?? emptyHiddenContentFilter(auth.user.id) };
};

export const requireSuppressedOnlyAccess = (auth: AuthDto, suppressedOnly?: boolean) => {
  if (!suppressedOnly) {
    return;
  }

  if (auth.sharedLink) {
    throw new BadRequestException('suppressedOnly is not available for shared links');
  }

  if (!auth.session?.hasElevatedPermission) {
    throw new BadRequestException('suppressedOnly requires an elevated session');
  }
};

export const getPrivacyQueryOptions = (auth: AuthDto, suppressedOnly?: boolean): HiddenContentQueryOptions => {
  requireSuppressedOnlyAccess(auth, suppressedOnly);
  return suppressedOnly ? getSuppressedOnlyQueryOptions(auth) : getHiddenContentQueryOptions(auth);
};

export const emptyHiddenContentFilter = (userId: string): HiddenContentFilter => ({
  userId,
  includeNsfw: false,
  ...emptySuppressionPreferences(),
});
