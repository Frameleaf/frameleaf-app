/**
 * "Find" in the Tags and Folders trees: the tree narrows to the rows whose name matches, plus the
 * branches that lead to them, so a long list visibly answers what was typed. Places filters its
 * grid the same way, so Find means one thing on all three pages.
 *
 * Pure, so both trees narrow exactly alike and the rule is tested without a DOM.
 */
import type { DiscoveryTreeNode } from '$lib/frameleaf/discovery-tree';

export interface TreeFindResult<T extends DiscoveryTreeNode> {
  /** Copies of the matching rows and their ancestors; a row keeps only the children that lead to a match. */
  roots: T[];
  /** How many rows match by name (ancestors shown only as a path are not counted). */
  matches: number;
  /** Every kept branch, so each match is in view without the reader opening anything. */
  expanded: Set<string>;
  /** The first match from the top, to scroll into view. */
  firstMatchId: string | null;
}

/** Whether `name` contains what was typed, ignoring case and surrounding spaces. Empty never matches. */
export const nameMatchesFind = (name: string, query: string): boolean => {
  const needle = query.trim().toLowerCase();
  return needle !== '' && name.toLowerCase().includes(needle);
};

export const findInTree = <T extends DiscoveryTreeNode>(
  roots: readonly T[],
  isMatch: (node: T) => boolean,
): TreeFindResult<T> => {
  const expanded = new Set<string>();
  let matches = 0;
  let firstMatchId: string | null = null;

  const prune = (nodes: readonly T[]): T[] => {
    const kept: T[] = [];
    for (const node of nodes) {
      const matched = isMatch(node);
      if (matched) {
        matches += 1;
        firstMatchId ??= node.id;
      }
      const children = prune(node.children as T[]);
      if (!matched && children.length === 0) {
        continue;
      }
      if (children.length > 0) {
        expanded.add(node.id);
      }
      kept.push({ ...node, children });
    }
    return kept;
  };

  return { roots: prune(roots), matches, expanded, firstMatchId };
};
