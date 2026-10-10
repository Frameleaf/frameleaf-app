import type { TagResponseDto, TagStatisticsResponseDto } from '@frameleaf/sdk';
import { describe, expect, it } from 'vitest';
import {
  TAG_COLORS,
  buildTagTree,
  cleanTagName,
  expandableTagIds,
  findTags,
  flattenTagTree,
  sortTagNodes,
  tagAncestorIds,
  tagAndDescendantIds,
  tagAtPath,
  tagBreadcrumbs,
  tagColorId,
  tagDescendantCount,
  tagDotColor,
  tagInsideSummary,
  tagMatches,
  tagMoveProblem,
  tagMoveTargets,
  tagNameTaken,
  tagPathExists,
  tagTrail,
  visibleTagRows,
} from '$lib/frameleaf/tag-tree';

const tag = (partial: Partial<TagResponseDto> & { id: string; name: string }): TagResponseDto =>
  ({
    createdAt: '2026-09-22T00:00:00.000Z',
    updatedAt: '2026-09-22T00:00:00.000Z',
    value: partial.name,
    ...partial,
  }) as TagResponseDto;

/** A statistics row; the cover and dates default to "one item on New Year's Day 2026". */
const stat = (
  id: string,
  count: number,
  total: number,
  extra: Partial<TagStatisticsResponseDto> = {},
): TagStatisticsResponseDto => ({
  id,
  count,
  total,
  coverAssetIds: [`${id}-cover`],
  startDate: '2026-01-01T00:00:00.000Z',
  endDate: '2026-01-01T00:00:00.000Z',
  ...extra,
});

describe('Frameleaf tag tree adapter', () => {
  it('nests tags by parentId and sorts siblings by name', () => {
    const tree = buildTagTree([
      tag({ id: 'family', name: 'Family' }),
      tag({ id: 'trips', name: 'Trips' }),
      tag({ id: 'rockies', name: 'Rockies 2026', parentId: 'trips' }),
      tag({ id: 'lakes', name: 'Lakes', parentId: 'rockies' }),
    ]);

    expect(tree.roots.map((node) => node.id)).toEqual(['family', 'trips']);
    const trips = tree.byId.get('trips')!;
    expect(trips.children.map((node) => node.id)).toEqual(['rockies']);
    const rockies = tree.byId.get('rockies')!;
    expect(rockies.path).toEqual(['Trips', 'Rockies 2026']);
    expect(rockies.depth).toBe(1);
    const lakes = tree.byId.get('lakes')!;
    expect(lakes.path).toEqual(['Trips', 'Rockies 2026', 'Lakes']);
    expect(lakes.depth).toBe(2);
  });

  it('promotes a tag with a missing parent to the root instead of dropping it', () => {
    const tree = buildTagTree([tag({ id: 'orphan', name: 'Orphan', parentId: 'missing-parent' })]);
    expect(tree.roots.map((node) => node.id)).toEqual(['orphan']);
    expect(tree.byId.get('orphan')!.parent).toBeNull();
  });

  it('breaks a parentId cycle by promoting every member to the root rather than looping', () => {
    const tree = buildTagTree([tag({ id: 'a', name: 'A', parentId: 'b' }), tag({ id: 'b', name: 'B', parentId: 'a' })]);
    expect(tree.roots.map((node) => node.id).sort()).toEqual(['a', 'b']);
  });

  it('computes breadcrumbs from root to the node', () => {
    const tree = buildTagTree([
      tag({ id: 'trips', name: 'Trips' }),
      tag({ id: 'rockies', name: 'Rockies 2026', parentId: 'trips' }),
    ]);
    const breadcrumbs = tagBreadcrumbs(tree.byId.get('rockies')!);
    expect(breadcrumbs.map((node) => node.id)).toEqual(['trips', 'rockies']);
  });

  it('collects a node and every descendant id for an "any of these tags" filter', () => {
    const tree = buildTagTree([
      tag({ id: 'trips', name: 'Trips' }),
      tag({ id: 'rockies', name: 'Rockies 2026', parentId: 'trips' }),
      tag({ id: 'lakes', name: 'Lakes', parentId: 'rockies' }),
      tag({ id: 'family', name: 'Family' }),
    ]);
    expect(tagAndDescendantIds(tree.byId.get('trips')!).sort()).toEqual(['lakes', 'rockies', 'trips']);
  });

  it('flattens the whole tree in depth-first order', () => {
    const tree = buildTagTree([
      tag({ id: 'trips', name: 'Trips' }),
      tag({ id: 'rockies', name: 'Rockies 2026', parentId: 'trips' }),
      tag({ id: 'family', name: 'Family' }),
    ]);
    expect(flattenTagTree(tree).map((node) => node.id)).toEqual(['family', 'trips', 'rockies']);
  });

  it('lists only rows whose ancestors are expanded', () => {
    const tree = buildTagTree([
      tag({ id: 'trips', name: 'Trips' }),
      tag({ id: 'rockies', name: 'Rockies 2026', parentId: 'trips' }),
      tag({ id: 'lakes', name: 'Lakes', parentId: 'rockies' }),
    ]);
    expect(visibleTagRows(tree, new Set()).map((node) => node.id)).toEqual(['trips']);
    expect(visibleTagRows(tree, new Set(['trips'])).map((node) => node.id)).toEqual(['trips', 'rockies']);
    expect(visibleTagRows(tree, new Set(['trips', 'rockies'])).map((node) => node.id)).toEqual([
      'trips',
      'rockies',
      'lakes',
    ]);
  });

  describe('tagPathExists', () => {
    const tags = [
      tag({ id: 'trips', name: 'Trips' }),
      tag({ id: 'rockies', name: 'Rockies 2026', parentId: 'trips', value: 'Trips/Rockies 2026' }),
    ];

    it('finds a tag by its full value, with or without stray slashes', () => {
      expect(tagPathExists(tags, 'Trips')).toBe(true);
      expect(tagPathExists(tags, 'Trips/Rockies 2026')).toBe(true);
      expect(tagPathExists(tags, '/Trips/Rockies 2026/')).toBe(true);
    });

    it('treats the empty path as the page with nothing selected', () => {
      expect(tagPathExists(tags, '')).toBe(true);
      expect(tagPathExists([], '')).toBe(true);
    });

    it('does not find a tag the list leaves out, such as one suppressed while locked', () => {
      expect(tagPathExists(tags, 'Private')).toBe(false);
      expect(tagPathExists(tags, 'Trips/Private')).toBe(false);
      expect(tagPathExists(tags, 'Trip')).toBe(false);
    });
  });

  describe('counts, covers and dates (GET /tags/statistics)', () => {
    const tags = [
      tag({ id: 'trips', name: 'Trips' }),
      tag({ id: 'rockies', name: 'Rockies 2026', parentId: 'trips', value: 'Trips/Rockies 2026' }),
      tag({ id: 'lakes', name: 'Lakes', parentId: 'rockies', value: 'Trips/Rockies 2026/Lakes' }),
      tag({ id: 'family', name: 'Family' }),
      tag({ id: 'empty', name: 'Empty' }),
    ];
    const statistics = [stat('trips', 1, 6), stat('rockies', 3, 5), stat('lakes', 2, 2), stat('family', 9, 9)];

    it('carries each tag its own count and its total with subtags, zero when it has none', () => {
      const tree = buildTagTree(tags, statistics);
      expect(tree.byId.get('trips')).toMatchObject({ count: 1, total: 6 });
      expect(tree.byId.get('lakes')).toMatchObject({ count: 2, total: 2 });
      expect(tree.byId.get('empty')).toMatchObject({ count: 0, total: 0 });
    });

    it('orders siblings busiest first, then by name', () => {
      const tree = buildTagTree(tags, statistics);
      expect(tree.roots.map((node) => node.id)).toEqual(['family', 'trips', 'empty']);
    });

    it('carries the cover items and the capture dates, and none for a tag without items', () => {
      const tree = buildTagTree(tags, [
        stat('trips', 1, 6, {
          coverAssetIds: ['a', 'b', 'c', 'd', 'e'],
          startDate: '2023-07-22T00:00:00.000Z',
          endDate: '2026-10-03T00:00:00.000Z',
        }),
      ]);
      // never more than the four a cover shows
      expect(tree.byId.get('trips')).toMatchObject({
        covers: ['a', 'b', 'c', 'd'],
        startDate: '2023-07-22T00:00:00.000Z',
        endDate: '2026-10-03T00:00:00.000Z',
      });
      expect(tree.byId.get('empty')).toMatchObject({ covers: [], startDate: null, endDate: null });
    });

    it('reads a statistics row from a server that sends no covers or dates yet', () => {
      const tree = buildTagTree(tags, [{ id: 'trips', count: 1, total: 6 } as TagStatisticsResponseDto]);
      expect(tree.byId.get('trips')).toMatchObject({ total: 6, covers: [], startDate: null, endDate: null });
    });

    it('drops a tag that was deleted or renamed away from the counts it had', () => {
      const tree = buildTagTree(
        tags.filter((item) => item.id !== 'rockies'),
        statistics,
      );
      // the orphaned subtag is promoted, the deleted one has no row
      expect(tree.byId.has('rockies')).toBe(false);
      expect(tree.roots.map((node) => node.id)).toContain('lakes');
    });
  });

  describe('address, search and expansion', () => {
    const tree = buildTagTree([
      tag({ id: 'trips', name: 'Trips' }),
      tag({ id: 'rockies', name: 'Rockies 2026', parentId: 'trips', value: 'Trips/Rockies 2026' }),
      tag({ id: 'lakes', name: 'Lakes', parentId: 'rockies', value: 'Trips/Rockies 2026/Lakes' }),
      tag({ id: 'family', name: 'Family' }),
    ]);

    it('selects the tag whose full value is the address, and nothing for the overview', () => {
      expect(tagAtPath(tree, 'Trips/Rockies 2026/Lakes')?.id).toBe('lakes');
      expect(tagAtPath(tree, '/Trips/')?.id).toBe('trips');
      expect(tagAtPath(tree, '')).toBeNull();
      expect(tagAtPath(tree, 'Trips/Gone')).toBeNull();
    });

    it("opens a deep tag's ancestors so its row is visible", () => {
      expect(tagAncestorIds(tree.byId.get('lakes')!)).toEqual(['trips', 'rockies']);
      expect(tagAncestorIds(tree.byId.get('trips')!)).toEqual([]);
    });

    it('matches a tag by its own name, ignoring case', () => {
      expect(tagMatches(tree.byId.get('lakes')!, 'LAK')).toBe(true);
      expect(tagMatches(tree.byId.get('lakes')!, ' '.repeat(2))).toBe(false);
    });

    it('lists every tag with tags inside it: the groups, and what "Expand all" opens', () => {
      expect(expandableTagIds(tree).sort()).toEqual(['rockies', 'trips']);
    });
  });

  describe("the index: order, find and the cards' lines", () => {
    const tags = [
      tag({ id: 'travel', name: 'Travel' }),
      tag({ id: 'canada', name: 'Canada', parentId: 'travel', value: 'Travel/Canada' }),
      tag({ id: 'banff', name: 'Banff', parentId: 'canada', value: 'Travel/Canada/Banff' }),
      tag({ id: 'norway', name: 'Norway', parentId: 'travel', value: 'Travel/Norway' }),
      tag({ id: 'iceland', name: 'Iceland', parentId: 'travel', value: 'Travel/Iceland' }),
      tag({ id: 'japan', name: 'japan', parentId: 'travel', value: 'Travel/japan' }),
      tag({ id: 'family', name: 'Family' }),
      tag({ id: 'album10', name: 'Album 10' }),
      tag({ id: 'album9', name: 'album 9' }),
      tag({ id: 'unused', name: 'Banff ideas' }),
    ];
    const tree = buildTagTree(tags, [
      stat('travel', 0, 60, { endDate: '2026-08-23T00:00:00.000Z' }),
      stat('canada', 10, 40, { endDate: '2026-08-23T00:00:00.000Z' }),
      stat('banff', 30, 30, { endDate: '2025-02-01T00:00:00.000Z' }),
      stat('norway', 12, 12, { endDate: '2025-07-17T00:00:00.000Z' }),
      stat('iceland', 6, 6, { endDate: '2024-09-16T00:00:00.000Z' }),
      stat('japan', 2, 2, { endDate: '2023-11-11T00:00:00.000Z' }),
      stat('family', 80, 80, { endDate: '2026-10-01T00:00:00.000Z' }),
      stat('album10', 5, 5, { endDate: '2022-01-01T00:00:00.000Z' }),
      stat('album9', 5, 5, { endDate: '2022-01-02T00:00:00.000Z' }),
    ]);
    const ids = (nodes: { id: string }[]) => nodes.map((node) => node.id);

    it('orders tags busiest first, by name, or by their newest item', () => {
      expect(ids(sortTagNodes(tree.roots, 'used'))).toEqual(['family', 'travel', 'album10', 'album9', 'unused']);
      // by name: case does not matter and "9" comes before "10"
      expect(ids(sortTagNodes(tree.roots, 'name'))).toEqual(['album9', 'album10', 'unused', 'family', 'travel']);
      // a tag without items has no newest item and goes last
      expect(ids(sortTagNodes(tree.roots, 'newest'))).toEqual(['family', 'travel', 'album9', 'album10', 'unused']);
      // the tree keeps its own order
      expect(ids(tree.roots)).toEqual(['family', 'travel', 'album10', 'album9', 'unused']);
    });

    it('orders every level of the list the same way, and only opens what is expanded', () => {
      expect(ids(visibleTagRows(tree, new Set(['travel']), 'name'))).toEqual([
        'album9',
        'album10',
        'unused',
        'family',
        'travel',
        'canada',
        'iceland',
        'japan',
        'norway',
      ]);
      expect(ids(visibleTagRows(tree, new Set(['travel', 'canada']), 'newest')).slice(1, 7)).toEqual([
        'travel',
        'canada',
        'banff',
        'norway',
        'iceland',
        'japan',
      ]);
    });

    it('finds nested tags too, as one flat list in the chosen order', () => {
      expect(ids(findTags(tree, 'BAN'))).toEqual(['banff', 'unused']);
      expect(ids(findTags(tree, 'an', 'name'))).toEqual(['banff', 'unused', 'canada', 'iceland', 'japan']);
      expect(findTags(tree, '  ')).toEqual([]);
      expect(findTags(tree, 'nothing like it')).toEqual([]);
    });

    it('says where a nested tag sits, and nothing for a top-level one', () => {
      expect(tagTrail(tree.byId.get('banff')!)).toEqual(['Travel', 'Canada']);
      expect(tagTrail(tree.byId.get('travel')!)).toEqual([]);
    });

    it('names the first tags inside a tag, busiest first, and counts the rest', () => {
      expect(tagInsideSummary(tree.byId.get('travel')!)).toEqual({ names: ['Canada', 'Norway', 'Iceland'], more: 1 });
      expect(tagInsideSummary(tree.byId.get('canada')!)).toEqual({ names: ['Banff'], more: 0 });
      expect(tagInsideSummary(tree.byId.get('family')!)).toEqual({ names: [], more: 0 });
    });

    it('counts the tags a delete takes along at every depth', () => {
      expect(tagDescendantCount(tree.byId.get('travel')!)).toBe(5);
      expect(tagDescendantCount(tree.byId.get('canada')!)).toBe(1);
      expect(tagDescendantCount(tree.byId.get('banff')!)).toBe(0);
    });
  });

  describe('moving a tag', () => {
    const tree = buildTagTree([
      tag({ id: 'travel', name: 'Travel' }),
      tag({ id: 'canada', name: 'Canada', parentId: 'travel', value: 'Travel/Canada' }),
      tag({ id: 'banff', name: 'Banff', parentId: 'canada', value: 'Travel/Canada/Banff' }),
      tag({ id: 'nature', name: 'Nature' }),
      tag({ id: 'nature-canada', name: 'canada', parentId: 'nature', value: 'Nature/canada' }),
      tag({ id: 'ideas', name: 'Banff' }),
    ]);
    const node = (id: string) => tree.byId.get(id)!;

    it('offers every tag except the tag itself and the tags inside it', () => {
      expect(
        tagMoveTargets(tree, node('canada'))
          .map((target) => target.id)
          .sort(),
      ).toEqual(['ideas', 'nature', 'nature-canada', 'travel']);
      expect(tagMoveTargets(tree, node('banff'))).toHaveLength(5);
    });

    it('allows a move to another tag or to the top level', () => {
      expect(tagMoveProblem(tree, node('banff'), 'nature')).toBeNull();
      expect(tagMoveProblem(tree, node('canada'), null)).toBeNull();
    });

    it('refuses a move under the tag itself or a tag inside it', () => {
      expect(tagMoveProblem(tree, node('travel'), 'travel')).toBe('inside-itself');
      expect(tagMoveProblem(tree, node('travel'), 'banff')).toBe('inside-itself');
    });

    it('refuses a place that already has a tag of that name, ignoring case', () => {
      expect(tagMoveProblem(tree, node('canada'), 'nature')).toBe('name-taken');
      expect(tagMoveProblem(tree, node('banff'), null)).toBe('name-taken');
    });

    it('has nothing to do when the tag is already there', () => {
      expect(tagMoveProblem(tree, node('canada'), 'travel')).toBe('same-place');
      expect(tagMoveProblem(tree, node('travel'), null)).toBe('same-place');
    });

    it('judges by id, so a tag held from an earlier read of the tree is still recognised', () => {
      const stale = { ...node('travel') };
      expect(tagMoveProblem(tree, stale, 'banff')).toBe('inside-itself');
      expect(tagMoveTargets(tree, stale).map((target) => target.id)).not.toContain('canada');
    });
  });

  describe('names', () => {
    const tree = buildTagTree([
      tag({ id: 'trips', name: 'Trips' }),
      tag({ id: 'rockies', name: 'Rockies', parentId: 'trips', value: 'Trips/Rockies' }),
    ]);

    it('accepts a trimmed name of 1-60 characters without a slash', () => {
      expect(cleanTagName('  Beach ')).toBe('Beach');
      expect(cleanTagName('a/b')).toBeNull();
      expect(cleanTagName(' '.repeat(3))).toBeNull();
      expect(cleanTagName('x'.repeat(61))).toBeNull();
    });

    it('refuses a sibling with the same name, ignoring case, but not the tag being renamed', () => {
      expect(tagNameTaken(tree, 'trips', 'ROCKIES')).toBe(true);
      expect(tagNameTaken(tree, null, 'rockies')).toBe(false);
      expect(tagNameTaken(tree, null, 'trips')).toBe(true);
      expect(tagNameTaken(tree, 'trips', 'Rockies', 'rockies')).toBe(false);
    });
  });

  describe('colours', () => {
    it("names a stored hex by the prototype's palette, including the first FL-46 palette", () => {
      expect(TAG_COLORS.map((option) => option.id)).toEqual([
        'grey',
        'green',
        'teal',
        'blue',
        'purple',
        'pink',
        'amber',
        'red',
      ]);
      expect(tagColorId('#D9639B')).toBe('pink');
      expect(tagColorId('3fb46a')).toBe('green');
      expect(tagColorId('#a78bfa')).toBe('purple');
      expect(tagColorId('#123456')).toBeNull();
      expect(tagColorId(null)).toBeNull();
    });

    it('draws a tag without a colour in grey', () => {
      expect(tagDotColor(undefined)).toBe('#8b95a1');
      expect(tagDotColor('123456')).toBe('#123456');
    });
  });
});
