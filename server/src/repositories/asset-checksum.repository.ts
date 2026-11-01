import { Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { EXTERNAL_SCAN_CHECKSUM } from 'src/constants.js';
import { ChecksumAlgorithm } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { isAssetChecksumConstraint } from 'src/utils/database.js';

/** Byte-verified checksum evidence shared by uploads, integrity scans and recovery. */
@Injectable()
export class AssetChecksumRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}
  async recordAssetChecksums(input: {
    assetId: string;
    sha1: Buffer;
    sha256: Buffer;
    sizeInBytes: number;
    path: string;
    source: 'upload' | 'integrity' | 'recovery';
  }): Promise<void> {
    await sql`
      INSERT INTO public.asset_checksum
        ("assetId", sha1, sha256, "sizeInBytes", "verifiedPaths", "linkCount", evidence, "verifiedAt", "updatedAt")
      VALUES (
        ${input.assetId}::uuid,
        ${input.sha1},
        ${input.sha256},
        ${input.sizeInBytes},
        ARRAY[${input.path}]::text[],
        1,
        jsonb_build_object('source', ${input.source}::text),
        now(),
        now()
      )
      ON CONFLICT ("assetId") DO UPDATE SET
        sha1 = EXCLUDED.sha1,
        sha256 = EXCLUDED.sha256,
        "sizeInBytes" = EXCLUDED."sizeInBytes",
        "verifiedPaths" = EXCLUDED."verifiedPaths",
        evidence = EXCLUDED.evidence,
        "verifiedAt" = EXCLUDED."verifiedAt",
        "updatedAt" = EXCLUDED."updatedAt"
      WHERE ${input.source} = 'recovery'
    `.execute(this.db);
  }

  /**
   * Moves a legacy upload whose file was just read and verified from its SHA-1 to the SHA-256 read with it,
   * so the uploads and duplicate checks of the apps, which send SHA-256, match it directly. Only an upload
   * (`libraryId` null) still holding that SHA-1 changes: a path checksum or an external original never does.
   * The update trigger gives it a new `updateId`, so sync sends it again. False when the asset changed
   * meanwhile, or when the owner already has another upload with that SHA-256: that is a real duplicate,
   * left for duplicate review, and the asset keeps its SHA-1.
   * ponytail: a sealed Locked original is never read by the checksum check, so the SHA-1 its encrypted backup
   * record keeps (FL-738) still matches its deletion. Only one unlocked after that backup, then promoted and
   * deleted before the next backup, can't be listed from it; the deletion capture keeping the SHA-1 too closes that.
   */
  async promoteToSha256(input: { assetId: string; sha1: Buffer; sha256: Buffer }): Promise<boolean> {
    try {
      const result = await this.db
        .updateTable('asset')
        .set({ checksum: input.sha256, checksumAlgorithm: ChecksumAlgorithm.sha256File })
        .where('id', '=', input.assetId)
        .where('checksumAlgorithm', '=', ChecksumAlgorithm.sha1File)
        .where('checksum', '=', input.sha1)
        .where('libraryId', 'is', null)
        .where('isExternal', '=', false)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    } catch (error) {
      if (isAssetChecksumConstraint(error)) {
        return false;
      }
      throw error;
    }
  }

  /**
   * FL-69: the digests of an external-library original, read by a Library Care scan while the file was
   * present and intact. Its own checksum is only a path checksum, so these are what a moved copy is
   * verified against. They are recorded only while the asset still has that path checksum and the path
   * the bytes were read from; a recovery or relink that finished meanwhile is never overwritten with the
   * old path's bytes. The asset row is share-locked so such a change waits for this write, and an
   * unchanged file does not rewrite the row.
   *
   * These rows carry `evidence.source = 'external-scan'` and are read only to verify a Library Care copy:
   * duplicate pre-checks, the untracked-file restore and sync never treat bytes on an external mount as
   * a managed copy (see `EXTERNAL_SCAN_CHECKSUM`). Those readers also leave out every sidecar of an asset
   * that has a path checksum, whoever wrote it.
   */
  async recordExternalScanChecksums(input: {
    assetId: string;
    sha1: Buffer;
    sha256: Buffer;
    sizeInBytes: number;
    path: string;
  }): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const current = await sql`
        SELECT 1 FROM public.asset
        WHERE id = ${input.assetId}::uuid
          AND "checksumAlgorithm" = ${ChecksumAlgorithm.sha1Path}::asset_checksum_algorithm_enum
          AND "originalPath" = ${input.path}
        FOR SHARE
      `.execute(trx);
      if (current.rows.length === 0) {
        return;
      }
      await sql`
        INSERT INTO public.asset_checksum
          ("assetId", sha1, sha256, "sizeInBytes", "verifiedPaths", "linkCount", evidence, "verifiedAt", "updatedAt")
        VALUES (
          ${input.assetId}::uuid,
          ${input.sha1},
          ${input.sha256},
          ${input.sizeInBytes},
          ARRAY[${input.path}]::text[],
          1,
          jsonb_build_object('source', ${EXTERNAL_SCAN_CHECKSUM}::text),
          now(),
          now()
        )
        ON CONFLICT ("assetId") DO UPDATE SET
          sha1 = EXCLUDED.sha1,
          sha256 = EXCLUDED.sha256,
          "sizeInBytes" = EXCLUDED."sizeInBytes",
          "verifiedPaths" = EXCLUDED."verifiedPaths",
          "linkCount" = EXCLUDED."linkCount",
          evidence = EXCLUDED.evidence,
          "verifiedAt" = EXCLUDED."verifiedAt",
          "updatedAt" = EXCLUDED."updatedAt"
        -- its own earlier reads, and a relink's recovery row (the asset kept its path checksum, so the file at
        -- this path was read just now); upload and integrity evidence is never replaced here
        WHERE asset_checksum.evidence ->> 'source' IN (${EXTERNAL_SCAN_CHECKSUM}, 'recovery')
          AND (asset_checksum.sha1, asset_checksum.sha256, asset_checksum."sizeInBytes")
            IS DISTINCT FROM (EXCLUDED.sha1, EXCLUDED.sha256, EXCLUDED."sizeInBytes")
      `.execute(trx);
    });
  }

  /**
   * Maps the SHA-1 digests an upstream Immich client sends onto the SHA-256
   * digests this fork stores on `public.asset`, so a SHA-1 duplicate
   * pre-check can be resolved through the normal filtered lookup.
   */
  async getChecksumTranslations(
    ownerId: string,
    sha1Checksums: Buffer[],
  ): Promise<Array<{ sha1: Buffer; checksum: Buffer }>> {
    if (sha1Checksums.length === 0) {
      return [];
    }

    // Bind each digest as its own bytea parameter: postgres.js sends a
    // Buffer[] as a single bytea value, so `= ANY($1::bytea[])` fails with
    // "cannot cast type bytea to bytea[]".
    const digests = sql.join(
      sha1Checksums.map((sha1) => sql`${sha1}`),
      sql`, `,
    );

    const result = await sql<{ sha1: Buffer; checksum: Buffer }>`
      SELECT checksum.sha1, asset.checksum
      FROM public.asset_checksum checksum
      INNER JOIN public.asset asset ON asset.id = checksum."assetId"
      WHERE asset."ownerId" = ${ownerId}::uuid
        AND checksum.sha1 IN (${digests})
        AND asset.checksum <> checksum.sha1
        AND asset."checksumAlgorithm" <> ${ChecksumAlgorithm.sha1Path}::asset_checksum_algorithm_enum
        AND checksum.evidence ->> 'source' IS DISTINCT FROM ${EXTERNAL_SCAN_CHECKSUM}
    `.execute(this.db);

    return result.rows;
  }

  async hasAssetChecksum(ownerId: string, sha1: Buffer, sha256: Buffer): Promise<boolean> {
    const result = await sql`
      SELECT 1
      FROM public.asset_checksum checksum
      INNER JOIN public.asset asset ON asset.id = checksum."assetId"
      WHERE asset."ownerId" = ${ownerId}::uuid
        AND (checksum.sha1 = ${sha1} OR checksum.sha256 = ${sha256})
        AND asset."checksumAlgorithm" <> ${ChecksumAlgorithm.sha1Path}::asset_checksum_algorithm_enum
        AND checksum.evidence ->> 'source' IS DISTINCT FROM ${EXTERNAL_SCAN_CHECKSUM}
      LIMIT 1
    `.execute(this.db);
    return result.rows.length > 0;
  }
}
