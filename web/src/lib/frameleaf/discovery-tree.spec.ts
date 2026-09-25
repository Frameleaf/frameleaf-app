import { describe, expect, it } from 'vitest';
import { treeKeyAction, visibleTreeRows, type DiscoveryTreeNode } from '$lib/frameleaf/discovery-tree';

const node = (id: string, children: DiscoveryTreeNode[] = []): DiscoveryTreeNode => ({ id, name: id, children });

// trips ▸ rockies ▸ lakes, family (a deep branch next to a leaf)
const lakes = node('lakes');
const rockies = node('rockies', [lakes]);
const trips = node('trips', [rockies]);
const family = node('family');
const roots = [trips, family];

const context = (focusedId: string, expanded: Set<string>) => {
  const visible = visibleTreeRows(roots, expanded).map((row) => row.id);
  const all = new Map<string, { node: DiscoveryTreeNode; parent: string | null }>([
    ['trips', { node: trips, parent: null }],
    ['rockies', { node: rockies, parent: 'trips' }],
    ['lakes', { node: lakes, parent: 'rockies' }],
    ['family', { node: family, parent: null }],
  ]);
  const entry = all.get(focusedId)!;
  return {
    visible,
    focusedId,
    hasChildren: entry.node.children.length > 0,
    expanded: expanded.has(focusedId),
    parentId: entry.parent,
    firstChildId: entry.node.children.at(0)?.id ?? null,
  };
};

/** FL-46 keyboard tree (Tags.jsx:249-274, Folders.jsx:127-153). */
describe('discovery tree keyboard model', () => {
  it('lists only the rows under open branches, in order, however deep', () => {
    expect(visibleTreeRows(roots, new Set()).map((row) => row.id)).toEqual(['trips', 'family']);
    expect(visibleTreeRows(roots, new Set(['trips', 'rockies'])).map((row) => row.id)).toEqual([
      'trips',
      'rockies',
      'lakes',
      'family',
    ]);
    // an open branch under a closed one stays hidden
    expect(visibleTreeRows(roots, new Set(['rockies'])).map((row) => row.id)).toEqual(['trips', 'family']);
  });

  it('moves the tab stop with the arrows, Home and End', () => {
    const open = new Set(['trips', 'rockies']);
    expect(treeKeyAction('ArrowDown', context('rockies', open))).toEqual({ type: 'focus', id: 'lakes' });
    expect(treeKeyAction('ArrowUp', context('rockies', open))).toEqual({ type: 'focus', id: 'trips' });
    expect(treeKeyAction('ArrowUp', context('trips', open))).toBeNull();
    expect(treeKeyAction('ArrowDown', context('family', open))).toBeNull();
    expect(treeKeyAction('Home', context('lakes', open))).toEqual({ type: 'focus', id: 'trips' });
    expect(treeKeyAction('End', context('trips', open))).toEqual({ type: 'focus', id: 'family' });
  });

  it('opens a closed branch, then steps into it, with ArrowRight', () => {
    expect(treeKeyAction('ArrowRight', context('trips', new Set()))).toEqual({ type: 'expand', id: 'trips' });
    expect(treeKeyAction('ArrowRight', context('trips', new Set(['trips'])))).toEqual({ type: 'focus', id: 'rockies' });
    expect(treeKeyAction('ArrowRight', context('family', new Set()))).toBeNull();
  });

  it('closes an open branch, then steps to the parent, with ArrowLeft', () => {
    const open = new Set(['trips', 'rockies']);
    expect(treeKeyAction('ArrowLeft', context('rockies', open))).toEqual({ type: 'collapse', id: 'rockies' });
    expect(treeKeyAction('ArrowLeft', context('lakes', open))).toEqual({ type: 'focus', id: 'rockies' });
    expect(treeKeyAction('ArrowLeft', context('family', open))).toBeNull();
  });

  it('chooses the focused row with Enter or Space and ignores other keys', () => {
    expect(treeKeyAction('Enter', context('family', new Set()))).toEqual({ type: 'choose', id: 'family' });
    expect(treeKeyAction(' ', context('family', new Set()))).toEqual({ type: 'choose', id: 'family' });
    expect(treeKeyAction('a', context('family', new Set()))).toBeNull();
  });
});
