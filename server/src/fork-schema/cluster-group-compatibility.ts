import { Kysely, RawBuilder, sql } from 'kysely';
import {
  down as revertClusterGroups,
  up as applyClusterGroups,
} from 'src/schema/migrations/1787148183729-ClusterGroups.js';

const snapshotName = 'cluster-groups-official-handoff';

// The released down migration assumes one person per group. Split shared
// groups by asset owner first, retaining the original grouping in the audit
// sidecar. Both callers run inside the migration/cutover transaction.
export async function revertClusterGroupsForOfficial(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TEMP TABLE fork_person_handoff ON COMMIT DROP AS
    SELECT owners.*, uuid_generate_v4() AS "officialId"
    FROM (
      SELECT "ownerId", "personGroupId" FROM public.person
      UNION
      SELECT asset."ownerId", face."personGroupId"
      FROM public.asset_face face JOIN public.asset asset ON asset.id = face."assetId"
      WHERE face."personGroupId" IS NOT NULL
    ) owners
  `.execute(db);
  await sql`
    INSERT INTO immich_fork.migration_audit (name, phase, status, details, "completedAt")
    SELECT ${snapshotName}, 'official-cutover', 'applied', jsonb_build_object(
      'mapping', (SELECT coalesce(jsonb_agg(to_jsonb(m)), '[]'::jsonb) FROM fork_person_handoff m),
      'users', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'clusterGroupId', "clusterGroupId")), '[]'::jsonb) FROM public."user"),
      'clusters', (SELECT coalesce(jsonb_agg(to_jsonb(c)), '[]'::jsonb) FROM public.cluster_group c),
      'groups', (SELECT coalesce(jsonb_agg(to_jsonb(g)), '[]'::jsonb) FROM public.person_group g),
      'requests', (SELECT coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) FROM public.cluster_group_request r),
      'audit', (SELECT coalesce(jsonb_agg(to_jsonb(a)), '[]'::jsonb) FROM public.person_group_audit a)
    ), now()
  `.execute(db);
  // A face group may not yet have a materialized person for every asset owner.
  await sql`
    INSERT INTO public.person ("ownerId", "personGroupId")
    SELECT "ownerId", "personGroupId" FROM fork_person_handoff
    ON CONFLICT DO NOTHING
  `.execute(db);
  await sql`
    INSERT INTO public.person_group (id, "clusterGroupId", "createdAt")
    SELECT mapping."officialId", groups."clusterGroupId", groups."createdAt"
    FROM fork_person_handoff mapping JOIN public.person_group groups ON groups.id = mapping."personGroupId"
  `.execute(db);
  await sql`
    UPDATE public.asset_face face SET "personGroupId" = mapping."officialId"
    FROM fork_person_handoff mapping, public.asset asset
    WHERE asset.id = face."assetId" AND asset."ownerId" = mapping."ownerId"
      AND face."personGroupId" = mapping."personGroupId"
  `.execute(db);
  await sql`
    UPDATE public.person person SET "personGroupId" = mapping."officialId"
    FROM fork_person_handoff mapping
    WHERE person."ownerId" = mapping."ownerId" AND person."personGroupId" = mapping."personGroupId"
  `.execute(db);
  await sql`
    UPDATE public.person_audit audit SET "personGroupId" = mapping."officialId"
    FROM fork_person_handoff mapping
    WHERE audit."ownerId" = mapping."ownerId" AND audit."personGroupId" = mapping."personGroupId"
  `.execute(db);
  await detachSharedSpacePeopleForOfficial(db);
  await revertClusterGroups(db);
  // Sync sends deletions before upserts. Retire the previous IDs as well as
  // bumping the live rows, so clients do not keep ghost people after remapping.
  await sql`
    INSERT INTO public.person_audit ("personId", "ownerId")
    SELECT "personGroupId", "ownerId" FROM fork_person_handoff
  `.execute(db);
}

export async function applyClusterGroupsAfterOfficial(db: Kysely<any>): Promise<void> {
  const present = await sql<{ present: boolean }>`
    SELECT to_regclass('public.cluster_group') IS NOT NULL AS present
  `.execute(db);
  if (present.rows[0]?.present) {
    return;
  }
  await applyClusterGroups(db);
  const auditExists = await sql<{ present: boolean }>`
    SELECT to_regclass('immich_fork.migration_audit') IS NOT NULL AS present
  `.execute(db);
  if (!auditExists.rows[0]?.present) {
    await reattachSharedSpacePeopleAfterOfficial(db, null);
    return;
  }
  const snapshot = await sql<{ id: string; details: Record<string, unknown> }>`
    SELECT id::text, details FROM immich_fork.migration_audit
    WHERE name = ${snapshotName} AND status = 'applied' ORDER BY id DESC LIMIT 1
  `.execute(db);
  const saved = snapshot.rows[0];
  if (!saved) {
    await reattachSharedSpacePeopleAfterOfficial(db, null);
    return;
  }
  const { mapping, users, clusters, groups, requests, audit } = saved.details;
  const mappings = sql`jsonb_to_recordset(${mapping}::jsonb)
    AS mapping("ownerId" uuid, "personGroupId" uuid, "officialId" uuid)`;
  const owners = sql`jsonb_to_recordset(${users}::jsonb)
    AS saved_user(id uuid, "clusterGroupId" uuid)`;

  // Restore grouping only for surviving users. Person names, face assignments,
  // deletions, and people added in official Immich remain authoritative.
  await sql`
    INSERT INTO public.cluster_group
    SELECT cluster.* FROM jsonb_populate_recordset(NULL::public.cluster_group, ${clusters}::jsonb) cluster
    WHERE EXISTS (SELECT 1 FROM ${owners} JOIN public."user" u ON u.id = saved_user.id
      WHERE saved_user."clusterGroupId" = cluster.id)
    ON CONFLICT (id) DO NOTHING
  `.execute(db);
  await sql`
    UPDATE public."user" u SET "clusterGroupId" = saved_user."clusterGroupId"
    FROM ${owners} WHERE u.id = saved_user.id
  `.execute(db);
  await sql`
    INSERT INTO public.person_group
    SELECT groups.* FROM jsonb_populate_recordset(NULL::public.person_group, ${groups}::jsonb) groups
    JOIN public.cluster_group cluster ON cluster.id = groups."clusterGroupId"
    ON CONFLICT (id) DO NOTHING
  `.execute(db);
  await sql`
    UPDATE public.asset_face face SET "personGroupId" = mapping."personGroupId"
    FROM ${mappings}, public.asset asset, public.person person
    WHERE asset.id = face."assetId" AND asset."ownerId" = mapping."ownerId"
      AND face."personGroupId" = mapping."officialId"
      AND person."ownerId" = mapping."ownerId" AND person."personGroupId" = mapping."officialId"
  `.execute(db);
  await sql`
    UPDATE public.person person SET "personGroupId" = mapping."personGroupId"
    FROM ${mappings}
    WHERE person."ownerId" = mapping."ownerId" AND person."personGroupId" = mapping."officialId"
  `.execute(db);
  await sql`
    UPDATE public.person_audit audit SET "personGroupId" = mapping."personGroupId"
    FROM ${mappings}
    WHERE audit."ownerId" = mapping."ownerId" AND audit."personGroupId" = mapping."officialId"
  `.execute(db);
  await sql`
    INSERT INTO public.person_audit ("personGroupId", "ownerId")
    SELECT mapping."officialId", mapping."ownerId" FROM ${mappings}
    JOIN public."user" u ON u.id = mapping."ownerId"
  `.execute(db);
  // Official-created people also join their owner's restored cluster.
  await sql`
    UPDATE public.person_group groups SET "clusterGroupId" = u."clusterGroupId"
    FROM public.person person JOIN public."user" u ON u.id = person."ownerId"
    WHERE groups.id = person."personGroupId" AND groups."clusterGroupId" <> u."clusterGroupId"
  `.execute(db);
  await sql`
    INSERT INTO public.cluster_group_request
    SELECT request.* FROM jsonb_populate_recordset(NULL::public.cluster_group_request, ${requests}::jsonb) request
    JOIN public."user" u ON u.id = request."userId"
    JOIN public.cluster_group cluster ON cluster.id = request."clusterGroupId"
    ON CONFLICT DO NOTHING
  `.execute(db);
  await sql`
    INSERT INTO public.person_group_audit
    SELECT * FROM jsonb_populate_recordset(NULL::public.person_group_audit, ${audit}::jsonb)
    ON CONFLICT DO NOTHING
  `.execute(db);
  await reattachSharedSpacePeopleAfterOfficial(db, mappings);
  await sql`
    UPDATE immich_fork.migration_audit SET status = 'reconciled', "completedAt" = now()
    WHERE id = ${saved.id}::bigint
  `.execute(db);
}

const sharedSpacePersonFk = 'shared_space_person_personGroupId_fkey';

const hasSharedSpacePersonFk = async (db: Kysely<any>) => {
  const result = await sql<{ present: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = ${sharedSpacePersonFk} AND conrelid = to_regclass('public.shared_space_person')
    ) AS present
  `.execute(db);
  return !!result.rows[0]?.present;
};

// A shared space's linked people (fork table `shared_space_person`, migration 2100000000200) point at a
// person group, which the certified tag does not have. Before the groups are dropped, move each link onto
// its owner's official person (the id the down migration gives that person) and release the foreign key;
// the table itself is fork data the certified container never reads. Runs after `fork_person_handoff`
// exists and before `revertClusterGroups`.
async function detachSharedSpacePeopleForOfficial(db: Kysely<any>): Promise<void> {
  if (!(await hasSharedSpacePersonFk(db))) {
    return;
  }
  await sql.raw(`ALTER TABLE public.shared_space_person DROP CONSTRAINT "${sharedSpacePersonFk}"`).execute(db);
  await sql`
    UPDATE public.shared_space_person link SET "personGroupId" = mapping."officialId"
    FROM fork_person_handoff mapping
    WHERE link."personOwnerId" = mapping."ownerId" AND link."personGroupId" = mapping."personGroupId"
  `.execute(db);
}

// The return: map each link back onto its restored person group, drop links whose owner's person was
// removed while the official container ran (deleting that person removed it from the space), and restore
// the key.
async function reattachSharedSpacePeopleAfterOfficial(
  db: Kysely<any>,
  mappings: RawBuilder<unknown> | null,
): Promise<void> {
  const table = await sql<{ present: boolean }>`
    SELECT to_regclass('public.shared_space_person') IS NOT NULL AS present
  `.execute(db);
  if (!table.rows[0]?.present || (await hasSharedSpacePersonFk(db))) {
    return;
  }
  if (mappings) {
    await sql`
      UPDATE public.shared_space_person link SET "personGroupId" = mapping."personGroupId"
      FROM ${mappings}
      WHERE link."personOwnerId" = mapping."ownerId" AND link."personGroupId" = mapping."officialId"
    `.execute(db);
  }
  await sql`
    DELETE FROM public.shared_space_person link
    WHERE NOT EXISTS (
      SELECT 1 FROM public.person person
      WHERE person."ownerId" = link."personOwnerId" AND person."personGroupId" = link."personGroupId"
    )
  `.execute(db);
  await sql
    .raw(
      `ALTER TABLE public.shared_space_person ADD CONSTRAINT "${sharedSpacePersonFk}" FOREIGN KEY ("personGroupId") REFERENCES "person_group" ("id") ON UPDATE CASCADE ON DELETE CASCADE`,
    )
    .execute(db);
}
