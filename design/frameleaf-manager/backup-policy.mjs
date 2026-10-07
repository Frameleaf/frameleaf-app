// Prototype decision policy. Discovery and integrity checks are fictional fixtures,
// not Docker or filesystem access. Re-evaluate against the host clock at cutover.
export const MAX_DATABASE_BACKUP_AGE_MS = 24 * 60 * 60 * 1000;

export function databaseBackupPlan(backups, { sourceId, database, now }) {
  const sourceBackups = backups.filter(backup => backup.sourceId === sourceId && backup.database === database);
  const usable = sourceBackups.filter(backup => {
    const age = now - Date.parse(backup.createdAt);
    return backup.status === 'completed' && backup.readable === true && backup.integrity === 'passed'
      && Number.isFinite(age) && age >= 0 && age <= MAX_DATABASE_BACKUP_AGE_MS;
  }).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return {
    skipBackup: usable.length > 0,
    backup: usable[0] ?? null,
    reason: usable.length ? 'recent' : sourceBackups.length ? 'no-usable-recent-backup' : 'missing',
  };
}
