import { Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { AssetStatus, PhysicalFileType } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { asUuid } from 'src/utils/database.js';

export type StorageMigrationAsset = {
  id: string;
  ownerId: string;
  originalPath: string;
  originalFileName: string;
  checksum: Buffer;
  sizeInBytes: number | null;
  isExternal: boolean;
  libraryId: string | null;
  physicalOriginalFileId: string | null;
};

export type StorageMigrationGroup = {
  /** `<checksum hex>:<size>`: the group's place in the walk, and the cursor after it. */
  key: string;
  checksum: Buffer;
  sizeInBytes: number;
  /** Oldest first: the first that verifies on disk is the group's primary asset. */
  assetIds: string[];
};

export type StorageMigrationUnreferencedOriginal = {
  id: string;
  path: string;
  sizeInBytes: number;
  lastOwnerId: string | null;
  lastAssetId: string | null;
  originalFileName: string | null;
};

const parseGroupKey = (key: string): { checksum: Buffer; sizeInBytes: number } => {
  const [checksum, size] = key.split(':', 2);
  return { checksum: Buffer.from(checksum, 'hex'), sizeInBytes: Number(size) };
};

export const storageMigrationGroupKey = (checksum: Buffer, sizeInBytes: number) =>
  `${checksum.toString('hex')}:${sizeInBytes}`;

/**
 * The reads the universal storage upgrade migration walks (FL-326, spec §3.6). Each is a page after a
 * cursor, so a checkpointed migration carries on where it stopped. Writes go through the
 * physical-file, media-health and file-trash repositories, which hold the path locks.
 */
@Injectable()
export class StorageMigrationRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  private activeAssets() {
    return this.db
      .selectFrom('asset')
      .leftJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .where('asset.deletedAt', 'is', null)
      .where('asset.status', '=', AssetStatus.Active);
  }

  /** Every active asset, external ones included: the "checking files" stage's total. */
  async countAssets(): Promise<number> {
    const { count } = await this.activeAssets()
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .executeTakeFirstOrThrow();
    return Number(count);
  }

  /** The next active assets in id order after `afterId`. */
  getAssetPage(afterId: string | null, limit: number): Promise<StorageMigrationAsset[]> {
    return this.activeAssets()
      .select([
        'asset.id',
        'asset.ownerId',
        'asset.originalPath',
        'asset.originalFileName',
        'asset.checksum',
        'asset.isExternal',
        'asset.libraryId',
        'asset.physicalOriginalFileId',
        'asset_exif.fileSizeInByte as sizeInBytes',
      ])
      .$if(!!afterId, (qb) => qb.where('asset.id', '>', asUuid(afterId!)))
      .orderBy('asset.id', 'asc')
      .limit(limit)
      .execute() as Promise<StorageMigrationAsset[]>;
  }

  /**
   * Other library-storage assets with exactly this checksum and size, oldest first: where a missing
   * original may be relinked from. External-library assets are never a source.
   */
  getGroupSources(assetId: string, checksum: Buffer, sizeInBytes: number): Promise<StorageMigrationAsset[]> {
    return this.managedAssets()
      .select([
        'asset.id',
        'asset.ownerId',
        'asset.originalPath',
        'asset.originalFileName',
        'asset.checksum',
        'asset.isExternal',
        'asset.libraryId',
        'asset.physicalOriginalFileId',
        'asset_exif.fileSizeInByte as sizeInBytes',
      ])
      .where('asset.id', '!=', asUuid(assetId))
      .where('asset.checksum', '=', checksum)
      .where('asset_exif.fileSizeInByte', '=', sizeInBytes)
      .orderBy('asset.createdAt', 'asc')
      .orderBy('asset.id', 'asc')
      .limit(10)
      .execute() as Promise<StorageMigrationAsset[]>;
  }

  private managedAssets() {
    return this.db
      .selectFrom('asset')
      .innerJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .where('asset.deletedAt', 'is', null)
      .where('asset.status', '=', AssetStatus.Active)
      .where('asset.libraryId', 'is', null)
      .where('asset.isExternal', '=', false)
      .where('asset.isOffline', '=', false)
      .where('asset_exif.fileSizeInByte', 'is not', null);
  }

  private duplicateGroups() {
    return this.managedAssets()
      .select(['asset.checksum', 'asset_exif.fileSizeInByte as sizeInBytes'])
      .groupBy(['asset.checksum', 'asset_exif.fileSizeInByte'])
      .having((eb) => eb.fn.count(eb.fn('distinct', [eb.ref('asset.originalPath')])), '>', 1);
  }

  /** Checksum and size groups of library-storage assets still held in more than one file. */
  async countDuplicateGroups(): Promise<number> {
    const { count } = await this.db
      .selectFrom(this.duplicateGroups().as('groups'))
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .executeTakeFirstOrThrow();
    return Number(count);
  }

  /** The next duplicate groups after the group key `afterKey`, in checksum and size order. */
  async getDuplicateGroupPage(afterKey: string | null, limit: number): Promise<StorageMigrationGroup[]> {
    const after = afterKey ? parseGroupKey(afterKey) : undefined;
    const rows = await this.duplicateGroups()
      .select(sql<string[]>`array_agg("asset"."id" ORDER BY "asset"."createdAt", "asset"."id")`.as('assetIds'))
      .$if(!!after, (qb) =>
        qb.where(
          sql<boolean>`("asset"."checksum", "asset_exif"."fileSizeInByte") > (${after!.checksum}::bytea, ${after!.sizeInBytes}::bigint)`,
        ),
      )
      .orderBy('asset.checksum', 'asc')
      .orderBy('asset_exif.fileSizeInByte', 'asc')
      .limit(limit)
      .execute();
    return rows.map((row) => ({
      key: storageMigrationGroupKey(row.checksum, Number(row.sizeInBytes)),
      checksum: row.checksum,
      sizeInBytes: Number(row.sizeInBytes),
      assetIds: row.assetIds,
    }));
  }

  private unreferencedOriginals() {
    return this.db
      .selectFrom('physical_file')
      .where('physical_file.type', '=', PhysicalFileType.Original)
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('asset')
              .select('asset.id')
              .where((inner) =>
                inner.or([
                  inner('asset.physicalOriginalFileId', '=', inner.ref('physical_file.id')),
                  inner('asset.originalPath', '=', inner.ref('physical_file.path')),
                ]),
              ),
          ),
        ),
      )
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('asset_file')
              .select('asset_file.id')
              .where((inner) =>
                inner.or([
                  inner('asset_file.physicalFileId', '=', inner.ref('physical_file.id')),
                  inner('asset_file.path', '=', inner.ref('physical_file.path')),
                ]),
              ),
          ),
        ),
      );
  }

  /** Originals no asset names any more: the "moving extra copies to the file trash" stage's total. */
  async countUnreferencedOriginals(): Promise<number> {
    const { count } = await this.unreferencedOriginals()
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .executeTakeFirstOrThrow();
    return Number(count);
  }

  /**
   * The next unreferenced originals after `afterId`, with the asset that last owned each. These are
   * only candidates: the file trash counts every reference again under the path lock before it moves
   * anything.
   */
  async getUnreferencedOriginalPage(
    afterId: string | null,
    limit: number,
  ): Promise<StorageMigrationUnreferencedOriginal[]> {
    const rows = await this.unreferencedOriginals()
      .leftJoin('asset as lastAsset', 'lastAsset.id', 'physical_file.canonicalAssetId')
      .select([
        'physical_file.id',
        'physical_file.path',
        'physical_file.sizeInBytes',
        'lastAsset.id as lastAssetId',
        'lastAsset.ownerId as lastOwnerId',
        'lastAsset.originalFileName as originalFileName',
      ])
      .$if(!!afterId, (qb) => qb.where('physical_file.id', '>', asUuid(afterId!)))
      .orderBy('physical_file.id', 'asc')
      .limit(limit)
      .execute();
    return rows.map((row) => ({ ...row, sizeInBytes: Number(row.sizeInBytes) }));
  }
}
