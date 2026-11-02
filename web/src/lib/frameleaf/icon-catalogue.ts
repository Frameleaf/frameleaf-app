import { getAlbumIconCatalogue, type AlbumIconCatalogueResponseDto } from '@frameleaf/sdk';
import { ALBUM_ICONS, DEFAULT_ALBUM_ICON_PATH } from '$lib/utils/album-icons';

/**
 * Icon catalogue access for every Frameleaf icon chooser.
 *
 * What is valid, and which icons are suggested first, comes from the server
 * (`GET /albums/icons`) so no client bundles the catalogue to know it. The SVG
 * geometry for rendering is a display asset like a font: it is fetched as a
 * static JSON asset (generated at build time by vite.config.ts's
 * frameleaf-mdi-icon-paths plugin, from the same `@mdi/js` package) the first
 * time an icon outside the 31 legacy keys has to be drawn, never in the main
 * bundle. FL-139: this used to be `import('@mdi/js')`, a dynamic import of the
 * whole npm module - since the app also statically imports named icons from
 * that same module everywhere, Rollup kept all 7,448 exports in one shared
 * chunk that loaded eagerly on every route. A static asset isn't part of any
 * JS module graph, so it can't be pulled into that chunk.
 */

export type IconPaths = Record<string, string>;

let cataloguePromise: Promise<AlbumIconCatalogueResponseDto> | undefined;
let pathsPromise: Promise<IconPaths> | undefined;

export const loadIconCatalogue = (): Promise<AlbumIconCatalogueResponseDto> => {
  cataloguePromise ??= getAlbumIconCatalogue().catch((error: unknown) => {
    cataloguePromise = undefined;
    throw error;
  });
  return cataloguePromise;
};

export const loadIconPaths = (): Promise<IconPaths> => {
  pathsPromise ??= fetch('/mdi-icon-paths.json')
    .then((response) => {
      if (!response.ok) {
        throw new Error(`Failed to load icon paths (HTTP ${response.status})`);
      }
      return response.json() as Promise<IconPaths>;
    })
    .catch((error: unknown) => {
      pathsPromise = undefined;
      throw error;
    });
  return pathsPromise;
};

/** Test seam: forget cached results so the next call fetches again. */
export const resetIconCatalogueCache = () => {
  cataloguePromise = undefined;
  pathsPromise = undefined;
};

const MDI_NAME = /^mdi[A-Z][A-Za-z0-9]{1,79}$/;

/**
 * Resolve a stored icon (a Material Design Icons name or a legacy kebab key) to
 * an SVG path. Legacy keys resolve without the catalogue chunk; a name that is
 * not drawable yet (chunk still loading, or unknown) falls back to the default.
 */
export const iconPathFor = (name: string | null | undefined, paths?: IconPaths): string => {
  if (!name) {
    return DEFAULT_ALBUM_ICON_PATH;
  }
  if (Object.hasOwn(ALBUM_ICONS, name)) {
    return ALBUM_ICONS[name as keyof typeof ALBUM_ICONS];
  }
  if (!MDI_NAME.test(name) || !paths) {
    return DEFAULT_ALBUM_ICON_PATH;
  }
  const path = paths[name];
  return typeof path === 'string' ? path : DEFAULT_ALBUM_ICON_PATH;
};

export const needsIconPaths = (name: string | null | undefined): boolean =>
  !!name && !Object.hasOwn(ALBUM_ICONS, name) && MDI_NAME.test(name);

/** "mdiCameraBurst" -> "camera burst"; the curated label wins when the catalogue has one. */
export const derivedIconLabel = (name: string): string =>
  name
    .replace(/^mdi/, '')
    .replaceAll(/([A-Z])/g, ' $1')
    .replaceAll(/(\d+)/g, ' $1')
    .trim()
    .toLowerCase();

/**
 * Search keywords for icons whose names miss common words people type ("lake" finds no water
 * icon by name, only "snowflake"). `@mdi/js` ships names and paths only, no tags.
 * ponytail: hand-picked for outdoor/travel albums; load MDI's meta.json tags if this list keeps growing.
 */
const ICON_KEYWORDS: Record<string, string> = {
  mdiWaves: 'water lake sea ocean',
  mdiWater: 'lake river drop',
  mdiSailBoat: 'lake sea sailing',
  mdiKayaking: 'lake river canoe',
  mdiRowing: 'lake river canoe',
  mdiFish: 'lake fishing',
  mdiBeach: 'sea ocean coast',
  mdiImageFilterHdr: 'mountain hiking',
};

export interface CatalogueEntry {
  name: string;
  label: string;
  /** Lower-cased search text: curated label plus the derived words. */
  text: string;
}

/** Every catalogue icon with its search text, curated labels first. */
export const buildCatalogueEntries = (catalogue: AlbumIconCatalogueResponseDto): CatalogueEntry[] => {
  const curated = new Map(catalogue.suggested.flatMap(({ icons }) => icons.map(({ name, label }) => [name, label])));
  return catalogue.names.map((name) => {
    const derived = derivedIconLabel(name);
    const label = curated.get(name);
    const text = [label?.toLowerCase(), derived, ICON_KEYWORDS[name]].filter(Boolean).join(' ');
    return { name, label: label ?? derived, text };
  });
};

export const searchCatalogue = (entries: CatalogueEntry[], query: string): CatalogueEntry[] => {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) {
    return entries;
  }
  // Each term scores 0 for a whole word, 1 for a word prefix, 2 inside a word; lowest total first.
  const scoreOf = (entry: CatalogueEntry) => {
    const words = entry.text.split(' ');
    let total = 0;
    for (const term of terms) {
      if (words.includes(term)) {
        continue;
      }
      if (words.some((word) => word.startsWith(term))) {
        total += 1;
      } else if (entry.text.includes(term)) {
        total += 2;
      } else {
        return -1;
      }
    }
    return total;
  };
  return entries
    .map((entry) => ({ entry, score: scoreOf(entry) }))
    .filter(({ score }) => score >= 0)
    .sort((a, b) => a.score - b.score)
    .map(({ entry }) => entry);
};
