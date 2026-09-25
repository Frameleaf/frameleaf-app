import { createHash } from 'node:crypto';
import type { AssetEditActionItem } from 'src/dtos/editing.dto.js';

/**
 * Frameleaf FL-38: what a face box drawn in a client depends on. A face tagger draws on the
 * asset's upright, edited preview, so a box is only meaningful for the same original file
 * (`checksum`), the same stored geometry (`width`/`height`, EXIF size and orientation) and
 * the same crop/rotate/mirror edits. Any change to those makes a box drawn earlier land in
 * the wrong place, so the server refuses it (409) when the client's source revision is stale.
 */
export type FaceSource = {
  checksum: Buffer | string;
  width: number | null;
  height: number | null;
  edits?: Pick<AssetEditActionItem, 'action' | 'parameters'>[] | null;
  exifInfo?: {
    exifImageWidth: number | null;
    exifImageHeight: number | null;
    orientation: string | null;
  } | null;
};

/**
 * An opaque, deterministic revision of an asset's face-drawing source. Metadata that does not
 * move pixels (favorite, description, album, …) never changes it.
 */
export const getFaceSourceRevision = (asset: FaceSource): string => {
  const checksum = Buffer.isBuffer(asset.checksum) ? asset.checksum.toString('hex') : asset.checksum;
  const payload = JSON.stringify([
    checksum,
    asset.width ?? null,
    asset.height ?? null,
    asset.exifInfo?.exifImageWidth ?? null,
    asset.exifInfo?.exifImageHeight ?? null,
    asset.exifInfo?.orientation ?? null,
    (asset.edits ?? []).map(({ action, parameters }) => [action, parameters]),
  ]);
  return createHash('sha256').update(payload).digest('base64url');
};
