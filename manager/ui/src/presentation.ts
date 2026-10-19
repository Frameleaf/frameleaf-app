export type JournalOperation = {
  kind: string;
  state: string;
  step: string | null;
  completed: string[];
  error: string | null;
  replacesInstallation?: boolean;
};
export const operationNames: Record<string, string> = {
  'move-library': 'Moving your library',
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
  'move-stop-writers': 'Stop uploads and background writers',
  'move-checkpoint': 'Verify a database recovery point',
  'move-fence-stack': 'Stop and fence the stack',
  'move-freeze': 'Record the original media checksums',
  'move-copy': 'Copy and check every file',
  'move-verify': 'Independently verify both locations',
  'move-switch': 'Switch the verified media mapping',
  'move-start': 'Start Frameleaf and check the library',
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
  'move-library': [
    'move-stop-writers',
    'move-checkpoint',
    'move-fence-stack',
    'move-freeze',
    'move-copy',
    'move-verify',
    'move-switch',
    'move-start',
  ],
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
const moveRefusals: Record<string, string> = {
  media_quiescence_unavailable:
    'This server cannot yet confirm that all uploads and jobs have safely stopped. The move is unavailable; nothing was stopped or moved.',
  media_quiescence_timeout:
    'Uploads and background work did not finish in time. Nothing was stopped or moved, and Frameleaf is working normally again. Try again later.',
  media_quiescence_lost:
    'Frameleaf stopped holding uploads and background work before the move began. Nothing was stopped or moved; try again.',
  unsupported_media_mappings:
    'This move supports one writable media folder. External folders and named volumes need a separate move plan.',
  unsupported_media_entry:
    'This library contains links, special files or nested filesystems. Nothing will be switched until these are resolved.',
  media_move_overlap: 'Choose a drive outside the current media, database, Manager and backup folders.',
  media_mount_changed: 'A reviewed storage location changed. Check the mounted drives before continuing.',
  media_source_changed: 'The original files changed after the move was recorded. Both locations are kept for review.',
  media_copy_mismatch: 'The copy does not match the original. Nothing has been switched.',
  media_copy_failed: 'Copying could not finish. Check drive space and permissions. The original is kept.',
  media_move_reverse_required:
    'The new folder may have received writes. Returning to the old folder requires another verified move or a complete restore.',
  media_destination_unverified:
    'The destination folder has no verified ownership receipt. Cancel safely and start a new move; no folder is deleted.',
  media_move_cancelled: 'The move was stopped. Choose Cancel safely to return to the original folder.',
  media_move_cancelled_original_retained: 'The original folder is in use. Any partial copy was kept.',
  media_copy_still_running: 'The copy helper is still running. Stop safely and wait for it to exit before recovery.',
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
  source_changed_review_again:
    'The Immich installation changed after it was reviewed. Review the import again so Manager works from its current settings.',
  port_in_use:
    'Another app on this server is already using that port. Choose a different Frameleaf port. Immich’s own port is fine for an import, because Immich is stopped first.',
  docker_operation_failed:
    'A Docker command did not finish. The Manager container log has the command, exit code and error output. Fix the cause, then resume.',
  docker_unavailable: 'Manager could not run Docker. Check that the Docker socket is mapped into Manager.',
  database_overlaps_existing_container_data:
    'Another container can write inside this database folder. Choose a folder of its own, such as /mnt/user/appdata/frameleaf-databases. The Manager container log names the container.',
  source_version_unreachable:
    'Manager found this Immich server but could not ask it for its version. Check that it is running and healthy; Manager uses its IMMICH_PORT and IMMICH_HOST settings.',
  database_connection_ambiguous:
    'Manager could not tell which container holds this Immich database. Its DB_HOSTNAME must name or address the database container.',
  unsupported_database_connection: 'This Immich database connection is not supported yet: it needs a password.',
  operation_failed:
    'This step stopped with an unexpected error. The Manager container log has the details. Completed steps are kept, so you can resume.',
};
export const readable = (value: string) => {
  const refused = /^server_refused_(\d{3})$/.exec(value);
  if (refused) return `The Frameleaf server refused Manager's request (${refused[1]}). Check the server logs, then resume.`;
  return stepNames[value] ?? moveRefusals[value] ?? refusals[value] ?? value.replaceAll(/[_-]/g, ' ');
};
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
