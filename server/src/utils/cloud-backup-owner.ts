import { basename } from 'node:path';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { OwnerBackupHistoryResponseDto, OwnerBackupPageDto } from 'src/dtos/cloud-backup-owner.dto.js';
import type { CloudBackupManifest, CloudBackupManifestFile } from 'src/utils/cloud-backup.js';
import { compareCodeUnits } from 'src/utils/compare.js';
import { hasHiddenContentFilter } from 'src/utils/hidden-content.js';

export type OwnerBackupState = {
  ownerId?: string;
  allowed?: boolean;
  status?: string;
  deletedAt?: Date | null;
  deletion?: {
    ownerId: string;
    deletedAt: Date;
    visibility: string;
    wasLocked: boolean;
    checksum: Buffer | null;
    checksumAlgorithm: string | null;
    evidenceVersion: number;
    modernPrivacyEvidenceUnavailable: boolean;
  };
};
export const MAX_OWNER_THUMBNAIL_BYTES = 8 * 1024 * 1024;
export const ownerThumbnail = (files: CloudBackupManifestFile[]) =>
  files.find(
    (file) =>
      file.role === 'thumbnail' &&
      /^[a-f\d]{64}$/.test(file.sha256) &&
      Number.isSafeInteger(file.size) &&
      file.size > 0 &&
      file.size <= MAX_OWNER_THUMBNAIL_BYTES,
  );

/** Historical rows have no current classifications: an active filter cannot be safely evaluated. */
export const ownerBackupHistoryPage = (
  auth: AuthDto,
  manifest: CloudBackupManifest,
  states: Map<string, OwnerBackupState>,
  page: OwnerBackupPageDto & { query?: string },
): OwnerBackupHistoryResponseDto => {
  const query = page.query?.toLocaleLowerCase();
  const filtered = Object.entries(manifest.assets)
    .filter(([id, item]) => {
      if (item.owner !== auth.user.id || manifest.version !== 2 || !item.details || !item.originalFileName)
        return false;
      if (item.details.visibility === 'hidden') return false;
      if (item.details.visibility === 'locked' && !auth.session?.hasElevatedPermission) return false;
      const current = states.get(id);
      if (current?.ownerId)
        return (
          current.ownerId === auth.user.id &&
          current.allowed === true &&
          (current.status === 'trashed' || !!current.deletedAt)
        );
      // v2 records don't preserve the modern classification/rule evidence required to evaluate a filter.
      const deletion = current?.deletion;
      const original = item.files.find((file) => file.role === 'original');
      if (
        !deletion ||
        deletion.ownerId !== auth.user.id ||
        deletion.evidenceVersion !== 1 ||
        deletion.checksumAlgorithm !== 'sha256' ||
        !original ||
        !/^[a-f\d]{64}$/.test(original.sha256) ||
        deletion.checksum?.length !== 32 ||
        deletion.checksum?.toString('hex') !== original.sha256
      )
        return false;
      if (deletion.visibility === 'hidden' || !['timeline', 'archive'].includes(deletion.visibility)) return false;
      if (deletion.wasLocked && !auth.session?.hasElevatedPermission) return false;
      return !auth.hideNsfwAssets && !hasHiddenContentFilter(auth.hiddenContent);
    })
    .filter(
      ([, item]) =>
        !query || basename(item.originalFileName!.replaceAll('\\', '/')).toLocaleLowerCase().includes(query),
    )
    .sort(([a], [b]) => compareCodeUnits(a, b));
  const items = filtered.slice(page.offset, page.offset + page.limit).map(([assetId, item]) => {
    const state = states.get(assetId);
    const physical = (state?.ownerId ? undefined : state?.deletion?.deletedAt.toISOString()) ?? null;
    return {
      assetId,
      name: basename(item.originalFileName!.replaceAll('\\', '/')),
      backupDate: manifest.createdAt,
      state: state?.ownerId ? ('trashed' as const) : ('deleted' as const),
      trashDate: state?.deletedAt?.toISOString() ?? null,
      deletionDate: { state: physical ? ('available' as const) : ('unavailable' as const), at: physical },
      thumbnailAvailable: !!ownerThumbnail(item.files),
    };
  });
  return {
    items,
    total: filtered.length,
    nextOffset: page.offset + page.limit < filtered.length ? page.offset + page.limit : null,
  };
};
