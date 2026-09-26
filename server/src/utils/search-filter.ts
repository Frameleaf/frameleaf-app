import { BadRequestException } from '@nestjs/common';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { SearchFilter, SearchFilterBranch } from 'src/dtos/search.dto.js';
import { AssetVisibility } from 'src/enum.js';
import { requireElevatedPermission } from 'src/utils/access.js';

type EnumField = 'type' | 'visibility';
type EnumOperator = keyof NonNullable<SearchFilterBranch[EnumField]>;
type EnumOperandMap<T> = { eq: T; ne: T; in: T[]; notIn: T[] };
type EnumCondition<T> = { [K in EnumOperator]?: EnumOperandMap<T>[K] };
type IdsFilterField = 'albumIds' | 'personIds' | 'petIds' | 'tagIds';

const filterBranches = (filter: SearchFilter): SearchFilterBranch[] => [filter, ...(filter.or ?? [])];

/** Whether a row with `value` can satisfy the condition. A missing operator allows any value. */
const canMatch = <T>(condition: EnumCondition<T>, value: T): boolean => {
  const { eq, ne, in: anyOf, notIn, ...unhandled } = condition;
  // fails to compile when EnumFilter gains an operator this check does not consider
  void (unhandled satisfies Record<string, never>);

  return (
    (eq === undefined || eq === value) &&
    (ne === undefined || ne !== value) &&
    (anyOf === undefined || anyOf.includes(value)) &&
    (notIn === undefined || !notIn.includes(value))
  );
};

/**
 * The conditions that decide which `field` values the filter can return. A top-level condition decides alone, otherwise each branch itself.
 */
const decidingConditions = <F extends EnumField>(filter: SearchFilter, field: F) => {
  if (filter[field] !== undefined) {
    return [filter[field]];
  }

  return filterBranches(filter)
    .map((branch) => branch[field])
    .filter((condition) => condition !== undefined);
};

/**
 * Keeps locked assets out of search results unless the session is elevated: a filter that asks for
 * them is rejected with 401, and any other filter gets `visibility != locked` ANDed in.
 */
export const applyLockedVisibilityPolicy = (auth: AuthDto, filter: SearchFilter): SearchFilter => {
  if (auth.session?.hasElevatedPermission) {
    return filter;
  }

  if (decidingConditions(filter, 'visibility').some((condition) => canMatch(condition, AssetVisibility.Locked))) {
    requireElevatedPermission(auth);
  }

  if (filter.visibility !== undefined) {
    return filter;
  }

  return { ...filter, visibility: { ne: AssetVisibility.Locked } };
};

const LOCATION_FIELDS = ['city', 'state', 'country'] as const;

/**
 * Whether any branch narrows by place. Matching on a partner's place names would reveal locations the
 * partner hides, so such searches leave those partners out of the searched universe (FL-54).
 */
export const filterUsesLocation = (filter: SearchFilter): boolean =>
  filterBranches(filter).some((branch) => LOCATION_FIELDS.some((field) => branch[field] !== undefined));

/** The flat (deprecated) search DTOs carry the same three place fields at the top level. */
export const usesLocationFilter = (dto: { city?: string | null; state?: string | null; country?: string | null }) =>
  LOCATION_FIELDS.some((field) => dto[field] !== undefined);

export const collectFilterIds = (filter: SearchFilter, field: IdsFilterField): string[] => {
  const ids = new Set<string>();

  for (const branch of filterBranches(filter)) {
    for (const operator of ['any', 'all', 'none'] as const) {
      for (const id of branch[field]?.[operator] ?? []) {
        ids.add(id);
      }
    }
  }

  return [...ids];
};

/**
 * Pets belong to their owner alone (FL-58): no pet endpoint accepts a shared link, so a shared-link
 * visitor has no pet to filter by. This check is load-bearing rather than cosmetic: a shared-link
 * request authenticates as the link's owner, so the SQL's "the viewer's own pets" scoping alone would
 * let a visitor who learnt a pet id narrow the shared album by the owner's pet.
 */
export const requirePetFilterAllowed = (auth: AuthDto, petIds: readonly string[] | undefined): void => {
  if (auth.sharedLink && petIds && petIds.length > 0) {
    throw new BadRequestException('Pet filters are not available through a shared link');
  }
};
