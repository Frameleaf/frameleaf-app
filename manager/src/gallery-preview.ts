import {
  GALLERY_ONLY,
  GALLERY_TABLES,
  OTHERS_FAVOURITES,
  OTHERS_FAVOURITES_NAME,
  galleryReads,
  type GalleryRead,
} from './gallery-reads.js';

/** Rows each Gallery read yields; null where this release's tables cannot be read. */
export type GalleryCounts = {
  spaces: number | null;
  /** People who are in at least one Space. */
  members: number | null;
  /** Memberships: one for each person in each Space. */
  memberships: number | null;
  spacePhotos: number | null;
  people: number | null;
  favourites: number | null;
  pets: number | null;
};
export type GalleryPreview = {
  /** False when the importer refuses this release (it dropped asset."isFavorite"); the import cannot start. */
  readable: boolean;
  counts: GalleryCounts;
  /** The first Spaces by name, each with its members and photos. */
  spaces: { name: string; members: number; photos: number }[];
  /** Gallery data holding rows that stays in the source, in the importer's own names. */
  notImported: string[];
};

/** How many Spaces the review lists by name. */
export const SPACE_LIST_LIMIT = 50;

const COUNTS: Record<Exclude<keyof GalleryCounts, 'members'>, GalleryRead> = {
  spaces: 'gallery_space',
  memberships: 'gallery_space_member',
  spacePhotos: 'gallery_space_asset',
  people: 'gallery_space_person',
  favourites: 'gallery_favorite',
  pets: 'gallery_pet',
};

/** The public tables the reads look at, with their columns. */
export const GALLERY_STRUCTURE_SQL = `SELECT coalesce(json_object_agg(t.relname, t.columns), '{}') FROM (
  SELECT c.relname, json_agg(a.attname) AS columns FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
  WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND c.relname IN (${GALLERY_TABLES.map((table) => `'${table}'`).join(',')})
  GROUP BY c.relname) t;`;

/** One read-only statement: a count over each read the source can answer, the first Spaces, and which Gallery-only tables hold rows. */
export const galleryCountSql = (structure: Record<string, string[]>): string => {
  const views = galleryReads((table, ...columns) => columns.every((column) => structure[table]?.includes(column)));
  const rows = (read: GalleryRead, what = '*') =>
    views[read] ? `(SELECT count(${what}) FROM (${views[read]}) r)` : 'NULL';
  const held = Object.keys(GALLERY_ONLY).filter((table) => structure[table]).map(
    (table) => `'${table}', EXISTS (SELECT 1 FROM public."${table}")`,
  );
  if (structure.asset_favorite && structure.asset) held.push(`'asset_favorite', (${OTHERS_FAVOURITES})`);
  const spaceList = views.gallery_space
    ? `(SELECT coalesce(json_agg(json_build_object('name', s.name,
        'members', (SELECT count(*) FROM (${views.gallery_space_member}) m WHERE m."spaceId" = s.id),
        'photos', (SELECT count(*) FROM (${views.gallery_space_asset}) a WHERE a."spaceId" = s.id)) ORDER BY s.name, s.id), '[]')
      FROM (SELECT v.id, v.name FROM (${views.gallery_space}) v ORDER BY v.name, v.id LIMIT ${SPACE_LIST_LIMIT}) s)`
    : `'[]'::json`;
  // The session refuses every write, whatever the source's own database user may do.
  return `SET default_transaction_read_only = on;
SELECT json_build_object(
  ${Object.entries(COUNTS)
    .map(([name, read]) => `'${name}', ${rows(read)}`)
    .join(',\n  ')},
  'members', ${rows('gallery_space_member', 'DISTINCT r."userId"')},
  'spaceList', ${spaceList},
  'held', json_build_object(${held.join(', ')}));`;
};

/** psql prints the SET before the answer: the answer is the last line. */
const lastLine = (output: string) => output.trim().split('\n').at(-1) ?? '';

/** Two read-only statements against the running source. Nothing is written, stopped or copied. */
export async function readGalleryPreview(sql: (statement: string) => Promise<string>): Promise<GalleryPreview> {
  const structure = JSON.parse(lastLine(await sql(GALLERY_STRUCTURE_SQL))) as Record<string, string[]>;
  const views = galleryReads((table, ...columns) => columns.every((column) => structure[table]?.includes(column)));
  const answer = JSON.parse(lastLine(await sql(galleryCountSql(structure)))) as Record<string, any>;
  const number = (value: unknown) => (value === null || value === undefined ? null : Number(value));
  const notImported = Object.entries(GALLERY_ONLY)
    .filter(([table, { carriedBy }]) => answer.held?.[table] && !(carriedBy && views[carriedBy]))
    .map(([, { name }]) => name);
  if (answer.held?.asset_favorite && !views.gallery_favorite) notImported.push(OTHERS_FAVOURITES_NAME);
  return {
    readable: !!structure.asset?.includes('isFavorite'),
    counts: {
      spaces: number(answer.spaces),
      members: number(answer.members),
      memberships: number(answer.memberships),
      spacePhotos: number(answer.spacePhotos),
      people: number(answer.people),
      favourites: number(answer.favourites),
      pets: number(answer.pets),
    },
    spaces: ((answer.spaceList ?? []) as { name: string; members: number; photos: number }[]).map((space) => ({
      name: String(space.name),
      members: Number(space.members),
      photos: Number(space.photos),
    })),
    notImported,
  };
}

const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
/**
 * What the importer reported when it verified the import: the rows each read carried and what stayed behind.
 * Absent for an Immich source, and for a Frameleaf release from before the importer reported it.
 */
export function importedGallery(report: Record<string, any> | undefined): Pick<GalleryPreview, 'counts' | 'notImported'> | null {
  const counts = report?.gallery;
  if (report?.sourceKind !== 'gallery' || !counts || typeof counts !== 'object') return null;
  return {
    counts: {
      spaces: count(counts.spaces),
      members: count(counts.members),
      memberships: count(counts.memberships),
      spacePhotos: count(counts.spacePhotos),
      people: count(counts.people),
      favourites: count(counts.favourites),
      pets: count(counts.pets),
    },
    notImported: Array.isArray(report.notImported)
      ? report.notImported.filter((name: unknown): name is string => typeof name === 'string').slice(0, 50)
      : [],
  };
}
