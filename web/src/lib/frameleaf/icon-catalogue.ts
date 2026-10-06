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
    .then((response) => response.json() as Promise<IconPaths>)
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
    return { name, label: label ?? derived, text: label ? `${label.toLowerCase()} ${derived}` : derived };
  });
};

export const searchCatalogue = (entries: CatalogueEntry[], query: string): CatalogueEntry[] => {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) {
    return entries;
  }
  return entries.filter((entry) => terms.every((term) => entry.text.includes(term)));
};
