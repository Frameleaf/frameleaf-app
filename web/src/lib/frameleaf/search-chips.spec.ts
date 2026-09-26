import type { SearchFilter } from '@immich/sdk';
import { entityNameKey, filterEntityIds, withoutFilterField } from '$lib/frameleaf/search-chips';

describe('filterEntityIds', () => {
  it('collects the ids of each id-list condition with the lookup that names it', () => {
    const filter = {
      personIds: { any: ['p1'], none: ['p2'] },
      petIds: { all: ['pet-1', 'pet-2'] },
      tagIds: { none: ['t1'] },
      albumIds: { any: ['a1'] },
      isFavorite: { eq: true },
    } as SearchFilter;

    expect(filterEntityIds(filter)).toEqual([
      { field: 'personIds', kind: 'person', ids: ['p1', 'p2'] },
      { field: 'petIds', kind: 'pet', ids: ['pet-1', 'pet-2'] },
      { field: 'tagIds', kind: 'tag', ids: ['t1'] },
      { field: 'albumIds', kind: 'album', ids: ['a1'] },
    ]);
  });

  it('ignores ids inside or branches, empty conditions and a missing filter', () => {
    const filter = { or: [{ personIds: { any: ['p1'] } }], petIds: {} } as SearchFilter;

    expect(filterEntityIds(filter)).toEqual([]);
    expect(filterEntityIds(undefined)).toEqual([]);
  });

  it('lists a repeated id once', () => {
    const filter = { tagIds: { any: ['t1'], all: ['t1'] } } as SearchFilter;

    expect(filterEntityIds(filter)).toEqual([{ field: 'tagIds', kind: 'tag', ids: ['t1'] }]);
  });
});

describe('entityNameKey', () => {
  it('keeps a person and a pet with the same id apart', () => {
    expect(entityNameKey('personIds', 'x')).not.toBe(entityNameKey('petIds', 'x'));
  });
});

describe('withoutFilterField', () => {
  it('removes one condition and keeps the rest of the search', () => {
    const terms = {
      query: 'beach',
      filter: { petIds: { any: ['pet-1'] }, isFavorite: { eq: true } } as SearchFilter,
    };

    expect(withoutFilterField(terms, 'petIds')).toEqual({ query: 'beach', filter: { isFavorite: { eq: true } } });
    // the original terms are left alone
    expect(terms.filter).toEqual({ petIds: { any: ['pet-1'] }, isFavorite: { eq: true } });
  });

  it('drops the filter when its last condition goes', () => {
    const terms = { query: 'beach', filter: { petIds: { any: ['pet-1'] } } as SearchFilter };

    expect(withoutFilterField(terms, 'petIds')).toEqual({ query: 'beach' });
  });
});
