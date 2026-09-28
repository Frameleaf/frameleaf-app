import { AssetTypeEnum, ImageEnrichmentFilter } from '@immich/sdk';
import type { MessageFormatter } from 'svelte-i18n';
import { emptyDiscoveryQuery, type DiscoveryQuery } from '$lib/components/discovery/query';
import {
  captureDateControlValue,
  captureDateHasCustomCondition,
  CUSTOM_CONDITION,
  describeFilterChips,
  ENRICHMENT_OPTIONS,
  ENRICHMENT_QUICK_FILTERS,
  equalityControlValue,
  flagToggleActive,
  isEnrichmentFilter,
  moveSetGroup,
  ratingConditionForValue,
  ratingControlValue,
  toggleFlagCondition,
  updateCaptureDate,
  updateSetGroup,
  withFilterCondition,
} from '$lib/frameleaf/search-filters';

/** The chip labels are assembled from keys, so a key-echoing formatter is enough to assert shape. */
const $t = ((key: string, options?: { values?: Record<string, unknown> }) => {
  const values = options?.values;
  return values ? `${key}(${Object.values(values).join(',')})` : key;
}) as unknown as MessageFormatter;

const query = (filter: Record<string, unknown>): DiscoveryQuery =>
  ({ ...emptyDiscoveryQuery(), filter }) as DiscoveryQuery;

describe('updateSetGroup', () => {
  it('edits one group and leaves the others untouched', () => {
    const condition = { any: ['a'], none: ['z'] };
    expect(updateSetGroup(condition, 'any', ['a', 'b'])).toEqual({ any: ['a', 'b'], none: ['z'] });
  });

  it('removes an emptied group and the whole condition when nothing is left', () => {
    expect(updateSetGroup({ any: ['a'], none: ['z'] }, 'any', [])).toEqual({ none: ['z'] });
    expect(updateSetGroup({ any: ['a'] }, 'any', [])).toBeNull();
  });

  it('de-duplicates and ignores an unknown group', () => {
    expect(updateSetGroup(null, 'any', ['a', 'a'])).toEqual({ any: ['a'] });
    expect(updateSetGroup({ any: ['a'] }, 'wrong', ['b'])).toEqual({ any: ['a'] });
  });
});

describe('moveSetGroup', () => {
  it('merges into the target rather than replacing it', () => {
    expect(moveSetGroup({ any: ['a'], all: ['b'] }, 'any', 'all')).toEqual({ all: ['b', 'a'] });
  });

  it('is a no-op for the same group or an unknown one', () => {
    expect(moveSetGroup({ any: ['a'] }, 'any', 'any')).toEqual({ any: ['a'] });
    expect(moveSetGroup({ any: ['a'] }, 'any', 'nope')).toEqual({ any: ['a'] });
  });

  it('returns null once the condition is empty', () => {
    expect(moveSetGroup({ any: [] }, 'any', 'all')).toBeNull();
  });
});

describe('equalityControlValue', () => {
  it('reads a plain equality and reports anything richer as a custom condition', () => {
    expect(equalityControlValue(undefined)).toBe('');
    expect(equalityControlValue({})).toBe('');
    expect(equalityControlValue({ eq: 'Banff' })).toBe('Banff');
    expect(equalityControlValue({ ne: 'Banff' })).toBe(CUSTOM_CONDITION);
    expect(equalityControlValue({ eq: 'Banff', ne: 'Jasper' })).toBe(CUSTOM_CONDITION);
  });

  it('applies the acceptance test the caller supplies', () => {
    const isType = (value: unknown) => value === AssetTypeEnum.Image || value === AssetTypeEnum.Video;
    expect(equalityControlValue({ eq: AssetTypeEnum.Image }, isType)).toBe(AssetTypeEnum.Image);
    expect(equalityControlValue({ eq: 'OTHER' }, isType)).toBe(CUSTOM_CONDITION);
  });
});

describe('rating', () => {
  it('reads every shape the select offers', () => {
    expect(ratingControlValue(undefined)).toBe('');
    expect(ratingControlValue({ eq: null })).toBe('null');
    expect(ratingControlValue({ eq: 0 })).toBe('0');
    expect(ratingControlValue({ eq: -1 })).toBe('-1');
    expect(ratingControlValue({ gte: 3 })).toBe('min3');
    expect(ratingControlValue({ gte: 9 })).toBe(CUSTOM_CONDITION);
    expect(ratingControlValue({ lte: 3 })).toBe(CUSTOM_CONDITION);
  });

  it('maps a control value back to a condition, refusing what it cannot express', () => {
    expect(ratingConditionForValue('')).toBeNull();
    expect(ratingConditionForValue('null')).toEqual({ eq: null });
    expect(ratingConditionForValue('4')).toEqual({ eq: 4 });
    expect(ratingConditionForValue('min2')).toEqual({ gte: 2 });
    // `undefined` is the signal to leave the stored condition alone.
    expect(ratingConditionForValue(CUSTOM_CONDITION)).toBeUndefined();
  });
});

describe('capture date', () => {
  it('reads each boundary as a calendar day', () => {
    expect(captureDateControlValue({ gte: '2026-08-01' }, 'gte')).toBe('2026-08-01');
    expect(captureDateControlValue({ lte: '2026-08-31' }, 'lte')).toBe('2026-08-31');
    expect(captureDateControlValue(undefined, 'gte')).toBe('');
  });

  it('shows an exclusive upper bound on its own calendar day', () => {
    expect(captureDateControlValue({ lt: '2026-09-01T00:00:00.000Z' }, 'lte')).toBe('2026-08-31');
  });

  it('replaces only the edited endpoint, including its strict variant', () => {
    expect(updateCaptureDate({ gte: '2026-01-01', lt: '2026-02-01' }, 'gte', '2026-03-01')).toEqual({
      gte: '2026-03-01',
      lt: '2026-02-01',
    });
    expect(updateCaptureDate({ gte: '2026-01-01', lt: '2026-02-01' }, 'lte', '2026-04-01')).toEqual({
      gte: '2026-01-01',
      lte: '2026-04-01',
    });
  });

  it('clears an endpoint and the whole condition', () => {
    expect(updateCaptureDate({ gte: '2026-01-01' }, 'gte', '')).toBeNull();
  });

  it('refuses a value the date input could not have produced', () => {
    const condition = { gte: '2026-01-01' };
    expect(updateCaptureDate(condition, 'gte', 'not-a-date')).toEqual(condition);
  });

  it('flags conditions the two date inputs cannot represent', () => {
    expect(captureDateHasCustomCondition({ gte: '2026-01-01', lte: '2026-02-01' })).toBe(false);
    expect(captureDateHasCustomCondition({ lt: '2026-02-01', lte: '2026-02-01' })).toBe(true);
    expect(captureDateHasCustomCondition({ ne: '2026-02-01' })).toBe(true);
    expect(captureDateHasCustomCondition({ gte: '2026-01-01T09:30:00.000Z' })).toBe(true);
  });
});

describe('boolean quick toggles', () => {
  it('toggles "Not in any album" and "Untagged" on a real SearchFilter field', () => {
    expect(flagToggleActive(undefined, false)).toBe(false);
    expect(flagToggleActive({ eq: false }, false)).toBe(true);
    expect(flagToggleActive({ eq: true }, false)).toBe(false);
    expect(toggleFlagCondition(undefined, false)).toEqual({ eq: false });
    expect(toggleFlagCondition({ eq: false }, false)).toBeNull();
    // A richer condition is not a toggle state, so pressing the button sets the toggle.
    expect(toggleFlagCondition({ eq: true }, false)).toEqual({ eq: false });
  });
});

describe('enrichment options', () => {
  it('offers only values the server enum defines', () => {
    const allowed = new Set<string>(Object.values(ImageEnrichmentFilter));
    for (const option of [...ENRICHMENT_OPTIONS, ...ENRICHMENT_QUICK_FILTERS]) {
      expect(allowed.has(option.value)).toBe(true);
    }
    expect(ENRICHMENT_OPTIONS).toHaveLength(Object.values(ImageEnrichmentFilter).length);
  });

  it('recognises a stored enrichment value', () => {
    expect(isEnrichmentFilter(ImageEnrichmentFilter.NsfwReview)).toBe(true);
    expect(isEnrichmentFilter('needs-review')).toBe(false);
    expect(isEnrichmentFilter(undefined)).toBe(false);
  });
});

describe('withFilterCondition', () => {
  it('sets, replaces and removes a field without touching the rest', () => {
    const start = query({ city: { eq: 'Banff' } });
    expect(withFilterCondition(start, 'rating', { gte: 3 }).filter).toEqual({
      city: { eq: 'Banff' },
      rating: { gte: 3 },
    });
    expect(withFilterCondition(start, 'city', null).filter).toEqual({});
    expect(withFilterCondition(start, 'city', {}).filter).toEqual({});
    // The input is never mutated.
    expect(start.filter).toEqual({ city: { eq: 'Banff' } });
  });
});

describe('describeFilterChips', () => {
  it('reads a boolean field in plain language rather than as "field: false"', () => {
    expect(describeFilterChips($t, query({ hasAlbums: { eq: false } }))[0].label).toBe('not_in_any_album');
    expect(describeFilterChips($t, query({ hasTags: { eq: false } }))[0].label).toBe('untagged');
    expect(describeFilterChips($t, query({ hasTags: { eq: true } }))[0].label).toBe('frameleaf_search_tagged');
  });

  it('names the field and its operator for everything else', () => {
    const [chip] = describeFilterChips($t, query({ takenAt: { gte: '2026-08-01' } }));
    expect(chip.field).toBe('takenAt');
    expect(chip.label).toContain('frameleaf_search_field_taken_at');
    expect(chip.label).toContain('frameleaf_search_op_from');
  });

  it('resolves ids through the caller and carries the person ids for avatars', () => {
    const [chip] = describeFilterChips($t, query({ personIds: { any: ['p1', 'p2'] } }), {
      nameFor: (field, id) => (field === 'personIds' && id === 'p1' ? 'Ada' : undefined),
    });
    expect(chip.personIds).toEqual(['p1', 'p2']);
    expect(chip.label).toContain('Ada');
    // An unresolved id still appears, so the chip can always be removed.
    expect(chip.label).toContain('p2');
  });

  it('names pets through the caller and draws no person avatars for them (FL-58)', () => {
    const [chip] = describeFilterChips($t, query({ petIds: { none: ['pet-1'] } }), {
      nameFor: (field, id) => (field === 'petIds' && id === 'pet-1' ? 'Biscuit' : undefined),
    });
    expect(chip.field).toBe('petIds');
    expect(chip.personIds).toEqual([]);
    expect(chip.label).toBe('frameleaf_pets_title: frameleaf_search_op_without(Biscuit)');
  });

  it('describes the enrichment facet even though it lives outside the filter', () => {
    const withEnrichment: DiscoveryQuery = {
      ...emptyDiscoveryQuery(),
      imageEnrichment: ImageEnrichmentFilter.NsfwReview,
    };
    const [chip] = describeFilterChips($t, withEnrichment);
    expect(chip.field).toBe('imageEnrichment');
    expect(chip.label).toContain('image_enrichment');
    expect(chip.label).toContain('image_enrichment_filter_nsfw_review');
  });

  it('describes only the fields the query reports as active', () => {
    // An empty or malformed condition is not an active filter, so it produces no chip.
    expect(describeFilterChips($t, query({ city: {} }))).toEqual([]);
    expect(describeFilterChips($t, emptyDiscoveryQuery())).toEqual([]);
  });
});
