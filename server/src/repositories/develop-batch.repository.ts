import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { randomUUID } from 'node:crypto';
import type { DevelopBatchResponseDto } from 'src/dtos/develop-batch.dto.js';
import type { DB } from 'src/schema/index.js';
import { publicationDatabase } from 'src/queue/transaction.js';

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
  async expiredPendingMasters() {
    const { rows } = await sql<{
      path: string;
    }>`WITH expired AS (SELECT id,"pendingMasterPath" FROM develop_batch_return WHERE "revisionId" IS NULL AND "pendingMasterPath" IS NOT NULL AND "stagedAt"<now()-interval '24 hours' FOR UPDATE SKIP LOCKED) UPDATE develop_batch_return r SET "pendingMasterPath"=NULL,"stagedAt"=NULL FROM expired WHERE r.id=expired.id RETURNING expired."pendingMasterPath" AS path`.execute(
      this.db,
    );
    return rows.map((row) => row.path);
  }
  async listOwners() {
    return this.db.selectFrom('user').select('id').execute();
  }
  async list(ownerId: string) {
    return this.db
      .selectFrom('develop_batch')
      .select('id')
      .where('ownerId', '=', ownerId)
      .orderBy('createdAt', 'desc')
      .execute();
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
      items: items.map((item) => ({
        ...item,
        sourceChecksum: item.sourceChecksum?.toString('hex') ?? null,
        preparationStatus: item.status as BatchItem['preparationStatus'],
        available: true,
        returns: (returnsByItem.get(item.id) ?? []).map(({ itemId: _, ...r }) => r),
      })),
    };
  }
  async confirm(ownerId: string, id: string, sessionId: string | null, files: { itemId: string; checksum: string }[]) {
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
      for (const file of files) {
        const item = await tx
          .selectFrom('develop_batch_item as item')
          .innerJoin('asset', 'asset.id', 'item.assetId')
          .select(['item.id', 'item.assetId'])
          .where('item.id', '=', file.itemId)
          .where('item.batchId', '=', id)
          .where('asset.ownerId', '=', ownerId)
          .where('asset.deletedAt', 'is', null)
          .executeTakeFirst();
        if (!item) throw new NotFoundException('Editing batch item not found');
        const existing = await tx
          .selectFrom('develop_batch_return')
          .selectAll()
          .where('itemId', '=', item.id)
          .where('checksum', '=', file.checksum)
          .executeTakeFirst();
        if (existing) continue;
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`asset_develop_revision:${item.assetId}`},0))`.execute(
          tx,
        );
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
          })
          .execute();
      }
    });
    return this.get(ownerId, id);
  }
  async fail(ownerId: string, batchId: string, itemId: string, confirmationId: string, errorCode: string) {
    await sql`UPDATE develop_batch_return r SET status='failed',error='Import failed',"errorCode"=${errorCode} FROM develop_batch_item item,develop_batch batch WHERE r."itemId"=item.id AND item."batchId"=batch.id AND batch.id=${batchId}::uuid AND batch."ownerId"=${ownerId}::uuid AND item.id=${itemId}::uuid AND r."confirmationId"=${confirmationId}::uuid AND r."revisionId" IS NULL AND batch.status<>'cancelled'`.execute(
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
        pendingMasterPath: string | null;
      }>`SELECT r."revisionId",r."pendingMasterPath" FROM develop_batch_return r JOIN develop_batch_item item ON item.id=r."itemId" WHERE item."batchId"=${id}::uuid AND r.status NOT IN ('completed','conflict') FOR UPDATE OF r`.execute(
        tx,
      );
      await sql`UPDATE develop_batch_return r SET status='cancelled',error='Batch cancelled',"errorCode"='batch_cancelled',"pendingMasterPath"=NULL,"stagedAt"=NULL FROM develop_batch_item item WHERE item.id=r."itemId" AND item."batchId"=${id}::uuid AND r.status NOT IN ('completed','conflict')`.execute(
        tx,
      );
      await sql`UPDATE asset_develop_revision SET "cancelRequested"=true WHERE id IN (SELECT r."revisionId" FROM develop_batch_return r JOIN develop_batch_item item ON item.id=r."itemId" WHERE item."batchId"=${id}::uuid AND r.status='cancelled') AND status<>'rendered'`.execute(
        tx,
      );
      return {
        revisionIds: rows.flatMap((r) => (r.revisionId ? [r.revisionId] : [])),
        pendingPaths: rows.flatMap((r) => (r.pendingMasterPath ? [r.pendingMasterPath] : [])),
      };
    });
  }
}
