import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { SearchFilter, isAlbumConfined, isFullyAlbumConfined } from 'src/dtos/search.dto.js';
import { AssetVisibility, Permission } from 'src/enum.js';
import {
  applyLockedVisibilityPolicy,
  collectFilterIds,
  filterNamesPeople,
  filterUsesLocation,
  requirePetFilterAllowed,
  requireSourceFilterAllowed,
  usesLocationFilter,
} from 'src/utils/search-filter.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { authStub } from 'test/fixtures/auth.stub.js';

const elevatedAuth = () => AuthFactory.from().session({ hasElevatedPermission: true }).build();
const unelevatedAuth = () => AuthFactory.from().session().build();

describe(applyLockedVisibilityPolicy.name, () => {
  it('should let an elevated session query locked assets', () => {
    const filter = { visibility: { eq: AssetVisibility.Locked } };
    expect(applyLockedVisibilityPolicy(elevatedAuth(), filter)).toBe(filter);
  });

  it('should reject an unelevated session when any operator permits locked', () => {
    for (const visibility of [
      { eq: AssetVisibility.Locked },
      { ne: AssetVisibility.Timeline },
      { in: [AssetVisibility.Locked, AssetVisibility.Timeline] },
      { notIn: [AssetVisibility.Timeline] },
    ]) {
      expect(() => applyLockedVisibilityPolicy(unelevatedAuth(), { visibility })).toThrow(UnauthorizedException);
    }
  });

  it('should keep a filter whose top-level visibility excludes locked', () => {
    for (const visibility of [
      { eq: AssetVisibility.Timeline },
      { ne: AssetVisibility.Locked },
      { in: [AssetVisibility.Timeline, AssetVisibility.Archive] },
      { notIn: [AssetVisibility.Locked] },
    ]) {
      const filter = { visibility };
      expect(applyLockedVisibilityPolicy(unelevatedAuth(), filter)).toBe(filter);
    }
  });

  it('should let a safe top-level visibility decide over could-match branches', () => {
    const filter = { visibility: { ne: AssetVisibility.Locked }, or: [{ visibility: { eq: AssetVisibility.Locked } }] };
    expect(applyLockedVisibilityPolicy(unelevatedAuth(), filter)).toBe(filter);
  });

  it('should reject a branch that permits locked when the top level has no visibility', () => {
    const filter = {
      or: [{ city: { eq: 'Oslo' } }, { visibility: { in: [AssetVisibility.Locked, AssetVisibility.Timeline] } }],
    };
    expect(() => applyLockedVisibilityPolicy(unelevatedAuth(), filter)).toThrow(UnauthorizedException);
  });

  it('should otherwise inject visibility != locked without mutating the input', () => {
    const filter = { city: { eq: 'Oslo' }, visibility: undefined };
    expect(applyLockedVisibilityPolicy(unelevatedAuth(), filter)).toEqual({
      city: { eq: 'Oslo' },
      visibility: { ne: AssetVisibility.Locked },
    });
    expect(filter.visibility).toBeUndefined();

    const branched = { or: [{ isFavorite: { eq: true } }, { visibility: { eq: AssetVisibility.Timeline } }] };
    expect(applyLockedVisibilityPolicy(unelevatedAuth(), branched).visibility).toEqual({ ne: AssetVisibility.Locked });
  });
});

describe(filterNamesPeople.name, () => {
  const [personA, personB] = ['00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000b'];

  it('should be true for a top-level "all of" or "any of" people condition', () => {
    for (const personIds of [{ all: [personA, personB] }, { any: [personA, personB] }]) {
      expect(filterNamesPeople({ personIds })).toBe(true);
    }
    expect(filterNamesPeople({ personIds: { all: [personA], none: [personB] }, city: { eq: 'Oslo' } })).toBe(true);
  });

  it('should be false for "none of" alone', () => {
    expect(filterNamesPeople({ personIds: { none: [personA] } })).toBe(false);
  });

  it('should be false without people, or with people only inside an `or` branch', () => {
    expect(filterNamesPeople(undefined)).toBe(false);
    expect(filterNamesPeople({})).toBe(false);
    expect(filterNamesPeople({ personIds: {} })).toBe(false);
    expect(filterNamesPeople({ or: [{ personIds: { any: [personA] } }, { city: { eq: 'Oslo' } }] })).toBe(false);
  });
});

describe(collectFilterIds.name, () => {
  it('should union and dedupe ids across operators and branches', () => {
    const [albumA, albumB, albumC] = [
      '00000000-0000-4000-8000-00000000000a',
      '00000000-0000-4000-8000-00000000000b',
      '00000000-0000-4000-8000-00000000000c',
    ];
    const filter: SearchFilter = {
      albumIds: { any: [albumA], none: [albumB] },
      or: [{ albumIds: { all: [albumC, albumA] } }, { city: { eq: 'Oslo' } }],
    };
    expect(collectFilterIds(filter, 'albumIds').toSorted()).toEqual([albumA, albumB, albumC]);
    expect(collectFilterIds({}, 'albumIds')).toEqual([]);
  });

  it('should only collect ids of the requested field', () => {
    const albumId = '00000000-0000-4000-8000-00000000000a';
    const personId = '00000000-0000-4000-8000-00000000000b';
    const filter = { albumIds: { any: [albumId] }, personIds: { any: [personId] } };
    expect(collectFilterIds(filter, 'personIds')).toEqual([personId]);
  });

  it('should collect pet ids from every operator and branch', () => {
    const [petA, petB] = ['00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000b'];
    const filter: SearchFilter = { petIds: { any: [petA] }, or: [{ petIds: { none: [petB] } }] };
    expect(collectFilterIds(filter, 'petIds').toSorted()).toEqual([petA, petB]);
    expect(collectFilterIds(filter, 'personIds')).toEqual([]);
  });
});

describe(requirePetFilterAllowed.name, () => {
  const petId = '00000000-0000-4000-8000-00000000000a';

  it('should reject a pet filter through a shared link, which authenticates as the link owner', () => {
    const auth = AuthFactory.from().sharedLink().build();
    expect(() => requirePetFilterAllowed(auth, [petId])).toThrow(BadRequestException);
  });

  it('should let a shared link search without a pet filter', () => {
    const auth = AuthFactory.from().sharedLink().build();
    expect(() => requirePetFilterAllowed(auth, undefined)).not.toThrow();
    expect(() => requirePetFilterAllowed(auth, [])).not.toThrow();
  });

  it('should let the signed-in owner filter by pet', () => {
    expect(() => requirePetFilterAllowed(unelevatedAuth(), [petId])).not.toThrow();
  });
});

describe(filterUsesLocation.name, () => {
  it('should detect a place condition on the top level or in any branch', () => {
    expect(filterUsesLocation({ city: { eq: 'Oslo' } })).toBe(true);
    expect(filterUsesLocation({ or: [{ isFavorite: { eq: true } }, { country: { eq: 'Norway' } }] })).toBe(true);
    expect(filterUsesLocation({ state: { eq: null } })).toBe(true);
  });

  it('should ignore filters without a place condition', () => {
    expect(filterUsesLocation({})).toBe(false);
    expect(filterUsesLocation({ isFavorite: { eq: true }, or: [{ make: { eq: 'Canon' } }] })).toBe(false);
  });
});

describe(usesLocationFilter.name, () => {
  it('should treat explicit null place filters as location queries too', () => {
    expect(usesLocationFilter({ city: 'Oslo' })).toBe(true);
    expect(usesLocationFilter({ country: null })).toBe(true);
    expect(usesLocationFilter({})).toBe(false);
  });
});

describe(isAlbumConfined.name, () => {
  it('should require a positive albumIds constraint', () => {
    const albumId = '00000000-0000-4000-8000-00000000000a';
    expect(isAlbumConfined({ albumIds: { any: [albumId] } })).toBe(true);
    expect(isAlbumConfined({ albumIds: { all: [albumId] } })).toBe(true);
    expect(isAlbumConfined({ albumIds: { none: [albumId] } })).toBe(false);
    expect(isAlbumConfined({ city: { eq: 'Oslo' } })).toBe(false);
    expect(isAlbumConfined({})).toBe(false);
  });
});

describe(isFullyAlbumConfined.name, () => {
  const albumId = '00000000-0000-4000-8000-00000000000a';

  it('should be confined by the top level or by every branch', () => {
    expect(isFullyAlbumConfined({ albumIds: { any: [albumId] } })).toBe(true);
    expect(isFullyAlbumConfined({ albumIds: { any: [albumId] }, or: [{ city: { eq: 'Oslo' } }] })).toBe(true);
    expect(isFullyAlbumConfined({ or: [{ albumIds: { any: [albumId] } }, { albumIds: { all: [albumId] } }] })).toBe(
      true,
    );
  });

  it('should not be confined when any result can escape the albums', () => {
    expect(isFullyAlbumConfined({})).toBe(false);
    expect(isFullyAlbumConfined({ albumIds: { none: [albumId] } })).toBe(false);
    expect(isFullyAlbumConfined({ or: [{ albumIds: { any: [albumId] } }, { city: { eq: 'Oslo' } }] })).toBe(false);
    expect(isFullyAlbumConfined({ or: [] })).toBe(false);
  });
});

it('treats positive subtree filters as confined and collects their root authorization IDs', () => {
  const id = '00000000-0000-4000-8000-00000000000a';
  expect(isAlbumConfined({ albumSubtreeIds: { any: [id] } })).toBe(true);
  expect(isAlbumConfined({ albumSubtreeIds: { none: [id] } })).toBe(false);
  expect(collectFilterIds({ albumSubtreeIds: { all: [id] } }, 'albumSubtreeIds')).toEqual([id]);
});

it('requires the provenance permission before allowing source filters, including OR branches', () => {
  const filter = { or: [{ source: { contains: 'private-project' } }] };
  expect(() => requireSourceFilterAllowed(authStub.user1, filter)).not.toThrow();
  expect(() =>
    requireSourceFilterAllowed(
      { ...authStub.user1, apiKey: { id: 'key', permissions: [Permission.AssetRead] } },
      filter,
    ),
  ).toThrow();
  expect(() =>
    requireSourceFilterAllowed(
      { ...authStub.user1, apiKey: { id: 'key', permissions: [Permission.AssetSourceRead] } },
      filter,
    ),
  ).not.toThrow();
  expect(() =>
    requireSourceFilterAllowed({ ...authStub.user1, sharedLink: authStub.adminSharedLink.sharedLink }, filter),
  ).toThrow();
});
