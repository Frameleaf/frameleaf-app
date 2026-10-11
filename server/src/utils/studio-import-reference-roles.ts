import type { PublicationRow } from './studio-import-publication.js';

/** A published target has handed ownership to its ready import; recovery still owns its stage. */
export function journalOwnsPath(row: PublicationRow, path: string): boolean {
  if (!row.file || row.state === 'registered') return false;
  return path === row.file.stagedPath || (row.state !== 'published' && path === row.file.targetPath);
}

export type ReleasingPublicationRole = { publicationId: string; role: 'stage' | 'target' };
