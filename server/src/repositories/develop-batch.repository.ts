import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { randomUUID } from 'node:crypto';
import type { DevelopBatchResponseDto } from 'src/dtos/develop-batch.dto.js';
import type { DB } from 'src/schema/index.js';
import { Permission } from 'src/enum.js';
import { publicationDatabase } from 'src/queue/transaction.js';
import { countPathReferences, lockFilePath } from 'src/repositories/physical-file.repository.js';
import { anyUuid } from 'src/utils/database.js';
import { liveBatchGrant } from 'src/utils/develop-batch-grant.js';

export type BatchReturnAdmission = {
  batchId: string;
  itemId: string;
  confirmationId: string;
  checksum: string;
  bytes: number;
  sourceIdentity?: Buffer;
};
export type BatchItem = DevelopBatchResponseDto['items'][number];
@Injectable()
export class DevelopBatchRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {
    this.db = publicationDatabase(db);
  }
  async liveGrant(ownerId: string, sessionId: string | null, apiKeyId: string | null, permission: Permission) {
    return liveBatchGrant(this.db, ownerId, sessionId, apiKeyId, permission);
  }
  async create(
    ownerId: string,
    includeSidecars: boolean,
    items: { assetId: string; id: string; exportName: string; fileName: string }[],
  ) {
    return this.db.transaction().execute(async (tx) => {
      const batch = await tx
        .insertInto('develop_batch')
        .values({ ownerId, includeSidecars })
        .returningAll()
        .executeTakeFirstOrThrow();
      for (let offset = 0; offset < items.length; offset += 5000) {
        await tx
          .insertInto('develop_batch_item')
          .values(items.slice(offset, offset + 5000).map((item) => ({ ...item, batchId: batch.id })))
          .execute();
      }
      return batch.id;
    });
  }
  async requireOpen(ownerId: string, id: string) {
    const batch = await this.db
      .selectFrom('develop_batch')
      .selectAll()
      .where('id', '=', id)
      .where('ownerId', '=', ownerId)
      .executeTakeFirst();
    if (!batch) throw new NotFoundException('Editing batch not found');
    if (batch.status === 'cancelled') throw new ConflictException('This batch was cancelled');
    return batch;
  }
  async prepared(
    ownerId: string,
    batchId: string,
    itemId: string,
    exported: { id: string; fileName: string; sourceChecksum: string },
    hasSidecar: boolean,
  ) {
    await this.db.transaction().execute(async (tx) => {
      const batch = await tx
        .selectFrom('develop_batch')
        .selectAll()
        .where('id', '=', batchId)
        .where('ownerId', '=', ownerId)
        .forUpdate()
        .executeTakeFirst();
      if (!batch || batch.status === 'cancelled') throw new ConflictException('This batch was cancelled');
      await tx
        .updateTable('develop_batch_item')
        .set({ exportId: exported.id, status: 'prepared', hasSidecar, error: null, errorCode: null })
        .where('batchId', '=', batchId)
        .where('id', '=', itemId)
        .execute();
    });
  }
  async preparationFailed(batchId: string, itemId: string, error: string) {
    await this.db
      .updateTable('develop_batch_item')
      .set({ status: 'failed', error: 'Export preparation failed', errorCode: error })
      .where('batchId', '=', batchId)
      .where('id', '=', itemId)
      .execute();
  }
  async cleanupPendingMasters(remove: (path: string) => Promise<void>, batchId?: string) {
    const { rows } = await sql<{ id: string; batchId: string }>`SELECT r.id,item."batchId" FROM develop_batch_return r
      JOIN develop_batch_item item ON item.id=r."itemId" JOIN develop_batch batch ON batch.id=item."batchId"
      WHERE r."revisionId" IS NULL AND r."pendingMasterPath" IS NOT NULL
      AND (batch.status='cancelled' OR r.status='failed' OR r."stagedAt"<clock_timestamp()-interval '24 hours')
      ${batchId ? sql`AND batch.id=${batchId}::uuid` : sql``}`.execute(this.db);
    for (const row of rows)
      await this.db.transaction().execute(async (tx) => {
        const batch = await tx
          .selectFrom('develop_batch')
          .select('status')
          .where('id', '=', row.batchId)
          .forUpdate()
          .executeTakeFirst();
        if (!batch) return;
        const pending = await tx
          .selectFrom('develop_batch_return')
          .select(['id', 'pendingMasterPath', 'status'])
          .where('id', '=', row.id)
          .where('revisionId', 'is', null)
          .where('pendingMasterPath', 'is not', null)
          .$if(batch.status !== 'cancelled', (query) =>
            query.where((eb) =>
              eb.or([
                eb('status', '=', 'failed'),
                eb('stagedAt', '<', sql<Date>`clock_timestamp()-interval '24 hours'`),
              ]),
            ),
          )
          .forUpdate()
          .executeTakeFirst();
        if (!pending?.pendingMasterPath) return;
        const target = pending.pendingMasterPath;
        await lockFilePath(tx, target);
        await tx
          .updateTable('develop_batch_return')
          .set({ pendingMasterPath: null, stagedAt: null })
          .where('id', '=', row.id)
          .execute();
        if ((await countPathReferences(tx, target)) === 0) await remove(target);
      });
  }
  async listOwners() {
    return this.db.selectFrom('user').select('id').execute();
  }
  async list(ownerId: string, cursor?: string) {
    const anchor = cursor
      ? await this.db
          .selectFrom('develop_batch')
          .select(['id', 'createdAt'])
          .where('ownerId', '=', ownerId)
          .where('id', '=', cursor)
          .executeTakeFirst()
      : undefined;
    if (cursor && !anchor) throw new NotFoundException('Editing batch cursor not found');
    const { rows } = await sql<{
      id: string;
      createdAt: Date;
      includeSidecars: boolean;
      status: 'open' | 'completed' | 'cancelled';
      itemCount: number;
    }>`
      SELECT b.id,b."createdAt",b."includeSidecars",count(item.id)::int AS "itemCount",
        CASE WHEN b.status='cancelled' THEN 'cancelled' WHEN count(item.id)>0 AND bool_and(EXISTS (SELECT 1 FROM develop_batch_return r WHERE r."itemId"=item.id AND r.status IN ('completed','conflict'))) THEN 'completed' ELSE 'open' END AS status
      FROM (SELECT * FROM develop_batch WHERE "ownerId"=${ownerId}::uuid
        ${anchor ? sql`AND ("createdAt",id)<(SELECT "createdAt",id FROM develop_batch WHERE id=${anchor.id}::uuid AND "ownerId"=${ownerId}::uuid)` : sql``}
        ORDER BY "createdAt" DESC,id DESC LIMIT 51) b
      LEFT JOIN develop_batch_item item ON item."batchId"=b.id GROUP BY b.id,b."createdAt",b."includeSidecars",b.status
      ORDER BY b."createdAt" DESC,b.id DESC`.execute(this.db);
    const hasMore = rows.length > 50;
    const page = rows.slice(0, 50).map((row) => ({ ...row, createdAt: new Date(row.createdAt).toISOString() }));
    return { items: page, nextCursor: hasMore ? page.at(-1)!.id : null };
  }
  async get(ownerId: string, id: string, itemId?: string): Promise<DevelopBatchResponseDto> {
    const batch = await this.db
      .selectFrom('develop_batch')
      .selectAll()
      .where('ownerId', '=', ownerId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!batch) throw new NotFoundException('Editing batch not found');
    const items = await this.db
      .selectFrom('develop_batch_item as item')
      .leftJoin('develop_export as exported', 'exported.id', 'item.exportId')
      .select([
        'item.id',
        'item.assetId',
        'item.exportId',
        'item.exportName',
        'item.fileName',
        'item.status',
        'item.error',
        'item.errorCode',
        'item.hasSidecar',
        'exported.sourceChecksum',
      ])
      .where('item.batchId', '=', id)
      .$if(!!itemId, (query) => query.where('item.id', '=', itemId!))
      .orderBy('item.createdAt')
      .orderBy('item.id')
      .execute();
    const { rows } = await sql<{
      id: string;
      itemId: string;
      checksum: string;
      confirmationId: string;
      expectedCurrentRevisionId: string | null;
      revisionId: string | null;
      status: BatchItem['returns'][number]['status'];
      error: string | null;
      errorCode: string | null;
      progress: number;
    }>`
      SELECT r.id,r."itemId",r.checksum,r."confirmationId",r."expectedCurrentRevisionId",r."revisionId",
        CASE WHEN r.status IN ('completed','conflict','cancelled') THEN r.status WHEN revision.status IN ('failed','cancelled') THEN revision.status ELSE r.status END AS status,
        CASE WHEN r.error IS NOT NULL THEN r.error WHEN revision.status='failed' THEN 'Preview rendering failed' ELSE NULL END AS error,
        CASE WHEN r."errorCode" IS NOT NULL THEN r."errorCode" WHEN revision.status='failed' THEN 'render_failed' WHEN revision.status='cancelled' THEN 'batch_cancelled' ELSE NULL END AS "errorCode",COALESCE(revision.progress,0) AS progress
      FROM develop_batch_return r JOIN develop_batch_item item ON item.id=r."itemId" LEFT JOIN asset_develop_revision revision ON revision.id=r."revisionId"
      WHERE item."batchId"=${id}::uuid AND (${itemId ?? null}::uuid IS NULL OR item.id=${itemId ?? null}::uuid) ORDER BY r."createdAt",r.id
    `.execute(this.db);
    const returnsByItem = new Map<string, typeof rows>();
    for (const row of rows) {
      const group = returnsByItem.get(row.itemId) ?? [];
      group.push(row);
      returnsByItem.set(row.itemId, group);
    }
    return {
      id: batch.id,
      status:
        batch.status === 'cancelled'
          ? 'cancelled'
          : items.length > 0 &&
              items.every((item) =>
                returnsByItem.get(item.id)?.some((r) => ['completed', 'conflict'].includes(r.status)),
              )
            ? 'completed'
            : 'open',
      createdAt: new Date(batch.createdAt).toISOString(),
      includeSidecars: batch.includeSidecars,
      items: items.map(({ status, ...item }) => ({
        ...item,
        sourceChecksum: item.sourceChecksum?.toString('hex') ?? null,
        preparationStatus: status as BatchItem['preparationStatus'],
        available: true,
        returns: (returnsByItem.get(item.id) ?? []).map(({ itemId: _, ...r }) => r),
      })),
    };
  }
  async confirm(
    ownerId: string,
    id: string,
    sessionId: string | null,
    apiKeyId: string | null,
    files: { itemId: string; checksum: string }[],
  ) {
    await this.db.transaction().execute(async (tx) => {
      const batch = await tx
        .selectFrom('develop_batch')
        .selectAll()
        .where('id', '=', id)
        .where('ownerId', '=', ownerId)
        .forUpdate()
        .executeTakeFirst();
      if (!batch) throw new NotFoundException('Editing batch not found');
      if (batch.status === 'cancelled') throw new ConflictException('This batch was cancelled');
      const items = await tx
        .selectFrom('develop_batch_item as item')
        .innerJoin('asset', 'asset.id', 'item.assetId')
        .select(['item.id', 'item.assetId'])
        .where('item.id', '=', anyUuid(files.map((file) => file.itemId)))
        .where('item.batchId', '=', id)
        .where('asset.ownerId', '=', ownerId)
        .where('asset.deletedAt', 'is', null)
        .execute();
      const byId = new Map(items.map((item) => [item.id, item]));
      if (files.some((file) => !byId.has(file.itemId))) throw new NotFoundException('Editing batch item not found');
      for (const assetId of [...new Set(items.map((item) => item.assetId))].sort()) {
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`asset_develop_revision:${assetId}`},0))`.execute(tx);
      }
      for (const file of files) {
        const item = byId.get(file.itemId)!;
        const existing = await tx
          .selectFrom('develop_batch_return')
          .selectAll()
          .where('itemId', '=', item.id)
          .where('checksum', '=', file.checksum)
          .executeTakeFirst();
        if (existing) continue;
        const { rows } = await sql<{
          id: string;
        }>`SELECT id FROM asset_develop_revision WHERE "assetId"=${item.assetId}::uuid AND "isCurrent"`.execute(tx);
        const locked = await tx
          .selectFrom('asset_lock')
          .select('assetId')
          .where('assetId', '=', item.assetId)
          .executeTakeFirst();
        await tx
          .insertInto('develop_batch_return')
          .values({
            itemId: item.id,
            checksum: file.checksum,
            confirmationId: randomUUID(),
            expectedCurrentRevisionId: rows[0]?.id ?? null,
            locked: !!locked,
            sessionId,
            apiKeyId,
          })
          .execute();
      }
    });
    return this.get(ownerId, id);
  }
  async fail(ownerId: string, batchId: string, itemId: string, confirmationId: string, errorCode: string) {
    await sql`UPDATE develop_batch_return r SET status='failed',error='Import failed',"errorCode"=${errorCode} FROM develop_batch_item item,develop_batch batch WHERE r."itemId"=item.id AND item."batchId"=batch.id AND batch.id=${batchId}::uuid AND batch."ownerId"=${ownerId}::uuid AND item.id=${itemId}::uuid AND r."confirmationId"=${confirmationId}::uuid AND r."revisionId" IS NULL AND r."pendingMasterPath" IS NULL AND batch.status<>'cancelled'`.execute(
      this.db,
    );
  }
  async cancel(ownerId: string, id: string) {
    return this.db.transaction().execute(async (tx) => {
      const batch = await tx
        .updateTable('develop_batch')
        .set({ status: 'cancelled' })
        .where('ownerId', '=', ownerId)
        .where('id', '=', id)
        .returning('id')
        .executeTakeFirst();
      if (!batch) throw new NotFoundException('Editing batch not found');
      const { rows } = await sql<{
        revisionId: string | null;
      }>`SELECT r."revisionId" FROM develop_batch_return r JOIN develop_batch_item item ON item.id=r."itemId" WHERE item."batchId"=${id}::uuid AND r.status NOT IN ('completed','conflict') FOR UPDATE OF r`.execute(
        tx,
      );
      await sql`UPDATE develop_batch_return r SET status='cancelled',error='Batch cancelled',"errorCode"='batch_cancelled' FROM develop_batch_item item WHERE item.id=r."itemId" AND item."batchId"=${id}::uuid AND r.status NOT IN ('completed','conflict')`.execute(
        tx,
      );
      await sql`UPDATE asset_develop_revision SET "cancelRequested"=true WHERE id IN (SELECT r."revisionId" FROM develop_batch_return r JOIN develop_batch_item item ON item.id=r."itemId" WHERE item."batchId"=${id}::uuid AND r.status='cancelled') AND status<>'rendered'`.execute(
        tx,
      );
      return {
        revisionIds: rows.flatMap((r) => (r.revisionId ? [r.revisionId] : [])),
      };
    });
  }
}
