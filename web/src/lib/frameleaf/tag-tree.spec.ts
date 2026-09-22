import type { TagResponseDto } from '@immich/sdk';
import { describe, expect, it } from 'vitest';
import { buildTagTree, flattenTagTree, tagAndDescendantIds, tagBreadcrumbs, visibleTagRows } from '$lib/frameleaf/tag-tree';

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
    const tree = buildTagTree([
      tag({ id: 'a', name: 'A', parentId: 'b' }),
      tag({ id: 'b', name: 'B', parentId: 'a' }),
    ]);
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
});
