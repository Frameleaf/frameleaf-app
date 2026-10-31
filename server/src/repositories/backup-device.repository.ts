import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type {
  BackupDevicePageDto,
  BackupDeviceWriteDto,
  ReconciliationBucketDto,
  ReconciliationStartDto,
} from 'src/dtos/backup-device.dto.js';
import type { DB } from 'src/schema/index.js';
import { IntegrityRepository } from 'src/repositories/integrity.repository.js';
import {
  assertInventoryUnchanged,
  bucketInventory,
  startProgress,
  validateBucket,
} from 'src/utils/backup-reconciliation.js';

@Injectable()
export class BackupDeviceRepository {
  constructor(
    @InjectKysely()
    private db: Kysely<DB>,
  ) {}
  register(ownerId: string, dto: BackupDeviceWriteDto) {
    return this.db.transaction().execute((tx) =>
      tx
        .insertInto('backup_device')
        .values({
          ownerId,
          ...dto,
          lastSuccessfulBackupAt: dto.lastSuccessfulBackupAt ? new Date(dto.lastSuccessfulBackupAt) : null,
          deletedAt: null,
        })
        .onConflict((oc) =>
          oc.columns(['ownerId', 'deviceKey']).doUpdateSet({
            displayName: dto.displayName,
            model: dto.model,
            platform: dto.platform,
            appVersion: dto.appVersion,
            pendingCount: dto.pendingCount,
            lastSuccessfulBackupAt: dto.lastSuccessfulBackupAt ? new Date(dto.lastSuccessfulBackupAt) : null,
            reportedAt: sql`clock_timestamp()`,
            deletedAt: null,
          }),
        )
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }
  list(ownerId: string | undefined, page: BackupDevicePageDto) {
    return this.db
      .selectFrom('backup_device')
      .selectAll()
      .where('deletedAt', 'is', null)
      .$if(ownerId !== undefined, (qb) => qb.where('ownerId', '=', ownerId!))
      .orderBy('id')
      .limit(page.limit + 1)
      .offset(page.offset)
      .execute();
  }
  async remove(ownerId: string, id: string) {
    const row = await this.db.transaction().execute((tx) =>
      tx
        .updateTable('backup_device')
        .set({ deletedAt: sql`clock_timestamp()` })
        .where('ownerId', '=', ownerId)
        .where('id', '=', id)
        .where('deletedAt', 'is', null)
        .returning('id')
        .executeTakeFirst(),
    );
    if (!row) throw new NotFoundException('Backup device not found');
  }
  private async inventory(auth: AuthDto, db: Kysely<DB>) {
    const query = new IntegrityRepository(db).getSafetyQuery(auth);
    const hashes: string[] = [];
    for await (const row of db
      .selectFrom(query.as('original'))
      .select('original.sha256')
      .distinct()
      .where('original.sha256', 'is not', null)
      .where('original.isOffline', '=', false)
      .where(sql<boolean>`original."integrityResult" IS DISTINCT FROM 'missing'`)
      .stream(1000)) {
      hashes.push(row.sha256!);
      if (hashes.length > 256 * 2000) throw new BadRequestException('Inventory exceeds reconciliation ceiling');
    }
    return { hashes, buckets: bucketInventory(hashes) };
  }
  private async ownedDevice(db: Kysely<DB>, ownerId: string, deviceId: string) {
    const device = await db
      .selectFrom('backup_device')
      .select('id')
      .where('id', '=', deviceId)
      .where('ownerId', '=', ownerId)
      .where('deletedAt', 'is', null)
      .forUpdate()
      .executeTakeFirst();
    if (!device) throw new NotFoundException('Backup device not found');
  }
  async start(auth: AuthDto, deviceId: string, dto: ReconciliationStartDto) {
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .execute(async (tx) => {
        await this.ownedDevice(tx, auth.user.id, deviceId);
        const {
          rows: [time],
        } = await sql<{
          at: Date;
        }>`SELECT transaction_timestamp() as at`.execute(tx);
        const server = await this.inventory(auth, tx);
        const progress = startProgress(dto, server.buckets);
        const itemsChecked = server.buckets.reduce(
          (sum, bucket, i) => sum + (progress.differing.includes(i) ? 0 : bucket.count),
          0,
        );
        return tx
          .insertInto('backup_reconciliation')
          .values({
            deviceId,
            ownerId: auth.user.id,
            checkedAt: time.at,
            completedAt: progress.differing.length > 0 ? null : sql`clock_timestamp()`,
            itemsChecked,
            itemsMissing: 0,
            progress,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      })
      .catch((error: unknown) => {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === '40001')
          throw new ConflictException('Concurrent reconciliation changed; retry the request');
        throw error;
      });
  }
  async submit(auth: AuthDto, deviceId: string, runId: string, dto: ReconciliationBucketDto) {
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .execute(async (tx) => {
        await this.ownedDevice(tx, auth.user.id, deviceId);
        const run = await tx
          .selectFrom('backup_reconciliation')
          .selectAll()
          .where('id', '=', runId)
          .where('deviceId', '=', deviceId)
          .where('ownerId', '=', auth.user.id)
          .forUpdate()
          .executeTakeFirst();
        if (!run) throw new NotFoundException('Reconciliation not found');
        const {
          rows: [time],
        } = await sql<{
          at: Date;
        }>`SELECT transaction_timestamp() as at`.execute(tx);
        const current = await this.inventory(auth, tx);
        assertInventoryUnchanged(run.progress, current.buckets);
        const { bucket, hashes } = validateBucket(dto, run.progress);
        const present = new Set(current.hashes);
        const missingHashes = hashes.filter((hash) => !present.has(hash));
        if (run.progress.completed.includes(bucket)) return { run, missingHashes };
        const progress = { ...run.progress, completed: [...run.progress.completed, bucket].sort((a, b) => a - b) };
        const completed = progress.differing.every((i) => progress.completed.includes(i));
        const updated = await tx
          .updateTable('backup_reconciliation')
          .set({
            progress,
            checkedAt: time.at,
            itemsChecked: run.itemsChecked + hashes.length,
            itemsMissing: run.itemsMissing + missingHashes.length,
            completedAt: completed ? sql`clock_timestamp()` : null,
          })
          .where('id', '=', run.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        return { run: updated, missingHashes };
      })
      .catch((error: unknown) => {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === '40001')
          throw new ConflictException('Concurrent reconciliation changed; retry the request');
        throw error;
      });
  }
  history(ownerId: string, deviceId: string, page: BackupDevicePageDto) {
    return this.db
      .selectFrom('backup_reconciliation')
      .selectAll()
      .where('ownerId', '=', ownerId)
      .where('deviceId', '=', deviceId)
      .orderBy('startedAt', 'desc')
      .orderBy('id')
      .limit(page.limit + 1)
      .offset(page.offset)
      .execute();
  }
}
