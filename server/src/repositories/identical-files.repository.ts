import { Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { randomBytes } from 'node:crypto';
import { parse } from 'node:path';
import { AssetStatus, ChecksumAlgorithm } from 'src/enum.js';
import { countPathReferences, lockChecksum, lockFilePath } from 'src/repositories/physical-file.repository.js';
import { DB } from 'src/schema/index.js';
import { isAssetChecksumConstraint } from 'src/utils/database.js';
import { libraryPathOnRelink } from 'src/utils/library-path.js';
import { holdsEncryptedOriginal, isEncryptedOriginalPath } from 'src/utils/locked-encryption-set.js';

/** A managed original the scan reads: active, online, not trashed, never an external library's. */
export type IdenticalFilesOriginal = {
  id: string;
  ownerId: string;
  originalPath: string;
  originalFileName: string;
  type: string;
  checksum: Buffer;
  checksumAlgorithm: ChecksumAlgorithm;
  physicalOriginalFileId: string | null;
};

/** One photo holding a content, as the merge stages read it. */
export type IdenticalFilesMember = {
  id: string;
  ownerId: string;
  originalPath: string;
  originalFileName: string;
  physicalOriginalFileId: string | null;
  createdAt: Date;
  checksum: Buffer;
  sha1: Buffer;
};

/** Why a newer identical photo in one library is not merged into the older one automatically. */
export type IdenticalFilesMergeGuard =
  'edited' | 'stacked' | 'live-photo' | 'shared' | 'partner-copy' | 'face-corrections' | 'locked' | 'undone';

export type IdenticalFilesContent = { sha256: Buffer; sizeInBytes: number };
export type IdenticalFilesLibraryContent = IdenticalFilesContent & { ownerId: string };

const managed = sql<boolean>`a."libraryId" IS NULL AND NOT a."isExternal" AND NOT a."isOffline"
  AND a."deletedAt" IS NULL AND a.status = ${AssetStatus.Active}`;

/**
 * FL-413: the identical-files engine's reads and writes. Identity is always the SHA-256 and size read
 * from disk by the scan (`asset_checksum`), never a checksum a client sent.
 */
@Injectable()
export class IdenticalFilesRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /* ------------------------------------------------------------------------ */
  /* Scan                                                                      */
  /* ------------------------------------------------------------------------ */

  countOriginals(): Promise<number> {
    return sql<{ count: number }>`SELECT count(*)::int AS count FROM public.asset a WHERE ${managed}`
      .execute(this.db)
      .then(({ rows }) => rows[0].count);
  }

  /** The next page of managed originals after `after` (by id). */
  async getOriginals(after: string | null, limit: number): Promise<IdenticalFilesOriginal[]> {
    const { rows } = await sql<IdenticalFilesOriginal>`
      SELECT a.id, a."ownerId", a."originalPath", a."originalFileName", a.type, a.checksum, a."checksumAlgorithm",
        a."physicalOriginalFileId"
      FROM public.asset a
      WHERE ${managed} ${after ? sql`AND a.id > ${after}::uuid` : sql``}
      ORDER BY a.id
      LIMIT ${limit}`.execute(this.db);
    return rows;
  }

  /** Records the digests read from the file at `path`, replacing older evidence. */
  async recordDigests(input: { assetId: string; sha1: Buffer; sha256: Buffer; sizeInBytes: number; path: string }) {
    await sql`
      INSERT INTO public.asset_checksum
        ("assetId", sha1, sha256, "sizeInBytes", "verifiedPaths", "linkCount", evidence, "verifiedAt", "updatedAt")
      VALUES (${input.assetId}::uuid, ${input.sha1}, ${input.sha256}, ${input.sizeInBytes},
        ARRAY[${input.path}]::text[], 1, jsonb_build_object('source', 'identical-files'), now(), now())
      ON CONFLICT ("assetId") DO UPDATE SET
        sha1 = EXCLUDED.sha1, sha256 = EXCLUDED.sha256, "sizeInBytes" = EXCLUDED."sizeInBytes",
        "verifiedPaths" = EXCLUDED."verifiedPaths", evidence = EXCLUDED.evidence,
        "verifiedAt" = EXCLUDED."verifiedAt", "updatedAt" = EXCLUDED."updatedAt"`.execute(this.db);
  }

  /**
   * Upgrades a SHA-1 record to the SHA-256 just read. Devices keep seeing the SHA-1 (`asset_checksum`).
   * False when the owner already holds a photo with that SHA-256 (its identical twin, merged later) or the
   * photo changed meanwhile; the photo then keeps its SHA-1.
   */
  async upgradeChecksum(assetId: string, from: Buffer, sha256: Buffer): Promise<boolean> {
    try {
      const result = await this.db
        .updateTable('asset')
        .set({ checksum: sha256, checksumAlgorithm: ChecksumAlgorithm.sha256File })
        .where('id', '=', assetId)
        .where('checksum', '=', from)
        .where('checksumAlgorithm', '=', ChecksumAlgorithm.sha1File)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    } catch (error) {
      if (isAssetChecksumConstraint(error)) {
        return false;
      }
      throw error;
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Merge across people                                                       */
  /* ------------------------------------------------------------------------ */

  /** Contents held in more than one file on disk, after `after`, in a stable order. */
  async getSharedContents(after: string | null, limit: number): Promise<IdenticalFilesContent[]> {
    const { rows } = await sql<{ sha256: Buffer; sizeInBytes: string }>`
      SELECT c.sha256, c."sizeInBytes"
      FROM public.asset_checksum c JOIN public.asset a ON a.id = c."assetId"
      WHERE ${managed} ${after ? sql`AND (encode(c.sha256, 'hex') || ':' || c."sizeInBytes") > ${after}` : sql``}
      GROUP BY c.sha256, c."sizeInBytes"
      HAVING count(DISTINCT a."originalPath") > 1
      ORDER BY encode(c.sha256, 'hex') || ':' || c."sizeInBytes"
      LIMIT ${limit}`.execute(this.db);
    return rows.map((row) => ({ sha256: row.sha256, sizeInBytes: Number(row.sizeInBytes) }));
  }

  /**
   * FL-520: extra copies on the drive, from what the scan already recorded: for each content held in
   * more than one file, every file but one, and the space they take. Reads no file.
   */
  async countExtraCopies(): Promise<{ files: number; contents: number; bytes: number }> {
    const { rows } = await sql<{ files: number; contents: number; bytes: string }>`
      SELECT coalesce(sum(g.copies - 1), 0)::int AS files, count(*)::int AS contents,
        coalesce(sum((g.copies - 1) * g.size), 0)::text AS bytes
      FROM (
        SELECT c."sizeInBytes" AS size, count(DISTINCT a."originalPath") AS copies
        FROM public.asset_checksum c JOIN public.asset a ON a.id = c."assetId"
        WHERE ${managed}
        GROUP BY c.sha256, c."sizeInBytes"
        HAVING count(DISTINCT a."originalPath") > 1
      ) g`.execute(this.db);
    return { files: rows[0].files, contents: rows[0].contents, bytes: Number(rows[0].bytes) };
  }

  /**
   * Every active managed photo holding this content, oldest first (the photo added first, then id).
   * FL-721 (spec §6.1): a photo whose file an encrypted Locked item reads is never a member, so it is
   * never kept for others, linked to another file or merged.
   */
  async getMembers(content: IdenticalFilesContent, ownerId?: string): Promise<IdenticalFilesMember[]> {
    const { rows } = await sql<IdenticalFilesMember>`
      SELECT a.id, a."ownerId", a."originalPath", a."originalFileName", a."physicalOriginalFileId", a."createdAt",
        a.checksum, c.sha1
      FROM public.asset_checksum c JOIN public.asset a ON a.id = c."assetId"
      WHERE ${managed} AND c.sha256 = ${content.sha256} AND c."sizeInBytes" = ${content.sizeInBytes}::bigint
        AND NOT ${holdsEncryptedOriginal('a')}
        ${ownerId ? sql`AND a."ownerId" = ${ownerId}::uuid` : sql``}
      ORDER BY a."createdAt", a.id`.execute(this.db);
    return rows;
  }

  /** Whether an earlier link of this photo was undone: it is never linked again automatically. */
  async wasUndone(assetId: string): Promise<boolean> {
    const { rows } = await sql`SELECT 1 FROM public.identical_file_change
      WHERE "assetId" = ${assetId}::uuid AND "undoneAt" IS NOT NULL LIMIT 1`.execute(this.db);
    return rows.length > 0;
  }

  /**
   * Points `assetId` at the kept file, in one transaction under the content lock and then both paths'
   * locks in sorted order (the order upload linking takes them). Before anything is written the photo is
   * read again: still active, still the owner's photo of this content, still on `ownPath`; and the kept
   * file still registered at `kept.path`, unchanged on disk (`unchanged`). The change is journalled with
   * the photo's own path, so it can be undone. Returns the journal id, or null when anything changed.
   */
  async linkToKept(input: {
    runId: string;
    assetId: string;
    ownPath: string;
    keptAssetId: string;
    kept: { id: string; path: string };
    content: IdenticalFilesContent;
    unchanged: () => Promise<boolean>;
  }): Promise<string | null> {
    return this.db.transaction().execute(async (trx) => {
      await lockChecksum(trx, input.content.sha256);
      for (const path of [...new Set([input.ownPath, input.kept.path])].toSorted()) {
        await lockFilePath(trx, path);
      }
      const { rows: current } = await sql`
        SELECT a.id FROM public.asset a JOIN public.asset_checksum c ON c."assetId" = a.id
        WHERE a.id = ${input.assetId}::uuid AND ${managed} AND a."originalPath" = ${input.ownPath}
          AND c.sha256 = ${input.content.sha256} AND c."sizeInBytes" = ${input.content.sizeInBytes}::bigint
          AND NOT ${holdsEncryptedOriginal('a')}
        FOR UPDATE OF a`.execute(trx);
      // FL-721: checked again under the locks, as the kept file may have been Locked meanwhile
      const { rows: kept } = await sql`
        SELECT 1 FROM public.physical_file
        WHERE id = ${input.kept.id}::uuid AND path = ${input.kept.path} AND type = 'original'
          AND NOT ${isEncryptedOriginalPath(input.kept.path)}`.execute(trx);
      if (current.length === 0 || kept.length === 0 || !(await input.unchanged())) {
        return null;
      }
      await trx
        .updateTable('asset')
        .set({
          physicalOriginalFileId: input.kept.id,
          originalPath: input.kept.path,
          libraryPath: libraryPathOnRelink(input.kept.path, false),
        })
        .where('id', '=', input.assetId)
        .execute();
      const { rows } = await sql<{ id: string }>`
        INSERT INTO public.identical_file_change
          ("runId", kind, "assetId", "keptAssetId", "ownPath", checksum, "sizeInBytes")
        VALUES (${input.runId}::uuid, 'link', ${input.assetId}::uuid, ${input.keptAssetId}::uuid, ${input.ownPath},
          ${input.content.sha256}, ${input.content.sizeInBytes}::bigint)
        RETURNING id`.execute(trx);
      return rows[0].id;
    });
  }

  /** The newest Unused files entry holding this photo's own former file. */
  async findUnusedEntry(assetId: string, path: string): Promise<string | undefined> {
    // the entry's checksum is whatever the file was registered with (SHA-1 for an older record)
    const { rows } = await sql<{ id: string }>`SELECT id FROM public.physical_file_trash
      WHERE "lastAssetId" = ${assetId}::uuid AND "originalFileName" = ${parse(path).base}
      ORDER BY "trashedAt" DESC, id LIMIT 1`.execute(this.db);
    return rows[0]?.id;
  }

  async setUnusedEntry(changeId: string, trashEntryId: string) {
    await sql`UPDATE public.identical_file_change SET "trashEntryId" = ${trashEntryId}::uuid
      WHERE id = ${changeId}::uuid`.execute(this.db);
  }

  /** Links whose photo's own file still waits to move to Unused files (a backup held it, or a crash). */
  async getPendingTidy(runId: string) {
    const { rows } = await sql<{ id: string; assetId: string; ownPath: string; checksum: Buffer; sizeInBytes: string }>`
      SELECT id, "assetId", "ownPath", checksum, "sizeInBytes" FROM public.identical_file_change
      WHERE "runId" = ${runId}::uuid AND kind = 'link' AND "trashEntryId" IS NULL AND "undoneAt" IS NULL
      ORDER BY id`.execute(this.db);
    return rows.map((row) => ({ ...row, sizeInBytes: Number(row.sizeInBytes) }));
  }

  /* ------------------------------------------------------------------------ */
  /* Merge inside one library                                                  */
  /* ------------------------------------------------------------------------ */

  /** (owner, content) pairs with two or more active photos, after `after`, in a stable order. */
  async getLibraryContents(after: string | null, limit: number): Promise<IdenticalFilesLibraryContent[]> {
    const key = sql`a."ownerId"::text || ':' || encode(c.sha256, 'hex') || ':' || c."sizeInBytes"`;
    const { rows } = await sql<{ ownerId: string; sha256: Buffer; sizeInBytes: string }>`
      SELECT a."ownerId", c.sha256, c."sizeInBytes"
      FROM public.asset_checksum c JOIN public.asset a ON a.id = c."assetId"
      WHERE ${managed} ${after ? sql`AND ${key} > ${after}` : sql``}
      GROUP BY a."ownerId", c.sha256, c."sizeInBytes"
      HAVING count(*) > 1
      ORDER BY ${key}
      LIMIT ${limit}`.execute(this.db);
    return rows.map((row) => ({ ownerId: row.ownerId, sha256: row.sha256, sizeInBytes: Number(row.sizeInBytes) }));
  }

  /**
   * Why each newer photo may not be merged into `keptId` automatically. A photo with edits or develop
   * history, a stack, its own Live Photo motion, a share, a partner origin, face corrections, a different
   * Locked state, or a merge with the kept photo that was undone, is listed instead.
   */
  async getMergeGuards(keptId: string, newerIds: string[]): Promise<Map<string, IdenticalFilesMergeGuard>> {
    const guards = new Map<string, IdenticalFilesMergeGuard>();
    if (newerIds.length === 0) {
      return guards;
    }
    const { rows } = await sql<{ id: string; guard: IdenticalFilesMergeGuard | null }>`
      SELECT n.id, CASE
        WHEN n."isEdited" OR k."isEdited"
          OR EXISTS (SELECT 1 FROM public.asset_develop_revision r WHERE r."assetId" IN (n.id, k.id))
          OR EXISTS (SELECT 1 FROM public.asset_edit e WHERE e."assetId" IN (n.id, k.id)) THEN 'edited'
        WHEN n."stackId" IS NOT NULL THEN 'stacked'
        WHEN n."livePhotoVideoId" IS NOT NULL AND n."livePhotoVideoId" IS DISTINCT FROM k."livePhotoVideoId" THEN 'live-photo'
        WHEN EXISTS (SELECT 1 FROM public.shared_link_asset s WHERE s."assetId" = n.id)
          OR EXISTS (SELECT 1 FROM public.asset_user_share s WHERE s."assetId" = n.id) THEN 'shared'
        WHEN EXISTS (SELECT 1 FROM public.asset_origin o WHERE o."assetId" = n.id) THEN 'partner-copy'
        WHEN EXISTS (SELECT 1 FROM public.face_correction f WHERE f."assetId" = n.id AND f."undoneAt" IS NULL) THEN 'face-corrections'
        WHEN EXISTS (SELECT 1 FROM public.asset_lock l WHERE l."assetId" = n.id)
          <> EXISTS (SELECT 1 FROM public.asset_lock l WHERE l."assetId" = k.id) THEN 'locked'
        WHEN EXISTS (SELECT 1 FROM public.duplicate_decision d WHERE d."undoneAt" IS NOT NULL
          AND d."memberIds" @> jsonb_build_array(n.id::text, k.id::text)) THEN 'undone'
        ELSE NULL END AS guard
      FROM public.asset n CROSS JOIN public.asset k
      WHERE k.id = ${keptId}::uuid AND n.id = ANY(${newerIds}::uuid[])`.execute(this.db);
    for (const row of rows) {
      if (row.guard) {
        guards.set(row.id, row.guard);
      }
    }
    return guards;
  }

  /** Puts these photos (the owner's) in one duplicate group, so a decision or Duplicate review can take them. */
  async groupPhotos(ownerId: string, assetIds: string[], duplicateId: string): Promise<void> {
    await this.db
      .updateTable('asset')
      .set({ duplicateId })
      .where('ownerId', '=', ownerId)
      .where('id', 'in', assetIds)
      .execute();
  }

  /**
   * The kept photo takes the SHA-256 and every newer twin keeps (or takes back) its SHA-1. The owner's
   * checksums are unique including the Trash, so the swap goes through a placeholder in one transaction.
   */
  async swapChecksums(
    ownerId: string,
    keptId: string,
    twins: Array<{ id: string; sha1: Buffer }>,
    sha256: Buffer,
  ): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const holder = await trx
        .selectFrom('asset')
        .select(['id'])
        .where('ownerId', '=', ownerId)
        .where('checksum', '=', sha256)
        .executeTakeFirst();
      if (holder?.id === keptId) {
        return true;
      }
      if (holder && twins.every((twin) => twin.id !== holder.id)) {
        // another photo of the owner (one in the Trash) holds it: the kept photo keeps its SHA-1
        return false;
      }
      // the twin holding the SHA-256 steps aside to a placeholder, the kept photo takes the SHA-256, and
      // the twin takes the SHA-1 the kept photo held (both hold the same content's SHA-1)
      const twin = holder ? twins.find(({ id }) => id === holder.id) : undefined;
      const { rows: kept } = await sql<{ checksum: Buffer; checksumAlgorithm: ChecksumAlgorithm }>`
        SELECT checksum, "checksumAlgorithm" FROM public.asset WHERE id = ${keptId}::uuid FOR UPDATE`.execute(trx);
      if (twin) {
        await trx
          .updateTable('asset')
          .set({ checksum: randomBytes(32) })
          .where('id', '=', twin.id)
          .execute();
      }
      await trx
        .updateTable('asset')
        .set({ checksum: sha256, checksumAlgorithm: ChecksumAlgorithm.sha256File })
        .where('id', '=', keptId)
        .where('ownerId', '=', ownerId)
        .execute();
      if (twin) {
        const sha1 = kept[0]?.checksumAlgorithm === ChecksumAlgorithm.sha1File ? kept[0].checksum : twin.sha1;
        await trx
          .updateTable('asset')
          .set({ checksum: sha1, checksumAlgorithm: ChecksumAlgorithm.sha1File })
          .where('id', '=', twin.id)
          .execute();
      }
      return true;
    });
  }

  /* ------------------------------------------------------------------------ */
  /* Orphans                                                                   */
  /* ------------------------------------------------------------------------ */

  /** Of these paths, the ones a row already names (a fast first pass; `isUnreferenced` decides). */
  async getKnownPaths(paths: string[]): Promise<Set<string>> {
    if (paths.length === 0) {
      return new Set();
    }
    const { rows } = await sql<{ path: string }>`
      SELECT "originalPath" AS path FROM public.asset WHERE "originalPath" = ANY(${paths}::text[])
      UNION SELECT path FROM public.physical_file WHERE path = ANY(${paths}::text[])
      UNION SELECT path FROM public.asset_file WHERE path = ANY(${paths}::text[])
      UNION SELECT path FROM public.physical_file_trash WHERE path = ANY(${paths}::text[])
      UNION SELECT "finalPath" FROM public.asset_upload_resource WHERE "finalPath" = ANY(${paths}::text[])
      UNION SELECT path FROM public.asset_upload_part WHERE path = ANY(${paths}::text[])
      UNION SELECT evidence->>'retainedPath' FROM public.asset_health
        WHERE evidence->>'retainedPath' = ANY(${paths}::text[])`.execute(this.db);
    return new Set(rows.map(({ path }) => path));
  }

  /** The one authoritative answer for an orphan: nothing at all references `path` (`countPathReferences`). */
  isUnreferenced(path: string): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      await lockFilePath(trx, path);
      return (await countPathReferences(trx, path)) === 0;
    });
  }

  /** Users by id and by storage label, for working out who owns a folder. */
  async getOwners() {
    return this.db
      .selectFrom('user')
      .select(['id', 'storageLabel', 'isAdmin', 'deletedAt', 'quotaSizeInBytes', 'quotaUsageInBytes'])
      .execute();
  }

  /** Active managed photos holding this content: whose they are, and the file they use. */
  async findContent(content: IdenticalFilesContent) {
    const { rows } = await sql<{
      id: string;
      ownerId: string;
      physicalOriginalFileId: string | null;
      originalPath: string;
    }>`
      SELECT a.id, a."ownerId", a."physicalOriginalFileId", a."originalPath"
      FROM public.asset_checksum c JOIN public.asset a ON a.id = c."assetId"
      WHERE c.sha256 = ${content.sha256} AND c."sizeInBytes" = ${content.sizeInBytes}::bigint
        AND a."libraryId" IS NULL AND NOT a."isExternal" AND a.status <> ${AssetStatus.Deleted}
      ORDER BY a."createdAt", a.id`.execute(this.db);
    return rows;
  }

  /** Whether the owner's library already holds this content, in the Trash included. */
  async ownerHolds(ownerId: string, content: IdenticalFilesContent & { sha1: Buffer }): Promise<boolean> {
    const { rows } = await sql`
      SELECT 1 FROM public.asset a LEFT JOIN public.asset_checksum c ON c."assetId" = a.id
      WHERE a."ownerId" = ${ownerId}::uuid AND (a.checksum IN (${content.sha256}, ${content.sha1})
        OR (c.sha256 = ${content.sha256} AND c."sizeInBytes" = ${content.sizeInBytes}::bigint))
      LIMIT 1`.execute(this.db);
    return rows.length > 0;
  }

  /** Import paths of external libraries: never walked, never touched. */
  async getExternalImportPaths(): Promise<string[]> {
    const rows = await this.db.selectFrom('library').select('importPaths').execute();
    return rows.flatMap(({ importPaths }) => importPaths);
  }

  /* ------------------------------------------------------------------------ */
  /* Undo                                                                      */
  /* ------------------------------------------------------------------------ */

  async getChange(id: string) {
    const { rows } = await sql<{
      id: string;
      assetId: string;
      keptAssetId: string | null;
      ownPath: string;
      checksum: Buffer;
      sizeInBytes: string;
      trashEntryId: string | null;
      undoneAt: Date | null;
    }>`SELECT id, "assetId", "keptAssetId", "ownPath", checksum, "sizeInBytes", "trashEntryId", "undoneAt"
      FROM public.identical_file_change WHERE id = ${id}::uuid`.execute(this.db);
    return rows[0] ? { ...rows[0], sizeInBytes: Number(rows[0].sizeInBytes) } : undefined;
  }

  async listChanges(assetId: string) {
    const { rows } = await sql<{
      id: string;
      kind: string;
      keptAssetId: string | null;
      createdAt: Date;
      undoneAt: Date | null;
      restorable: boolean;
    }>`
      SELECT id, kind, "keptAssetId", "createdAt", "undoneAt", "trashEntryId" IS NOT NULL AS restorable
      FROM public.identical_file_change WHERE "assetId" = ${assetId}::uuid ORDER BY id DESC`.execute(this.db);
    return rows;
  }

  /**
   * FL-416: the newest links the run made, across the server, for the "Merged for you" history: the photo,
   * whose it is, whose file it now shares, and whether its own file still waits in Unused files.
   */
  async listRecentChanges(limit: number) {
    const { rows } = await sql<{
      id: string;
      assetId: string;
      originalFileName: string;
      ownerId: string;
      ownerName: string;
      keptAssetId: string | null;
      keptOwnerName: string | null;
      sizeInBytes: string;
      createdAt: Date;
      undoneAt: Date | null;
      restorable: boolean;
    }>`
      SELECT c.id, c."assetId", a."originalFileName", a."ownerId", owner.name AS "ownerName", c."keptAssetId",
        kept_owner.name AS "keptOwnerName", c."sizeInBytes", c."createdAt", c."undoneAt",
        c."trashEntryId" IS NOT NULL AS restorable
      FROM public.identical_file_change c
      JOIN public.asset a ON a.id = c."assetId"
      JOIN public."user" owner ON owner.id = a."ownerId"
      LEFT JOIN public.asset kept ON kept.id = c."keptAssetId"
      LEFT JOIN public."user" kept_owner ON kept_owner.id = kept."ownerId"
      ORDER BY c."createdAt" DESC, c.id DESC
      LIMIT ${limit}`.execute(this.db);
    return rows.map((row) => ({ ...row, sizeInBytes: Number(row.sizeInBytes) }));
  }

  async markUndone(id: string) {
    await sql`UPDATE public.identical_file_change SET "undoneAt" = now() WHERE id = ${id}::uuid`.execute(this.db);
  }
}
