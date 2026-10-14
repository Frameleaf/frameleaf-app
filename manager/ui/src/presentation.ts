export type JournalOperation = {
  kind: string;
  state: string;
  step: string | null;
  completed: string[];
  error: string | null;
  replacesInstallation?: boolean;
};
export const operationNames: Record<string, string> = {
  install: 'Setting up Frameleaf',
  import: 'Bringing your library to Frameleaf',
  restore: 'Restoring your library',
  backup: 'Protecting your database',
  update: 'Updating Frameleaf',
  start: 'Starting services',
  stop: 'Stopping services',
  restart: 'Restarting services',
};
export const stepNames: Record<string, string> = {
  preflight: 'Recheck the reviewed configuration',
  'download-images': 'Download the verified image set',
  configure: 'Prepare separate database storage',
  'review-source': 'Revalidate the source installation',
  'fence-source': 'Stop Immich and disable automatic restart',
  'start-database': 'Start the new PostgreSQL database',
  'capture-fenced-settings': 'Preserve the stopped source settings',
  'copy-current-database': 'Copy the current stopped database',
  'database-backup': 'Create and verify a database backup',
  'configure-offline-import': 'Prepare the offline importer',
  'import-canonical-database': 'Import into Frameleaf',
  'verify-import': 'Verify the imported library',
  'import-settings': 'Apply compatible settings',
  'start-frameleaf': 'Start Frameleaf',
  'prepare-library': 'Begin library preparation',
  'stop-application': 'Pause application writes',
  'database-checkpoint': 'Create a database recovery point',
  'apply-release': 'Apply and verify the update',
  'restore-new-database': 'Restore into the new empty database',
  'reconstruct-execution-state': 'Reconcile restored background work',
  'stop-previous-installation': 'Stop and retain the previous installation',
  'archive-previous-installation': 'Preserve the previous recovery configuration',
};
const plans: Record<string, string[]> = {
  install: ['preflight', 'download-images', 'configure', 'start-database', 'start-frameleaf', 'prepare-library'],
  import: [
    'preflight',
    'download-images',
    'configure',
    'review-source',
    'fence-source',
    'start-database',
    'capture-fenced-settings',
    'copy-current-database',
    'database-backup',
    'configure-offline-import',
    'import-canonical-database',
    'verify-import',
    'import-settings',
    'start-frameleaf',
    'prepare-library',
  ],
  update: ['download-images', 'stop-application', 'database-checkpoint', 'apply-release'],
  restore: [
    'download-images',
    'stop-previous-installation',
    'archive-previous-installation',
    'configure',
    'start-database',
    'restore-new-database',
    'reconstruct-execution-state',
    'start-frameleaf',
  ],
  backup: ['database-backup'],
  start: ['start'],
  stop: ['stop'],
  restart: ['restart'],
};
const refusals: Record<string, string> = {
  release_service_unavailable: 'Manager could not reach GitHub to check Frameleaf releases. Check this server can reach github.com, then try again.',
  release_not_eligible: 'This Frameleaf release is not offered to this server. Choose another release.',
  release_bundle_missing: 'This Frameleaf release is missing installation files Manager needs. Choose a newer release.',
  release_download_failed: 'Manager could not download this release. Check the network connection, then try again.',
  release_asset_size_mismatch: 'A release file did not download completely. Try again.',
  release_verification_timeout: 'Checking the release took too long. Try again.',
  release_verification_failed: 'This release did not pass signature and checksum verification, so Manager will not use it.',
  release_architecture_unavailable: 'This release has no images for this server’s processor type.',
};
// ponytail: only release refusals have sentences so far; other codes still show as words.
export const readable = (value: string) => stepNames[value] ?? refusals[value] ?? value.replaceAll(/[_-]/g, ' ');
export function operationProgress(operation: JournalOperation, backupSkipped = false) {
  const ids = [
    ...new Set([...(plans[operation.kind] ?? []), ...operation.completed, ...(operation.step ? [operation.step] : [])]),
  ].filter(
    (id) =>
      (id !== 'database-backup' || !backupSkipped) &&
      (!['stop-previous-installation', 'archive-previous-installation'].includes(id) || operation.replacesInstallation),
  );
  const successful = operation.state === 'complete' && !operation.error;
  const steps = ids.map((id) => ({
    id,
    label: readable(id),
    state: operation.completed.includes(id)
      ? 'complete'
      : id === operation.step
        ? operation.state
        : successful
          ? 'complete'
          : 'waiting',
  }));
  return {
    successful,
    steps,
    percent: successful
      ? 100
      : Math.min(
          99,
          Math.round((operation.completed.filter((id) => ids.includes(id)).length / Math.max(ids.length, 1)) * 100),
        ),
  };
}
export function canCancel(operation: JournalOperation, installation: { mayHaveWrittenMedia: boolean } | null) {
  if (!['failed', 'interrupted'].includes(operation.state)) return false;
  return (
    operation.kind === 'backup' ||
    (operation.kind === 'update' &&
      operation.step !== 'apply-release' &&
      !operation.completed.includes('apply-release')) ||
    !installation?.mayHaveWrittenMedia
  );
}
export function serviceState(service: { running: boolean; health: string }) {
  return !service.running
    ? 'Stopped'
    : service.health === 'healthy'
      ? 'Ready'
      : service.health === 'unhealthy'
        ? 'Needs attention'
        : service.health === 'starting'
          ? 'Starting'
          : 'Running';
}
export function formatBytes(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return 'Unavailable';
  const unit = Math.min(4, Math.max(0, Math.floor(Math.log(Math.max(value, 1)) / Math.log(1024))));
  return `${Number((value / 1024 ** unit).toFixed(1)).toLocaleString()} ${['B', 'KB', 'MB', 'GB', 'TB'][unit]}`;
}
