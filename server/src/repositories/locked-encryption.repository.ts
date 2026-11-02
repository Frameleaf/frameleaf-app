import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { Insertable, Kysely, Updateable } from 'kysely';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { DB } from 'src/schema/index.js';
import { LockedEncryptionTable } from 'src/schema/tables/locked-encryption.table.js';
import { asUuid } from 'src/utils/database.js';
import { holdsEncryptedOriginal } from 'src/utils/locked-encryption-set.js';

/** One of the person's own Locked items, as the settings API counts and queues them. */
export interface LockedEncryptionAsset {
  id: string;
  originalPath: string;
  /** False for a file Frameleaf doesn't own (an external or read-only library), which stays plain (spec §6.3). */
  encryptable: boolean;
  /** Set while the item is on its way out of Locked: its files are decrypted, then the lock goes (spec §7.3). */
  pendingUnlockAt: Date | null;
}

/**
 * FL-721 (spec §4.2): the `locked_encryption` rows, which mirror a person's Locked encryption state
 * only. No key material is ever read from or written to the database.
 */
@Injectable()
export class LockedEncryptionRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  @GenerateSql({ params: [DummyValue.UUID] })
  get(userId: string) {
    return this.db.selectFrom('locked_encryption').selectAll().where('userId', '=', asUuid(userId)).executeTakeFirst();
  }

  /** FL-721: which of these people have Locked encryption on (a row exists). */
  @GenerateSql({ params: [[DummyValue.UUID]] })
  async getUserIds(userIds: string[]): Promise<Set<string>> {
    if (userIds.length === 0) {
      return new Set();
    }
    const rows = await this.db
      .selectFrom('locked_encryption')
      .select('userId')
      .where(
        'userId',
        'in',
        userIds.map((id) => asUuid(id)),
      )
      .execute();
    return new Set(rows.map(({ userId }) => userId));
  }

  /** Everyone with Locked encryption on, turning on or turning off. */
  @GenerateSql()
  async getAllUserIds(): Promise<string[]> {
    const rows = await this.db.selectFrom('locked_encryption').select('userId').execute();
    return rows.map(({ userId }) => userId);
  }

  /**
   * FL-721 (spec §6.2): the people with Locked encryption on (or turning on or off) who share their
   * library with `partnerId`, so their encrypted Locked items may carry an entry for that partner's key.
   */
  @GenerateSql({ params: [DummyValue.UUID] })
  async getOwnersSharingWith(partnerId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom('locked_encryption')
      .innerJoin('partner', 'partner.sharedById', 'locked_encryption.userId')
      .innerJoin('user', 'user.id', 'locked_encryption.userId')
      .select('locked_encryption.userId')
      .where('partner.sharedWithId', '=', asUuid(partnerId))
      .where('user.deletedAt', 'is', null)
      .orderBy('locked_encryption.userId')
      .execute();
    return rows.map(({ userId }) => userId);
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async delete(userId: string): Promise<void> {
    await this.db.deleteFrom('locked_encryption').where('userId', '=', asUuid(userId)).execute();
  }

  create(values: Insertable<LockedEncryptionTable>) {
    return this.db.insertInto('locked_encryption').values(values).returningAll().executeTakeFirstOrThrow();
  }

  update(userId: string, values: Updateable<LockedEncryptionTable>) {
    return this.db
      .updateTable('locked_encryption')
      .set(values)
      .where('userId', '=', asUuid(userId))
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /**
   * FL-721: the original and `asset_file` paths of the person's items that are no longer Locked, on
   * storage Frameleaf owns. A seal or unseal that stopped before its rename may have left a `.fllk.tmp`
   * beside one of them; the start-up sweep clears those so they never hold up a backup.
   */
  @GenerateSql({ params: [DummyValue.UUID] })
  async getUnlockedFilePaths(ownerId: string): Promise<string[]> {
    const { rows } = await sql<{ path: string }>`
      select a."originalPath" as path from public.asset a
      where a."ownerId" = ${asUuid(ownerId)} and a."libraryId" is null
        and not exists (select 1 from public.asset_lock l where l."assetId" = a.id)
        and not exists (select 1 from public.asset_origin o where o."assetId" = a.id)
      union
      select f.path from public.asset_file f join public.asset a on a.id = f."assetId"
      where a."ownerId" = ${asUuid(ownerId)} and a."libraryId" is null
        and not exists (select 1 from public.asset_lock l where l."assetId" = a.id)
        and not exists (select 1 from public.asset_origin o where o."assetId" = a.id)
    `.execute(this.db);
    return rows.map(({ path }) => path);
  }

  /**
   * The person's own Locked items, oldest lock first, trashed ones included (their files are still on
   * disk). A partner's copy is left out: its files are the partner's (spec §6.1).
   */
  @GenerateSql({ params: [DummyValue.UUID] })
  getLockedAssets(ownerId: string): Promise<LockedEncryptionAsset[]> {
    return this.db
      .selectFrom('asset')
      .innerJoin('asset_lock', 'asset_lock.assetId', 'asset.id')
      .select(['asset.id', 'asset.originalPath', 'asset_lock.pendingUnlockAt'])
      .select((eb) => eb('asset.libraryId', 'is', null).$castTo<boolean>().as('encryptable'))
      .where('asset.ownerId', '=', asUuid(ownerId))
      .where(sql<boolean>`not exists (select 1 from public.asset_origin o where o."assetId" = "asset"."id")`)
      .orderBy('asset_lock.lockedAt', 'asc')
      .orderBy('asset.id', 'asc')
      .execute() as Promise<LockedEncryptionAsset[]>;
  }

  /**
   * FL-721 (I3): the person's Locked copies of a partner's items whose file stays plain. A copy reads its
   * owner's file (spec §6.1), which is encrypted only while a Locked item whose owner's encryption covers
   * it reads that file. The partner may not encrypt, or the item is Locked only here; either way this
   * person's setting doesn't encrypt it, and the settings page says so.
   */
  @GenerateSql({ params: [DummyValue.UUID] })
  async countPlainPartnerCopies(ownerId: string): Promise<number> {
    const { count } = await this.db
      .selectFrom('asset')
      .innerJoin('asset_lock', 'asset_lock.assetId', 'asset.id')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('asset.ownerId', '=', asUuid(ownerId))
      .where(sql<boolean>`exists (select 1 from public.asset_origin o where o."assetId" = "asset"."id")`)
      .where(sql<boolean>`not ${holdsEncryptedOriginal('asset')}`)
      .executeTakeFirstOrThrow();
    return Number(count);
  }
}
