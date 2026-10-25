/* eslint-disable no-restricted-imports -- Shared with the standalone offline recovery command. */
import { posix, win32 } from 'node:path';
import { BUDDY_BLOCK_BYTES, BUDDY_ID, BUDDY_UUID } from './buddy-backup-crypto.ts';
import { parseSourceOriginalPath } from './source-original.ts';
import type { SourceEpoch } from '../repositories/asset-local-effect.repository.ts';
import type { BuddyManifest } from '../services/buddy-backup-capture.service.ts';

export type BuddyReferenceOriginal = {
  version: 1;
  sourcePath: string;
  sourceEpoch: SourceEpoch & { reference: NonNullable<SourceEpoch['reference']> };
};

/** The managed upload layout is portable archive metadata, not a path on the source computer. */
export function referenceOriginalPath(root: string, ownerId: string, assetId: string, name: string) {
  const paths = /^[a-z]:[\\/]|^\\\\|^\/\//iu.test(root) ? win32 : posix;
  const canonical = paths === win32 ? root.replaceAll('/', '\\') : root;
  if (
    !paths.isAbsolute(canonical) ||
    (paths.normalize(canonical) !== canonical && paths.normalize(canonical) !== canonical + paths.sep) ||
    root.includes('\0') ||
    !BUDDY_UUID.test(ownerId) ||
    !BUDDY_UUID.test(assetId)
  )
    throw new Error('Buddy reference original target is invalid');
  const extension = posix.extname(name).toLowerCase();
  const suffix = /^\.[a-z0-9]{1,16}$/u.test(extension) ? extension : '.original';
  return paths.join(root, 'upload', ownerId, assetId.slice(0, 2), assetId.slice(2, 4), `${assetId}${suffix}`);
}

/** A reference archive must contain independently recoverable originals, never a live cache address. */
export function readBuddyReferenceOriginals(manifest: BuddyManifest): Record<string, BuddyReferenceOriginal> {
  try {
    const bindings = manifest.referenceOriginals ?? {};
    if (manifest.referenceOriginals === null || typeof bindings !== 'object' || Array.isArray(bindings))
      throw new Error('Invalid original binding');
    if (Object.keys(bindings).length > 0 && manifest.version !== 2) throw new Error('Invalid original binding');
    const assets = manifest.library?.assets ?? {};
    for (const [id, asset] of Object.entries(assets)) {
      if (
        asset.files?.some((file) => file.role === 'original' && /^frameleaf-source:/iu.test(file.path)) &&
        !Object.hasOwn(bindings, id)
      )
        throw new Error('Invalid original binding');
    }
    for (const [id, binding] of Object.entries(bindings)) {
      const asset = assets[id];
      const epoch = binding?.sourceEpoch;
      const reference = epoch?.reference;
      const originals = asset?.files?.filter((file) => file.role === 'original');
      if (
        binding?.version !== 1 ||
        !parseSourceOriginalPath(binding.sourcePath) ||
        !BUDDY_UUID.test(id) ||
        !asset ||
        !epoch ||
        epoch.assetId !== id ||
        epoch.ownerId !== asset.owner ||
        typeof epoch.epoch !== 'string' ||
        !/^(?:0|[1-9][0-9]{0,18})$/u.test(epoch.epoch) ||
        BigInt(epoch.epoch) > 9_223_372_036_854_775_807n ||
        !reference ||
        !BUDDY_UUID.test(reference.resourceId) ||
        !BUDDY_ID.test(reference.version) ||
        !BUDDY_ID.test(reference.sha256) ||
        !originals ||
        originals.length !== 1 ||
        typeof asset.originalFileName !== 'string'
      )
        throw new Error('Invalid original binding');
      const file = originals[0];
      const content = manifest.contents?.[file.sha256];
      if (
        file.path !== referenceOriginalPath(manifest.storageRoot, epoch.ownerId, id, asset.originalFileName) ||
        file.sha256 !== reference.sha256 ||
        !Number.isSafeInteger(file.size) ||
        // eslint-disable-next-line unicorn/no-impossible-length-comparison -- Untrusted manifest JSON may contain a negative byte count.
        file.size < 0 ||
        !content ||
        content.bytes !== file.size ||
        !Number.isSafeInteger(content.keyVersion) ||
        content.keyVersion < 1 ||
        !Array.isArray(content.blocks) ||
        content.blocks.length !== Math.ceil(file.size / BUDDY_BLOCK_BYTES) ||
        content.blocks.some((id) => typeof id !== 'string' || !BUDDY_ID.test(id))
      )
        throw new Error('Invalid original binding');
    }
    return bindings;
  } catch {
    throw new Error('Buddy reference original content or provenance is invalid');
  }
}
