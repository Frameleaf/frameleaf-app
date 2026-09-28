import type { TagResponseDto, TagStatisticsResponseDto } from '@immich/sdk';

/**
 * Client-side tag tree adapter for the Frameleaf Tags browser (FL-46).
 *
 * Ported from the approved prototype (`design/frameleaf/template/src/Tags.jsx`,
 * `discovery-data.mjs` `tagTree`), but built directly from the production tag API instead of the
 * prototype's slash-path/localStorage-override simulation: every tag carries a real `parentId` and
 * `color`, set by `POST /tags` and changed (name, colour, parent) by `PUT /tags/:id`. Counts come
 * from `GET /tags/statistics`: `count` is the Timeline items carrying exactly the tag and `total`
 * those carrying it or any tag under it, which is also what "Show all" opens, because the tag filter
 * matches a tag's whole subtree. Nothing archived, Locked or hidden is ever counted.
 *
 * Mirrors the cycle-guarding of `album-tree.ts` so both trees behave the same way.
 */

export interface FrameleafTagNode {
  id: string;
  /** Leaf name, e.g. "Rockies 2026" for a tag whose value is "Trips/Rockies 2026". */
  name: string;
  /** The tag's full value ("Trips/Rockies 2026"), which is also its `?path=` address. */
  value: string;
  /** Tag color (hex), or null when the tag has none set. */
  color: string | null;
  parent: FrameleafTagNode | null;
  children: FrameleafTagNode[];
  /** Display path from the root, e.g. ["Trips", "Rockies 2026"]. */
  path: string[];
  depth: number;
  /** Timeline items tagged with exactly this tag. */
  count: number;
  /** Timeline items tagged with this tag or any tag under it (prototype `total`). */
  total: number;
}

export interface FrameleafTagTree {
  roots: FrameleafTagNode[];
  byId: Map<string, FrameleafTagNode>;
}

/** Prototype `sortNodes`: busiest first, then by name. */
const compareNodes = (a: FrameleafTagNode, b: FrameleafTagNode) =>
  b.total - a.total || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

/**
 * Build the tag tree from the flat list `getAllTags()` returns, with the counts from
 * `getTagStatistics()` (a tag missing from the statistics has no counted items).
 *
 * A tag whose `parentId` is not in the list (deleted or filtered out between the tag load and
 * this build) is promoted to the root, matching how `album-tree.ts` treats a missing parent. A
 * cycle in `parentId` — which the server should never produce, but a client is not allowed to
 * trust that — also promotes the tag to the root rather than looping.
 */
export function buildTagTree(
  tags: readonly TagResponseDto[],
  statistics: readonly TagStatisticsResponseDto[] = [],
): FrameleafTagTree {
  const counts = new Map(statistics.map((row) => [row.id, row]));
  const byId = new Map<string, FrameleafTagNode>();
  for (const tag of tags) {
    const row = counts.get(tag.id);
    byId.set(tag.id, {
      id: tag.id,
      name: tag.name,
      value: tag.value,
      color: tag.color ?? null,
      parent: null,
      children: [],
      path: [],
      depth: 0,
      count: row?.count ?? 0,
      total: row?.total ?? 0,
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
    node.children.sort(compareNodes);
    for (const child of node.children) {
      assignPath(child, node.path, depth + 1);
    }
  };
  roots.sort(compareNodes);
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
  const trimmed = trimTagPath(path);
  if (trimmed === '') {
    return true;
  }
  return tags.some((tag) => tag.value === trimmed || tag.value.startsWith(`${trimmed}/`));
};

const trimTagPath = (path: string) => path.replaceAll(/^\/+|\/+$/g, '');

/** The tag a `?path=` address selects, or null for the overview (or a path that is only a prefix). */
export const tagAtPath = (tree: FrameleafTagTree, path: string): FrameleafTagNode | null => {
  const trimmed = trimTagPath(path);
  if (trimmed === '') {
    return null;
  }
  for (const node of tree.byId.values()) {
    if (node.value === trimmed) {
      return node;
    }
  }
  return null;
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

/** The ids of the node's ancestors (not the node), for opening the branches above it. */
export const tagAncestorIds = (node: FrameleafTagNode): string[] =>
  tagBreadcrumbs(node)
    .slice(0, -1)
    .map((ancestor) => ancestor.id);

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

/** Every branch id, for "Expand all" (prototype `Tags.jsx:305-316`). */
export const expandableTagIds = (tree: FrameleafTagTree): string[] =>
  flattenTagTree(tree)
    .filter((node) => node.children.length > 0)
    .map((node) => node.id);

/** Prototype "Find a tag": a case-insensitive match on the tag's own name. */
export const tagMatches = (node: FrameleafTagNode, query: string): boolean => {
  const needle = query.trim().toLowerCase();
  return needle !== '' && node.name.toLowerCase().includes(needle);
};

/** Searching opens every ancestor of a match so it can be seen (prototype `Tags.jsx:206-216`). */
export const tagIdsRevealingMatches = (tree: FrameleafTagTree, query: string): string[] => {
  const ids = new Set<string>();
  for (const node of tree.byId.values()) {
    if (tagMatches(node, query)) {
      for (const id of tagAncestorIds(node)) {
        ids.add(id);
      }
    }
  }
  return [...ids];
};

/** Prototype "Most used": tags carrying items themselves, busiest (with subtags) first, at most 12. */
export const mostUsedTags = (tree: FrameleafTagTree, limit = 12): FrameleafTagNode[] =>
  [...tree.byId.values()]
    .filter((node) => node.count > 0)
    .sort((a, b) => b.total - a.total || a.path.join('/').localeCompare(b.path.join('/')))
    .slice(0, limit);

/**
 * Prototype "Give the tag a name without slashes." (`discovery-data.mjs` `tagName`): trimmed, 1–60
 * characters, no slash or control character. Returns the cleaned name, or null when it is not valid.
 */
export const cleanTagName = (value: string): string | null => {
  const name = value.trim();
  // eslint-disable-next-line no-control-regex
  return name.length > 0 && name.length <= 60 && !/[\u{0}-\u{1F}/]/u.test(name) ? name : null;
};

/** Whether a sibling under `parent` (or a top-level tag) already has this name, ignoring case. */
export const tagNameTaken = (
  tree: FrameleafTagTree,
  parentId: string | null,
  name: string,
  exceptId?: string,
): boolean => {
  const siblings = parentId ? (tree.byId.get(parentId)?.children ?? []) : tree.roots;
  const lower = name.toLowerCase();
  return siblings.some((node) => node.id !== exceptId && node.name.toLowerCase() === lower);
};

/**
 * The prototype's eight tag colours (`discovery-data.mjs` `tagColors`, `discovery.css`
 * `--dv-color-*`). The API stores any hex colour, so each option is saved as its hex; `aliases`
 * are the hexes the first FL-46 palette saved, so those tags still show their colour's name.
 */
export const TAG_COLORS = [
  { id: 'grey', hex: '#8b95a1', aliases: ['#6b7280'] },
  { id: 'green', hex: '#3fb46a', aliases: ['#22c55e'] },
  { id: 'teal', hex: '#0ea5a0', aliases: [] },
  { id: 'blue', hex: '#5794f7', aliases: [] },
  { id: 'purple', hex: '#8b6cf0', aliases: ['#a78bfa'] },
  { id: 'pink', hex: '#d9639b', aliases: ['#f472b6'] },
  { id: 'amber', hex: '#d9a441', aliases: ['#e4bd69'] },
  { id: 'red', hex: '#f16966', aliases: [] },
] as const;

export type TagColorId = (typeof TAG_COLORS)[number]['id'];

/** The prototype's default colour for a new tag. */
export const DEFAULT_TAG_COLOR: TagColorId = 'grey';

/** Which palette colour a stored hex is, if any (case-insensitive, with or without "#"). */
export const tagColorId = (hex: string | null | undefined): TagColorId | null => {
  if (!hex) {
    return null;
  }
  const normalized = (hex.startsWith('#') ? hex : `#${hex}`).toLowerCase();
  const match = TAG_COLORS.find(
    (option) => option.hex === normalized || (option.aliases as readonly string[]).includes(normalized),
  );
  return match?.id ?? null;
};

export const tagColorHex = (id: TagColorId): string => TAG_COLORS.find((option) => option.id === id)!.hex;

/** What a tag's dot is drawn in: its own colour, else the prototype's grey. */
export const tagDotColor = (hex: string | null | undefined): string => {
  if (!hex) {
    return tagColorHex(DEFAULT_TAG_COLOR);
  }
  return hex.startsWith('#') ? hex : `#${hex}`;
};
