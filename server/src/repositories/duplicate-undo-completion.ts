import { ConflictException, ForbiddenException } from '@nestjs/common';
import { type Transaction, type Updateable, sql } from 'kysely';
import type { DB } from 'src/schema/index.js';
import type { AssetExifTable } from 'src/schema/tables/asset-exif.table.js';
import type { AssetTable } from 'src/schema/tables/asset.table.js';
import { placeProperties } from 'src/database.js';
import { AlbumKind, AlbumUserRole, AssetVisibility, SharedSpaceEventType } from 'src/enum.js';
import { publicationTransaction } from 'src/queue/transaction.js';
import { AlbumUserRepository } from 'src/repositories/album-user.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ClassificationRepository } from 'src/repositories/classification.repository.js';
import {
  DuplicateDecisionRepository,
  type DuplicateKeeperState,
} from 'src/repositories/duplicate-decision.repository.js';
import { type DuplicateUndoClaim } from 'src/repositories/duplicate-undo-authority.js';
import {
  AlbumOriginField,
  AssetOriginField,
  PartnerOriginRepository,
} from 'src/repositories/partner-origin.repository.js';
import { SmartAlbumRepository } from 'src/repositories/smart-album.repository.js';
import { albumCoverReplacement, getBestPhotoScoreTable } from 'src/utils/cover-references.js';
import { updateLockedColumns } from 'src/utils/database.js';

type State = { before?: Record<string, DuplicateKeeperState>; after?: Record<string, DuplicateKeeperState> };
export type DuplicateUndoEffects = {
  edits: { assetId: string; fields: string[] }[];
  visibility: string[];
  untagged: string[];
  albums: { id: string; userIds: string[]; recipientIds: string[] }[];
};

/** Album membership writers take album before asset. Lock recorded resources before group assets. */
export async function lockDuplicateUndoMetadata(tx: Transaction<DB>, claim: DuplicateUndoClaim): Promise<void> {
  const decision = await tx
    .selectFrom('duplicate_decision')
    .select('state')
    .where('id', '=', claim.decisionId)
    .executeTakeFirstOrThrow();
  const after = (decision.state as State).after ?? {};
  const albumIds = [...new Set(Object.values(after).flatMap((s) => s.albumIds))].sort();
  const tagIds = [...new Set(Object.values(after).flatMap((s) => s.tagIds))].sort();
  if (albumIds.length > 0)
    await tx.selectFrom('album').select('id').where('id', 'in', albumIds).orderBy('id').forNoKeyUpdate().execute();
  if (tagIds.length > 0)
    await tx.selectFrom('tag').select('id').where('id', 'in', tagIds).orderBy('id').forShare().execute();
}

/** No newly associated motion, stack or published derivative may escape the already acquired locks. */
export async function requireDuplicateUndoFamily(
  tx: Transaction<DB>,
  ownerId: string,
  locked: string[],
): Promise<void> {
  const { rows } = await sql<{
    id: string;
  }>`WITH known AS (SELECT * FROM asset WHERE id=ANY(${locked}::uuid[])), related AS (
    SELECT id FROM known UNION SELECT "livePhotoVideoId" FROM known WHERE "livePhotoVideoId" IS NOT NULL
    UNION SELECT a.id FROM asset a JOIN known k ON a."livePhotoVideoId"=k.id OR (a."stackId" IS NOT NULL AND a."stackId"=k."stackId")
    UNION SELECT a.id FROM asset a JOIN known k ON a."livePhotoVideoId"=k."livePhotoVideoId" WHERE k."livePhotoVideoId" IS NOT NULL
    UNION SELECT v."resultAssetId" FROM studio_export_version_source s JOIN studio_export_version v ON v.id=s."versionId"
      WHERE s."assetId"=ANY(${locked}::uuid[]) AND v.state='published' AND v."resultAssetId" IS NOT NULL
  ) SELECT DISTINCT a.id FROM related r JOIN asset a ON a.id=r.id WHERE a."ownerId"=${ownerId}::uuid`.execute(tx);
  if (rows.some(({ id }) => !locked.includes(id))) throw new ConflictException('duplicate_undo_family_changed');
}

/** DB-only reversal; the caller owns complete family/asset locks and the live operation/decision. */
export async function restoreDuplicateUndoMetadata(
  tx: Transaction<DB>,
  ownerId: string,
  claim: DuplicateUndoClaim,
): Promise<DuplicateUndoEffects> {
  // Existing repository nested transactions join this explicit transaction. This supplies connection
  // affinity only; all authority comes from requireDuplicateUndoClaim in the owning transaction.
  return publicationTransaction.run(tx, async () => {
    const decisions = new DuplicateDecisionRepository(tx);
    const decision = (await decisions.getById(ownerId, claim.decisionId))!;
    const { before = {}, after = {} } = decision.state as State;
    const keepers = decision.keepAssetIds.filter((id) => before[id] && after[id]);
    const effects: DuplicateUndoEffects = { edits: [], visibility: [], untagged: [], albums: [] };
    if (keepers.length === 0) return effects;
    await tx
      .selectFrom('asset_exif')
      .select('assetId')
      .where('assetId', 'in', keepers)
      .orderBy('assetId')
      .forUpdate()
      .execute();
    const current = await decisions.getKeeperStates(keepers);
    const locked = await decisions.getLockedIds(keepers);
    const assets = new AssetRepository(tx);
    const partner = new PartnerOriginRepository(tx);
    for (const id of keepers) {
      const was = before[id],
        left = after[id],
        now = current.get(id);
      if (!now) throw new ConflictException('duplicate_undo_selection_changed');
      const asset: Updateable<AssetTable> = {},
        exif: Updateable<AssetExifTable> = {};
      const fields: string[] = [];
      if (was.livePhotoVideoId === null && left.livePhotoVideoId && now.livePhotoVideoId === left.livePhotoVideoId) {
        const motion = await tx
          .selectFrom('asset')
          .select('id')
          .where('id', '=', left.livePhotoVideoId)
          .where('ownerId', '=', ownerId)
          .where('deletedAt', 'is', null)
          .executeTakeFirst();
        if (!motion) throw new ConflictException('duplicate_undo_selection_changed');
        const original = await tx
          .selectFrom('asset')
          .select('id')
          .where('id', '!=', id)
          .where('ownerId', '=', ownerId)
          .where('deletedAt', 'is', null)
          .where('livePhotoVideoId', '=', left.livePhotoVideoId)
          .executeTakeFirst();
        if (original) {
          asset.livePhotoVideoId = null;
          effects.visibility.push(id);
        }
      }
      if (now.isFavorite === left.isFavorite && was.isFavorite !== left.isFavorite) asset.isFavorite = was.isFavorite;
      // Undo never unlocks a Locked keeper, including an elevated recorded operation.
      if (!locked.has(id) && now.visibility === left.visibility && was.visibility !== left.visibility) {
        if (was.visibility === AssetVisibility.Locked) throw new ConflictException('duplicate_undo_selection_changed');
        asset.visibility = was.visibility;
        fields.push(AssetOriginField.Visibility);
        effects.visibility.push(id);
      }
      if (now.rating === left.rating && was.rating !== left.rating) {
        exif.rating = was.rating;
        fields.push(AssetOriginField.Rating);
      }
      if (now.description === left.description && was.description !== left.description) {
        exif.description = was.description;
        fields.push(AssetOriginField.Description);
      }
      const moved =
        now.latitude === left.latitude &&
        now.longitude === left.longitude &&
        (was.latitude !== left.latitude || was.longitude !== left.longitude) &&
        was.latitude !== null &&
        was.longitude !== null;
      if (moved) {
        exif.latitude = was.latitude;
        exif.longitude = was.longitude;
        fields.push(AssetOriginField.Location);
      }
      if (Object.keys(exif).length > 0) await assets.updateAllExif([id], exif, moved ? [...placeProperties] : []);
      if (Object.keys(asset).length > 0) await assets.updateAll([id], asset);
      for (const albumId of left.albumIds) {
        if (was.albumIds.includes(albumId) || !now.albumIds.includes(albumId)) continue;
        const liveAlbum = await tx
          .selectFrom('album')
          .select('id')
          .where('id', '=', albumId)
          .where('deletedAt', 'is', null)
          .executeTakeFirst();
        if (!liveAlbum) throw new ForbiddenException('duplicate_undo_album_access_required');
        const membership = await tx
          .selectFrom('album_user')
          .select('role')
          .where('albumId', '=', albumId)
          .where('userId', '=', ownerId)
          .forShare()
          .executeTakeFirst();
        if (!membership || membership.role === AlbumUserRole.Viewer)
          throw new ForbiddenException('duplicate_undo_album_access_required');
        await new AlbumRepository(tx).removeAssetIds(albumId, [id]);
        const outcome = await new ClassificationRepository(tx).recordAlbumRemovals(albumId, [id], ownerId);
        effects.untagged.push(...outcome.untagged);
        if (membership.role === AlbumUserRole.Owner) await new SmartAlbumRepository(tx).excludeFromAlbum(albumId, [id]);
        const album = await tx
          .selectFrom('album')
          .select(['kind', 'albumThumbnailAssetId'])
          .where('id', '=', albumId)
          .executeTakeFirstOrThrow();
        if (album.albumThumbnailAssetId === id) {
          await new AlbumRepository(tx).updateNewestCovers([albumId], tx);
          const scores = await getBestPhotoScoreTable(tx);
          await tx
            .updateTable('album')
            .set((eb) => ({ albumThumbnailAssetId: albumCoverReplacement(eb, scores) }))
            .where('id', '=', albumId)
            .where('albumThumbnailAssetId', '=', id)
            .execute();
        }
        if (album.kind === AlbumKind.Space)
          await new AlbumUserRepository(tx).createSpaceEvent({
            albumId,
            actorId: ownerId,
            type: SharedSpaceEventType.AssetsRemoved,
            assetIds: [id],
          });
        await partner.markOverridden('album', [albumId], [AlbumOriginField.Membership]);
        const users = await tx.selectFrom('album_user').select('userId').where('albumId', '=', albumId).execute();
        effects.albums.push({ id: albumId, userIds: users.map((u) => u.userId), recipientIds: [] });
      }
      let tagsChanged = false;
      for (const tagId of left.tagIds) {
        if (was.tagIds.includes(tagId) || !now.tagIds.includes(tagId)) continue;
        const tag = await tx
          .selectFrom('tag')
          .select('id')
          .where('id', '=', tagId)
          .where('userId', '=', ownerId)
          .executeTakeFirst();
        if (!tag) throw new ForbiddenException('duplicate_undo_tag_access_required');
        const removed = await tx
          .deleteFrom('tag_asset')
          .where('tagId', '=', tagId)
          .where('assetId', '=', id)
          .returning('assetId')
          .execute();
        if (removed.length > 0) {
          tagsChanged = true;
          effects.untagged.push(id);
        }
      }
      if (tagsChanged) {
        const { tags } = await assets.getForUpdateTags(id);
        await assets.upsertExif({
          exif: updateLockedColumns({ assetId: id, tags: tags.map(({ value }) => value) }),
          lockedPropertiesBehavior: 'append',
        });
        fields.push(AssetOriginField.Tags);
      }
      if (Object.keys(asset).length > 0 || Object.keys(exif).length > 0 || tagsChanged)
        effects.edits.push({ assetId: id, fields });
      if (fields.length > 0) await partner.markOverridden('asset', [id], fields, ownerId);
    }
    return effects;
  });
}

/** The final SQL statement is both full-group certification and a DB-clock lease fence. */
export async function completeDuplicateUndo(
  tx: Transaction<DB>,
  ownerId: string,
  claim: DuplicateUndoClaim,
): Promise<void> {
  const { rows } = await sql`UPDATE duplicate_decision d SET "undoneAt"=clock_timestamp()
    WHERE d.id=${claim.decisionId}::uuid AND d."ownerId"=${ownerId}::uuid
      AND d."undoOperationId"=${claim.operationId}::uuid AND d."undoneAt" IS NULL
      AND NOT EXISTS(SELECT 1 FROM unnest(${claim.memberIds}::uuid[]) member(id)
        LEFT JOIN asset a ON a.id=member.id WHERE a.id IS NULL OR a."ownerId"<>${ownerId}::uuid
          OR a.status<>'active' OR a."deletedAt" IS NOT NULL OR a."duplicateId" IS DISTINCT FROM ${claim.duplicateId}::uuid)
      AND EXISTS(SELECT 1 FROM media_operation o WHERE o.id=${claim.operationId}::uuid
        AND o."ownerId"=${ownerId}::uuid AND o."claimToken"=${claim.claimToken}::uuid
        AND o.status='rendering' AND o."claimExpiresAt">clock_timestamp()
        AND o."cancelRequestedAt" IS NULL AND o."pauseRequestedAt" IS NULL)
    RETURNING d.id`.execute(tx);
  if (rows.length !== 1) throw new ConflictException('duplicate_undo_claim_required');
}
