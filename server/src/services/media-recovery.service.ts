import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, link, mkdir, open, unlink } from 'node:fs/promises';
import { basename, dirname, extname, join, normalize } from 'node:path';
import { StorageCore } from 'src/cores/storage.core.js';
import { AssetStatus, AssetType, StorageFolder } from 'src/enum.js';
import {
  MediaRecoveryRepository,
  RecoveryAuthority,
  RecoveryResult,
  RecoveryTarget,
} from 'src/repositories/media-recovery.repository.js';
import { MediaIntegrityService } from 'src/services/media-integrity.service.js';

export type MediaRecoveryInput = RecoveryAuthority & {
  stagedPath: string;
  originalFileName: string;
  type: AssetType;
  sourceCreatedAt?: Date;
  sourceHidden?: boolean;
};

@Injectable()
export class MediaRecoveryService {
  constructor(
    private repository: MediaRecoveryRepository,
    private integrity: MediaIntegrityService,
  ) {}

  async verifyMapped(input: RecoveryAuthority): Promise<RecoveryResult | undefined> {
    try {
      const resource = await this.repository.getResource(input);
      if (!resource) {
        return { outcome: 'retry', reason: 'lease_unavailable' };
      }
      if (!resource.assetId || !resource.sha1 || !resource.sha256) {
        return;
      }
      const candidates = await this.repository.findCandidates(
        input.ownerId,
        { sha1: resource.sha1, sha256: resource.sha256 },
        resource.assetId,
      );
      const candidate = candidates.find(({ id }) => id === resource.assetId);
      if (!candidate?.matchesContent || candidate.identityConflict) {
        return { outcome: 'needs-review', reason: 'mapped_asset_identity_changed' };
      }
      if (candidate.hidden && !input.includeHidden) {
        return { outcome: 'needs-review', reason: 'hidden_match_requires_consent' };
      }
      if (candidate.deletedAt || candidate.status !== AssetStatus.Active) {
        return { outcome: 'preserve-trashed', assetId: candidate.id, reason: 'destination_not_active' };
      }
      // An external original is never reused (owner decision, FL-69): the transfer goes on to import the
      // item as a managed copy, so the server keeps it if the external drive goes away.
      if (candidate.isOffline || candidate.damaged || candidate.isExternal) {
        return;
      }
      const validate = () =>
        this.integrity.validate({
          path: candidate.originalPath,
          originalFileName: candidate.originalFileName,
          type: candidate.type,
          expected: { sha1: resource.sha1!, sha256: resource.sha256!, sizeInBytes: resource.expectedSize ?? undefined },
          deep: true,
        });
      const verified = await validate();
      if (['missing', 'unreadable', 'corrupt'].includes(verified.status)) {
        return;
      }
      if (verified.status !== 'healthy') {
        return { outcome: verified.status === 'unsupported' ? 'needs-review' : 'retry', reason: verified.reason };
      }
      return await this.repository.commitVerifiedReuse({ ...input, candidate, verified, verifyFinal: validate });
    } catch {
      return { outcome: 'retry', reason: 'reuse_not_committed' };
    }
  }

  async reconcile(input: MediaRecoveryInput): Promise<RecoveryResult> {
    if (input.sourceHidden && !input.includeHidden) {
      return { outcome: 'needs-review', reason: 'source_hidden_requires_consent' };
    }
    try {
      const resource = await this.repository.getResource(input);
      if (!resource) {
        return { outcome: 'retry', reason: 'lease_unavailable' };
      }
      if (!resource.stagingPath || normalize(resource.stagingPath) !== normalize(input.stagedPath)) {
        return { outcome: 'failed', reason: 'staging_path_mismatch' };
      }
      const staged = await this.integrity.validate({
        path: input.stagedPath,
        originalFileName: input.originalFileName,
        type: input.type,
        expected: { sizeInBytes: resource.expectedSize ?? undefined },
        deep: true,
      });
      if (staged.status !== 'healthy') {
        return {
          outcome: staged.status === 'corrupt' ? 'failed' : staged.status === 'unsupported' ? 'needs-review' : 'retry',
          reason: staged.reason,
        };
      }
      if (
        (resource.sha256 && !resource.sha256.equals(staged.sha256)) ||
        (resource.sha1 && !resource.sha1.equals(staged.sha1))
      ) {
        return { outcome: 'failed', reason: 'source_identity_changed' };
      }
      const candidates = await this.repository.findCandidates(input.ownerId, staged, resource.assetId);
      if (candidates.some(({ hidden }) => hidden) && !input.includeHidden) {
        return { outcome: 'needs-review', reason: 'hidden_match_requires_consent' };
      }
      if (
        resource.assetId &&
        candidates.every(({ id, matchesContent }) => !(id === resource.assetId && matchesContent))
      ) {
        return { outcome: 'needs-review', reason: 'mapped_asset_identity_changed' };
      }
      if (candidates.some(({ identityConflict }) => identityConflict)) {
        return { outcome: 'needs-review', reason: 'saved_checksum_conflict' };
      }
      // FL-69 (owner decision): recovery always stores a managed copy. An external original with the same
      // content is evidence only: it is never reused, repaired or converted, and the item is imported as a
      // new managed asset beside it.
      const exact = candidates.filter(({ matchesContent, isExternal }) => matchesContent && !isExternal);
      const matchedExternal = candidates.find(({ matchesContent, isExternal }) => matchesContent && isExternal);
      const mapped = exact.find(({ id }) => id === resource.assetId);
      if (exact.length > 1 && !mapped) {
        return { outcome: 'needs-review', reason: 'multiple_content_matches' };
      }
      const candidate = mapped ?? exact[0];
      if (candidate && (candidate.deletedAt || candidate.status !== AssetStatus.Active)) {
        return { outcome: 'preserve-trashed', assetId: candidate.id, reason: 'destination_not_active' };
      }
      if (candidate && candidate.type !== input.type) {
        return { outcome: 'needs-review', reason: 'media_type_mismatch' };
      }
      if (candidate && resource.expectedTarget && !resource.expectedTarget.updateId) {
        // Keep both recovery copies accounted for until the concurrent import is reconciled.
        return { outcome: 'needs-review', reason: 'reserved_import_content_match' };
      }
      let outcome: RecoveryTarget['outcome'] = 'imported';
      if (candidate) {
        const current = await this.integrity.validate({
          path: candidate.originalPath,
          originalFileName: candidate.originalFileName,
          type: candidate.type,
          expected: staged,
          deep: true,
        });
        if (['timeout', 'transient', 'unsupported'].includes(current.status)) {
          return { outcome: current.status === 'unsupported' ? 'needs-review' : 'retry', reason: current.reason };
        }
        outcome =
          current.status === 'healthy' && !candidate.isOffline
            ? 'reused'
            : current.status === 'corrupt'
              ? 'repaired-corrupt'
              : 'repaired-missing';
      }
      const extension = extname(input.originalFileName).toLowerCase();
      const name = `${randomUUID()}${/^\.[a-z0-9]{1,12}$/.test(extension) ? extension : ''}`;
      // Hidden promotion paths cannot be discovered by the managed untracked-file crawler before commit.
      const proposedPath =
        outcome === 'reused'
          ? candidate!.originalPath
          : join(
              dirname(StorageCore.getNestedPath(StorageFolder.Upload, input.ownerId, name)),
              '.icloud-recovery',
              name,
            );
      const reservation = await this.repository.reserve({
        ...input,
        verified: staged,
        candidate,
        outcome,
        proposedPath,
        ...(!candidate && matchedExternal ? { matchedExternalAssetId: matchedExternal.id } : {}),
      });
      if (!reservation) {
        return { outcome: 'retry', reason: 'reservation_changed' };
      }
      if (reservation.target.outcome !== 'reused') {
        await mkdir(dirname(reservation.promotedPath), { recursive: true, mode: 0o700 });
        const temporary = `${reservation.promotedPath}.${randomUUID()}.partial`;
        try {
          await copyFile(input.stagedPath, temporary, constants.COPYFILE_EXCL);
          const file = await open(temporary, 'r');
          try {
            await file.sync();
          } finally {
            await file.close();
          }
          // link() publishes complete bytes exclusively; a retry verifies an existing final rather than replacing it.
          try {
            await link(temporary, reservation.promotedPath);
          } catch (error) {
            if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) {
              throw error;
            }
          }
          const directory = await open(dirname(reservation.promotedPath), 'r');
          try {
            await directory.sync();
          } finally {
            await directory.close();
          }
        } finally {
          await unlink(temporary).catch(() => {});
        }
      }
      return await this.repository.commit({
        ...input,
        originalFileName: basename(input.originalFileName),
        reservation,
        verified: staged,
        verifyFinal: () =>
          this.integrity.validate({
            path: reservation.promotedPath,
            originalFileName: input.originalFileName,
            type: input.type,
            expected: staged,
            deep: true,
          }),
      });
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      return { outcome: 'retry', reason: code === '23505' ? 'concurrent_content_match' : 'recovery_not_committed' };
    }
  }
}
