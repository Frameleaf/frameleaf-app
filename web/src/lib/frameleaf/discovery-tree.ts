/**
 * The keyboard model shared by the Tags and Folders trees (FL-46), ported from the prototype's
 * `keyboard` handlers (`design/frameleaf/template/src/Tags.jsx:249-274`, `Folders.jsx:127-153`):
 * a single tab stop that roves with the arrow keys, Home and End; Right expands a closed branch or
 * moves into an open one; Left closes an open branch or moves to the parent; Enter and Space choose
 * the focused row.
 *
 * Pure, so the rules are tested without a DOM and both trees answer a key exactly the same way.
 */

export interface DiscoveryTreeNode {
  /** Stable id: a tag id, or a folder path. */
  id: string;
  name: string;
  children: DiscoveryTreeNode[];
}

/** The rows a reader can currently reach, in order, honouring which branches are open. */
export const visibleTreeRows = <T extends DiscoveryTreeNode>(
  roots: readonly T[],
  expanded: ReadonlySet<string>,
): T[] => {
  const out: T[] = [];
  const visit = (nodes: readonly T[]) => {
    for (const node of nodes) {
      out.push(node);
      if (node.children.length > 0 && expanded.has(node.id)) {
        visit(node.children as T[]);
      }
    }
  };
  visit(roots);
  return out;
};

export type TreeKeyAction =
  | { type: 'focus'; id: string }
  | { type: 'expand'; id: string }
  | { type: 'collapse'; id: string }
  | { type: 'choose'; id: string };

export interface TreeKeyContext {
  /** The ids of the visible rows, in order (`visibleTreeRows`). */
  visible: readonly string[];
  /** The row holding the tab stop. */
  focusedId: string;
  hasChildren: boolean;
  expanded: boolean;
  parentId: string | null;
  firstChildId: string | null;
}

/** What a key does in the tree, or null when the tree leaves the key alone. */
export const treeKeyAction = (key: string, context: TreeKeyContext): TreeKeyAction | null => {
  const { visible, focusedId, hasChildren, expanded, parentId, firstChildId } = context;
  const index = visible.indexOf(focusedId);
  const focus = (id: string | undefined): TreeKeyAction | null => (id === undefined ? null : { type: 'focus', id });
  switch (key) {
    case 'ArrowDown': {
      return index === -1 ? focus(visible[0]) : focus(visible[index + 1]);
    }
    case 'ArrowUp': {
      return index <= 0 ? null : focus(visible[index - 1]);
    }
    case 'Home': {
      return focus(visible[0]);
    }
    case 'End': {
      return focus(visible.at(-1));
    }
    case 'ArrowRight': {
      if (!hasChildren) {
        return null;
      }
      return expanded ? focus(firstChildId ?? undefined) : { type: 'expand', id: focusedId };
    }
    case 'ArrowLeft': {
      if (hasChildren && expanded) {
        return { type: 'collapse', id: focusedId };
      }
      return focus(parentId ?? undefined);
    }
    case 'Enter':
    case ' ': {
      return { type: 'choose', id: focusedId };
    }
    default: {
      return null;
    }
  }
};
