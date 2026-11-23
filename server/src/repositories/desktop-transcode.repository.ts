import { Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { randomUUID } from 'node:crypto';
import { MediaOperationKind, MediaOperationStatus } from 'src/enum.js';
import {
  DesktopWorkerGrant,
  lockDesktopWorker,
  readDesktopAssistancePolicy,
} from 'src/repositories/desktop-worker.repository.js';
import { DB } from 'src/schema/index.js';
import { desktopMayTranscode, desktopTranscodesEveryone } from 'src/utils/desktop-transcode.js';
import { lockedAssetIdExists } from 'src/utils/locked.js';
import { CLAIMED_MEDIA_OPERATION_STATUSES } from 'src/utils/media-operation.js';

/** Names the authorization epoch too: a claim never survives the computer's authorization changing. */
const claimant = ({ deviceId, authorizationEpoch }: DesktopWorkerGrant) => `desktop:${deviceId}:${authorizationEpoch}`;
const kind = MediaOperationKind.PlaybackTranscode;

export type DesktopTranscodeResult = { outputPath: string; checksum: string; sizeInBytes: number };
export type DesktopTranscodeUpload = { tokenHash: string; checksum: string; sizeInBytes: string };

/** Leases of `playback_transcode` operations; every read and write rechecks the desktop's live authority. */
@Injectable()
export class DesktopTranscodeRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /** The lock record, which exists before the Locked seal job has encrypted the file. */
  async isLockedAsset(assetId: string) {
    const { rows } = await sql<{
      locked: boolean;
    }>`SELECT ${lockedAssetIdExists(sql`${assetId}::uuid`)} AS locked`.execute(this.db);
    return !!rows[0]?.locked;
  }

  ownerOf(grant: DesktopWorkerGrant) {
    return this.db.transaction().execute(async (tx) => (await lockDesktopWorker(tx, grant))?.ownerId);
  }

  /** One conversion per desktop in v1: a repeated claim gets the lease it already holds. */
  claim(grant: DesktopWorkerGrant, leaseMs: number) {
    return this.db.transaction().execute(async (tx) => {
      const worker = await lockDesktopWorker(tx, grant);
      if (!worker) return;
      const claimedBy = claimant(grant);
      const held = await tx
        .selectFrom('media_operation')
        .selectAll()
        .where('kind', '=', kind)
        .where('claimedBy', '=', claimedBy)
        .where('status', 'in', [MediaOperationStatus.Preparing, MediaOperationStatus.Rendering])
        .where('claimExpiresAt', '>', sql<Date>`clock_timestamp()`)
        .where('cancelRequestedAt', 'is', null)
        .limit(1)
        .executeTakeFirst();
      if (held) return { ...held, workerOwnerId: worker.ownerId };

      const everyone = desktopTranscodesEveryone(await readDesktopAssistancePolicy(tx), grant.deviceId);
      const next = await tx
        .selectFrom('media_operation')
        .select('id')
        .where('kind', '=', kind)
        .where('status', '=', MediaOperationStatus.Queued)
        .where('claimToken', 'is', null)
        .where('cancelRequestedAt', 'is', null)
        .where('pauseRequestedAt', 'is', null)
        .$if(!everyone, (query) => query.where('ownerId', '=', worker.ownerId))
        .orderBy('createdAt', 'asc')
        .limit(1)
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (!next) return;
      const claimed = await tx
        .updateTable('media_operation')
        .set({
          status: MediaOperationStatus.Preparing,
          claimToken: randomUUID(),
          claimedBy,
          claimExpiresAt: sql<Date>`now() + ${sql.lit(leaseMs)} * interval '1 millisecond'`,
          heartbeatAt: sql<Date>`now()`,
          attemptStartedAt: sql<Date>`now()`,
          startedAt: sql<Date>`coalesce("startedAt", now())`,
          attempt: sql<number>`"attempt" + 1`,
        })
        .where('id', '=', next.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return { ...claimed, workerOwnerId: worker.ownerId };
    });
  }

  /** The operation, only while this desktop holds this exact claim and may still work on this owner's video. */
  getClaimed(grant: DesktopWorkerGrant, id: string, claimToken: string) {
    return this.db.transaction().execute(async (tx) => {
      const worker = await lockDesktopWorker(tx, grant);
      if (!worker) return;
      const operation = await tx
        .selectFrom('media_operation')
        .selectAll()
        .where('id', '=', id)
        .where('kind', '=', kind)
        .where('claimToken', '=', claimToken)
        .where('claimedBy', '=', claimant(grant))
        .where('status', 'in', [...CLAIMED_MEDIA_OPERATION_STATUSES])
        .where('claimExpiresAt', '>', sql<Date>`clock_timestamp()`)
        .where('cancelRequestedAt', 'is', null)
        .executeTakeFirst();
      if (!operation) return;
      const policy = await readDesktopAssistancePolicy(tx);
      return desktopMayTranscode(policy, { id: grant.deviceId, ownerId: worker.ownerId }, operation.ownerId)
        ? operation
        : undefined;
    });
  }

  /** Replaces any earlier upload grant: only the newest token can upload, and only while this claim holds. */
  async setUploadGrant(id: string, claimToken: string, upload: DesktopTranscodeUpload) {
    const row = await this.db
      .updateTable('media_operation')
      .set({ settings: sql`${JSON.stringify({ upload })}::jsonb` })
      .where('id', '=', id)
      .where('kind', '=', kind)
      .where('claimToken', '=', claimToken)
      .where('status', 'in', [MediaOperationStatus.Preparing, MediaOperationStatus.Rendering])
      .where('claimExpiresAt', '>', sql<Date>`clock_timestamp()`)
      .where('cancelRequestedAt', 'is', null)
      .returning('id')
      .executeTakeFirst();
    return !!row;
  }

  /** The operation an upload token opens, while its claim is live. */
  getByUploadToken(id: string, tokenHash: string) {
    return this.db
      .selectFrom('media_operation')
      .selectAll()
      .where('id', '=', id)
      .where('kind', '=', kind)
      .where(sql<boolean>`"settings"->'upload'->>'tokenHash' = ${tokenHash}`)
      .where('claimToken', 'is not', null)
      .where('status', 'in', [...CLAIMED_MEDIA_OPERATION_STATUSES])
      .where('claimExpiresAt', '>', sql<Date>`clock_timestamp()`)
      .where('cancelRequestedAt', 'is', null)
      .executeTakeFirst();
  }

  /** Records the uploaded file for validation. An identical repeat of a lost answer is `duplicate`. */
  async stageResult(
    id: string,
    claimToken: string,
    tokenHash: string,
    staged: DesktopTranscodeResult,
  ): Promise<boolean | 'duplicate'> {
    const row = await this.db
      .updateTable('media_operation')
      .set({
        status: MediaOperationStatus.Validating,
        result: sql`${JSON.stringify(staged)}::jsonb`,
        outputBytes: staged.sizeInBytes,
        heartbeatAt: sql<Date>`now()`,
      })
      .where('id', '=', id)
      .where('kind', '=', kind)
      .where('claimToken', '=', claimToken)
      .where(sql<boolean>`"settings"->'upload'->>'tokenHash' = ${tokenHash}`)
      .where('status', 'in', [MediaOperationStatus.Preparing, MediaOperationStatus.Rendering])
      .where('claimExpiresAt', '>', sql<Date>`clock_timestamp()`)
      .where('cancelRequestedAt', 'is', null)
      .returning('id')
      .executeTakeFirst();
    if (row) return true;
    const current = await this.db
      .selectFrom('media_operation')
      .select('result')
      .where('id', '=', id)
      .where('claimToken', '=', claimToken)
      .where('status', '=', MediaOperationStatus.Validating)
      .executeTakeFirst();
    return (current?.result as DesktopTranscodeResult | null)?.checksum === staged.checksum ? 'duplicate' : false;
  }
}
