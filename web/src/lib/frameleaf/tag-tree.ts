import type { TagResponseDto } from '@immich/sdk';

/**
 * Client-side tag tree adapter for the Frameleaf Tags browser (FL-46).
 *
 * Ported from the approved prototype (`design/frameleaf/template/src/Tags.jsx`,
 * `discovery-data.mjs`), but built directly from the production tag API instead of the
 * prototype's slash-path/localStorage-override simulation: every tag already carries a real
 * `parentId` and `color`, set at creation time by `POST /tags` (`createTag`) and changed by
 * `PUT /tags/:id` (`updateTag`). There is no endpoint to re-parent an existing tag, so unlike
 * the prototype this adapter never exposes a "move" action; nesting happens only at creation.
 *
 * Mirrors the shape and cycle-guarding of `album-tree.ts` so both trees behave the same way in
 * the rail and in their browsers.
 */

export interface FrameleafTagNode {
  id: string;
  /** Leaf name, e.g. "Rockies 2026" for a tag whose value is "Trips/Rockies 2026". */
  name: string;
  /** Tag color (hex), or null when the tag has none set. */
  color: string | null;
  parent: FrameleafTagNode | null;
  children: FrameleafTagNode[];
  /** Display path from the root, e.g. ["Trips", "Rockies 2026"]. */
  path: string[];
  depth: number;
}

export interface FrameleafTagTree {
  roots: FrameleafTagNode[];
  byId: Map<string, FrameleafTagNode>;
}

const compareByName = (a: FrameleafTagNode, b: FrameleafTagNode) =>
  a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

/**
 * Build the tag tree from the flat list `getAllTags()` returns.
 *
 * A tag whose `parentId` is not in the list (deleted or filtered out between the tag load and
 * this build) is promoted to the root, matching how `album-tree.ts` treats a missing parent. A
 * cycle in `parentId` — which the server should never produce, but a client is not allowed to
 * trust that — also promotes the tag to the root rather than looping.
 */
export function buildTagTree(tags: TagResponseDto[]): FrameleafTagTree {
  const byId = new Map<string, FrameleafTagNode>();
  for (const tag of tags) {
    byId.set(tag.id, {
      id: tag.id,
      name: tag.name,
      color: tag.color ?? null,
      parent: null,
      children: [],
      path: [],
      depth: 0,
    });
  }

  const byTagId = new Map(tags.map((tag) => [tag.id, tag]));
  const roots: FrameleafTagNode[] = [];

  for (const tag of tags) {
    const node = byId.get(tag.id)!;
    const parentId = resolveParentId(tag.id, byTagId);
    const parent = parentId ? byId.get(parentId) : undefined;
    if (parent) {
      node.parent = parent;
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const assignPath = (node: FrameleafTagNode, ancestors: string[], depth: number) => {
    node.path = [...ancestors, node.name];
    node.depth = depth;
    node.children.sort(compareByName);
    for (const child of node.children) {
      assignPath(child, node.path, depth + 1);
    }
  };
  roots.sort(compareByName);
  for (const root of roots) {
    assignPath(root, [], 0);
  }

  return { roots, byId };
}

/**
 * The tag's direct parent id, or null when it has none, its parent is missing from the list, or
 * following the chain upward from the parent would eventually cycle back to this tag.
 */
function resolveParentId(tagId: string, byTagId: Map<string, TagResponseDto>): string | null {
  const tag = byTagId.get(tagId);
  if (!tag?.parentId || !byTagId.has(tag.parentId)) {
    return null;
  }
  const seen = new Set<string>([tagId]);
  let current: TagResponseDto | undefined = tag;
  while (current?.parentId) {
    if (seen.has(current.parentId)) {
      return null;
    }
    seen.add(current.parentId);
    current = byTagId.get(current.parentId);
  }
  return tag.parentId;
}

/**
 * Whether a tags-page address names something in the tag list: a tag's full value, or a path that
 * a tag's value continues. An empty path is the page with nothing selected, which always exists.
 *
 * The list leaves out a tag the owner suppressed (and every tag nested under it) while the session
 * is not unlocked, so an address for one is not found, exactly like an address for a deleted tag.
 */
export const tagPathExists = (tags: readonly TagResponseDto[], path: string): boolean => {
  const trimmed = path.replaceAll(/^\/+|\/+$/g, '');
  if (trimmed === '') {
    return true;
  }
  return tags.some((tag) => tag.value === trimmed || tag.value.startsWith(`${trimmed}/`));
};

/** The node's ancestors, root first, followed by the node itself. */
export const tagBreadcrumbs = (node: FrameleafTagNode): FrameleafTagNode[] => {
  const chain: FrameleafTagNode[] = [];
  let current: FrameleafTagNode | null = node;
  while (current) {
    chain.unshift(current);
    current = current.parent;
  }
  return chain;
};

/** The node's id plus every descendant's id, for an "any of these tags" query filter. */
export const tagAndDescendantIds = (node: FrameleafTagNode): string[] => {
  const ids: string[] = [node.id];
  for (const child of node.children) {
    ids.push(...tagAndDescendantIds(child));
  }
  return ids;
};

export const flattenTagTree = (tree: FrameleafTagTree): FrameleafTagNode[] => {
  const out: FrameleafTagNode[] = [];
  const visit = (node: FrameleafTagNode) => {
    out.push(node);
    for (const child of node.children) {
      visit(child);
    }
  };
  for (const root of tree.roots) {
    visit(root);
  }
  return out;
};

/** Visible rows in tree order, honoring which node ids are expanded. */
export const visibleTagRows = (tree: FrameleafTagTree, expanded: ReadonlySet<string>): FrameleafTagNode[] => {
  const out: FrameleafTagNode[] = [];
  const visit = (nodes: FrameleafTagNode[]) => {
    for (const node of nodes) {
      out.push(node);
      if (node.children.length > 0 && expanded.has(node.id)) {
        visit(node.children);
      }
    }
  };
  visit(tree.roots);
  return out;
};

/** A fixed, translated-by-caller swatch palette. The API accepts any hex color; these are the
 * offered suggestions, matching the prototype's eight-color palette with production hex values. */
export const TAG_COLOR_SWATCHES: readonly { id: string; hex: string }[] = [
  { id: 'grey', hex: '#6b7280' },
  { id: 'green', hex: '#22c55e' },
  { id: 'teal', hex: '#0ea5a0' },
  { id: 'blue', hex: '#5794f7' },
  { id: 'purple', hex: '#a78bfa' },
  { id: 'pink', hex: '#f472b6' },
  { id: 'amber', hex: '#e4bd69' },
  { id: 'red', hex: '#f16966' },
];
