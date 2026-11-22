// FL-1742: what a Noodle Gallery import reads, for Manager's review before anything is stopped or copied.
//
// These are the importer's own read-only SELECTs (server/src/immich-import/gallery.ts) and its list of
// Gallery-only tables (server/src/immich-import/source.ts). Manager is a separate package and reviews the
// source before the Frameleaf server image is on the host, so it holds a copy; the server's
// gallery.spec.ts fails when the two differ. This file imports nothing, so that spec can load it.

export const GALLERY_READS = [
  'gallery_space',
  'gallery_space_member',
  'gallery_space_asset',
  'gallery_favorite',
  'gallery_pet',
  'gallery_space_person',
] as const;
export type GalleryRead = (typeof GALLERY_READS)[number];

/** Gallery-only data by source table: the importer's name for it, and the read that carries it when offered. */
export const GALLERY_ONLY: Record<string, { name: string; carriedBy?: GalleryRead }> = {
  shared_space: { name: 'Spaces', carriedBy: 'gallery_space' },
  shared_space_person: { name: 'people named in Spaces', carriedBy: 'gallery_space_person' },
  shared_space_library: { name: 'libraries linked to Spaces' },
  shared_space_album: { name: 'albums linked to Spaces' },
  person_user: { name: 'people shared between accounts' },
  person_pet: { name: 'pets', carriedBy: 'gallery_pet' },
  user_group: { name: 'user groups' },
  asset_image_adjust: { name: 'exposure, contrast, saturation and invert adjustments' },
  asset_video_trim: { name: 'video trims' },
  cleanup_decision: { name: 'clean-up review decisions' },
};
/** The importer's name for hearts on other people's photos when their read is not offered. */
export const OTHERS_FAVOURITES_NAME = 'favourites set by other people';
/** Each owner's favourite is asset."isFavorite"; asset_favorite also holds favourites other people set. */
export const OTHERS_FAVOURITES = `SELECT EXISTS (SELECT 1 FROM public.asset_favorite f JOIN public.asset a ON a.id = f."assetId"
  WHERE f."userId" <> a."ownerId") AS rows`;

/** Every table a read or the stays-behind list looks at. */
export const GALLERY_TABLES = [
  ...Object.keys(GALLERY_ONLY),
  'shared_space_member',
  'shared_space_asset',
  'shared_space_person_face',
  'asset_favorite',
  'asset',
  'asset_face',
  'person',
];

/** The SELECT of each read this source can answer: `has` says whether a table has every named column. */
export const galleryReads = (
  has: (table: string, ...columns: string[]) => boolean,
): Partial<Record<GalleryRead, string>> => {
  const views: Partial<Record<GalleryRead, string>> = {};
  // Immich 3.2 names people by person group; before it a face points at its person.
  const grouped = has('person', 'personGroupId') && has('asset_face', 'personGroupId');
  const group = grouped ? 'n."personGroupId"' : 'n.id';

  const spaces =
    has('shared_space', 'id', 'name', 'description', 'createdById', 'createdAt', 'updatedAt') &&
    has('shared_space_member', 'spaceId', 'userId', 'role', 'joinedAt') &&
    has('shared_space_asset', 'spaceId', 'assetId', 'addedAt');
  if (spaces) {
    views.gallery_space = `SELECT s.id, s.name, s.description, s."createdAt", s."updatedAt" FROM public.shared_space s`;
    views.gallery_space_member = `WITH owner AS (SELECT s.id AS "spaceId", coalesce((SELECT m."userId" FROM public.shared_space_member m
          WHERE m."spaceId" = s.id AND m.role = 'owner'
          ORDER BY (m."userId" = s."createdById") DESC, m."joinedAt", m."userId" LIMIT 1), s."createdById") AS "userId"
        FROM public.shared_space s)
      SELECT o."spaceId", o."userId", 'owner' AS role FROM owner o
      UNION ALL SELECT m."spaceId", m."userId", CASE WHEN m.role IN ('owner','editor') THEN 'editor' ELSE 'viewer' END
        FROM public.shared_space_member m JOIN owner o ON o."spaceId" = m."spaceId" AND o."userId" <> m."userId"`;
    views.gallery_space_asset = `SELECT t."spaceId", t."assetId", t."addedAt" FROM public.shared_space_asset t`;
    if (
      has('shared_space_person', 'id', 'spaceId', 'name', 'isHidden') &&
      has('shared_space_person_face', 'personId', 'assetFaceId')
    ) {
      views.gallery_space_person = `SELECT p.id, p."spaceId", p.name, best."ownerId" AS "personOwnerId", best."personGroupId"
        FROM public.shared_space_person p JOIN LATERAL (
          SELECT n."ownerId", ${group} AS "personGroupId" FROM public.shared_space_person_face pf
          JOIN public.asset_face f ON f.id = pf."assetFaceId"
          JOIN public.person n ON ${grouped ? 'n."personGroupId" = f."personGroupId"' : 'n.id = f."personId"'}
          JOIN public.shared_space_member m ON m."spaceId" = p."spaceId" AND m."userId" = n."ownerId"
          WHERE pf."personId" = p.id GROUP BY n."ownerId", ${group}, n.name
          ORDER BY count(*) DESC, (n.name = p.name) DESC, n."ownerId" LIMIT 1) best ON true
        WHERE btrim(p.name) <> '' AND NOT p."isHidden"${has('shared_space_person', 'type') ? ` AND p.type = 'person'` : ''}`;
    }
  }

  if (has('asset_favorite', 'userId', 'assetId', 'createdAt')) {
    views.gallery_favorite = `SELECT f."userId", f."assetId", f."createdAt" FROM public.asset_favorite f
      JOIN public.asset a ON a.id = f."assetId" WHERE f."userId" <> a."ownerId"`;
  }

  if (has('person', 'ownerId', 'name', 'birthDate', 'isHidden', 'isFavorite')) {
    const sidecar = grouped && has('person_pet', 'personGroupId', 'species');
    const from = sidecar
      ? `public.person n JOIN public.person_pet k ON k."personGroupId" = n."personGroupId" WHERE`
      : has('person', 'type', 'species')
        ? `public.person n WHERE n.type = 'pet' AND`
        : null;
    if (from) {
      views.gallery_pet = `SELECT n."ownerId", ${group} AS "personGroupId", n.name, ${sidecar ? 'k' : 'n'}.species, n."birthDate",
          n."isHidden", n."isFavorite" FROM ${from} btrim(n.name) <> ''`;
    }
  }
  return views;
};
