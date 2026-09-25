import type { TagResponseDto } from '@immich/sdk';
import { describe, expect, it } from 'vitest';
import {
  TAG_COLORS,
  buildTagTree,
  cleanTagName,
  expandableTagIds,
  flattenTagTree,
  mostUsedTags,
  tagAncestorIds,
  tagAndDescendantIds,
  tagAtPath,
  tagBreadcrumbs,
  tagColorId,
  tagDotColor,
  tagIdsRevealingMatches,
  tagMatches,
  tagNameTaken,
  tagPathExists,
  visibleTagRows,
} from '$lib/frameleaf/tag-tree';

const tag = (partial: Partial<TagResponseDto> & { id: string; name: string }): TagResponseDto =>
  ({
    createdAt: '2026-09-22T00:00:00.000Z',
    updatedAt: '2026-09-22T00:00:00.000Z',
    value: partial.name,
    ...partial,
  }) as TagResponseDto;

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

  describe('counts (FL-46, GET /tags/statistics)', () => {
    const tags = [
      tag({ id: 'trips', name: 'Trips' }),
      tag({ id: 'rockies', name: 'Rockies 2026', parentId: 'trips', value: 'Trips/Rockies 2026' }),
      tag({ id: 'lakes', name: 'Lakes', parentId: 'rockies', value: 'Trips/Rockies 2026/Lakes' }),
      tag({ id: 'family', name: 'Family' }),
      tag({ id: 'empty', name: 'Empty' }),
    ];
    const statistics = [
      { id: 'trips', count: 1, total: 6 },
      { id: 'rockies', count: 3, total: 5 },
      { id: 'lakes', count: 2, total: 2 },
      { id: 'family', count: 9, total: 9 },
    ];

    it('carries each tag its own count and its total with subtags, zero when it has none', () => {
      const tree = buildTagTree(tags, statistics);
      expect(tree.byId.get('trips')).toMatchObject({ count: 1, total: 6 });
      expect(tree.byId.get('lakes')).toMatchObject({ count: 2, total: 2 });
      expect(tree.byId.get('empty')).toMatchObject({ count: 0, total: 0 });
    });

    it('orders siblings busiest first, then by name (prototype sortNodes)', () => {
      const tree = buildTagTree(tags, statistics);
      expect(tree.roots.map((node) => node.id)).toEqual(['family', 'trips', 'empty']);
    });

    it('lists the most used tags that carry items themselves, busiest first', () => {
      const tree = buildTagTree(tags, statistics);
      expect(mostUsedTags(tree).map((node) => node.id)).toEqual(['family', 'trips', 'rockies', 'lakes']);
      expect(mostUsedTags(tree, 2).map((node) => node.id)).toEqual(['family', 'trips']);
      expect(mostUsedTags(buildTagTree(tags, [{ id: 'trips', count: 0, total: 4 }]))).toEqual([]);
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

    it('finds tags by name, ignoring case, and opens the branches above each match', () => {
      expect(tagMatches(tree.byId.get('lakes')!, 'LAK')).toBe(true);
      expect(tagMatches(tree.byId.get('lakes')!, ' '.repeat(2))).toBe(false);
      expect(tagIdsRevealingMatches(tree, 'lak').sort()).toEqual(['rockies', 'trips']);
      expect(tagIdsRevealingMatches(tree, '')).toEqual([]);
    });

    it('expands every branch for "Expand all"', () => {
      expect(expandableTagIds(tree).sort()).toEqual(['rockies', 'trips']);
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
