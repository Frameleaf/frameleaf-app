import { Injectable } from '@nestjs/common';
import { Kysely, Transaction, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import {
  PhysicalFileTrashMove,
  countPathReferences,
  lockFilePath,
  recoverFileTrashMoves,
  trashUnreferencedOriginal,
  withFileTrashMove,
} from 'src/repositories/physical-file.repository.js';
import { DB } from 'src/schema/index.js';

export type PhysicalFileTrashEntry = {
  id: string;
  physicalFileId: string | null;
  path: string;
  checksum: Buffer;
  sizeInBytes: number;
  lastOwnerId: string | null;
  lastAssetId: string | null;
  originalFileName: string;
  trashedAt: Date;
  /** Null means the original's privacy lineage cannot be proved. */
  wasLocked: boolean | null;
};
export type PhysicalFileTrashInput = {
  /** The original's physical file row, deleted once the file is in the trash; null for an unregistered original. */
  physicalFileId: string | null;
  path: string;
  checksum: Buffer;
  sizeInBytes: number;
  lastOwnerId: string | null;
  lastAssetId: string | null;
  originalFileName: string;
  /** FL-169: an asset whose removal queued this; while it still exists (its removal rolled back) the file stays. */
  removedAssetId?: string;
};
export type PhysicalFileTrashResult =
  | {
      status: 'trashed';
      entry: PhysicalFileTrashEntry;
    }
  | {
      status: 'referenced';
      references: number;
    }
  | {
      status: 'missing';
    };
export type { PhysicalFileTrashMove } from 'src/repositories/physical-file.repository.js';
// A hidden motion can outlive its still; without trusted parent evidence its privacy is unknown.
const LOCK_EVIDENCE = sql<boolean | null>`coalesce(
  (SELECT EXISTS (SELECT 1 FROM public.asset_lock locked WHERE locked."assetId" = original.id)
    OR CASE
      WHEN original.visibility <> 'hidden' THEN false
      WHEN EXISTS (
        SELECT 1 FROM public.asset parent JOIN public.asset_lock locked ON locked."assetId" = parent.id
        WHERE parent."livePhotoVideoId" = original.id AND parent."ownerId" = original."ownerId")
        OR EXISTS (SELECT 1 FROM public.asset_backup_deletion parent
          WHERE parent."livePhotoVideoId" = original.id AND parent."ownerId" = original."ownerId"
            AND parent."evidenceVersion" = 1 AND parent."wasLocked") THEN true
      WHEN EXISTS (SELECT 1 FROM public.asset_backup_deletion parent
        WHERE parent."livePhotoVideoId" = original.id
          AND (parent."ownerId" <> original."ownerId" OR parent."evidenceVersion" <> 1)) THEN null
      WHEN EXISTS (SELECT 1 FROM public.asset parent
        WHERE parent."livePhotoVideoId" = original.id AND parent."ownerId" = original."ownerId")
        OR EXISTS (SELECT 1 FROM public.asset_backup_deletion parent
          WHERE parent."livePhotoVideoId" = original.id AND parent."ownerId" = original."ownerId"
            AND parent."evidenceVersion" = 1) THEN false
      ELSE null END
    FROM public.asset original WHERE original.id = physical_file_trash."lastAssetId"
      AND original."ownerId" = physical_file_trash."lastOwnerId" AND original.checksum = physical_file_trash.checksum),
  (SELECT deleted."wasLocked" FROM public.asset_backup_deletion deleted
    WHERE deleted."assetId" = physical_file_trash."lastAssetId"
      AND deleted."ownerId" = physical_file_trash."lastOwnerId" AND deleted.checksum = physical_file_trash.checksum
      AND deleted."evidenceVersion" = 1
      AND NOT EXISTS (SELECT 1 FROM public.asset original WHERE original.id = physical_file_trash."lastAssetId")))`;
const ENTRY_COLUMNS = sql`
  id, "physicalFileId", path, checksum, "sizeInBytes"::float8 AS "sizeInBytes", "lastOwnerId", "lastAssetId",
  "originalFileName", "trashedAt", ${LOCK_EVIDENCE} AS "wasLocked"`;
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
/** Library Care file trash (universal storage, spec §3.5). */
@Injectable()
export class PhysicalFileTrashRepository {
  constructor(
    @InjectKysely()
    private db: Kysely<DB>,
  ) {}
  /**
   * Moves an original nothing references any more into the file trash, instead of unlinking it. Under the
   * path lock the references are counted as `deleteUnreferencedPath` counts them; while any remain nothing
   * changes. Otherwise `move` puts the file at `<media>/file-trash/<entryId>/<name>`, the trash row is
   * written and the physical file row deleted, in one transaction. A file already missing is reported and
   * its physical file row kept, for media health to report.
   */
  async trash(input: PhysicalFileTrashInput, move: PhysicalFileTrashMove): Promise<PhysicalFileTrashResult> {
    return withFileTrashMove<PhysicalFileTrashResult>(
      this.db,
      input.path,
      input.originalFileName,
      move,
      async (trx, id) => {
        if (input.removedAssetId) {
          const kept = await trx
            .selectFrom('asset')
            .select('id')
            .where('id', '=', input.removedAssetId)
            .executeTakeFirst();
          if (kept) {
            return { status: 'referenced', references: 1 };
          }
        }
        const physicalFile = await trx
          .selectFrom('physical_file')
          .select(['id'])
          .where('path', '=', input.path)
          .executeTakeFirst();
        const references = (await countPathReferences(trx, input.path, physicalFile?.id)) - 1;
        if (references > 0) {
          return { status: 'referenced', references };
        }
        const trashed = await trashUnreferencedOriginal(
          trx,
          input.path,
          move,
          {
            physicalFileId: input.physicalFileId ?? physicalFile?.id ?? null,
            checksum: input.checksum,
            sizeInBytes: input.sizeInBytes,
            lastOwnerId: input.lastOwnerId,
            lastAssetId: input.lastAssetId,
            originalFileName: input.originalFileName,
          },
          id,
        );
        if (!trashed) {
          return { status: 'missing' };
        }
        if (physicalFile) {
          await trx.deleteFrom('physical_file').where('id', '=', physicalFile.id).execute();
        }
        const entry = await this.getForUpdate(trx, trashed.id);
        return { status: 'trashed', entry };
      },
    );
  }
  recoverMoves(move: PhysicalFileTrashMove) {
    return recoverFileTrashMoves(this.db, move);
  }
  /** The newest trashed original with this exact content, if any. */
  async findByChecksum(
    checksum: Buffer,
    sizeInBytes: number,
    kysely: Kysely<DB> = this.db,
  ): Promise<PhysicalFileTrashEntry | undefined> {
    const { rows } = await sql<PhysicalFileTrashEntry>`
      SELECT ${ENTRY_COLUMNS} FROM public.physical_file_trash
      WHERE checksum = ${checksum} AND "sizeInBytes" = ${sizeInBytes}::bigint
      ORDER BY "trashedAt" DESC, id
      LIMIT 1`.execute(kysely);
    return rows[0];
  }
  async getById(id: string): Promise<PhysicalFileTrashEntry | undefined> {
    const { rows } = await sql<PhysicalFileTrashEntry>`
      SELECT ${ENTRY_COLUMNS} FROM public.physical_file_trash WHERE id = ${id}::uuid`.execute(this.db);
    return rows[0];
  }
  async list({ skip, take, lockedOwnerId }: { skip: number; take: number; lockedOwnerId?: string }) {
    const visible = sql`${LOCK_EVIDENCE} IS FALSE OR "lastOwnerId" = ${lockedOwnerId ?? null}::uuid`;
    const { rows } = await sql<PhysicalFileTrashEntry>`
      SELECT ${ENTRY_COLUMNS} FROM public.physical_file_trash
      WHERE ${visible}
      ORDER BY "trashedAt" DESC, id
      LIMIT ${take} OFFSET ${skip}`.execute(this.db);
    const totals = await sql<{
      total: number;
      totalBytes: number;
    }>`
      SELECT count(*)::int AS total, coalesce(sum("sizeInBytes"), 0)::float8 AS "totalBytes"
      FROM public.physical_file_trash WHERE ${visible}`.execute(this.db);
    return { items: rows, total: totals.rows[0].total, totalBytes: totals.rows[0].totalBytes };
  }
  /**
   * Takes a trashed file back out to `targetPath` and removes its trash row under both paths' locks.
   * A journal committed before the move lets rollback or restart put it back. Returns the entry,
   * or undefined when it is no longer in the trash.
   */
  async untrash(
    id: string,
    targetPath: string,
    move: PhysicalFileTrashMove,
    register?: (trx: Transaction<DB>, entry: PhysicalFileTrashEntry) => Promise<void>,
  ): Promise<PhysicalFileTrashEntry | undefined> {
    const original = await this.getById(id);
    if (!original) return;
    return withFileTrashMove(
      this.db,
      original.path,
      original.originalFileName,
      move,
      async (trx) => {
        const entry = await this.getForUpdate(trx, id);
        if (!entry) {
          return;
        }
        await move(entry.path, targetPath);
        await register?.(trx, entry);
        await sql`DELETE FROM public.physical_file_trash WHERE id = ${id}::uuid`.execute(trx);
        return entry;
      },
      { targetPath, checksum: original.checksum },
    );
  }
  /** Permanently deletes a trashed file: `unlink` runs under the path lock, then the row goes. */
  async purge(
    id: string,
    unlink: (path: string, entry: PhysicalFileTrashEntry) => Promise<void>,
  ): Promise<PhysicalFileTrashEntry | undefined> {
    return this.db.transaction().execute(async (trx) => {
      const entry = await this.getForUpdate(trx, id);
      if (!entry) {
        return;
      }
      await lockFilePath(trx, entry.path);
      await unlink(entry.path, entry).catch((error: unknown) => {
        if (!isMissing(error)) {
          throw error;
        }
      });
      await sql`DELETE FROM public.physical_file_trash WHERE id = ${id}::uuid`.execute(trx);
      return entry;
    });
  }
  private async getForUpdate(trx: Transaction<DB>, id: string) {
    const { rows } = await sql<PhysicalFileTrashEntry>`
      SELECT ${ENTRY_COLUMNS} FROM public.physical_file_trash WHERE id = ${id}::uuid FOR UPDATE`.execute(trx);
    return rows[0];
  }
}
