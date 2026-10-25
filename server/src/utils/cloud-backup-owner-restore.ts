import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { CloudBackupIndexRepository } from 'src/repositories/cloud-backup-index.repository.js';
import type { CloudBackupRestoreSnapshot } from 'src/services/cloud-backup-restore.js';
import type { BuddyReferenceAdoption } from 'src/utils/buddy-reference-adoption.js';
import type { CloudBackupAssetRecord, CloudBackupManifest } from 'src/utils/cloud-backup.js';
import { AssetStatus, ChecksumAlgorithm } from 'src/enum.js';
import { ownerBackupHistoryPage } from 'src/utils/cloud-backup-owner.js';
import { hasHiddenContentFilter } from 'src/utils/hidden-content.js';
import { canonicalJson } from 'src/utils/object.js';

type RestoreSource = Pick<
  NonNullable<CloudBackupRestoreSnapshot['owner']>['current'][string],
  'sourceEpoch' | 'sourceReference'
>;
export const sameOwnerRestoreSource = (before: RestoreSource, current: RestoreSource) =>
  (before.sourceEpoch ?? '0') === (current.sourceEpoch ?? '0') &&
  canonicalJson(before.sourceReference ?? null) === canonicalJson(current.sourceReference ?? null);

export const readBackupAssetRecord = (asset: CloudBackupManifest['assets'][string]): CloudBackupAssetRecord | null =>
  asset.type && asset.originalFileName && asset.fileCreatedAt && asset.fileModifiedAt && asset.localDateTime
    ? {
        type: asset.type,
        originalFileName: asset.originalFileName,
        fileCreatedAt: asset.fileCreatedAt,
        fileModifiedAt: asset.fileModifiedAt,
        localDateTime: asset.localDateTime,
        duration: asset.duration ?? null,
      }
    : null;

export const ownerRestoreHash = (
  asset: CloudBackupManifest['assets'][string],
  manifest: CloudBackupManifest,
): string => {
  // Bind selected related metadata without hashing every unrelated backup item at each write.
  return createHash('sha256')
    .update(
      canonicalJson({
        asset,
        albums: (asset.details?.albums ?? []).map(({ id }) => manifest.albums[id] ?? null),
        people: (asset.details?.faces ?? []).map(({ personId }) =>
          personId ? (manifest.people[personId] ?? null) : null,
        ),
      }),
    )
    .digest('hex');
};

export const checkOwnerRestoreItems = async (
  auth: AuthDto,
  manifest: CloudBackupManifest,
  snapshot: CloudBackupRestoreSnapshot,
  resumed: boolean,
  index: CloudBackupIndexRepository,
  ids = snapshot.assetIds ?? [],
  allowCurrent = false,
  motionParent?: string,
  referenceDestination?: BuddyReferenceAdoption,
  referenceParentDestination?: BuddyReferenceAdoption,
) => {
  const owner = snapshot.owner;
  if (
    !owner ||
    auth.user.id !== owner.ownerId ||
    !auth.session?.hasElevatedPermission ||
    (manifest.version !== 2 && manifest.version !== 3)
  )
    throw new ForbiddenException('Owner restore unavailable');
  if (motionParent) {
    if (ids.includes(motionParent) || !snapshot.assetIds?.includes(motionParent))
      throw new NotFoundException('Backup item unavailable');
    await checkOwnerRestoreItems(
      auth,
      manifest,
      snapshot,
      resumed,
      index,
      [motionParent],
      allowCurrent,
      undefined,
      referenceParentDestination,
    );
  }
  const states = await index.getOwnerHistoryState(auth, ids);
  const library = await index.getAssetDetails(ids);
  for (const id of ids) {
    const asset = manifest.assets[id];
    if (
      !asset ||
      asset.owner !== auth.user.id ||
      !readBackupAssetRecord(asset) ||
      !asset.details ||
      owner.assetHashes[id] !== ownerRestoreHash(asset, manifest)
    )
      throw new NotFoundException('Backup item unavailable');
    const original = asset.files.find((file) => file.role === 'original');
    if (
      !original ||
      !/^[a-f\d]{64}$/.test(original.sha256) ||
      !Number.isSafeInteger(original.size) ||
      original.size === 0
    )
      throw new NotFoundException('Backup item unavailable');
    const state = states.get(id);
    const current = library.get(id);
    const identities = await index.getOwnerRestoreIdentities([id]);
    const identity = identities[id];
    const before = owner.current[id];
    if (before && identity && !sameOwnerRestoreSource(before, identity))
      throw new NotFoundException('Owner restore source changed');
    // Only the separately guarded independent-original transaction can admit a reference destination.
    if (
      identity?.isExternal &&
      (!referenceDestination ||
        referenceDestination.assetId !== id ||
        referenceDestination.ownerId !== auth.user.id ||
        referenceDestination.type !== asset.type ||
        current?.record.type !== referenceDestination.type ||
        referenceDestination.file.sha256 !== original.sha256 ||
        referenceDestination.file.size !== original.size ||
        referenceDestination.source.sourcePath !== identity.originalPath ||
        identity.checksumAlgorithm !== ChecksumAlgorithm.sha1Path ||
        identity.checksum !== createHash('sha1').update(identity.originalPath).digest('hex') ||
        !sameOwnerRestoreSource(identity, {
          sourceEpoch: referenceDestination.source.sourceEpoch.epoch,
          sourceReference: referenceDestination.source.sourceEpoch.reference,
        }))
    )
      throw new NotFoundException('Owner restore external destination unavailable');
    if (
      identity &&
      (identity.ownerId !== owner.ownerId ||
        (before
          ? identity.originalPath !== before.originalPath ||
            (identity.checksum !== before.checksum && identity.checksum !== original.sha256)
          : !resumed || identity.originalPath !== original.path || identity.checksum !== original.sha256))
    )
      throw new NotFoundException('Backup item unavailable');
    if (!identity && before) throw new NotFoundException('Backup item unavailable');
    const restored =
      resumed &&
      state?.ownerId === auth.user.id &&
      state.allowed &&
      state.status === AssetStatus.Active &&
      current?.record &&
      identity?.checksumAlgorithm === 'sha256' &&
      identity.checksum === original.sha256;
    const deletion = state?.deletion;
    const motionAllowed =
      motionParent &&
      manifest.assets[motionParent]?.owner === auth.user.id &&
      ((state?.ownerId === auth.user.id &&
        state.allowed &&
        [AssetStatus.Active, AssetStatus.Trashed].includes(state.status as AssetStatus)) ||
        (!state?.ownerId &&
          deletion?.ownerId === auth.user.id &&
          deletion.evidenceVersion === 1 &&
          deletion.checksumAlgorithm === 'sha256' &&
          deletion.checksum?.toString('hex') === original.sha256 &&
          (!deletion.wasLocked || auth.session?.hasElevatedPermission) &&
          !auth.hideNsfwAssets &&
          !hasHiddenContentFilter(auth.hiddenContent)));
    if (
      !restored &&
      !motionAllowed &&
      !(
        allowCurrent &&
        state?.ownerId === auth.user.id &&
        state.allowed &&
        asset.details.visibility !== 'hidden' &&
        state.status === AssetStatus.Active
      ) &&
      ownerBackupHistoryPage(auth, { ...manifest, assets: { [id]: asset } }, states, { offset: 0, limit: 1 }).total !==
        1
    )
      throw new NotFoundException('Backup item unavailable');
  }
};
