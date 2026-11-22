import type { SourceStructure } from 'src/immich-import/schema.js';
import { FrozenSource, TableShape } from 'src/immich-import/types.js';

/**
 * Noodle Gallery data carried into Frameleaf (FL-995). Each read is one read-only SELECT over Gallery's own
 * tables, shaped for the Frameleaf rows it becomes, and is offered only when the source has every column it
 * names. A Gallery release whose tables differ keeps that data in the "stays behind" list rather than failing
 * the import. The importer copies them in this order, after the standard library.
 */
export const GALLERY_READS = [
  'gallery_space',
  'gallery_space_member',
  'gallery_space_asset',
  'gallery_favorite',
  'gallery_pet',
  'gallery_space_person',
] as const;

const shape = (columns: string[], key: string[]): TableShape => ({ columns, key, types: {} });

export const withGalleryContent = (source: FrozenSource, structure: SourceStructure): FrozenSource => {
  const has = (table: string, ...columns: string[]) => columns.every((column) => structure.tables[table]?.[column]);
  const tables = { ...source.tables };
  const views = { ...source.views };
  const add = (name: (typeof GALLERY_READS)[number], columns: string[], key: string[], view: string) => {
    tables[name] = shape(columns, key);
    views[name] = view;
  };
  // Immich 3.2 names people by person group; before it a face points at its person.
  const grouped = has('person', 'personGroupId') && has('asset_face', 'personGroupId');
  const group = grouped ? 'n."personGroupId"' : 'n.id';

  const spaces =
    has('shared_space', 'id', 'name', 'description', 'createdById', 'createdAt', 'updatedAt') &&
    has('shared_space_member', 'spaceId', 'userId', 'role', 'joinedAt') &&
    has('shared_space_asset', 'spaceId', 'assetId', 'addedAt');
  if (spaces) {
    add(
      'gallery_space',
      ['id', 'name', 'description', 'createdAt', 'updatedAt'],
      ['id'],
      `SELECT s.id, s.name, s.description, s."createdAt", s."updatedAt" FROM public.shared_space s`,
    );
    // A Frameleaf space has exactly one owner: Gallery's owner member (its creator first), else its creator.
    // Any other owner becomes an editor, and a role Frameleaf does not know becomes a viewer.
    add(
      'gallery_space_member',
      ['spaceId', 'userId', 'role'],
      ['spaceId', 'userId'],
      `WITH owner AS (SELECT s.id AS "spaceId", coalesce((SELECT m."userId" FROM public.shared_space_member m
          WHERE m."spaceId" = s.id AND m.role = 'owner'
          ORDER BY (m."userId" = s."createdById") DESC, m."joinedAt", m."userId" LIMIT 1), s."createdById") AS "userId"
        FROM public.shared_space s)
      SELECT o."spaceId", o."userId", 'owner' AS role FROM owner o
      UNION ALL SELECT m."spaceId", m."userId", CASE WHEN m.role IN ('owner','editor') THEN 'editor' ELSE 'viewer' END
        FROM public.shared_space_member m JOIN owner o ON o."spaceId" = m."spaceId" AND o."userId" <> m."userId"`,
    );
    add(
      'gallery_space_asset',
      ['spaceId', 'assetId', 'addedAt'],
      ['spaceId', 'assetId'],
      `SELECT t."spaceId", t."assetId", t."addedAt" FROM public.shared_space_asset t`,
    );
    // A named, visible person of a Space becomes a Frameleaf link to one member's own person: the person group
    // most of its faces belong to, as named by a member of that Space (one whose own name matches first).
    if (
      has('shared_space_person', 'id', 'spaceId', 'name', 'isHidden') &&
      has('shared_space_person_face', 'personId', 'assetFaceId')
    ) {
      add(
        'gallery_space_person',
        ['id', 'spaceId', 'name', 'personOwnerId', 'personGroupId'],
        ['id'],
        `SELECT p.id, p."spaceId", p.name, best."ownerId" AS "personOwnerId", best."personGroupId"
        FROM public.shared_space_person p JOIN LATERAL (
          SELECT n."ownerId", ${group} AS "personGroupId" FROM public.shared_space_person_face pf
          JOIN public.asset_face f ON f.id = pf."assetFaceId"
          JOIN public.person n ON ${grouped ? 'n."personGroupId" = f."personGroupId"' : 'n.id = f."personId"'}
          JOIN public.shared_space_member m ON m."spaceId" = p."spaceId" AND m."userId" = n."ownerId"
          WHERE pf."personId" = p.id GROUP BY n."ownerId", ${group}, n.name
          ORDER BY count(*) DESC, (n.name = p.name) DESC, n."ownerId" LIMIT 1) best ON true
        WHERE btrim(p.name) <> '' AND NOT p."isHidden"${has('shared_space_person', 'type') ? ` AND p.type = 'person'` : ''}`,
      );
    }
  }

  // The owner's own favourite is asset."isFavorite", copied with the photo. These are hearts on other people's photos.
  if (has('asset_favorite', 'userId', 'assetId', 'createdAt')) {
    add(
      'gallery_favorite',
      ['userId', 'assetId', 'createdAt'],
      ['userId', 'assetId'],
      `SELECT f."userId", f."assetId", f."createdAt" FROM public.asset_favorite f
      JOIN public.asset a ON a.id = f."assetId" WHERE f."userId" <> a."ownerId"`,
    );
  }

  // Gallery keeps a pet as a person: marked by a person_pet row for its group (5.11), or person.type before that.
  if (has('person', 'ownerId', 'name', 'birthDate', 'isHidden', 'isFavorite')) {
    const sidecar = grouped && has('person_pet', 'personGroupId', 'species');
    const from = sidecar
      ? `public.person n JOIN public.person_pet k ON k."personGroupId" = n."personGroupId" WHERE`
      : has('person', 'type', 'species')
        ? `public.person n WHERE n.type = 'pet' AND`
        : null;
    if (from) {
      add(
        'gallery_pet',
        ['ownerId', 'personGroupId', 'name', 'species', 'birthDate', 'isHidden', 'isFavorite'],
        ['ownerId', 'personGroupId'],
        `SELECT n."ownerId", ${group} AS "personGroupId", n.name, ${sidecar ? 'k' : 'n'}.species, n."birthDate",
          n."isHidden", n."isFavorite" FROM ${from} btrim(n.name) <> ''`,
      );
    }
  }
  return { ...source, tables, views };
};
