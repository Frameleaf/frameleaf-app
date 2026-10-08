import { ConflictException } from '@nestjs/common';
import { Kysely, Transaction, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { AssetStatus, JobName, QueueName } from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { QUEUE_TIMING } from 'src/queue/types.js';
import { DB } from 'src/schema/index.js';
import { canonicalJson } from 'src/utils/studio-project.js';

export type SourceEpoch = { assetId: string; ownerId: string; epoch: string };
export type LocalEffectIntent = {
  origin: { kind: 'publication' | 'trash' | 'restore' | 'stack'; decisionId?: string };
  assets: { assetId: string; status: AssetStatus.Active | AssetStatus.Trashed; revoke: boolean }[];
  stacks: { stackId: string; primaryAssetId: string; memberAssetIds: string[] }[];
};
export type AssetLocalEffectBundle = {
  formatVersion: 1;
  effectId: string;
  ownerId: string;
  streamEpoch: string;
  sequence: string;
  intentDigest: string;
  origin: LocalEffectIntent['origin'];
  assets: { assetId: string; status: AssetStatus.Active | AssetStatus.Trashed; sourceEpoch: string }[];
  stacks: LocalEffectIntent['stacks'];
  revocations: { assetId: string; priorEpoch: string; sourceEpoch: string }[];
};

const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest();
function unavailable(): never {
  throw new ConflictException('asset_local_effect_conflict');
}
const key = (ownerId: string) => `${JobName.ICloudRelations}:owner-stream:${ownerId}`;

/** Durable local order and source revocation facts. Domain callers own all publication/status locks. */
export class AssetLocalEffectRepository {
  constructor(private db: Kysely<DB>) {}

  static async sourceEpochs(db: Kysely<DB>, ids: string[]): Promise<SourceEpoch[]> {
    if (ids.length === 0) return [];
    const { rows } = await sql<SourceEpoch>`SELECT a.id AS "assetId",a."ownerId",
      coalesce(e."lastTrashSequence",0)::text AS epoch FROM asset a
      LEFT JOIN asset_source_epoch e ON e."assetId"=a.id AND e."ownerId"=a."ownerId"
      WHERE a.id=ANY(${[...new Set(ids)].sort()}::uuid[]) ORDER BY a.id`.execute(db);
    return rows;
  }

  async append(
    tx: Transaction<DB>,
    ownerId: string,
    effectId: string,
    input: LocalEffectIntent,
  ): Promise<AssetLocalEffectBundle> {
    const assets = [...input.assets].sort((a, b) => a.assetId.localeCompare(b.assetId));
    const stacks = input.stacks
      .map((stack) => ({ ...stack, memberAssetIds: [...new Set(stack.memberAssetIds)].sort() }))
      .sort((a, b) => a.stackId.localeCompare(b.stackId));
    if (
      assets.length > 100 ||
      stacks.length > 100 ||
      new Set(assets.map((a) => a.assetId)).size !== assets.length ||
      stacks.some((s) => s.memberAssetIds.length > 100)
    )
      unavailable();
    const intentDigest = hash({ ownerId, origin: input.origin, assets, stacks }).toString('hex');
    const previous = await tx
      .selectFrom('asset_local_effect')
      .selectAll()
      .where('effectId', '=', effectId)
      .executeTakeFirst();
    if (previous) {
      const bundle = previous.bundle as unknown as AssetLocalEffectBundle;
      if (
        previous.ownerId !== ownerId ||
        bundle.intentDigest !== intentDigest ||
        !previous.bundleSha256.equals(hash(bundle))
      )
        unavailable();
      return bundle;
    }
    // No config/item/asset/stack lock is acquired here: callers supply their complete locked proof set.
    const found = await tx
      .selectFrom('asset')
      .select(['id', 'ownerId', 'status', 'deletedAt'])
      .where(
        'id',
        'in',
        assets.map((a) => a.assetId),
      )
      .execute();
    if (
      assets.some(
        (a) =>
          !found.some(
            (row) =>
              row.id === a.assetId &&
              row.ownerId === ownerId &&
              row.status === a.status &&
              (a.status === AssetStatus.Trashed ? row.deletedAt !== null : row.deletedAt === null),
          ),
      ) ||
      assets.some((a) => a.revoke && a.status !== AssetStatus.Trashed)
    )
      unavailable();
    const initialized =
      await sql`INSERT INTO asset_local_effect_stream("ownerId","streamEpoch") VALUES(${ownerId}::uuid,${randomUUID()}::uuid)
      ON CONFLICT("ownerId") DO NOTHING RETURNING "ownerId"`.execute(tx);
    const {
      rows: [stream],
    } = await sql<{ streamEpoch: string; sequence: string }>`SELECT "streamEpoch","nextSequence"::text AS sequence
      FROM asset_local_effect_stream WHERE "ownerId"=${ownerId}::uuid FOR UPDATE`.execute(tx);
    if (!stream || BigInt(stream.sequence) >= 9_223_372_036_854_775_807n) unavailable();
    const epochs = await AssetLocalEffectRepository.sourceEpochs(
      tx,
      assets.map((a) => a.assetId),
    );
    const bundle: AssetLocalEffectBundle = {
      formatVersion: 1,
      effectId,
      ownerId,
      streamEpoch: stream.streamEpoch,
      sequence: stream.sequence,
      intentDigest,
      origin: input.origin,
      assets: assets.map((a) => ({
        assetId: a.assetId,
        status: a.status,
        sourceEpoch: a.revoke ? stream.sequence : epochs.find((e) => e.assetId === a.assetId)!.epoch,
      })),
      stacks,
      revocations: assets
        .filter((a) => a.revoke)
        .map((a) => ({
          assetId: a.assetId,
          priorEpoch: epochs.find((e) => e.assetId === a.assetId)!.epoch,
          sourceEpoch: stream.sequence,
        })),
    };
    await sql`INSERT INTO asset_local_effect("ownerId",sequence,"effectId",bundle,"bundleSha256")
      VALUES(${ownerId}::uuid,${stream.sequence}::bigint,${effectId}::uuid,${bundle}::jsonb,${hash(bundle)})`.execute(
      tx,
    );
    for (const asset of assets.filter((a) => a.revoke)) {
      const changed =
        await sql`INSERT INTO asset_source_epoch("assetId","ownerId","lastTrashSequence") VALUES(${asset.assetId}::uuid,${ownerId}::uuid,${stream.sequence}::bigint)
        ON CONFLICT("assetId") DO UPDATE SET "lastTrashSequence"=excluded."lastTrashSequence"
        WHERE asset_source_epoch."ownerId"=excluded."ownerId" RETURNING "assetId"`.execute(tx);
      if (changed.rows.length !== 1) unavailable();
    }
    await sql`UPDATE asset_local_effect_stream SET "nextSequence"="nextSequence"+1 WHERE "ownerId"=${ownerId}::uuid`.execute(
      tx,
    );
    // A committed stream already owns its cursor; do not touch a row a dispatcher may hold across await.
    if (initialized.rows.length === 1)
      await sql`INSERT INTO asset_local_effect_cursor("ownerId") VALUES(${ownerId}::uuid)`.execute(tx);
    return bundle;
  }

  /** Queue first, never called underneath publication locks. Cursor ACK leaves immutable effects/epochs intact. */
  async enqueuePending(): Promise<number> {
    return this.db.transaction().execute(async (tx) => {
      await sql`INSERT INTO job_queue(name) VALUES(${QueueName.BackgroundTask}) ON CONFLICT DO NOTHING`.execute(tx);
      await sql`SELECT name FROM job_queue WHERE name=${QueueName.BackgroundTask} FOR NO KEY UPDATE`.execute(tx);
      const { rows } = await sql<{ ownerId: string }>`SELECT s."ownerId" FROM asset_local_effect_stream s
        JOIN asset_local_effect_cursor c USING("ownerId") WHERE s."nextSequence">coalesce(c."acknowledgedSequence",0)+1
        AND NOT EXISTS(SELECT 1 FROM job j WHERE j.queue=${QueueName.BackgroundTask}
          AND j."dedupKey"=${JobName.ICloudRelations + ':owner-stream:'}||s."ownerId"::text AND j.state IN ('pending','waiting','active'))
        ORDER BY (SELECT max(j."createdAt") FROM job j WHERE j.queue=${QueueName.BackgroundTask}
          AND j."dedupKey"=${JobName.ICloudRelations + ':owner-stream:'}||s."ownerId"::text) ASC NULLS FIRST,s."ownerId" LIMIT 25`.execute(
        tx,
      );
      await new SqlQueueStore(this.db).enqueue(
        rows.map((row) => ({
          name: JobName.ICloudRelations,
          queue: QueueName.BackgroundTask,
          data: { kind: 'owner-stream', id: row.ownerId, ownerId: row.ownerId },
          options: { deduplication: { id: key(row.ownerId), keepLastIfActive: true } },
          sensitive: true,
          safeToRetry: true,
          deadlineMs: QUEUE_TIMING.opaqueDeadline,
        })),
        tx,
      );
      return rows.length;
    });
  }

  async resolveOwnerTarget(): Promise<string | undefined> {
    const context = queueExecution.getStore();
    if (context?.claim.name !== JobName.ICloudRelations || context.claim.queue !== QueueName.BackgroundTask)
      unavailable();
    context.signal.throwIfAborted();
    const { rows } = await sql<{ ownerId: string }>`SELECT s."ownerId" FROM job j JOIN asset_local_effect_stream s
      ON j."dedupKey"=${JobName.ICloudRelations + ':owner-stream:'}||s."ownerId"::text
      WHERE j.id=${context.claim.id}::uuid AND j.token=${context.claim.token}::uuid AND j.name=${JobName.ICloudRelations}
        AND j.queue=${QueueName.BackgroundTask} AND j.state='active' AND j."leaseExpiresAt">clock_timestamp() AND j."cancelRequestedAt" IS NULL`.execute(
      this.db,
    );
    return rows[0]?.ownerId;
  }

  private async fence(tx: Transaction<DB>, ownerId: string) {
    const context = queueExecution.getStore();
    if (context?.claim.name !== JobName.ICloudRelations || context.claim.queue !== QueueName.BackgroundTask)
      unavailable();
    context.signal.throwIfAborted();
    const { rows } =
      await sql`SELECT id FROM job WHERE id=${context.claim.id}::uuid AND token=${context.claim.token}::uuid
      AND name=${JobName.ICloudRelations} AND queue=${QueueName.BackgroundTask} AND "dedupKey"=${key(ownerId)}
      AND state='active' AND "leaseExpiresAt">clock_timestamp() AND "cancelRequestedAt" IS NULL FOR SHARE`.execute(tx);
    if (rows.length !== 1) unavailable();
  }

  async dispatch(ownerId: string, send: (bundle: AssetLocalEffectBundle) => Promise<void>): Promise<boolean> {
    return this.db.transaction().execute(async (tx) => {
      await this.fence(tx, ownerId);
      const {
        rows: [lock],
      } = await sql<{
        held: boolean;
      }>`SELECT pg_try_advisory_xact_lock(hashtextextended(${'asset-local-dispatch:v1:' + ownerId},0)) AS held`.execute(
        tx,
      );
      if (!lock?.held) return false;
      const {
        rows: [head],
      } = await sql<{ sequence: string; bundle: AssetLocalEffectBundle; bundleSha256: Buffer; streamEpoch: string }>`
        SELECT e.sequence::text,e.bundle,e."bundleSha256",s."streamEpoch" FROM asset_local_effect_cursor c
        JOIN asset_local_effect_stream s USING("ownerId") JOIN asset_local_effect e ON e."ownerId"=c."ownerId"
          AND e.sequence=coalesce(c."acknowledgedSequence",0)+1 WHERE c."ownerId"=${ownerId}::uuid FOR UPDATE OF c`.execute(
        tx,
      );
      if (!head) return false;
      if (
        head.bundle.ownerId !== ownerId ||
        head.bundle.sequence !== head.sequence ||
        head.bundle.streamEpoch !== head.streamEpoch ||
        !head.bundleSha256.equals(hash(head.bundle))
      )
        unavailable();
      await send(head.bundle);
      await this.fence(tx, ownerId);
      const { rows } = await sql`UPDATE asset_local_effect_cursor SET "acknowledgedSequence"=${head.sequence}::bigint
        WHERE "ownerId"=${ownerId}::uuid AND coalesce("acknowledgedSequence",0)=${(BigInt(head.sequence) - 1n).toString()}::bigint RETURNING "ownerId"`.execute(
        tx,
      );
      if (rows.length !== 1) unavailable();
      return true;
    });
  }
}
