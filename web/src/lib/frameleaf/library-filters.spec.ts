import { describe, expect, it } from 'vitest';
import { emptyDiscoveryQuery, type DiscoveryQuery } from '$lib/components/discovery/query';
import { describeFilterField, describeFilterFields, filterFieldLabelKey } from './library-filters';

const withFilter = (filter: Record<string, unknown>): DiscoveryQuery =>
  ({ ...emptyDiscoveryQuery(), filter }) as DiscoveryQuery;

describe('filterFieldLabelKey', () => {
  it('names known fields and falls back for the rest', () => {
    expect(filterFieldLabelKey('personIds')).toBe('people');
    expect(filterFieldLabelKey('city')).toBe('city');
    expect(filterFieldLabelKey('somethingNew')).toBe('frameleaf_library_filter_field_other');
  });
});

describe('describeFilterField', () => {
  it('returns nothing for a field with no condition', () => {
    expect(describeFilterField(withFilter({}), 'city')).toBeNull();
    expect(describeFilterField(withFilter({ city: {} }), 'city')).toBeNull();
    expect(describeFilterField(withFilter({ personIds: { any: [] } }), 'personIds')).toBeNull();
    expect(describeFilterField(withFilter({ or: [] }), 'or')).toBeNull();
  });

  it('lets the field name speak for a boolean, and marks a negated one', () => {
    expect(describeFilterField(withFilter({ isFavorite: { eq: true } }), 'isFavorite')).toEqual({
      field: 'isFavorite',
      labelKey: 'favorite',
      detail: null,
      count: 0,
      negated: false,
    });
    expect(describeFilterField(withFilter({ isFavorite: { eq: false } }), 'isFavorite')?.negated).toBe(true);
    expect(describeFilterField(withFilter({ hasTags: { eq: false } }), 'hasTags')?.negated).toBe(true);
  });

  it('counts the values of a list condition', () => {
    const description = describeFilterField(withFilter({ personIds: { any: ['a', 'b', 'c'] } }), 'personIds');
    expect(description).toMatchObject({ labelKey: 'people', count: 3, detail: null, negated: false });
    expect(describeFilterField(withFilter({ tagIds: { none: ['a'] } }), 'tagIds')?.negated).toBe(true);
  });

  it('shows the value of a scalar condition and strips SQL wildcards from a text one', () => {
    expect(describeFilterField(withFilter({ city: { eq: 'Halifax' } }), 'city')?.detail).toBe('Halifax');
    expect(describeFilterField(withFilter({ rating: { eq: 4 } }), 'rating')?.detail).toBe('4');
    expect(describeFilterField(withFilter({ description: { like: '%harbour%' } }), 'description')?.detail).toBe(
      'harbour',
    );
    expect(describeFilterField(withFilter({ make: { ne: 'Canon' } }), 'make')).toMatchObject({
      detail: 'Canon',
      negated: true,
    });
  });

  it('renders a range from whichever bounds were supplied', () => {
    expect(describeFilterField(withFilter({ takenAt: { gte: '2026-01-01', lte: '2026-02-01' } }), 'takenAt')?.detail).toBe(
      '2026-01-01 – 2026-02-01',
    );
    expect(describeFilterField(withFilter({ takenAt: { gte: '2026-01-01' } }), 'takenAt')?.detail).toBe('2026-01-01');
    expect(describeFilterField(withFilter({ takenAt: { lte: '2026-02-01' } }), 'takenAt')?.detail).toBe('2026-02-01');
  });

  it('counts an or branch once, as the badge does', () => {
    const description = describeFilterField(withFilter({ or: [{ city: { eq: 'a' } }, { city: { eq: 'b' } }] }), 'or');
    expect(description).toMatchObject({ labelKey: 'frameleaf_library_filter_field_any_of', count: 2 });
  });

  it('never throws on an unexpected shape', () => {
    expect(describeFilterField(withFilter({ city: 'Halifax' as unknown as object }), 'city')).toBeNull();
    expect(describeFilterField(withFilter({ city: { unknownOperator: 'x' } }), 'city')).toMatchObject({
      detail: null,
      count: 0,
    });
  });
});

describe('describeFilterFields', () => {
  it('keeps the order it was given and drops empty conditions', () => {
    const query = withFilter({ city: { eq: 'Halifax' }, personIds: { any: ['a'] }, make: {} });
    expect(describeFilterFields(query, ['personIds', 'make', 'city']).map((item) => item.field)).toEqual([
      'personIds',
      'city',
    ]);
  });
});
