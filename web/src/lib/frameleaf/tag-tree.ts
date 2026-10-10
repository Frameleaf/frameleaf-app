import type { TagResponseDto, TagStatisticsResponseDto } from '@frameleaf/sdk';

/**
 * Client-side tag tree adapter for the Frameleaf Tags screen (FL-46, redesigned as "tags as
 * collections").
 *
 * Built directly from the production tag API: every tag carries a real `parentId` and `color`, set
 * by `POST /tags` and changed (name, colour, parent) by `PUT /tags/:id`. Counts, covers and the
 * capture-date range come from `GET /tags/statistics`: `count` is the Timeline items carrying
 * exactly the tag, and `total`, the covers and the dates cover those carrying it or any tag under
 * it, which is also what the tag's page shows, because the tag filter matches a tag's whole
 * subtree. Nothing archived, Locked or hidden is ever counted or shown as a cover.
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
  /** Up to four items for the cover, newest capture first, from the same items as `total`. */
  covers: string[];
  /** Capture date of the oldest and the newest item in `total`; null for a tag without items. */
  startDate: string | null;
  endDate: string | null;
}

export interface FrameleafTagTree {
  roots: FrameleafTagNode[];
  byId: Map<string, FrameleafTagNode>;
}

/** Busiest first, then by name: the order the tree is built in. */
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
      // A server from before the covers existed sends none; the card then shows its empty tile.
      covers: (row?.coverAssetIds ?? []).slice(0, 4),
      startDate: row?.startDate ?? null,
      endDate: row?.endDate ?? null,
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

/** The node's id plus every descendant's id. */
export const tagAndDescendantIds = (node: FrameleafTagNode): string[] => {
  const ids: string[] = [node.id];
  for (const child of node.children) {
    ids.push(...tagAndDescendantIds(child));
  }
  return ids;
};

/** How many tags sit under the node at any depth: what deleting it takes along. */
export const tagDescendantCount = (node: FrameleafTagNode): number => tagAndDescendantIds(node).length - 1;

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

/**
 * How the index orders tags: busiest first (the tree's own order), by name, or by the capture date
 * of the newest item. "Newest" is the newest photo carrying the tag, not when the tag was last
 * applied, which the server does not record.
 */
export const TAG_SORTS = ['used', 'name', 'newest'] as const;
export type TagSort = (typeof TAG_SORTS)[number];

export const isTagSort = (value: unknown): value is TagSort => TAG_SORTS.includes(value as TagSort);

const compareNames = (a: FrameleafTagNode, b: FrameleafTagNode) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) || a.id.localeCompare(b.id);

const tagComparators: Record<TagSort, (a: FrameleafTagNode, b: FrameleafTagNode) => number> = {
  used: compareNodes,
  name: compareNames,
  // ISO dates compare as text; a tag without items has no date and goes last.
  newest: (a, b) => (b.endDate ?? '').localeCompare(a.endDate ?? '') || compareNames(a, b),
};

/** A copy of the tags in the chosen order; the tree itself stays busiest first. */
export const sortTagNodes = (nodes: readonly FrameleafTagNode[], sort: TagSort): FrameleafTagNode[] =>
  [...nodes].sort(tagComparators[sort]);

/**
 * The list view's rows: every level in the chosen order, and a branch's tags only while it is open.
 */
export const visibleTagRows = (
  tree: FrameleafTagTree,
  expanded: ReadonlySet<string>,
  sort: TagSort = 'used',
): FrameleafTagNode[] => {
  const out: FrameleafTagNode[] = [];
  const visit = (nodes: FrameleafTagNode[]) => {
    for (const node of sortTagNodes(nodes, sort)) {
      out.push(node);
      if (node.children.length > 0 && expanded.has(node.id)) {
        visit(node.children);
      }
    }
  };
  visit(tree.roots);
  return out;
};

/** Every tag that has tags inside it: the "groups" of the counts line, and what "Expand all" opens. */
export const expandableTagIds = (tree: FrameleafTagTree): string[] =>
  flattenTagTree(tree)
    .filter((node) => node.children.length > 0)
    .map((node) => node.id);

/** "Find a tag": a case-insensitive match on the tag's own name. */
export const tagMatches = (node: FrameleafTagNode, query: string): boolean => {
  const needle = query.trim().toLowerCase();
  return needle !== '' && node.name.toLowerCase().includes(needle);
};

/** "Find a tag" results: every matching tag, nested ones included, as one flat list in the chosen order. */
export const findTags = (tree: FrameleafTagTree, query: string, sort: TagSort = 'used'): FrameleafTagNode[] =>
  sortTagNodes(
    flattenTagTree(tree).filter((node) => tagMatches(node, query)),
    sort,
  );

/** Where a nested tag sits: its ancestors' names, outermost first; empty for a top-level tag. */
export const tagTrail = (node: FrameleafTagNode): string[] => node.path.slice(0, -1);

/** The card's "tags inside" line: the first few names (busiest first) and how many more there are. */
export const tagInsideSummary = (node: FrameleafTagNode, limit = 3): { names: string[]; more: number } => {
  const names = node.children.slice(0, limit).map((child) => child.name);
  return { names, more: node.children.length - names.length };
};

/** Whether `node` is `ancestor` or sits anywhere under it. */
const isWithinTag = (node: FrameleafTagNode, ancestor: FrameleafTagNode): boolean => {
  for (let current: FrameleafTagNode | null = node; current; current = current.parent) {
    if (current.id === ancestor.id) {
      return true;
    }
  }
  return false;
};

/** Where a tag may be moved: every tag except itself and the tags inside it, in tree order. */
export const tagMoveTargets = (tree: FrameleafTagTree, node: FrameleafTagNode): FrameleafTagNode[] =>
  flattenTagTree(tree).filter((candidate) => !isWithinTag(candidate, node));

export type TagMoveProblem = 'same-place' | 'inside-itself' | 'name-taken';

/**
 * Why a tag cannot be moved under `parentId` (null for the top level), or null when it can: it is
 * there already, the target is the tag itself or one inside it, or a tag with its name is there.
 * The server refuses the same moves; checking here says why before anything is sent.
 */
export const tagMoveProblem = (
  tree: FrameleafTagTree,
  node: FrameleafTagNode,
  parentId: string | null,
): TagMoveProblem | null => {
  if ((node.parent?.id ?? null) === parentId) {
    return 'same-place';
  }
  const target = parentId ? tree.byId.get(parentId) : undefined;
  if (target && isWithinTag(target, node)) {
    return 'inside-itself';
  }
  return tagNameTaken(tree, parentId, node.name, node.id) ? 'name-taken' : null;
};

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
