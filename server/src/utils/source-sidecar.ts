import { StorageCore } from 'src/cores/storage.core.js';
import { StorageFolder } from 'src/enum.js';
import { parseSourceOriginalPath } from 'src/utils/source-original.js';

export function sourceSidecarPath(asset: { id: string; ownerId: string; originalPath: string }, existing?: string) {
  if (!parseSourceOriginalPath(asset.originalPath)) return;
  const managed = StorageCore.getNestedPath(StorageFolder.Upload, asset.ownerId, `${asset.id}.xmp`);
  // Keep unknown bindings for recovery; a source URI never grants host filesystem access.
  if (existing !== undefined && existing !== managed) throw new Error('source_sidecar_unavailable');
  return managed;
}
