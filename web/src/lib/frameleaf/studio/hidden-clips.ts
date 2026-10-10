/**
 * Clips of media hidden from this session (FL-195 follow-up, owner decision, September 27, 2026).
 *
 * While the session is locked, a project keeps the clips of the owner's Locked items (and of items
 * their Locked rules hide), but the editor shows none of them: not as clips and not as missing media.
 * The server names those items in `resources.hiddenSources`. The host takes their clips out of the
 * graph it hands the editor ({@link holdBackHiddenClips}) and puts them back into every graph it saves
 * ({@link withHeldClips}), so an edit made while locked never drops them from the project.
 *
 * A clip is any object in an array of the graph whose `mediaId` or `assetId` names a hidden item.
 * Whatever else in the graph points at a held clip by its id (a transition's `leftClipId`, a
 * keyframe's `itemId`, a link list) is held with it, so the editor never meets a dangling reference.
 * Each held entry remembers the array it came from, by object keys and, inside arrays, by the `id` of
 * the element that holds it, and goes back there when the graph is saved, unless an entry with its id
 * is already there. Graphs are never mutated; both functions return copies where they change anything.
 */

type Json = unknown;
type JsonObject = Record<string, Json>;

/** One step from the graph root to an array: an object key, or the element of an array with this id. */
export type StudioGraphStep = { key: string } | { id: string };

export interface StudioHeldClip {
  /** Where the array that held it is: object keys, and array elements by their `id`. */
  path: StudioGraphStep[];
  /** The entry, exactly as the stored graph had it. */
  entry: JsonObject;
}

const MAX_DEPTH = 64;

const isObject = (value: Json): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value);

const idOf = (value: Json): string | null => (isObject(value) && typeof value.id === 'string' ? value.id : null);

const namesHiddenMedia = (entry: JsonObject, hidden: ReadonlySet<string>) =>
  (typeof entry.mediaId === 'string' && hidden.has(entry.mediaId)) ||
  (typeof entry.assetId === 'string' && hidden.has(entry.assetId));

/** Whether an entry points at one of these clip ids through a direct string or string-list field. */
const pointsAt = (entry: JsonObject, ids: ReadonlySet<string>) =>
  Object.entries(entry).some(
    ([key, value]) =>
      key !== 'id' &&
      ((typeof value === 'string' && ids.has(value)) ||
        (Array.isArray(value) && value.some((item) => typeof item === 'string' && ids.has(item)))),
  );

/**
 * Take out every clip of hidden media, and what points at those clips, from a copy of the graph.
 * With nothing hidden (the owner's unlocked session) the graph is returned as it is.
 */
export const holdBackHiddenClips = (
  graph: Json,
  hiddenSources: readonly string[] | null | undefined,
): { graph: Json; held: StudioHeldClip[] } => {
  const hidden = new Set(hiddenSources);
  if (hidden.size === 0 || !graph || typeof graph !== 'object') {
    return { graph, held: [] };
  }

  const held: StudioHeldClip[] = [];
  const heldIds = new Set<string>();

  // A pass takes out what names hidden media or points at a clip already held; repeat until nothing
  // more goes (a transition of a keyframed clip, a link of a link), bounded like the resolver's walk.
  let current: Json = graph;
  for (let pass = 0; pass < 8; pass++) {
    const before = held.length;
    current = strip(
      current,
      [],
      0,
      (entry) => namesHiddenMedia(entry, hidden) || pointsAt(entry, heldIds),
      (path, entry) => {
        held.push({ path, entry });
        const id = idOf(entry);
        if (id) {
          heldIds.add(id);
        }
      },
    );
    if (held.length === before) {
      break;
    }
  }

  return { graph: current, held };
};

const strip = (
  node: Json,
  path: StudioGraphStep[],
  depth: number,
  shouldHold: (entry: JsonObject) => boolean,
  onHold: (path: StudioGraphStep[], entry: JsonObject) => void,
): Json => {
  if (depth > MAX_DEPTH || !node || typeof node !== 'object') {
    return node;
  }
  if (Array.isArray(node)) {
    let changed = false;
    const kept: Json[] = [];
    for (const item of node) {
      if (isObject(item) && shouldHold(item)) {
        onHold(path, item);
        changed = true;
        continue;
      }
      const id = idOf(item);
      const next = id === null ? item : strip(item, [...path, { id }], depth + 1, shouldHold, onHold);
      changed ||= next !== item;
      kept.push(next);
    }
    return changed ? kept : node;
  }
  let changed = false;
  const copy: JsonObject = {};
  for (const [key, value] of Object.entries(node)) {
    const next = strip(value, [...path, { key }], depth + 1, shouldHold, onHold);
    changed ||= next !== value;
    copy[key] = next;
  }
  return changed ? copy : node;
};

/** The array a path names in this graph, or null when the editor removed what held it. */
const arrayAt = (root: Json, path: readonly StudioGraphStep[]): Json[] | null => {
  let node: Json = root;
  for (const step of path) {
    if ('key' in step) {
      node = isObject(node) ? node[step.key] : undefined;
    } else {
      node = Array.isArray(node) ? node.find((item) => idOf(item) === step.id) : undefined;
    }
    if (node === undefined) {
      return null;
    }
  }
  return Array.isArray(node) ? node : null;
};

/**
 * The graph with every held clip back in the array it came from (appended, since the editor's own
 * order may have moved on), unless an entry with its id is already there. A held clip whose array the
 * editor removed altogether (a deleted nested sequence) goes with it.
 */
export const withHeldClips = (graph: Json, held: readonly StudioHeldClip[]): Json => {
  if (held.length === 0 || !graph || typeof graph !== 'object') {
    return graph;
  }
  const copy = structuredClone(graph);
  for (const { path, entry } of held) {
    const array = arrayAt(copy, path);
    const id = idOf(entry);
    if (!array || (id !== null && array.some((item) => idOf(item) === id))) {
      continue;
    }
    array.push(structuredClone(entry));
  }
  return copy;
};
