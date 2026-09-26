import { getAlbumInfo, getPerson, getPet, getTagById } from '@immich/sdk';

/**
 * Name lookups for a person/pet/tag (and an album, for the FL-49 search chips) behind an id-list
 * library filter (FL-45).
 *
 * A structured filter (`personIds`, `petIds` since FL-58's pet search filter, `tagIds`) carries
 * only ids: the route that owns the filter (Photos reached from a "view in library" link, a typed
 * search, a pet's page) has no name to give a bulk-download archive without asking for one. This module
 * is that ask: a thin, cached wrapper over the already-authorized single-entity SDK reads
 * (`getPerson`, `getPet`, `getTagById`), used only for naming — never for access control, which
 * those endpoints already enforce (an id the caller cannot see 403s, which resolves here to `null`
 * exactly like any other lookup failure).
 *
 * A lookup never blocks or fails the download it is naming: every rejection — not found, not
 * authorized, network error — resolves to `null`, and the caller falls back to a generic label.
 * `null` is also what a *successful* lookup returns for a person or pet marked hidden, or with no
 * name set: the owner decision this ships under is explicit that a hidden identity's name must
 * never leak into a filename, and an empty name is not a name.
 */
export type FilterEntityKind = 'person' | 'pet' | 'tag' | 'album';

const nameCache = new Map<string, Promise<string | null>>();

const cacheKey = (kind: FilterEntityKind, id: string) => `${kind}:${id}`;

const fetchEntityName = async (kind: FilterEntityKind, id: string): Promise<string | null> => {
  if (kind === 'person') {
    const person = await getPerson({ id });
    return person.isHidden || !person.name.trim() ? null : person.name;
  }
  if (kind === 'pet') {
    const pet = await getPet({ id });
    return pet.isHidden || !pet.name.trim() ? null : pet.name;
  }
  if (kind === 'album') {
    // FL-49: the /search chip row names an album condition too; the album read enforces access
    const album = await getAlbumInfo({ id });
    return album.albumName.trim() || null;
  }
  const tag = await getTagById({ id });
  // The full nested path ("Trips/Rockies"), not just the leaf name: it is what the existing
  // search filter-chip row already shows for a tag (`getTagNames` on the search route) and it
  // disambiguates same-named tags nested under different parents. `sanitizeArchiveSegment` turns
  // its `/` into a hyphen like any other reserved character.
  return tag.value.trim() || null;
};

/** Resolve and cache one entity's display name for a filename. See the module doc for what `null` covers. */
export const resolveEntityName = (kind: FilterEntityKind, id: string): Promise<string | null> => {
  const key = cacheKey(kind, id);
  let cached = nameCache.get(key);
  if (!cached) {
    cached = fetchEntityName(kind, id).catch(() => null);
    nameCache.set(key, cached);
  }
  return cached;
};

/** Resolve several ids of the same kind, in order, each independently falling back to `null`. */
export const resolveEntityNames = (kind: FilterEntityKind, ids: string[]): Promise<(string | null)[]> =>
  Promise.all(ids.map((id) => resolveEntityName(kind, id)));

/**
 * FL-37: forget some cached names (a person renamed, hidden or merged away), so the next lookup
 * reads the current one.
 */
export const forgetEntityNames = (kind: FilterEntityKind, ids: string[]) => {
  for (const id of ids) {
    nameCache.delete(cacheKey(kind, id));
  }
};

/** Test seam: forget cached results so the next call looks up again. */
export const resetFilterEntityNameCache = () => {
  nameCache.clear();
};
