import { findInTree, nameMatchesFind } from '$lib/frameleaf/discovery-find';
import type { DiscoveryTreeNode } from '$lib/frameleaf/discovery-tree';

const node = (id: string, children: DiscoveryTreeNode[] = []): DiscoveryTreeNode => ({ id, name: id, children });

const tree = [
  node('Trips', [node('Rockies 2026', [node('Day one')]), node('Coast')]),
  node('Family', [node('Birthdays')]),
  node('Rock garden'),
];
const find = (query: string) => findInTree(tree, ({ name }) => nameMatchesFind(name, query));

describe('Find in a discovery tree', () => {
  it('keeps the matches and the branches that lead to them, and nothing else', () => {
    const found = find(' rock ');

    expect(found.roots.map(({ id }) => id)).toEqual(['Trips', 'Rock garden']);
    const [trips] = found.roots;
    const [rockies] = trips.children;
    expect(trips.children.map(({ id }) => id)).toEqual(['Rockies 2026']);
    expect(rockies.children).toEqual([]);
    expect(found.matches).toBe(2);
    expect(found.firstMatchId).toBe('Rockies 2026');
  });

  it('opens every kept branch so a deep match is in view', () => {
    expect([...find('day one').expanded]).toEqual(['Rockies 2026', 'Trips']);
  });

  it('reports no rows when nothing matches, and never matches an empty search', () => {
    expect(find('zebra')).toMatchObject({ roots: [], matches: 0, firstMatchId: null });
    expect(nameMatchesFind('Trips', '  ')).toBe(false);
  });

  it('leaves the tree it was given untouched', () => {
    find('coast');
    expect(tree[0].children).toHaveLength(2);
  });
});
