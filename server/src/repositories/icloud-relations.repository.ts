import { Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { ForkSchemaPhase } from 'src/repositories/fork-schema.repository.js';
import { AssetType, AssetVisibility } from 'src/enum.js';
import { isForkWriteEnabled } from 'src/fork-schema/authority.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { DB } from 'src/schema/index.js';
import { linkLivePhotoAssets } from 'src/utils/asset.util.js';
import { onStacksJoined } from 'src/utils/locked-stacks.js';

export type ICloudRelationEvent =
  | { name: 'AssetHide'; assetId: string; userId: string }
  | { name: 'StackCreate' | 'StackUpdate'; stackId: string; userId: string };
type RelationState = {
  signature?: string;
  status?: 'applied' | 'needs-review' | 'pending';
  reason?: string;
  stackId?: string;
  appliedPrimaryAssetId?: string;
  motionAssetId?: string;
  memberAssetIds?: string[];
  events?: ICloudRelationEvent[];
};
type Origin = { id: string; assetId: string; signature: string; source: { _sync?: { relations?: RelationState } } };
type Resource = {
  id: string;
  sourceAssetId: string;
  libraryKey: string;
  role: string;
  assetId: string | null;
  status: string;
  source: { _sync?: { relations?: RelationState } };
};
type Target = {
  id: string;
  ownerId: string;
  type: AssetType;
  stackId: string | null;
  livePhotoVideoId: string | null;
  visibility: AssetVisibility;
};

@Injectable()
export class ICloudRelationsRepository {
  constructor(@InjectKysely() private readonly db: Kysely<DB>) {}

  private pending(db: Kysely<DB>, connectionId: string, ownerId: string) {
    return sql<Origin>`SELECT DISTINCT ON (o."assetId") o.id,o."assetId",o.source,version.signature
      FROM immich_fork.icloud_resource o JOIN asset a ON a.id=o."assetId"
      CROSS JOIN LATERAL (SELECT md5(coalesce(string_agg(r.id::text || ':' || r.fingerprint || ':' || coalesce(r."assetId"::text,'') || ':' || r.status,',' ORDER BY r.id),'empty')) AS signature
        FROM immich_fork.icloud_resource r WHERE r."connectionId"=o."connectionId" AND r."ownerId"=${ownerId}::uuid
          AND coalesce((r.source->>'current')::boolean,true) AND r.role IN ('original','motion','edited-image','edited-video')
          AND EXISTS(SELECT 1 FROM immich_fork.icloud_resource family WHERE family."connectionId"=o."connectionId"
            AND family."ownerId"=${ownerId}::uuid AND family."assetId"=o."assetId" AND family.role='original'
            AND coalesce((family.source->>'current')::boolean,true) AND family."libraryKey"=r."libraryKey" AND family."sourceAssetId"=r."sourceAssetId")) version
      WHERE o."connectionId"=${connectionId}::uuid AND o."ownerId"=${ownerId}::uuid AND o.role='original'
        AND coalesce((o.source->>'current')::boolean,true) AND o.status IN ('committed','finalized','reused')
        AND a."ownerId"=${ownerId}::uuid AND a."deletedAt" IS NULL
        AND o.source#>>'{_sync,relations,signature}' IS DISTINCT FROM version.signature
      ORDER BY o."assetId",o.id LIMIT 1`
      .execute(db)
      .then(({ rows }) => rows[0]);
  }

  private async nextEvent(connectionId: string, ownerId: string, db: Kysely<DB>) {
    return sql<{ id: string; event: ICloudRelationEvent }>`SELECT r.id,r.source#>'{_sync,relations,events,0}' AS event
      FROM immich_fork.icloud_resource r JOIN immich_fork.icloud_connection c ON c.id=r."connectionId"
      WHERE r."connectionId"=${connectionId}::uuid AND r."ownerId"=${ownerId}::uuid AND c."ownerId"=${ownerId}::uuid
        AND c.state='connected' AND jsonb_array_length(coalesce(r.source#>'{_sync,relations,events}','[]'))>0 ORDER BY r.id LIMIT 1`
      .execute(db)
      .then(({ rows }) => rows[0]);
  }

  private async acknowledgeEvent(id: string, ownerId: string, event: ICloudRelationEvent, db: Kysely<DB>) {
    await sql`UPDATE immich_fork.icloud_resource SET source=jsonb_set(source,'{_sync,relations,events}',(source#>'{_sync,relations,events}') - 0)
      WHERE id=${id}::uuid AND "ownerId"=${ownerId}::uuid AND source#>'{_sync,relations,events,0}'=${event}::jsonb`.execute(
      db,
    );
  }

  async dispatchEvent(
    connectionId: string,
    ownerId: string,
    send: (event: ICloudRelationEvent) => Promise<void>,
  ): Promise<boolean> {
    return this.db.transaction().execute(async (db) => {
      const phase = await sql<{ phase: ForkSchemaPhase }>`SELECT phase FROM immich_fork.state WHERE id=1 FOR SHARE`
        .execute(db)
        .then(({ rows }) => rows[0]?.phase);
      if (!phase || !isForkWriteEnabled(phase)) {
        throw new Error('icloud_fork_inactive');
      }
      const handoff =
        await sql`SELECT 1 FROM immich_fork.migration_audit WHERE status='running' AND name IN ('official-handoff-preparation','fork-return-reconciliation') LIMIT 1`.execute(
          db,
        );
      if (handoff.rows.length > 0) {
        throw new Error('icloud_fork_handoff');
      }
      const connection =
        await sql`SELECT id FROM immich_fork.icloud_connection WHERE id=${connectionId}::uuid AND "ownerId"=${ownerId}::uuid AND state='connected' FOR UPDATE`.execute(
          db,
        );
      if (connection.rows.length === 0) {
        throw new Error('icloud_connection_not_found');
      }
      const pending = await this.nextEvent(connectionId, ownerId, db);
      if (!pending) {
        return false;
      }
      await send(pending.event);
      await this.acknowledgeEvent(pending.id, ownerId, pending.event, db);
      return true;
    });
  }

  async reconcile(connectionId: string, ownerId: string): Promise<boolean> {
    return this.db.transaction().execute(async (db) => {
      const phase = await sql<{ phase: ForkSchemaPhase }>`SELECT phase FROM immich_fork.state WHERE id=1 FOR SHARE`
        .execute(db)
        .then(({ rows }) => rows[0]?.phase);
      if (!phase || !isForkWriteEnabled(phase)) {
        throw new Error('icloud_fork_inactive');
      }
      const handoff =
        await sql`SELECT 1 FROM immich_fork.migration_audit WHERE status='running' AND name IN ('official-handoff-preparation','fork-return-reconciliation') LIMIT 1`.execute(
          db,
        );
      if (handoff.rows.length > 0) {
        throw new Error('icloud_fork_handoff');
      }
      const connection =
        await sql`SELECT id FROM immich_fork.icloud_connection WHERE id=${connectionId}::uuid AND "ownerId"=${ownerId}::uuid AND state='connected' FOR UPDATE`.execute(
          db,
        );
      if (connection.rows.length === 0) {
        throw new Error('icloud_connection_not_found');
      }
      const origin = await this.pending(db, connectionId, ownerId);
      if (!origin) {
        return true;
      }
      const { rows: resources } =
        await sql<Resource>`SELECT r.id,r."sourceAssetId",r."libraryKey",r.role,r."assetId",r.status,r.source
        FROM immich_fork.icloud_resource r WHERE r."connectionId"=${connectionId}::uuid AND r."ownerId"=${ownerId}::uuid
          AND coalesce((r.source->>'current')::boolean,true) AND r.role IN ('original','motion','edited-image','edited-video')
          AND EXISTS(SELECT 1 FROM immich_fork.icloud_resource family WHERE family."connectionId"=r."connectionId" AND family."ownerId"=${ownerId}::uuid
            AND family.role='original' AND family."assetId"=${origin.assetId}::uuid AND coalesce((family.source->>'current')::boolean,true)
            AND family."libraryKey"=r."libraryKey" AND family."sourceAssetId"=r."sourceAssetId")
        ORDER BY r."updatedAt" DESC,r.id LIMIT 101`.execute(db);
      const previous =
        origin.source._sync?.relations ??
        resources.find((r) => r.role === 'original' && r.source._sync?.relations?.stackId)?.source._sync?.relations ??
        {};
      const state: RelationState = {
        ...previous,
        signature: origin.signature,
        status: 'applied',
        reason: undefined,
        events: [],
      };
      if (resources.length > 100) {
        state.status = 'needs-review';
        state.reason = 'resource_family_too_large';
      } else if (resources.some((r) => !r.assetId || !['committed', 'finalized', 'reused'].includes(r.status))) {
        const terminal = resources.some(
          (r) =>
            !['pending', 'retry', 'staging', 'validated', 'promoted', 'committed', 'finalized', 'reused'].includes(
              r.status,
            ),
        );
        state.status = terminal ? 'needs-review' : 'pending';
        state.reason = terminal ? 'resource_family_incomplete' : 'awaiting_resources';
        // Save this signature so a waiting or failed family cannot starve other
        // families. A changed resource status/mapping makes it eligible again.
      } else {
        const ids = [...new Set(resources.map((r) => r.assetId!))];
        const { rows: targets } =
          await sql<Target>`SELECT id,"ownerId",type,"stackId","livePhotoVideoId",visibility FROM asset
          WHERE id=ANY(${ids}::uuid[]) AND "ownerId"=${ownerId}::uuid AND "deletedAt" IS NULL ORDER BY id FOR UPDATE`.execute(
            db,
          );
        if (targets.length === ids.length) {
          const still = targets.find((a) => a.id === origin.assetId)!;
          await this.linkMotion(db, ownerId, still, resources, targets, state);
          await this.stack(db, ownerId, still, resources, targets, state);
        } else {
          state.status = 'needs-review';
          state.reason = 'resource_owner_or_trash_changed';
        }
      }
      await sql`UPDATE immich_fork.icloud_resource SET source=jsonb_set(source,'{_sync}',coalesce(source->'_sync','{}') || jsonb_build_object('relations',
        CASE WHEN id=${origin.id}::uuid THEN ${state}::jsonb ELSE ${{ ...state, events: [] }}::jsonb END),true)
        WHERE "connectionId"=${connectionId}::uuid AND "ownerId"=${ownerId}::uuid AND role='original' AND "assetId"=${origin.assetId}::uuid
          AND coalesce((source->>'current')::boolean,true)`.execute(db);
      return !(await this.pending(db, connectionId, ownerId));
    });
  }

  private async linkMotion(
    db: Kysely<DB>,
    ownerId: string,
    still: Target,
    resources: Resource[],
    targets: Target[],
    state: RelationState,
  ) {
    const motions = [...new Set(resources.filter((r) => r.role === 'motion').map((r) => r.assetId!))];
    if (motions.length === 0) {
      return;
    }
    const motion = targets.find((a) => a.id === motions[0])!;
    if (
      motions.length !== 1 ||
      still.type !== AssetType.Image ||
      motion.type !== AssetType.Video ||
      still.id === motion.id
    ) {
      state.status = 'needs-review';
      state.reason = 'live_photo_identity_conflict';
      return;
    }
    if (
      still.livePhotoVideoId !== motion.id &&
      ((still.livePhotoVideoId !== null && still.livePhotoVideoId !== state.motionAssetId) ||
        (state.motionAssetId !== undefined && still.livePhotoVideoId !== state.motionAssetId))
    ) {
      state.status = 'needs-review';
      state.reason = 'local_live_photo_override';
      return;
    }
    if (
      ![AssetVisibility.Timeline, AssetVisibility.Hidden].includes(motion.visibility) ||
      (state.motionAssetId === motion.id && motion.visibility !== AssetVisibility.Hidden)
    ) {
      state.status = 'needs-review';
      state.reason = 'motion_visibility_override';
      return;
    }
    const memberships = await sql`SELECT 1 FROM album_asset WHERE "assetId"=${motion.id}::uuid LIMIT 1`.execute(db);
    if (memberships.rows.length > 0) {
      state.status = 'needs-review';
      state.reason = 'motion_has_manual_membership';
      return;
    }
    if (still.livePhotoVideoId !== motion.id || motion.visibility !== AssetVisibility.Hidden) {
      await linkLivePhotoAssets(
        {
          asset: {
            update: async (asset) => {
              await db
                .updateTable('asset')
                .set(asset)
                .where('id', '=', asset.id)
                .where('ownerId', '=', ownerId)
                .execute();
              return;
            },
          },
          album: new AlbumRepository(db),
          event: {
            emit: () => {
              state.events!.push({ name: 'AssetHide', assetId: motion.id, userId: ownerId });
              return Promise.resolve();
            },
          },
        },
        { photoAssetId: still.id, motionAssetId: motion.id, motionOwnerId: ownerId },
      );
    }
    state.motionAssetId = motion.id;
  }

  private async stack(
    db: Kysely<DB>,
    ownerId: string,
    original: Target,
    resources: Resource[],
    targets: Target[],
    state: RelationState,
  ) {
    const edits = resources.filter((r) => r.role === 'edited-image' || r.role === 'edited-video');
    if (edits.length === 0 && !state.stackId) {
      return;
    }
    const ids = [...new Set([original.id, ...edits.map((r) => r.assetId!)])];
    if (
      state.stackId &&
      targets.some(
        (target) =>
          ids.includes(target.id) && state.memberAssetIds?.includes(target.id) && target.stackId !== state.stackId,
      )
    ) {
      state.status = 'needs-review';
      state.reason = 'local_stack_membership_override';
      return;
    }
    const stackIds = [...new Set(targets.filter((a) => ids.includes(a.id) && a.stackId).map((a) => a.stackId!))];
    if (stackIds.some((id) => id !== state.stackId)) {
      state.status = 'needs-review';
      state.reason = 'manual_stack_conflict';
      return;
    }
    const primary = edits[0]?.assetId ?? original.id;
    if (!state.stackId) {
      if (ids.length < 2) {
        return;
      }
      const stackId = await sql<{
        id: string;
      }>`INSERT INTO stack("ownerId","primaryAssetId") VALUES(${ownerId}::uuid,${primary}::uuid) RETURNING id`
        .execute(db)
        .then(({ rows }) => rows[0].id);
      await db.updateTable('asset').set({ stackId }).where('id', 'in', ids).where('ownerId', '=', ownerId).execute();
      // a stack that holds a Locked photo is Locked as a whole (FL-53)
      await onStacksJoined(db, [stackId]);
      state.stackId = stackId;
      state.memberAssetIds = ids;
      state.appliedPrimaryAssetId = primary;
      state.events!.push({ name: 'StackCreate', stackId, userId: ownerId });
      return;
    }
    const stack = await sql<{
      primaryAssetId: string;
    }>`SELECT "primaryAssetId" FROM stack WHERE id=${state.stackId}::uuid AND "ownerId"=${ownerId}::uuid FOR UPDATE`
      .execute(db)
      .then(({ rows }) => rows[0]);
    if (!stack) {
      state.status = 'needs-review';
      state.reason = 'source_stack_removed';
      return;
    }
    await db
      .updateTable('asset')
      .set({ stackId: state.stackId })
      .where('id', 'in', ids)
      .where('ownerId', '=', ownerId)
      .where('stackId', 'is', null)
      .execute();
    await onStacksJoined(db, [state.stackId]);
    if (stack.primaryAssetId === state.appliedPrimaryAssetId) {
      await sql`UPDATE stack SET "primaryAssetId"=${primary}::uuid WHERE id=${state.stackId}::uuid AND "ownerId"=${ownerId}::uuid`.execute(
        db,
      );
      state.appliedPrimaryAssetId = primary;
    }
    state.memberAssetIds = ids;
    state.events!.push({ name: 'StackUpdate', stackId: state.stackId, userId: ownerId });
  }
}
