import { Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { AssetType, AssetVisibility, JobName, QueueName } from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { QUEUE_TIMING } from 'src/queue/types.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { currentAuth } from 'src/repositories/icloud-audit.repository.js';
import { lockICloudItemClaims } from 'src/repositories/icloud-item-claim-lock.js';
import { IntegrityRepository } from 'src/repositories/integrity.repository.js';
import { DB } from 'src/schema/index.js';
import { linkLivePhotoAssets } from 'src/utils/asset.util.js';
import { onStacksJoined } from 'src/utils/locked-stacks.js';

export type ICloudRelationEvent =
  | {
      name: 'AssetHide';
      assetId: string;
      userId: string;
    }
  | {
      name: 'StackCreate' | 'StackUpdate';
      stackId: string;
      userId: string;
    };
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
type Origin = {
  sourceAssetId: string;
  id: string;
  assetId: string;
  signature: string;
  source: {
    _sync?: {
      relations?: RelationState;
    };
  };
};
type Resource = {
  id: string;
  sourceAssetId: string;
  libraryKey: string;
  role: string;
  assetId: string | null;
  status: string;
  sha256: Buffer | null;
  source: {
    _sync?: {
      relations?: RelationState;
    };
  };
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
  constructor(
    @InjectKysely()
    private readonly db: Kysely<DB>,
  ) {}
  /** The decision's committed marker is an outbox; queue admission and marker settlement share one transaction.
   * This producer never holds item/connection/asset locks, so queue-first completion ordering is preserved.
   */
  async enqueuePending(): Promise<number> {
    return this.db.transaction().execute(async (tx) => {
      await sql`INSERT INTO job_queue(name) VALUES(${QueueName.BackgroundTask}) ON CONFLICT DO NOTHING`.execute(tx);
      await sql`SELECT name FROM job_queue WHERE name=${QueueName.BackgroundTask} FOR NO KEY UPDATE`.execute(tx);
      const decisions = await tx
        .selectFrom('icloud_edit_decision as d')
        .selectAll()
        .where(sql<boolean>`d.events @> '[{"type":"local-relations"}]'::jsonb`)
        .where(
          sql<boolean>`EXISTS (SELECT 1 FROM public.icloud_resource r JOIN public.icloud_connection c ON c.id=r."connectionId"
          WHERE r."ownerId"=d."ownerId" AND c."ownerId"=d."ownerId" AND upper(r."sourceAssetId")=d.item AND r."auditRequestId" IS NULL AND c.state='connected')`,
        )
        .orderBy('d.id')
        .limit(25)
        .forUpdate()
        .skipLocked()
        .execute();
      for (const decision of decisions) {
        const { rows } = await sql<{
          id: string;
        }>`SELECT DISTINCT c.id FROM public.icloud_resource r JOIN public.icloud_connection c ON c.id=r."connectionId"
          WHERE r."ownerId"=${decision.ownerId}::uuid AND c."ownerId"=${decision.ownerId}::uuid AND upper(r."sourceAssetId")=${decision.item} AND r."auditRequestId" IS NULL AND c.state='connected' ORDER BY c.id LIMIT 101`.execute(
          tx,
        );
        if (rows.length > 100) throw new Error('edit_relations_connections_too_large');
        await new SqlQueueStore(this.db).enqueue(
          rows.map((row) => ({
            name: JobName.ICloudRelations,
            queue: QueueName.BackgroundTask,
            data: { id: row.id, ownerId: decision.ownerId },
            options: { deduplication: { id: `${JobName.ICloudRelations}:${row.id}`, keepLastIfActive: true } },
            safeToRetry: true,
            sensitive: true,
            deadlineMs: QUEUE_TIMING.opaqueDeadline,
          })),
          tx,
        );
        await tx.updateTable('icloud_edit_decision').set({ events: [] }).where('id', '=', decision.id).execute();
      }
      return decisions.length;
    });
  }
  /** Sensitive retry payloads are erased by the queue; the accepted dedup key retains the local target.
   * Resolve its owner from current server state, never from a replacement handler's empty/foreign payload.
   */
  async resolveLocalTarget(): Promise<{ id: string; ownerId: string }> {
    const context = queueExecution.getStore();
    if (context?.claim.name !== JobName.ICloudRelations || context.claim.queue !== QueueName.BackgroundTask)
      throw new Error('edit_relations_claim_lost');
    context.signal.throwIfAborted();
    const { rows } = await sql<{ id: string; ownerId: string }>`SELECT c.id,c."ownerId" FROM job j
      JOIN public.icloud_connection c ON j."dedupKey"=${JobName.ICloudRelations + ':'}||c.id::text
      WHERE j.id=${context.claim.id}::uuid AND j.token=${context.claim.token}::uuid AND j.name=${JobName.ICloudRelations}
        AND j.queue=${QueueName.BackgroundTask} AND j.state='active' AND j."leaseExpiresAt">clock_timestamp() AND j."cancelRequestedAt" IS NULL AND c.state='connected'`.execute(
      this.db,
    );
    if (rows.length !== 1) throw new Error('edit_relations_claim_lost');
    return rows[0];
  }
  private pending(db: Kysely<DB>, connectionId: string, ownerId: string) {
    return sql<Origin>`SELECT DISTINCT ON (o."assetId") o.id,o."assetId",o."sourceAssetId",o.source,version.signature
      FROM public.icloud_resource o JOIN asset a ON a.id=o."assetId"
      CROSS JOIN LATERAL (SELECT md5(coalesce(string_agg(r.id::text || ':' || r.fingerprint || ':' || coalesce(r."assetId"::text,'') || ':' || r.status || ':' || coalesce(authority.generation::text,'') || ':' || coalesce(authority."currentVersionId"::text,''),',' ORDER BY r.id),'empty')) AS signature
        FROM public.icloud_resource r LEFT JOIN public.icloud_edit_authority authority ON authority."ownerId"=r."ownerId" AND authority.item=upper(r."sourceAssetId") WHERE r."auditRequestId" IS NULL AND r."connectionId"=o."connectionId" AND r."ownerId"=${ownerId}::uuid
          AND coalesce((r.source->>'current')::boolean,true) AND r.role IN ('original','motion','edited-image','edited-video')
          AND EXISTS(SELECT 1 FROM public.icloud_resource family WHERE family."connectionId"=o."connectionId"
            AND family."auditRequestId" IS NULL AND family."ownerId"=${ownerId}::uuid AND family."assetId"=o."assetId" AND family.role='original'
            AND coalesce((family.source->>'current')::boolean,true) AND family."libraryKey"=r."libraryKey" AND family."sourceAssetId"=r."sourceAssetId")) version
      WHERE o."auditRequestId" IS NULL AND o."connectionId"=${connectionId}::uuid AND o."ownerId"=${ownerId}::uuid AND o.role='original'
        AND coalesce((o.source->>'current')::boolean,true) AND o.status IN ('committed','finalized','reused')
        AND a."ownerId"=${ownerId}::uuid AND a."deletedAt" IS NULL
        AND o.source#>>'{_sync,relations,signature}' IS DISTINCT FROM version.signature
      ORDER BY o."assetId",o.id LIMIT 1`
      .execute(db)
      .then(({ rows }) => rows[0]);
  }
  private async nextEvent(connectionId: string, ownerId: string, db: Kysely<DB>) {
    return sql<{
      id: string;
      event: ICloudRelationEvent;
    }>`SELECT r.id,r.source#>'{_sync,relations,events,0}' AS event
      FROM public.icloud_resource r JOIN public.icloud_connection c ON c.id=r."connectionId"
      WHERE r."auditRequestId" IS NULL AND r."connectionId"=${connectionId}::uuid AND r."ownerId"=${ownerId}::uuid AND c."ownerId"=${ownerId}::uuid
        AND c.state='connected' AND jsonb_array_length(coalesce(r.source#>'{_sync,relations,events}','[]'))>0 ORDER BY r.id LIMIT 1`
      .execute(db)
      .then(({ rows }) => rows[0]);
  }
  private async acknowledgeEvent(id: string, ownerId: string, event: ICloudRelationEvent, db: Kysely<DB>) {
    await sql`UPDATE public.icloud_resource SET source=jsonb_set(source,'{_sync,relations,events}',(source#>'{_sync,relations,events}') - 0)
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
      const connection =
        await sql`SELECT id FROM public.icloud_connection WHERE id=${connectionId}::uuid AND "ownerId"=${ownerId}::uuid AND state='connected' FOR UPDATE`.execute(
          db,
        );
      if (connection.rows.length === 0) {
        throw new Error('icloud_connection_not_found');
      }
      const pending = await this.nextEvent(connectionId, ownerId, db);
      if (!pending) {
        return false;
      }
      await this.fenceDrain(db);
      await send(pending.event);
      await this.fenceDrain(db);
      await this.acknowledgeEvent(pending.id, ownerId, pending.event, db);
      return true;
    });
  }
  /** A local drain's domain write may not outlive its actual accepted queue claim. */
  private async fenceDrain(db: Kysely<DB>) {
    const context = queueExecution.getStore();
    if (context?.claim.name !== JobName.ICloudRelations) return;
    context.signal.throwIfAborted();
    const claim = context.claim;
    const result =
      await sql`SELECT id FROM job WHERE id=${claim.id}::uuid AND token=${claim.token}::uuid AND state='active' AND "leaseExpiresAt">clock_timestamp() AND "cancelRequestedAt" IS NULL FOR SHARE`.execute(
        db,
      );
    if (result.rows.length !== 1) throw new Error('edit_relations_claim_lost');
  }
  /** Membership must be prefetched, fenced by every sorted item prefix, then reread under the connection lock. */
  private async family(db: Kysely<DB>, connectionId: string, ownerId: string, originalId: string) {
    const { rows } =
      await sql<Resource>`SELECT r.id,r."sourceAssetId",r."libraryKey",r.role,r."assetId",r.status,r.sha256,r.source
        FROM public.icloud_resource r WHERE r."auditRequestId" IS NULL AND r."connectionId"=${connectionId}::uuid AND r."ownerId"=${ownerId}::uuid
          AND coalesce((r.source->>'current')::boolean,true) AND r.role IN ('original','motion','edited-image','edited-video')
          AND EXISTS(SELECT 1 FROM public.icloud_resource family WHERE family."connectionId"=r."connectionId" AND family."ownerId"=${ownerId}::uuid
            AND family."auditRequestId" IS NULL AND family.role='original' AND family."assetId"=${originalId}::uuid AND coalesce((family.source->>'current')::boolean,true)
            AND family."libraryKey"=r."libraryKey" AND family."sourceAssetId"=r."sourceAssetId")
        ORDER BY r.id LIMIT 101`.execute(db);
    return rows;
  }

  private async familyItems(db: Kysely<DB>, connectionId: string, ownerId: string, originalId: string) {
    const { rows } = await sql<{
      item: string;
    }>`SELECT DISTINCT upper("sourceAssetId") AS item FROM public.icloud_resource
      WHERE "connectionId"=${connectionId}::uuid AND "ownerId"=${ownerId}::uuid AND "auditRequestId" IS NULL AND role='original'
        AND "assetId"=${originalId}::uuid AND coalesce((source->>'current')::boolean,true) ORDER BY item LIMIT 101`.execute(
      db,
    );
    if (rows.length > 100) throw new Error('resource_shared_family_too_large');
    return rows.map((r) => r.item);
  }
  async reconcile(connectionId: string, ownerId: string): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const hint = await this.pending(this.db, connectionId, ownerId);
      if (!hint) {
        const connection =
          await sql`SELECT id FROM public.icloud_connection WHERE id=${connectionId}::uuid AND "ownerId"=${ownerId}::uuid AND state='connected'`.execute(
            this.db,
          );
        if (connection.rows.length === 0) throw new Error('icloud_connection_not_found');
        return true;
      }
      const prefetched = await this.family(this.db, connectionId, ownerId, hint.assetId);
      const prefix = await this.familyItems(this.db, connectionId, ownerId, hint.assetId);
      const result = await this.db.transaction().execute(async (db) => {
        await lockICloudItemClaims(db, ownerId, prefix);
        const connection =
          await sql`SELECT id FROM public.icloud_connection WHERE id=${connectionId}::uuid AND "ownerId"=${ownerId}::uuid AND state='connected' FOR UPDATE`.execute(
            db,
          );
        if (connection.rows.length === 0) throw new Error('icloud_connection_not_found');
        const origin = await this.pending(db, connectionId, ownerId);
        if (!origin) return true;
        if (origin.id !== hint.id || origin.assetId !== hint.assetId) return;
        const currentItems = await this.familyItems(db, connectionId, ownerId, origin.assetId);
        if (JSON.stringify(currentItems) !== JSON.stringify(prefix)) return;
        const resources = await this.family(db, connectionId, ownerId, origin.assetId);
        if (
          resources.some((r) => !prefix.includes(r.sourceAssetId.toUpperCase())) ||
          JSON.stringify(resources.map((r) => [r.id, r.sourceAssetId, r.libraryKey, r.assetId])) !==
            JSON.stringify(prefetched.map((r) => [r.id, r.sourceAssetId, r.libraryKey, r.assetId]))
        )
          return;
        // Applied provenance must agree across every original back-reference; never borrow an arbitrary row.
        const applied = resources
          .filter((r) => r.role === 'original')
          .map((r) => r.source._sync?.relations)
          .filter((state): state is RelationState => !!state?.stackId);
        const snapshots = [
          ...new Set(
            applied.map((state) =>
              JSON.stringify([
                state.stackId,
                state.appliedPrimaryAssetId,
                [...(state.memberAssetIds ?? [])].sort(),
                state.motionAssetId,
              ]),
            ),
          ),
        ];
        const previous: RelationState = snapshots.length === 1 ? applied[0] : {};
        const state: RelationState = {
          ...previous,
          signature: origin.signature,
          status: 'applied',
          reason: undefined,
          events: [],
        };
        if (snapshots.length > 1) {
          state.status = 'needs-review';
          state.reason = 'source_stack_provenance_conflict';
        } else if (resources.length > 100) {
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
          const ledger = await db
            .selectFrom('icloud_edit_version')
            .select('assetId')
            .where('ownerId', '=', ownerId)
            .where('item', 'in', prefix)
            .limit(101)
            .execute();
          const ids = [
            ...new Set([
              ...resources.map((r) => r.assetId!),
              ...(state.memberAssetIds ?? []),
              ...ledger.map((v) => v.assetId),
            ]),
          ].sort();
          if (ledger.length > 100) {
            state.status = 'needs-review';
            state.reason = 'resource_family_too_large';
          }

          const { rows: targets } =
            await sql<Target>`SELECT id,"ownerId",type,"stackId","livePhotoVideoId",visibility FROM asset
          WHERE id=ANY(${ids}::uuid[]) AND "ownerId"=${ownerId}::uuid AND "deletedAt" IS NULL AND status='active' ORDER BY id FOR UPDATE`.execute(
              db,
            );
          if (ledger.length <= 100 && targets.length === ids.length) {
            const still = targets.find((a) => a.id === origin.assetId)!;
            await this.fenceDrain(db);
            await this.linkMotion(db, ownerId, still, resources, targets, state);
            await this.stack(db, ownerId, still, resources, targets, state);
          } else {
            state.status = 'needs-review';
            state.reason = 'resource_owner_or_trash_changed';
          }
        }
        await this.fenceDrain(db);
        for (const row of resources) {
          if (row.role !== 'original' || row.assetId !== origin.assetId) continue;
          const ownState =
            snapshots.length > 1
              ? {
                  ...row.source._sync?.relations,
                  signature: origin.signature,
                  status: 'needs-review',
                  reason: 'source_stack_provenance_conflict',
                  events: [],
                }
              : { ...state, events: row.id === origin.id ? state.events : [] };
          await sql`UPDATE public.icloud_resource SET source=jsonb_set(source,'{_sync}',coalesce(source->'_sync','{}')||jsonb_build_object('relations',${ownState}::jsonb),true)
          WHERE id=${row.id}::uuid AND "connectionId"=${connectionId}::uuid AND "ownerId"=${ownerId}::uuid AND role='original' AND "assetId"=${origin.assetId}::uuid AND coalesce((source->>'current')::boolean,true)`.execute(
            db,
          );
        }
        return !(await this.pending(db, connectionId, ownerId));
      });
      if (result !== undefined) return result;
    }
    return false;
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
    const items = [
      ...new Set(resources.filter((r) => r.role === 'original').map((r) => r.sourceAssetId.toUpperCase())),
    ].sort();
    const canonicalIds: string[] = [];
    const acceptedIds = new Set<string>([original.id]);
    for (const item of items) {
      const authority = await db
        .selectFrom('icloud_edit_authority as a')
        .innerJoin('icloud_edit_decision as d', 'd.id', 'a.baselineDecisionId')
        .innerJoin('icloud_edit_version as v', 'v.id', 'a.currentVersionId')
        .select(['a.currentVersionId', 'v.assetId', 'd.evidence'])
        .where('a.ownerId', '=', ownerId)
        .where('a.item', '=', item)
        .where('v.ownerId', '=', ownerId)
        .where('v.item', '=', item)
        .executeTakeFirst();
      if (!authority || typeof authority.evidence.sessionId !== 'string') {
        state.status = 'needs-review';
        state.reason = 'legacy_edit_order_unproven';
        return;
      }
      const versions = await db
        .selectFrom('icloud_edit_version')
        .selectAll()
        .where('ownerId', '=', ownerId)
        .where('item', '=', item)
        .orderBy('assetId')
        .limit(101)
        .execute();
      if (versions.length > 100) {
        state.status = 'needs-review';
        state.reason = 'resource_family_too_large';
        return;
      }
      // Every current edit and canonical target requires its own item ledger AND actual receipt.
      const required = [
        ...new Set([
          authority.assetId,
          ...resources
            .filter((r) => r.sourceAssetId.toUpperCase() === item && ['edited-image', 'edited-video'].includes(r.role))
            .map((r) => r.assetId!),
        ]),
      ].sort();
      for (const id of required) {
        const version = versions.find((v) => v.assetId === id);
        const receipt =
          version &&
          (await sql`SELECT id FROM public.icloud_source_identity WHERE "ownerId"=${ownerId}::uuid AND upper("cplAssetRecordName")=${item} AND "assetId"=${id}::uuid AND sha256=${version.sha256} AND role=${version.isOriginal ? 'original' : 'edit-render'} LIMIT 1`.execute(
            db,
          ));
        if (!version || !receipt?.rows.length) {
          state.status = 'needs-review';
          state.reason = 'edit_member_evidence_unproven';
          return;
        }
        const sourceRows = resources.filter(
          (r) =>
            r.assetId === id &&
            r.sourceAssetId.toUpperCase() === item &&
            ['edited-image', 'edited-video'].includes(r.role),
        );
        if (sourceRows.some((r) => !r.sha256?.equals(version.sha256))) {
          state.status = 'needs-review';
          state.reason = 'edit_member_evidence_changed';
          return;
        }
        await db
          .selectFrom('asset')
          .select('id')
          .where('id', '=', id)
          .where('ownerId', '=', ownerId)
          .forUpdate()
          .execute();
        const auth = await currentAuth(db, ownerId, authority.evidence.sessionId, true);
        const safe =
          auth &&
          (await new IntegrityRepository(db)
            .getSafetyQuery(auth, [version.sha256.toString('hex')])
            .where('asset.id', '=', id)
            .executeTakeFirst());
        if (!safe) {
          state.status = 'needs-review';
          state.reason = 'edit_member_unavailable';
          return;
        }
        if (targets.every((target) => target.id !== id)) {
          const target = await db
            .selectFrom('asset')
            .select(['id', 'ownerId', 'type', 'stackId', 'livePhotoVideoId', 'visibility'])
            .where('id', '=', id)
            .executeTakeFirstOrThrow();
          targets.push(target);
        }
        acceptedIds.add(id);
      }
      canonicalIds.push(authority.assetId);
    }
    // Existing source-owned membership is provenance too: every retained edit must still have
    // an accepted item ledger, an actual same-byte receipt and live access, never a stack-wide blessing.
    for (const id of state.memberAssetIds ?? []) {
      if (id === original.id || acceptedIds.has(id)) continue;
      let proven = false;
      for (const item of items) {
        const version = await db
          .selectFrom('icloud_edit_version')
          .selectAll()
          .where('ownerId', '=', ownerId)
          .where('item', '=', item)
          .where('assetId', '=', id)
          .executeTakeFirst();
        if (!version) continue;
        const receipt =
          await sql`SELECT id FROM public.icloud_source_identity WHERE "ownerId"=${ownerId}::uuid AND upper("cplAssetRecordName")=${item} AND "assetId"=${id}::uuid AND sha256=${version.sha256} AND role=${version.isOriginal ? 'original' : 'edit-render'} LIMIT 1`.execute(
            db,
          );
        const authority = await db
          .selectFrom('icloud_edit_authority as a')
          .innerJoin('icloud_edit_decision as d', 'd.id', 'a.baselineDecisionId')
          .select('d.evidence')
          .where('a.ownerId', '=', ownerId)
          .where('a.item', '=', item)
          .executeTakeFirst();
        const auth =
          typeof authority?.evidence.sessionId === 'string' &&
          (await currentAuth(db, ownerId, authority.evidence.sessionId, true));
        if (
          receipt.rows.length > 0 &&
          auth &&
          (await new IntegrityRepository(db)
            .getSafetyQuery(auth, [version.sha256.toString('hex')])
            .where('asset.id', '=', id)
            .executeTakeFirst())
        ) {
          proven = true;
          break;
        }
      }
      if (!proven) {
        state.status = 'needs-review';
        state.reason = 'edit_member_evidence_unproven';
        return;
      }
      acceptedIds.add(id);
    }
    const distinct = [...new Set(canonicalIds)];
    if (distinct.length > 1 && !state.stackId) {
      state.status = 'needs-review';
      state.reason = 'shared_edit_primary_ambiguous';
      return;
    }
    const ids = [...acceptedIds];
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
    // Disagreement preserves a source-owned existing primary only under its actual membership/primary fence.
    const conflicting = distinct.length > 1;
    const primary = conflicting ? state.appliedPrimaryAssetId! : (distinct[0] ?? original.id);
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
    const membership = await db
      .selectFrom('asset')
      .select('id')
      .where('stackId', '=', state.stackId)
      .orderBy('id')
      .execute();
    if (JSON.stringify(membership.map((a) => a.id)) !== JSON.stringify([...(state.memberAssetIds ?? [])].sort())) {
      state.status = 'needs-review';
      state.reason = 'local_stack_membership_override';
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
    state.memberAssetIds = [...new Set([...(state.memberAssetIds ?? []), ...ids])];
    if (conflicting) {
      state.status = 'needs-review';
      state.reason = 'shared_edit_primary_ambiguous';
    }
    state.events!.push({ name: 'StackUpdate', stackId: state.stackId, userId: ownerId });
  }
}
