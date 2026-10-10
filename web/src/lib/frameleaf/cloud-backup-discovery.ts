/**
 * "We found a backup" (FL-176): the Cloud backup a Frameleaf account already holds from another
 * server, offered for restore during first-run setup.
 *
 * FL-145 residue: Frameleaf Cloud has no backup-discovery API yet, so this typed client always
 * reports no backup and setup never renders the offer. Wire it to the Cloud's discovery endpoint
 * (through the server's cloud link) once it exists; the setup screen already renders the result.
 */
export type FoundCloudBackup = {
  /** The server the backup came from. */
  server: string;
  /** When the last backup finished (ISO date-time). */
  date: string;
  items: number;
  bytes: number;
  /** The paired database backup, when there is one. */
  database: { date: string; bytes: number } | null;
};

export const findCloudBackup = (): Promise<FoundCloudBackup | null> => Promise.resolve(null);
