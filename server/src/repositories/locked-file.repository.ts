import { Injectable } from '@nestjs/common';
import { type Kysely, type Transaction, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { LockedFileKind } from '@frameleaf/locked-crypto';
import { StorageCore } from 'src/cores/storage.core.js';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { PhysicalFileType, StorageFolder } from 'src/enum.js';
import { LockedEncryptionRepository } from 'src/repositories/locked-encryption.repository.js';
import { LockedKeyRepository } from 'src/repositories/locked-key.repository.js';
import { filePathLockKey, lockFilePath } from 'src/repositories/physical-file.repository.js';
import { DB } from 'src/schema/index.js';
import { asUuid } from 'src/utils/database.js';
import { releaseDerivedResults } from 'src/utils/derivative-locks.js';
import { encryptsFilesOf } from 'src/utils/locked-encryption-set.js';

/** One stored file of an asset, as the seal and unseal jobs see it (spec §6). */
export interface LockedFileRef {
  path: string;
  kind: LockedFileKind;
  /** Where the path is recorded: `asset` (the original), `asset_file`, or a derived table. */
  table: string;
  physicalFileId?: string;
  /** Listed when it exists: a lineage record or a cached filmstrip may never have been written. */
  optional?: boolean;
}

export type LockedStatus = 'encrypting' | 'on' | 'decrypting';

/** `withFileLock`: another job is replacing this file right now. */
export const LOCKED_PATH_BUSY = Symbol('locked-path-busy');

/** What the seal, unseal and rewrap jobs need to know about one asset, read in one query. */
export interface LockedSealState {
  id: string;
  ownerId: string;
  originalFileName: string;
  /** False for a file Frameleaf doesn't own (an external or read-only library), which stays plain (spec §6.3). */
  encryptable: boolean;
  /** A partner's copy: its files are the owner's, sealed through the owner's asset (spec §6.1). */
  partnerCopy: boolean;
  locked: boolean;
  pendingUnlockAt: Date | null;
  status: LockedStatus | null;
  mode: 'pin' | 'advanced' | null;
}

const kindOfFileType = sql<LockedFileKind>`case f.type
  when 'thumbnail' then 'thumbnail'
  when 'preview' then 'preview'
  when 'hdr_preview' then 'preview'
  when 'fullsize' then 'fullsize'
  when 'hdr_fullsize' then 'fullsize'
  when 'encoded_video' then 'encoded-video'
  when 'sidecar' then 'sidecar'
  else 'other' end`;

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

const sha256Of = async (path: string) => {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest();
};

const syncFile = async (path: string) => {
  const handle = await fs.open(path, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

export const syncDirectory = async (directory: string) => {
  const handle = await fs.open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

/**
 * FL-721 (spec §6): the registry of an asset's stored files, and the database side of the seal and
 * unseal jobs. Every path an asset owns is listed by `filesOf` and only there, so adding a new kind
 * of derived file means adding it here.
 */
@Injectable()
export class LockedFileRepository {
  constructor(
    @InjectKysely() private db: Kysely<DB>,
    private lockedKeyRepository: LockedKeyRepository,
    private lockedEncryptionRepository: LockedEncryptionRepository,
  ) {}

  /**
   * Every stored file of the asset, de-duplicated by path: its original; every `asset_file` row
   * (thumbnail, previews, full size, encoded video, sidecar) and an edited video's lineage record;
   * develop revisions and artifacts; video edit versions with their extra files and lineage;
   * the Studio HDR intermediate; restoration outputs; video-moment frames; and the cached Studio
   * timeline media (filmstrip sprites and indexes, waveforms). A Live Photo's motion part is its own
   * asset, locked with the photo, so its files are listed under that asset.
   */
  @GenerateSql({ params: [DummyValue.UUID] })
  async filesOf(assetId: string): Promise<LockedFileRef[]> {
    const id = asUuid(assetId);
    const { rows } = await sql<{
      path: string;
      kind: LockedFileKind;
      table: string;
      physicalFileId: string | null;
      optional: boolean;
      ownerId: string;
    }>`
      select a."originalPath" as path, 'original' as kind, 'asset' as "table",
        a."physicalOriginalFileId" as "physicalFileId", false as optional, a."ownerId"
      from public.asset a where a.id = ${id}
      union all
      select f.path, ${kindOfFileType}, 'asset_file', f."physicalFileId", false, null
      from public.asset_file f where f."assetId" = ${id}
      union all
      select f.path || '.lineage.json', 'other', 'asset_file', null, true, null
      from public.asset_file f where f."assetId" = ${id} and f."isEdited" and f.type = 'encoded_video'
      union all
      select p.path, 'other', 'asset_develop_revision', null, false, null
      from public.asset_develop_revision r
      cross join lateral (values (r."masterPath"), (r."previewPath"), (r."hdrMasterPath"), (r."hdrPreviewPath")) as p(path)
      where r."assetId" = ${id} and p.path is not null
      union all
      select artifact.path, 'other', 'asset_develop_artifact', null, false, null
      from public.asset_develop_artifact artifact where artifact."assetId" = ${id}
      union all
      select p.path, 'other', 'video_edit_version', null, p.optional, null
      from public.video_edit_version v
      cross join lateral (
        values (v."masterPath", false), (v."proxyPath", false), (v."masterPath" || '.lineage.json', true)
      ) as p(path, optional)
      where v."assetId" = ${id} and p.path is not null
      union all
      select extra->>'path', 'other', 'video_edit_version', null, false, null
      from public.video_edit_version v
      cross join lateral jsonb_array_elements(v.files) as extra
      where v."assetId" = ${id} and jsonb_typeof(extra) = 'object' and extra->>'path' is not null
      union all
      select intermediate.path, 'encoded-video', 'studio_hdr_intermediate', null, false, null
      from public.studio_hdr_intermediate intermediate
      where intermediate."assetId" = ${id} and intermediate.path is not null
      union all
      select p.path, 'other', 'asset_restoration', null, false, null
      from public.asset_restoration restoration
      cross join lateral (
        values (restoration."previewBeforePath"), (restoration."previewAfterPath"),
          (restoration."resultPath"), (restoration."resultPreviewPath")
      ) as p(path)
      where restoration."assetId" = ${id} and p.path is not null and p.path <> ''
      union all
      select frame.path, 'other', 'video_moment_frame', null, false, null
      from public.video_moment_frame frame where frame."assetId" = ${id}
    `.execute(this.db);
    if (rows.length === 0) {
      return [];
    }

    const files: LockedFileRef[] = [];
    const seen = new Set<string>();
    const add = (ref: LockedFileRef) => {
      if (!seen.has(ref.path)) {
        seen.add(ref.path);
        files.push(ref);
      }
    };
    for (const row of rows) {
      add({
        path: row.path,
        kind: row.kind,
        table: row.table,
        ...(row.physicalFileId && { physicalFileId: row.physicalFileId }),
        ...(row.optional && { optional: true }),
      });
    }
    const ownerId = rows.find((row) => row.table === 'asset')?.ownerId;
    if (ownerId) {
      for (const path of await this.timelineFiles(ownerId, assetId)) {
        add({ path, kind: 'other', table: 'studio_timeline', optional: true });
      }
    }
    return files;
  }

  /**
   * The owner, when the asset is in their encrypted set (spec §6): it is Locked and not on its way out
   * (`pendingUnlockAt`), its owner's status is `encrypting`, `on` or `decrypting`, it isn't on a
   * read-only source and it isn't a partner's copy.
   */
  @GenerateSql({ params: [DummyValue.UUID] })
  async encryptedSetOwner(assetId: string): Promise<string | null> {
    const row = await this.db
      .selectFrom('asset')
      .innerJoin('asset_lock', 'asset_lock.assetId', 'asset.id')
      .select('asset.ownerId')
      .where('asset.id', '=', asUuid(assetId))
      .where('asset_lock.pendingUnlockAt', 'is', null)
      .where(encryptsFilesOf('asset'))
      .executeTakeFirst();
    return row?.ownerId ?? null;
  }

  /** Everything a seal, unseal or rewrap of the asset decides on. Undefined when the asset is gone. */
  @GenerateSql({ params: [DummyValue.UUID] })
  async getSealState(assetId: string, kysely: Kysely<DB> = this.db): Promise<LockedSealState | undefined> {
    const row = await kysely
      .selectFrom('asset')
      .leftJoin('asset_lock', 'asset_lock.assetId', 'asset.id')
      .leftJoin('locked_encryption', 'locked_encryption.userId', 'asset.ownerId')
      .select([
        'asset.id',
        'asset.ownerId',
        'asset.originalFileName',
        'asset_lock.pendingUnlockAt',
        'locked_encryption.status',
        'locked_encryption.mode',
      ])
      .select((eb) => eb('asset.libraryId', 'is', null).$castTo<boolean>().as('encryptable'))
      .select((eb) => eb('asset_lock.assetId', 'is not', null).$castTo<boolean>().as('locked'))
      .select(
        sql<boolean>`exists (select 1 from public.asset_origin o where o."assetId" = "asset"."id")`.as('partnerCopy'),
      )
      .where('asset.id', '=', asUuid(assetId))
      .executeTakeFirst();
    if (!row) {
      return undefined;
    }
    return {
      ...row,
      pendingUnlockAt: row.pendingUnlockAt ? new Date(row.pendingUnlockAt as unknown as string) : null,
    } as LockedSealState;
  }

  /** The person's own Locked items that their encryption covers, oldest lock first. */
  async *assetIdsForOwner(ownerId: string): AsyncIterable<string> {
    for (const asset of await this.lockedEncryptionRepository.getLockedAssets(ownerId)) {
      if (asset.encryptable) {
        yield asset.id;
      }
    }
  }

  /**
   * The partners who receive the owner's Locked items (spec §6.2) and have a key pair. A partner whose
   * key file is missing or can't be read is left out; a re-wrap adds them once they have one.
   */
  async partnerRecipients(ownerId: string): Promise<{ userId: string; publicKey: Buffer }[]> {
    const partners = await this.getPartnerIds(ownerId);
    const recipients: { userId: string; publicKey: Buffer }[] = [];
    for (const userId of partners) {
      const file = await this.lockedKeyRepository.read(userId).catch(() => null);
      if (file) {
        recipients.push({ userId, publicKey: Buffer.from(file.publicKey, 'base64') });
      }
    }
    return recipients;
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async getPartnerIds(ownerId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom('partner')
      .innerJoin('user', 'user.id', 'partner.sharedWithId')
      .select('partner.sharedWithId')
      .where('partner.sharedById', '=', asUuid(ownerId))
      .where('user.deletedAt', 'is', null)
      .orderBy('partner.sharedWithId')
      .execute();
    return rows.map(({ sharedWithId }) => sharedWithId);
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async isReadOnlySource(assetId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('asset')
      .select('asset.libraryId')
      .where('asset.id', '=', asUuid(assetId))
      .executeTakeFirst();
    return !!row?.libraryId;
  }

  /**
   * The assets other than this one that read `path` as their original or a generated file and must
   * keep reading it in plain form: anything but this asset, its partner copies (which follow the
   * owner's file, spec §6.1) and the same person's other Locked items that their encryption covers.
   */
  @GenerateSql({ params: [DummyValue.UUID, DummyValue.STRING] })
  async plainReaders(assetId: string, path: string, kysely: Kysely<DB> = this.db): Promise<string[]> {
    const { rows } = await sql<{ id: string }>`
      with self as (select id, "ownerId" from public.asset where id = ${asUuid(assetId)}),
      readers as (
        select other.id from public.asset other where other."originalPath" = ${path}
        union
        select f."assetId" from public.asset_file f where f.path = ${path}
      )
      select reader.id from readers
      join public.asset reader on reader.id = readers.id
      cross join self
      where reader.id <> self.id
        and not exists (
          select 1 from public.asset_origin o where o."assetId" = reader.id and o."sourceAssetId" = self.id
        )
        and not (
          reader."ownerId" = self."ownerId"
          and ${encryptsFilesOf('reader')}
          and exists (
            select 1 from public.asset_lock l where l."assetId" = reader.id and l."pendingUnlockAt" is null
          )
        )
      order by reader.id
    `.execute(kysely);
    return rows.map(({ id }) => id);
  }

  /**
   * The same person's other Locked items that still read `path` encrypted and must keep doing so: an
   * unseal of this asset (leaving Locked) must not decrypt a file they share. Empty while the person
   * is turning encryption off, when every item is decrypted.
   */
  @GenerateSql({ params: [DummyValue.UUID, DummyValue.STRING] })
  async sealedReaders(assetId: string, path: string): Promise<string[]> {
    const { rows } = await sql<{ id: string }>`
      with self as (select id, "ownerId" from public.asset where id = ${asUuid(assetId)}),
      readers as (
        select other.id from public.asset other where other."originalPath" = ${path}
        union
        select f."assetId" from public.asset_file f where f.path = ${path}
      )
      select reader.id from readers
      join public.asset reader on reader.id = readers.id
      cross join self
      join public.locked_encryption e on e."userId" = reader."ownerId"
      where reader.id <> self.id
        and e.status <> 'decrypting'
        and ${encryptsFilesOf('reader')}
        and exists (
          select 1 from public.asset_lock l where l."assetId" = reader.id and l."pendingUnlockAt" is null
        )
      order by reader.id
    `.execute(this.db);
    return rows.map(({ id }) => id);
  }

  /**
   * Spec §6.1: before an asset is sealed, its original must be a file no other asset reads in plain
   * form. When one does, the content is copied (and checked) to a new path in the owner's upload
   * folder, and this asset and its partner copies are pointed at the copy, which is then sealed. The
   * file the others read is never touched. False when nothing was shared (or the asset changed).
   */
  async unshareOriginal(assetId: string): Promise<boolean> {
    const asset = await this.db
      .selectFrom('asset')
      .select(['id', 'ownerId', 'originalPath'])
      .where('id', '=', asUuid(assetId))
      .executeTakeFirst();
    if (!asset || (await this.plainReaders(assetId, asset.originalPath)).length === 0) {
      return false;
    }
    const target = StorageCore.getNestedPath(
      StorageFolder.Upload,
      asset.ownerId,
      `${randomUUID()}${extname(asset.originalPath)}`,
    );
    return this.copyAndRepoint(assetId, { path: asset.originalPath, kind: 'original', table: 'asset' }, target, (to) =>
      this.copyVerified(asset.originalPath, to),
    );
  }

  /**
   * `unshareOriginal` for a generated file (an `asset_file` row): the copy goes beside the shared one
   * and only this asset's rows (and its partner copies') move to it.
   */
  async unshareFile(assetId: string, ref: LockedFileRef): Promise<boolean> {
    if (ref.table !== 'asset_file' || (await this.plainReaders(assetId, ref.path)).length === 0) {
      return false;
    }
    return this.copyAndRepoint(assetId, ref, this.siblingPath(ref.path), (to) => this.copyVerified(ref.path, to));
  }

  /** A new path beside `path` for this asset's own copy of a shared file. */
  siblingPath(path: string) {
    const extension = extname(path);
    return join(dirname(path), `${basename(path, extension)}.${randomUUID()}${extension}`);
  }

  /**
   * Writes this asset's own copy of a shared file with `write` (which must leave a complete, synced
   * file at the path it is given), then points this asset and its partner copies at it. The copy is
   * removed again when the asset no longer names `ref.path`. Only `asset` (original) and `asset_file`
   * paths can move.
   */
  async copyAndRepoint(
    assetId: string,
    ref: LockedFileRef,
    target: string,
    write: (to: string) => Promise<void>,
  ): Promise<boolean> {
    if (ref.table !== 'asset' && ref.table !== 'asset_file') {
      return false;
    }
    await fs.mkdir(dirname(target), { recursive: true });
    await write(target);
    let moved = false;
    try {
      moved = await this.db.transaction().execute((tx) => this.repoint(tx, assetId, ref, target));
    } finally {
      if (!moved) {
        await fs.rm(target, { force: true });
      }
    }
    return moved;
  }

  private async repoint(tx: Transaction<DB>, assetId: string, ref: LockedFileRef, target: string) {
    for (const path of [ref.path, target].toSorted()) {
      await lockFilePath(tx, path);
    }
    const asset = await tx
      .selectFrom('asset')
      .select(['id', 'ownerId', 'originalPath', 'physicalOriginalFileId', 'checksum'])
      .where('id', '=', asUuid(assetId))
      .forUpdate()
      .executeTakeFirst();
    if (!asset) {
      return false;
    }
    const { rows: copies } = await sql<{ assetId: string }>`
      select o."assetId" from public.asset_origin o where o."sourceAssetId" = ${asUuid(assetId)} order by o."assetId"
    `.execute(tx);
    const ids = [assetId, ...copies.map(({ assetId: copyId }) => copyId)];

    if (ref.table === 'asset') {
      if (asset.originalPath !== ref.path) {
        return false;
      }
      const { size } = await fs.stat(target);
      const physical = await tx
        .insertInto('physical_file')
        .values({
          type: PhysicalFileType.Original,
          checksum: asset.checksum,
          sizeInBytes: size,
          path: target,
          canonicalAssetId: assetId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      if (asset.physicalOriginalFileId) {
        // the shared file's primary moves to an asset that still reads it
        await sql`
          update public.physical_file set "canonicalAssetId" = (
            select other.id from public.asset other
            where other."physicalOriginalFileId" = ${asset.physicalOriginalFileId}::uuid
              and other.id <> all(${`{${ids}}`}::uuid[])
            order by other."deletedAt" is not null, other."createdAt", other.id limit 1
          )
          where id = ${asset.physicalOriginalFileId}::uuid and "canonicalAssetId" = ${assetId}::uuid
        `.execute(tx);
      }
      await sql`
        update public.asset
        set "originalPath" = ${target}, "physicalOriginalFileId" = ${physical.id}::uuid,
          "libraryPath" = coalesce("libraryPath", ${ref.path}), "updatedAt" = now()
        where id = any(${`{${ids}}`}::uuid[]) and "originalPath" = ${ref.path}
      `.execute(tx);
      return true;
    }

    const { numUpdatedRows } = await tx
      .updateTable('asset_file')
      .set({ path: target, physicalFileId: null })
      .where('assetId', 'in', ids)
      .where('path', '=', ref.path)
      .executeTakeFirst();
    return Number(numUpdatedRows) > 0;
  }

  /** Copies `from` to `to` through a temporary file, checks the copy's SHA-256 and syncs it. */
  private async copyVerified(from: string, to: string) {
    const temporary = `${to}.${randomUUID()}.fllk.tmp`;
    try {
      await fs.copyFile(from, temporary, constants.COPYFILE_EXCL);
      const [source, copy] = await Promise.all([sha256Of(from), sha256Of(temporary)]);
      if (!source.equals(copy)) {
        throw new Error('The copy of a shared file does not match it');
      }
      await syncFile(temporary);
      await fs.rename(temporary, to);
      await syncDirectory(dirname(to));
    } catch (error) {
      await fs.rm(temporary, { force: true });
      throw error;
    }
  }

  /**
   * FL-721: one replacement of a stored file at a time, whichever asset or job asks (two of a person's
   * Locked items may share a file). Runs `work` in a transaction holding the file's path lock (the key
   * `lockFilePath` uses), taken without waiting: `LOCKED_PATH_BUSY` when another job holds it.
   *
   * One job holds exactly one pooled connection: whatever runs under the lock and needs the database
   * uses the transaction `commit` passes to its step (N1), never `this.db`.
   *
   * `work` gets `commit`, which it calls for the final re-check, rename and folder sync only: it takes
   * the owner's per-user lock (class -721) in shared mode, so a rename never lands while turning off
   * or an unlock is being finished, which take it exclusively (`DatabaseRepository.withLockedKeyFileLock`).
   * Both locks are transaction-scoped, so a worker that dies leaves none behind.
   */
  async withFileLock<T>(
    path: string,
    ownerId: string,
    work: (commit: <R>(step: (trx: Kysely<DB>) => Promise<R>) => Promise<R>) => Promise<T>,
  ): Promise<T | typeof LOCKED_PATH_BUSY> {
    return this.db.transaction().execute(async (trx) => {
      const { rows } = await sql<{ locked: boolean }>`
        select pg_try_advisory_xact_lock(${filePathLockKey(path)}::bigint) as locked
      `.execute(trx);
      if (!rows[0]?.locked) {
        return LOCKED_PATH_BUSY;
      }
      return work(async (step) => {
        await sql`SET LOCAL lock_timeout = '120s'`.execute(trx);
        await sql`SELECT pg_advisory_xact_lock_shared(-721, hashtext(${ownerId})::int)`.execute(trx);
        return step(trx);
      });
    });
  }

  /**
   * Spec §7.3, the last step of moving an item out of Locked: once all its files are plain, its lock
   * row (marked `pendingUnlockAt`) goes, and the Studio results it alone kept locked follow it
   * (`releaseDerivedResults`), in one transaction. False when the lock was not pending any more (the
   * person locked it again meanwhile).
   */
  @GenerateSql({ params: [DummyValue.UUID] })
  async finishPendingUnlock(assetId: string): Promise<boolean> {
    return this.db.transaction().execute(async (tx) => {
      await sql`select asset.id from public.asset where asset.id = ${asUuid(assetId)} for no key update`.execute(tx);
      const deleted = await tx
        .deleteFrom('asset_lock')
        .where('assetId', '=', asUuid(assetId))
        .where('pendingUnlockAt', 'is not', null)
        .returning('assetId')
        .execute();
      if (deleted.length === 0) {
        return false;
      }
      await tx.updateTable('asset').set({ updatedAt: new Date() }).where('id', '=', asUuid(assetId)).execute();
      await releaseDerivedResults(tx, [assetId]);
      return true;
    });
  }

  /** The cached Studio timeline media of a video (`StudioMediaService`), when there are any. */
  private async timelineFiles(ownerId: string, assetId: string): Promise<string[]> {
    const folder = join(
      StorageCore.getNestedFolder(StorageFolder.Thumbnails, ownerId, assetId),
      `.${assetId}-timeline`,
    );
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(folder, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) {
        return [];
      }
      throw error;
    }
    return entries
      .filter((entry) => entry.isFile() && !entry.name.endsWith('.tmp'))
      .map((entry) => join(folder, entry.name))
      .toSorted();
  }
}
