import { describe, expect, it } from 'vitest';
import {
  collectionColour,
  collectionPath,
  collectionTree,
  isCollectionColour,
  type CollectionChoice,
} from './collections';

const a = (id: string, albumName: string, parentId: string | null = null) =>
  ({ id, albumName, parentId }) as CollectionChoice;

describe('collections', () => {
  it('orders collections as a tree with depth and children', () => {
    const tree = collectionTree([
      a('c', 'Packaging', 'p'),
      a('p', 'Inspiration'),
      a('b', 'Archive'),
      a('o', 'Orphan', 'missing'),
    ]);
    expect(
      tree.map(({ collection, depth, hasChildren }) => [
        collection.albumName,
        depth,
        hasChildren,
      ]),
    ).toEqual([
      ['Archive', 0, false],
      ['Inspiration', 0, true],
      ['Packaging', 1, false],
      ['Orphan', 0, false],
    ]);
    expect(tree.findIndex(({ collection }) => collection.id === 'c')).toBe(
      tree.findIndex(({ collection }) => collection.id === 'p') + 1,
    );
  });
  it('builds paths and survives cycles', () => {
    const list = [a('p', 'Inspiration'), a('c', 'Packaging', 'p')];
    expect(collectionPath(list, 'c')).toEqual(['Inspiration', 'Packaging']);
    const cycle = [a('x', 'X', 'y'), a('y', 'Y', 'x')];
    expect(collectionPath(cycle, 'x')).toEqual(['Y', 'X']);
    expect(collectionTree(cycle)).toHaveLength(2);
  });
  it('accepts only known colours', () => {
    expect(isCollectionColour('teal')).toBe(true);
    expect(isCollectionColour('toString')).toBe(false);
    expect(isCollectionColour('#fff')).toBe(false);
    expect(collectionColour({ ...a('t', 'T'), color: 'teal' })).toBe('#0ea5a0');
    expect(collectionColour(a('n', 'N'))).toBeUndefined();
  });
});
