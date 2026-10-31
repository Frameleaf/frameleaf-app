import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { FileIdentity } from 'src/utils/studio-import-publication.js';

export async function syncAncestors(
  leaf: string,
  anchor: string,
  syncDirectory: (path: string) => Promise<void>,
): Promise<void> {
  const inside = relative(anchor, leaf);
  if (
    !isAbsolute(leaf) ||
    !isAbsolute(anchor) ||
    resolve(leaf) !== leaf ||
    resolve(anchor) !== anchor ||
    inside === '..' ||
    inside.startsWith(`..${sep}`) ||
    isAbsolute(inside)
  ) {
    throw new Error('outside_durable_anchor');
  }
  for (let current = leaf; ; current = dirname(current)) {
    await syncDirectory(current);
    if (current === anchor) return;
    if (dirname(current) === current) throw new Error('durable_anchor_missing');
  }
}

export function assertSameOwnedInode(stage: FileIdentity, target: FileIdentity): void {
  if (stage.dev !== target.dev || stage.ino !== target.ino || stage.size !== target.size) {
    throw new Error('publication_identity_changed');
  }
}
