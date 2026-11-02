import { ImportDatabase } from 'src/immich-import/types.js';
import { LibraryImportRefused } from 'src/library-import/state.js';
import { upsertTags } from 'src/utils/tag.js';

/** Runs inside the canonical asset journal transaction; never reparents an existing tag. */
export async function writeImportedTags(tx: ImportDatabase, ownerId: string, assetId: string, values: string[]) {
  const tags = await upsertTags(
    {
      upsertValue: async ({ userId, value, parentId }) => {
        const [tag] = await tx.query(
          `WITH inserted AS (
            INSERT INTO public.tag("userId",value,"parentId")
            SELECT $1::uuid,$2,$3::uuid WHERE $3::uuid IS NULL OR EXISTS(
              SELECT 1 FROM public.tag WHERE id=$3::uuid AND "userId"=$1::uuid)
            ON CONFLICT ("userId",value) DO NOTHING RETURNING id,value,"parentId"
          ), chosen AS (
            SELECT id,value,"parentId" FROM inserted
            UNION ALL
            SELECT id,value,"parentId" FROM public.tag WHERE "userId"=$1::uuid AND value=$2
              AND "parentId" IS NOT DISTINCT FROM $3::uuid AND NOT EXISTS(SELECT 1 FROM inserted)
          ), closures AS (
            INSERT INTO public.tag_closure(id_ancestor,id_descendant)
            SELECT id,id FROM chosen
            UNION ALL
            SELECT c.id_ancestor,t.id FROM chosen t JOIN public.tag_closure c ON c.id_descendant=t."parentId"
            ON CONFLICT DO NOTHING
          ) SELECT id::text,value FROM chosen`,
          [userId, value, parentId ?? null],
        );
        if (!tag || typeof tag.id !== 'string' || tag.value !== value)
          throw new LibraryImportRefused('ASSET_TAGS_CONFLICT');
        return { id: tag.id, value };
      },
    },
    { userId: ownerId, tags: values },
  );
  for (const tag of tags)
    await tx.query('INSERT INTO public.tag_asset("assetId","tagId") VALUES($1::uuid,$2::uuid)', [assetId, tag.id]);
}

/** Independently reconciles all tag tables; tag names remain inside the private digest calculation. */
export async function reconcileImportedTags(
  tx: ImportDatabase,
  assets: { id: string; ownerId: string; tags: string[] | undefined }[],
) {
  const nodes = new Map<string, unknown>();
  const closures = new Map<string, unknown>();
  const memberships = [];
  for (const { id, ownerId, tags } of assets)
    for (const tag of tags ?? []) {
      const parts = tag.split('/');
      for (let i = 0; i < parts.length; i++) {
        const value = parts.slice(0, i + 1).join('/');
        const parentValue = i === 0 ? null : parts.slice(0, i).join('/');
        nodes.set(JSON.stringify([ownerId, value]), {
          ownerId,
          value,
          parentOwnerId: parentValue === null ? null : ownerId,
          parentValue,
          color: null,
        });
        for (let ancestor = 0; ancestor <= i; ancestor++) {
          const ancestorValue = parts.slice(0, ancestor + 1).join('/');
          closures.set(JSON.stringify([ownerId, ancestorValue, value]), {
            ancestorOwnerId: ownerId,
            ancestorValue,
            descendantOwnerId: ownerId,
            descendantValue: value,
          });
        }
      }
      memberships.push({ assetId: id, ownerId, tagOwnerId: ownerId, value: tag });
    }
  const actualNodes = await tx.query(`SELECT t."userId"::text AS "ownerId",t.value,
    p."userId"::text AS "parentOwnerId",p.value AS "parentValue",t.color
    FROM public.tag t LEFT JOIN public.tag p ON p.id=t."parentId"`);
  const actualClosures = await tx.query(`SELECT a."userId"::text AS "ancestorOwnerId",a.value AS "ancestorValue",
    d."userId"::text AS "descendantOwnerId",d.value AS "descendantValue"
    FROM public.tag_closure c JOIN public.tag a ON a.id=c.id_ancestor JOIN public.tag d ON d.id=c.id_descendant`);
  const actualMemberships = await tx.query(`SELECT a.id::text AS "assetId",a."ownerId"::text AS "ownerId",
    t."userId"::text AS "tagOwnerId",t.value FROM public.tag_asset m
    JOIN public.asset a ON a.id=m."assetId" JOIN public.tag t ON t.id=m."tagId"`);
  const ordered = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).toSorted();
  const evidence = {
    nodes: ordered(actualNodes),
    closures: ordered(actualClosures),
    memberships: ordered(actualMemberships),
  };
  if (
    JSON.stringify(evidence) !==
    JSON.stringify({
      nodes: ordered(nodes.values().toArray()),
      closures: ordered(closures.values().toArray()),
      memberships: ordered(memberships),
    })
  )
    throw new LibraryImportRefused('ASSET_RECONCILIATION_MISMATCH');
  return evidence;
}
