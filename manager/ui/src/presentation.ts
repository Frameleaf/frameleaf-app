import { isNewerRelease } from '../../src/release-order.js';

export type JournalOperation = {
  kind: string;
  state: string;
  step: string | null;
  completed: string[];
  error: string | null;
  detail?: string | null;
  replacesInstallation?: boolean;
  /** An update that moves the database to a new PostgreSQL image (FL-1265). */
  databaseMove?: boolean;
  commonImport?: { requiresBootstrap: boolean };
  /** Set by Manager on imports from another photo app. */
  photoApp?: { kind: string; name: string };
};
export const operationNames: Record<string, string> = {
  'move-library': 'Moving your library',
  'move-database': 'Moving your database',
  'move-thumbnails': 'Moving thumbnails',
  'thumbnails-home': 'Putting thumbnails back with your photos',
  install: 'Setting up Frameleaf',
  import: 'Bringing your library to Frameleaf',
  restore: 'Restoring your library',
  backup: 'Protecting your database',
  update: 'Updating Frameleaf',
  start: 'Starting services',
  stop: 'Stopping services',
  restart: 'Restarting services',
  reconfigure: 'Applying container settings',
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
  'fence-source': 'Stop the original app and disable automatic restart',
  'start-database': 'Start the new PostgreSQL database',
  'capture-fenced-settings': 'Preserve the stopped source settings',
  'copy-current-database': 'Copy the current stopped database',
  'database-backup': 'Create and verify a database backup',
  'stage-bootstrap-admin': 'Secure the destination administrator details',
  'capture-common-source': 'Stop the app and read its library',
  'preflight-common-import': 'Verify the reviewed import before transfer',
  'cancel-common-import': 'Verify rollback before restarting the source',
  'configure-offline-import': 'Prepare the offline importer',
  'import-canonical-database': 'Import into Frameleaf',
  'verify-import': 'Verify the imported library',
  'import-settings': 'Apply compatible settings',
  'retire-source-services': "Stop the original database and supporting services",
  'start-frameleaf': 'Start Frameleaf',
  'prepare-library': 'Begin library preparation',
  'stop-application': 'Pause application writes',
  'database-checkpoint': 'Create a database recovery point',
  'database-move': 'Copy the database into a new folder and check it',
  'return-original-database': 'Switch back to the original database folder',
  'start-original-database': 'Start Frameleaf on the original database folder',
  'apply-release': 'Apply and verify the update',
  'rollback-stop-release': 'Stop the release that did not start',
  'rollback-restore-database': 'Restore the database from before the update',
  'rollback-previous-database': 'Switch back to the database folder from before the update',
  'rollback-start-previous': 'Start the previous release',
  'restore-new-database': 'Restore into the new empty database',
  'reconstruct-execution-state': 'Reconcile restored background work',
  'stop-previous-installation': 'Stop and retain the previous installation',
  'archive-previous-installation': 'Preserve the previous recovery configuration',
  'apply-container-settings': 'Write the container settings into the stack',
  'restore-container-settings': 'Restore the previous container settings',
  start: 'Start Frameleaf',
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
  'common-import': [
    'preflight', 'stage-bootstrap-admin', 'download-images', 'configure', 'fence-source', 'start-database',
    'preflight-common-import', 'import-canonical-database', 'start-frameleaf', 'prepare-library',
  ],
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
    'retire-source-services',
    'start-frameleaf',
    'prepare-library',
  ],
  update: ['download-images', 'stop-application', 'database-checkpoint', 'database-move', 'apply-release'],
  'move-database': ['stop-application', 'database-checkpoint', 'database-move', 'start'],
  // FL-1323: the steps the Storage page's review lists (frameleaf-prototype MOVES.thumbs and MOVES.rebuild).
  'move-thumbnails': ['move-stop-writers', 'move-copy', 'move-verify', 'move-switch', 'move-start'],
  'thumbnails-home': ['thumbs-home-switch', 'start', 'thumbs-queue'],
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
  reconfigure: ['apply-container-settings', 'start'],
};
/**
 * FL-1323: a thumbnail move runs Library Move's journal; its steps read as the Storage page's review lists them. Its
 * settings, fence and record steps belong to the step shown in their place.
 */
const kindSteps: Record<string, { labels: Record<string, string>; within?: Record<string, string> }> = {
  'move-thumbnails': {
    labels: {
      'move-stop-writers': 'Pause uploads and background work',
      'move-copy': 'Copy thumbnails',
      'move-verify': 'Check every file',
      'move-switch': 'Switch to the new folder',
      'move-start': 'Start Frameleaf',
    },
    within: { 'move-checkpoint': 'move-stop-writers', 'move-fence-stack': 'move-stop-writers', 'move-freeze': 'move-copy' },
  },
  'thumbnails-home': {
    labels: { 'thumbs-home-switch': 'Switch to your photos folder', start: 'Start Frameleaf', 'thumbs-queue': 'Queue new thumbnails' },
  },
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
  invalid_storage_path: 'That folder path can’t be used. Use a full path such as /mnt/user/photos, with no comma in it.',
  storage_volume_missing: 'That drive or share isn’t on this server right now. Check that it’s connected, then choose the folder again.',
  // FL-1320: named before Docker refuses the whole stack; the detail names the folder.
  thumbnail_folder_missing: 'The thumbnails drive isn’t connected.',
  media_folder_missing: 'The photos drive isn’t connected.',
  mounted_folder_missing: 'A folder Frameleaf uses isn’t there.',
  unsupported_thumbnail_mount: 'Thumbnails can only be kept in one writable folder of their own, outside the photos folder.',
  // FL-1323: putting thumbnails back with the photos after their drive went missing.
  thumbnail_folder_present: 'The thumbnail drive is connected again. Check again to use it.',
  thumbnail_folder_not_visible: 'Manager can’t see the thumbnail folder from here, so it can’t tell whether its drive is connected. Your thumbnails were left where they are.',
  thumbnails_already_with_photos: 'Thumbnails are already with your photos and videos.',
  thumbnails_home_resume_required: 'Thumbnails are going back with your photos. Choose Resume to finish; the old drive isn’t used again.',
  chosen_folders_overlap: 'Photos and videos, the database, backups and Manager’s own settings each need their own separate folder.',
  external_folder_holds_frameleaf_data: 'This folder holds Frameleaf’s own data, or sits inside it. Choose a folder of photos instead.',
  drive_detection_unavailable: 'Drive suggestions are only available when Manager runs in Docker.',
  folder_browsing_unavailable: 'This server’s folders are set in its container settings, so they can’t be browsed here.',
  storage_inaccessible: 'Manager can’t find this media folder inside its container. In your server’s settings for Frameleaf, map a folder to it, then try again.',
  storage_outside_approved_roots: 'This folder isn’t one of Manager’s media folders. Choose one from the list, or add it to Media roots in your server’s settings for Frameleaf.',
  storage_permissions: 'Manager can’t read and write this media folder. Check the folder’s permissions on your server, then try again.',
  invalid_database_path: 'That database folder path can’t be used. Use a full path with no comma or colon in it.',
  database_requires_host_bind: 'This database folder isn’t mapped from a folder on your server. In your server’s settings for Frameleaf, map a writable folder to it, then try again.',
  database_directory_missing: 'Manager can’t find this database folder. Choose one listed in the field, or map a folder to it in your server’s settings for Frameleaf.',
  database_permissions: 'Manager can’t read and write this database folder. Check the folder’s permissions on your server, then try again.',
  database_storage_unavailable: 'This database folder is read-only or unavailable. Make it writable in your server’s settings for Frameleaf, then try again.',
  database_in_docker_storage: 'This database folder is inside Docker’s own storage, where it could be lost. Choose a folder on a normal share or pool.',
  database_requires_disk_storage: 'The database needs a folder on a local disk. Network shares, RAM disks and virtual disk images can’t be used, so choose another folder.',
  container_settings_invalid: 'Fix the advanced container settings marked below, then try again.',
  service_override_conflict: 'An extra folder would replace one Frameleaf manages. Choose another path inside the container.',
  service_override_unsafe_source:
    'That host folder is a system path (the Docker socket, /etc, /proc, /sys, /dev, /root, /boot, Docker’s data or Manager’s own state) and cannot be mounted into Frameleaf.',
  service_override_source_outside_roots:
    'That host folder is outside the folders Manager may mount. Map it into Manager and add its Manager path to MANAGER_MOUNT_ROOTS, or choose a folder inside the media or database roots.',
  claim_proxied_address_unverified:
    'This connection reached Manager through a proxy, so Manager cannot tell it came from your home network. Open Manager directly on its LAN address, or set MANAGER_TRUSTED_PROXIES for the proxy. The Manager container log has the details.',
  update_failed_rolled_back:
    'The new release did not start, so Manager put back the previous release and the library as it was before the update. Nothing was lost; try the update again later.',
  update_review_expired:
    'The reviewed release was withdrawn and this review has expired. Cancel this update, then review the newer release before installing it.',
  database_move_failed_rolled_back:
    'Manager could not move the database to the new release’s database engine, so it put back the previous release on its unchanged database folder. Nothing was lost. Check that the database folder’s drive has free space, then try the update again.',
  database_image_change_unsupported:
    'This release’s database engine cannot replace the one this server runs. Choose another release.',
  // Journals from Managers before FL-1265, which refused these updates.
  database_image_change_requires_restore:
    'This release changes the database engine. This Manager moves the database itself: review the update again.',
  database_move_verification_failed:
    'The copied database did not match the original, so Manager kept the original. Nothing was lost.',
  database_move_version_mismatch: 'The new database engine reported an unexpected version, so Manager kept the original database.',
  database_relocation_rolled_back:
    'Manager could not move the database to the chosen folder, so Frameleaf started again on its original database folder. Nothing was lost. Any partial copy was kept for you to remove.',
  database_relocation_cancelled: 'The database move was cancelled. Frameleaf is running on its original database folder.',
  database_move_reverse_required:
    'Frameleaf already started on the new database folder and may have saved changes there, so going back to the original folder is not offered. Resume to finish the move.',
  database_already_in_folder: 'The database is already in this folder. Choose a folder on another drive.',
  database_image_changed: 'The database engine differs from the installed release’s. Update Frameleaf first, then move the database.',
  database_folder_not_retained: 'Manager is not keeping this database folder. Refresh the Storage page.',
  database_folder_in_use: 'This database folder is still in use, so it was not removed.',
  database_folder_unverified: 'Manager could not confirm that no other app uses this folder, so it kept the old copy. Nothing was removed.',
  database_unconfirmed: 'Manager could not confirm the current database is working, so it kept the previous folder. Start Frameleaf, then try again.',
  insufficient_database_space:
    'The drive that holds the database folder does not have enough free space. Free some space, then try again.',
  database_checkpoint_required: 'A database checkpoint must exist before the database image can change. Resume the update to take one.',
  media_path_unsupported_character: 'A folder name contains a comma or a control character, which Docker cannot accept. Rename the folder, then review again.',
  settings_not_json: 'Settings must be a JSON object. Check for a missing comma or bracket, then save again.',
  masked_secret_missing: 'A secret value can only be kept as [unchanged] where it already exists. Enter the value, or restore the original line.',
  incompatible_settings_require_review: 'Some source settings aren’t recognised by Frameleaf. Review them in Advanced settings on the next step.',
  release_service_unavailable: 'GitHub could not complete the Frameleaf release check. Try again shortly.',
  select_a_new_release: 'Choose a release newer than the one this server runs. To go back to an older release, restore a database recovery point taken on it from Backups.',
  release_not_eligible:'This Frameleaf release is not offered to this server. Choose another release.',
  release_bundle_missing: 'This Frameleaf release is missing installation files Manager needs. Choose a newer release.',
  release_download_failed: 'Manager could not download this release. Check the network connection, then try again.',
  release_asset_size_mismatch: 'A release file did not download completely. Try again.',
  release_verification_timeout: 'Checking the release took too long. Try again.',
  release_verification_failed: 'This release did not pass signature and checksum verification, so Manager will not use it.',
  release_architecture_unavailable: 'This release has no images for this server’s processor type.',
  source_changed_review_again:
    'The original installation changed after it was reviewed. Review the import again so Manager works from its current settings.',
  port_in_use:
    'Another app on this server is already using that port. Choose a different Frameleaf port. The original app’s port is fine for an import, because it is stopped first.',
  docker_operation_failed:
    'A Docker command did not finish. The Manager container log has the command, exit code and error output. Fix the cause, then resume.',
  docker_unavailable: 'Manager could not run Docker. Check that the Docker socket is mapped into Manager.',
  compose_v2_required: 'This version of Docker Compose is too old. Frameleaf needs Docker Compose 2 or newer. Update Docker on this server, then try again.',
  unsupported_docker_host: 'Frameleaf can’t run on this Docker. It needs Docker on Linux with Swarm mode turned off.',
  unsupported_docker_version_or_architecture:
    'This version of Docker is too old, or this server’s processor isn’t supported. Frameleaf needs Docker 24 or newer on a 64-bit Intel, AMD or ARM processor.',
  docker_storage_unavailable: 'Manager can’t find where Docker keeps its storage. Check that Docker is running on this server, then try again.',
  host_mount_information_required:
    'Manager can’t see which drive holds this folder. Install Manager again from the Frameleaf template for your server, so it can read this server’s list of drives, then try again.',
  manager_host_mounts_unverified:
    'Manager can’t tell which container it runs in, so it can’t check this server’s drives. Make sure only one Frameleaf Manager is running, then try again.',
  dockerman_container_identity:
    'Manager couldn’t save Frameleaf’s settings for Unraid’s Docker tab, because a container in this library doesn’t match what Manager set up. Restart the library from Manager, then try again.',
  database_overlaps_existing_container_data:
    'Another container can write inside this database folder. Change that container’s mapping to read-only or a narrower folder, or choose a database folder outside it.',
  unraid_autostart_file_required:
    'Manager could not configure Unraid’s autostart list. Check that Unraid’s Docker service is running, then try again. The original app must stay unable to restart at boot during the import.',
  unraid_autostart_unavailable:
    'Manager could not access Unraid’s autostart list automatically. Check that Unraid’s Docker service is running and its existing unraid-autostart file is available and writable, then try again.',
  database_path_not_mounted:
    'This isn’t one of Manager’s database folders. Choose one listed in the field, or add it to Database roots in your server’s settings for Frameleaf.',
  source_version_unreachable:
    'Manager found this photo server but could not ask it for its version. Check that it is running and healthy; Manager uses its IMMICH_PORT and IMMICH_HOST settings.',
  database_connection_ambiguous:
    'Manager could not tell which container holds this database. Its DB_HOSTNAME must name or address the database container.',
  unsupported_database_connection: 'Check the database connection: it needs a password and a port that is a whole number from 1 to 65535.',
  manager_unexpected_response:
    'Manager sent an unexpected answer. It may be restarting, or a proxy in front of it may have failed. Wait a moment, then try again.',
  photo_app_not_importable: 'This app can’t be imported yet. Choose another app, or look again after fixing what’s listed.',
  photo_app_owner_unmapped: 'Every account needs an email address before the import can continue.',
  photo_app_loss_unapproved: 'Confirm the list of details that won’t come across, then try again.',
  photo_app_inspection_required: 'Review what comes across first, then try again.',
  photo_app_capture_not_ready: 'Manager is still reading the app’s library. Wait a moment, then try again.',
  photo_app_owner_email_duplicate: 'Each account needs its own email address.',
  photo_app_import_cancelled: 'The import was cancelled and the app is running again.',
  photo_app_not_recognised: 'Manager no longer recognises this app. Look again for apps to import.',
  photo_app_cancel_unavailable: 'This import can’t be cancelled right now. Wait for the current step to finish, then try again.',
  import_folder_invalid: 'Enter the folder’s full path, starting with /, such as /mnt/user/photos/ente-export.',
  import_folder_unreachable: 'Manager can’t open that folder. Check the path is spelled exactly right and that the folder exists.',
  import_folder_outside_roots:
    'Manager can’t reach that folder. Move the export into one of the folders listed under step 3, then enter its new path.',
  ente_export_not_found:
    'That folder doesn’t hold an Ente export. Choose the folder you exported to, or run the export command from step 1 first.',
  ente_inventory_required:
    'The list of your Ente files is missing. Run the command from step 2 so ente-files.json is saved inside the export folder, then try again.',
  invalid_import_authority: 'This import changed or expired. Cancel it and start again from the beginning.',
  source_database_dump_failed: 'Manager couldn’t read the app’s database. Check that its database is running, then try again.',
  source_database_restore_failed: 'Manager couldn’t open its copy of the app’s database. Try again; the app’s own database is unchanged.',
  operation_failed:
    'This step stopped with an unexpected error. The Manager container log has the details. Completed steps are kept, so you can resume.',
};
const states: Record<string, string> = {
  'awaiting-review': 'Waiting for your review',
};
export const readable = (value: string, detail?: string) => {
  if (value.startsWith('source_snapshot_') && !refusals[value])
    return `Manager couldn’t save a copy of the app’s library (${value}). The app’s own data is unchanged; cancel to start it again.${detail ? ' ' + detail : ''}`;
  // FL-1316: Manager matched the failure to a known problem; its wording says what happened and what to do.
  if (value === 'docker_operation_failed' && detail) return detail;
  const refused = /^server_refused_(\d{3})$/.exec(value);
  if (refused) return `The Frameleaf server refused Manager's request (${refused[1]}). Check the server logs, then resume.`;
  const text = stepNames[value] ?? states[value] ?? moveRefusals[value] ?? refusals[value] ?? value.replaceAll(/[_-]/g, ' ');
  return detail ? `${text} ${detail}` : text;
};
export function operationProgress(operation: JournalOperation, backupSkipped = false) {
  const own = kindSteps[operation.kind];
  if (own?.within) operation = grouped(operation, own.within);
  const capture = operation.step === 'capture-common-source' || operation.completed.includes('capture-common-source');
  const planned = operation.commonImport ? plans['common-import'] : capture ? [] : plans[operation.kind] ?? [];
  const ids = [
    ...new Set([...(capture ? ['capture-common-source'] : []), ...planned, ...operation.completed, ...(operation.step ? [operation.step] : [])]),
  ].filter(
    (id) =>
      (id !== 'stage-bootstrap-admin' || operation.commonImport?.requiresBootstrap) &&
      (id !== 'database-backup' || !backupSkipped) &&
      (!['stop-previous-installation', 'archive-previous-installation'].includes(id) || operation.replacesInstallation) &&
      (id !== 'database-move' || operation.databaseMove || operation.completed.includes(id) || operation.step === id),
  );
  const successful = operation.state === 'complete' && !operation.error;
  const steps = ids.map((id) => ({
    id,
    label:
      own?.labels[id] ??
      (id === 'capture-common-source' && isFolderImport(operation.photoApp?.kind) ? 'Read the export folder' : readable(id)),
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
/** The journal as its shown steps: a step counts as done once it and every step within it are. */
function grouped(operation: JournalOperation, within: Record<string, string>): JournalOperation {
  const shown = (id: string) => within[id] ?? id;
  const members = (id: string) => [id, ...Object.keys(within).filter((inner) => within[inner] === id)];
  const step = operation.step ? shown(operation.step) : null;
  const completed = [...new Set(operation.completed.map(shown))].filter(
    (id) => id !== step && members(id).every((inner) => operation.completed.includes(inner)),
  );
  return { ...operation, step, completed };
}
export function canCancel(operation: JournalOperation, installation: { mayHaveWrittenMedia: boolean } | null) {
  if (!['failed', 'interrupted'].includes(operation.state)) return false;
  return (
    operation.kind === 'backup' ||
    operation.kind === 'reconfigure' ||
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

const processors: Record<string, string> = { cuda: 'NVIDIA GPU', rocm: 'AMD GPU', openvino: 'Intel GPU' };
/** The ML accelerator Manager detected on the host (see detectAcceleration). */
export const hasGpu = (acceleration: string | undefined) => !!acceleration && Object.hasOwn(processors, acceleration);
export const processorName = (acceleration: string | undefined) =>
  (hasGpu(acceleration) && processors[acceleration!]) || 'CPU processing';

export const plural = (count: number, one: string, many = `${one}s`) =>
  `${count.toLocaleString()} ${count === 1 ? one : many}`;

/** Only releases newer than the running one are updates; going back is a database restore (Backups). */
export const newerReleases = <T extends { tag: string }>(releases: T[], running: string | undefined) =>
  running ? releases.filter((release) => isNewerRelease(release.tag, running)) : [];

/**
 * GitHub's generated notes are markdown with an HTML comment. Shown as plain text (Svelte escapes it),
 * so markup never renders; only the markdown syntax that reads as noise is removed.
 */
export const releaseNotesText = (notes: string) =>
  notes
    .replaceAll(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replaceAll(/\*\*(.+?)\*\*/g, '$1')
    .replaceAll(/^#{1,6}[ \t]+/gm, '')
    .replaceAll(/^[ \t]*[*-][ \t]+/gm, '• ')
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim();

export const setupScreens = [
  'photo-app',
  'import',
  'fresh',
  'restore',
  'progress',
  'success',
  'profile',
  'downloads',
  'phone',
  'setup-complete',
];
const operationSections: Record<string, string> = {
  backup: 'backups',
  restore: 'backups',
  update: 'updates',
  start: 'services',
  stop: 'services',
  restart: 'services',
  reconfigure: 'services',
  'move-library': 'storage',
  'move-database': 'storage',
  'move-thumbnails': 'storage',
  'thumbnails-home': 'storage',
};
/** The navigation entry for the open screen; maintenance on an installed server belongs to its own section. */
export function navSection(screen: string, installed: boolean, operationKind?: string) {
  if (installed && screen === 'restore') return 'backups';
  if (installed && screen === 'progress' && operationKind && operationSections[operationKind])
    return operationSections[operationKind];
  return setupScreens.includes(screen) ? 'welcome' : screen;
}

// ---------------------------------------------------------------- advanced container settings
// What a home-lab administrator types for each container; the server applies the parsed overrides.
export const CONTAINERS = [
  { id: 'frameleaf-server', label: 'Frameleaf server', about: 'The photo application. Extra folders appear inside the container at the path you give.' },
  { id: 'frameleaf-machine-learning', label: 'Machine learning', about: 'Faces and smart search. Only runs while machine learning is on.' },
  { id: 'database', label: 'Database', about: 'PostgreSQL. Manager owns its data folder and credentials.' },
] as const;
export type ContainerId = (typeof CONTAINERS)[number]['id'];
export type ContainerText = { environment: string; mounts: string; memory: string; cpus: string };
export type ContainerOverride = {
  environment: Record<string, string>;
  mounts: { source: string; target: string; readOnly: boolean }[];
  memory?: string;
  cpus?: number;
};
const RESERVED_ENVIRONMENT = /^(DB_|POSTGRES_|FRAMELEAF_MANAGER_|IMMICH_CONFIG_FILE$|IMMICH_MEDIA_LOCATION$)/;
export const emptyContainers = (): Record<ContainerId, ContainerText> =>
  Object.fromEntries(CONTAINERS.map((c) => [c.id, { environment: '', mounts: '', memory: '', cpus: '' }])) as Record<ContainerId, ContainerText>;
const lines = (text: string) => text.split('\n').map((line) => line.trim()).filter(Boolean);
/** Parses one container's text fields; `errors` lists every line that cannot be applied. */
export function parseContainerSettings(text: ContainerText): ContainerOverride & { errors: string[] } {
  const errors: string[] = [];
  const environment: Record<string, string> = {};
  for (const line of lines(text.environment)) {
    const at = line.indexOf('=');
    const name = at > 0 ? line.slice(0, at).trim() : '';
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) errors.push(`"${line}" is not NAME=value`);
    else if (RESERVED_ENVIRONMENT.test(name)) errors.push(`${name} is set by Manager`);
    else environment[name] = line.slice(at + 1);
  }
  const mounts: ContainerOverride['mounts'] = [];
  for (const line of lines(text.mounts)) {
    const [source, target, mode, ...rest] = line.split(':');
    if (!source?.startsWith('/') || !target?.startsWith('/') || rest.length || (mode && mode !== 'ro' && mode !== 'rw'))
      errors.push(`"${line}" is not /folder/on/server:/folder/in/container[:ro]`);
    else mounts.push({ source, target, readOnly: mode === 'ro' });
  }
  const memory = text.memory.trim();
  if (memory && !/^\d+(\.\d+)?[kmg]b?$/i.test(memory)) errors.push(`Memory limit "${memory}" should look like 4g or 512m`);
  const cpus = text.cpus.trim();
  if (cpus && !(Number(cpus) > 0)) errors.push(`CPU limit "${cpus}" should be a number of cores, like 2 or 0.5`);
  return { environment, mounts, ...(memory ? { memory } : {}), ...(cpus ? { cpus: Number(cpus) } : {}), errors };
}
/** The stored overrides as the text fields show them; the inverse of parseContainerSettings. */
export function containerText(services: Partial<Record<ContainerId, ContainerOverride>>): Record<ContainerId, ContainerText> {
  const containers = emptyContainers();
  for (const { id } of CONTAINERS) {
    const override = services[id];
    if (!override) continue;
    containers[id] = {
      environment: Object.entries(override.environment ?? {}).map(([name, value]) => `${name}=${value}`).join('\n'),
      mounts: (override.mounts ?? []).map((m) => `${m.source}:${m.target}${m.readOnly ? ':ro' : ''}`).join('\n'),
      memory: override.memory ?? '',
      cpus: override.cpus === undefined ? '' : String(override.cpus),
    };
  }
  return containers;
}
export type ExternalFolder = { path: string; readOnly: boolean };
/** External folders are the Frameleaf server's extra folders kept at the same path; any other line stays under Advanced. */
const sameFolderLine = (line: string) => {
  const [source, target, mode, ...rest] = line.split(':');
  return source === target && !rest.length && (mode === undefined || mode === 'ro' || mode === 'rw') ? { path: source, readOnly: mode === 'ro' } : null;
};
export const externalFolders = (mounts: string): ExternalFolder[] => lines(mounts).flatMap((line) => sameFolderLine(line) ?? []);
export function setExternalFolders(mounts: string, folders: ExternalFolder[]): string {
  // Anything else stays exactly as typed, including a line the Advanced editor is reporting as invalid.
  const others = lines(mounts).filter((line) => !sameFolderLine(line));
  return [...others, ...folders.map(({ path, readOnly }) => `${path}:${path}${readOnly ? ':ro' : ''}`)].join('\n');
}
const lexicalOverlap = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
const shareView = (path: string) => {
  const [, mnt, view, ...rest] = path.split('/');
  return mnt === 'mnt' && view && !['disks', 'remotes', 'rootshare', 'addons'].includes(view) ? { view, path: `/${rest.join('/')}` } : null;
};
/** /mnt/user/a and /mnt/disk1/a can be the same files; the server applies the same rule. */
export function folderOverlap(a: string, b: string): boolean {
  if (lexicalOverlap(a, b)) return true;
  const [left, right] = [shareView(a), shareView(b)];
  return !!left && !!right && [left.view, right.view].some((view) => view === 'user' || view === 'user0') && lexicalOverlap(left.path, right.path);
}
/** Why the browser can't use this as an external folder; the server checks the same rules on save. */
export function externalFolderIssue(path: string, occupied: string[], existing: ExternalFolder[]): string | null {
  if (path.split('/').length < 4) return 'Choose a folder inside this one.';
  if (/[,:]/.test(path)) return 'This folder’s name has a comma or colon, which Frameleaf can’t use.';
  if (existing.some((folder) => folder.path === path)) return 'This folder is already added.';
  if (occupied.some((other) => folderOverlap(path, other))) return 'This folder holds Frameleaf’s own data, or sits inside it. Choose a folder of photos instead.';
  return null;
}
/** "2 variables · 1 folder · 4g memory", or "" when nothing is set. */
export function containerSummary(parsed: ContainerOverride): string {
  const count = (n: number, word: string) => (n ? [`${n} ${word}${n === 1 ? '' : 's'}`] : []);
  return [
    ...count(Object.keys(parsed.environment).length, 'variable'),
    ...count(parsed.mounts.length, 'folder'),
    ...(parsed.memory ? [`${parsed.memory} memory`] : []),
    ...(parsed.cpus ? [`${parsed.cpus} CPU${parsed.cpus === 1 ? '' : 's'}`] : []),
  ].join(' · ');
}
/** The review request's `services`: only containers with something set, only when every line parsed. */
export function containerOverrides(
  containers: Record<ContainerId, ContainerText>,
  ml: boolean,
): { services: Partial<Record<ContainerId, ContainerOverride>>; invalid: boolean } {
  const services: Partial<Record<ContainerId, ContainerOverride>> = {};
  let invalid = false;
  for (const container of CONTAINERS) {
    if (!ml && container.id === 'frameleaf-machine-learning') continue;
    const { errors, ...parsed } = parseContainerSettings(containers[container.id]);
    if (errors.length) invalid = true;
    else if (containerSummary(parsed)) services[container.id] = parsed;
  }
  return { services, invalid };
}

// ---------------------------------------------------------------- imports from other photo apps (Beta)
export type PhotoAppKind = 'photoprism' | 'photoview' | 'pigallery2' | 'lychee' | 'nextcloud' | 'piwigo' | 'librephotos' | 'ente';
export type PhotoAppSource = {
  container: string;
  kind: PhotoAppKind | string;
  name?: string;
  version: string | null;
  database: 'sqlite' | 'mysql' | 'postgres' | 'unknown' | string;
  importable: boolean;
  reason?: string;
};
const photoAppNames: Record<string, string> = {
  photoprism: 'PhotoPrism',
  photoview: 'Photoview',
  pigallery2: 'PiGallery2',
  lychee: 'Lychee',
  nextcloud: 'Nextcloud',
  piwigo: 'Piwigo',
  librephotos: 'LibrePhotos',
  ente: 'Ente Photos',
};
/** The product name owners know, never the container name. */
export const photoAppName = (kind: string | undefined, fallback = 'your photo app') =>
  (kind && photoAppNames[kind]) || fallback;
const databaseNames: Record<string, string> = { sqlite: 'SQLite', mysql: 'MySQL', postgres: 'PostgreSQL' };
export const databaseName = (database: string | undefined) => (database && databaseNames[database]) || 'an unknown database';
/** "PhotoPrism 240915 · SQLite" for the picker. */
export const photoAppDetail = (source: Pick<PhotoAppSource, 'version' | 'database'>) =>
  [source.version ? `Version ${source.version}` : 'Version unknown', databaseName(source.database)].join(' · ');

const sourceReasons: Record<string, (app: string, database: string) => string> = {
  database_unsupported: (app, database) => `${app} on ${database} isn't supported yet.`,
  database_unknown: (app) => `Manager couldn't tell which database ${app} uses.`,
  database_container_not_found: (app) => `Manager couldn't find ${app}'s database. Check that its database container is running.`,
  database_image_unsupported: (app) => `${app}'s database runs on a version Manager can't copy yet.`,
  database_credentials_unavailable: (app) => `Manager couldn't find the login ${app} uses for its database.`,
  source_mount_missing: (app) => `${app}'s photo folder isn't mapped into its container, so Manager can't find your photos.`,
  source_mount_unsupported: (app) => `${app} keeps your photos in a Docker volume. Imports need a regular folder on the server.`,
  source_mount_unqualified: (app) => `${app}'s photo folders overlap or are nested in a way Manager can't import safely yet.`,
};
/** Why a detected app is greyed out, in words: Manager sends a code, a sentence, or nothing. */
export function photoAppReason(source: Pick<PhotoAppSource, 'kind' | 'database' | 'reason'>) {
  const app = photoAppName(source.kind);
  const database = databaseName(source.database);
  const reason = source.reason?.trim();
  if (reason && /\s/.test(reason)) return reason;
  const known = reason ? sourceReasons[reason] : undefined;
  if (known) return known(app, database);
  if (reason) return `${app} can't be imported yet (${reason}).`;
  return source.database === 'unknown'
    ? sourceReasons.database_unknown(app, database)
    : sourceReasons.database_unsupported(app, database);
}

/**
 * Apps imported from a folder the owner exported themselves, not from a container on this server. Nothing is
 * stopped and the export records no app version.
 */
export const isFolderImport = (kind: string | undefined) => kind === 'ente';
/** The version shown beside an app's name; an export folder has none worth showing. */
export const sourceVersion = (kind: string | undefined, version: string | null | undefined) =>
  (!isFolderImport(kind) && version) || '';
/** Ente's CLI release names (`ente-cli-v0.4.2`) as owners see them. */
const enteCli = (version: string | null | undefined) => (version ?? '').replace(/^ente-cli-v?/u, 'Ente CLI ');

/** Shown when the reader was not qualified against this exact version (no version pinning: best effort). */
export function untestedNotice(kind: string, version: string | null | undefined, testedVersion: string | null | undefined) {
  if (isFolderImport(kind))
    return (
      'This export isn’t exactly like the Ente exports Manager has been tested with. ' +
      'Photos and albums should come across; anything that can’t will be listed. ' +
      `For best results, export again${testedVersion ? ` with ${enteCli(testedVersion)}` : ''}.`
    );
  const app = photoAppName(kind);
  return (
    `${version ? `${app} ${version}` : `This version of ${app}`} hasn't been tested. ` +
    'Photos and albums should come across; anything that can’t will be listed. ' +
    `For best results, upgrade ${app}${testedVersion ? ` to ${testedVersion}` : ''} first.`
  );
}

export const UNTESTED_VERSION_LOSS = 'SOURCE_VERSION_UNTESTED';
// Every reader names its losses <APP>_<WHAT>; the <WHAT> part means the same thing for every app.
const lossTexts: Record<string, (app: string) => string> = {
  IDENTICAL_ORIGINALS_MERGED: () =>
    'Photos that were in the library more than once came across as one photo, in every album the copies were in. A merged copy’s own description, tags and favourite did not come across.',
  SOURCE_METADATA_ARCHIVED: (app) => `Some ${app}-only details and settings won't come across.`,
  SHARING_RESTRICTED: () => 'Shared links and sharing between accounts won’t come across. You can share again in Frameleaf.',
  PEOPLE_ARCHIVED: () => 'Named people and face groups won’t come across. Frameleaf finds faces again on its own.',
  TITLE_ARCHIVED: () => 'Photo titles won’t come across. Descriptions do.',
  ALBUM_SNAPSHOT: () => 'Smart albums become regular albums holding the photos they show today.',
  ALBUM_SNAPSHOT_REQUIRED: () => 'Smart albums become regular albums holding the photos they show today.',
  ALBUM_PARTITIONED: () => 'Albums with photos from several accounts are split into one album per account.',
  ALBUM_HIERARCHY_ARCHIVED: () => 'Albums inside other albums come across side by side, without the nesting.',
  CATEGORY_HIERARCHY_ARCHIVED: () => 'Albums inside other albums come across side by side, without the nesting.',
  DIRECTORY_HIERARCHY_ARCHIVED: () => 'Albums inside other albums come across side by side, without the nesting.',
  ALBUM_TAGS_ARCHIVED: () => 'Tags on albums won’t come across. Tags on photos do.',
  ALBUM_VISIBILITY_ARCHIVED: () => 'Hidden and archived albums come across as regular albums.',
  ALBUM_MEMBERSHIP_RESTRICTED: () => 'Photos their owner couldn’t see in an album are left out of that album.',
  CROSS_OWNER_ALBUM_RESTRICTED: () => 'Photos someone added to another person’s album stay with their owner, outside that album.',
  CROSS_OWNER_MEMBERSHIP_ARCHIVED: () => 'Photos someone added to another person’s album stay with their owner, outside that album.',
  PRIVATE_ALBUM_MEMBERSHIP_ARCHIVED: () => 'Private photos are left out of the albums they were in.',
  DYNAMIC_ALBUM_ARCHIVED: (app) => `Smart albums ${app} fills automatically (moments, months, searches) won’t come across.`,
  SAVED_SEARCH_ARCHIVED: (app) => `Saved searches from ${app} won’t come across.`,
  DELETED_ALBUM_ARCHIVED: (app) => `Albums you deleted in ${app} stay deleted.`,
  CAPTURE_TIME_FALLBACK: () => 'Photos with no recorded date use their file date instead.',
  CAPTURE_TIME_UNAVAILABLE: () => 'Photos with no recorded date use their file date instead.',
  CAPTURE_OFFSET_UNKNOWN: () => 'Some photos have no time zone, so they keep the time exactly as recorded.',
  CAPTURE_TIME_ZONE_UNRESOLVED: () => 'Some photos have no time zone, so they keep the time exactly as recorded.',
  CAPTURE_CLOCK_UNKNOWN: () => 'Some photos have no time zone, so their time is shown in UTC.',
  CAPTURE_PRECISION_ARCHIVED: () => 'Some photo times lose tiny fractions of a second.',
  VIEWER_RATINGS_ARCHIVED: () => 'Ratings other people gave won’t come across. Each owner’s own rating does.',
  VIEWER_PREFERENCES_ARCHIVED: () => 'Favourites other people set won’t come across. Each owner’s own favourites do.',
  OWNER_RATING_ARCHIVED: () => 'Ratings Frameleaf can’t show (above 5 stars, or from guests) won’t come across.',
  AGGREGATE_RATING_ARCHIVED: () => 'Average visitor ratings won’t come across.',
  ROTATION_ARCHIVED: (app) => `Rotations made in ${app} won’t come across; photos show the way their files are saved.`,
  UNVALIDATED_CONTENT_HIDDEN: (app) => `Photos still waiting for approval in ${app} come across hidden.`,
  MISSING_IMAGE_RELATIONSHIPS_ARCHIVED: () => 'Album and tag links for photos missing from disk won’t come across.',
  DUPLICATE_PATHS_ARCHIVED: () => 'Extra copies of the same photo in other folders are imported once.',
  STACK_ARCHIVED: () => 'Some grouped photos come across as separate photos.',
  LABELS_ARCHIVED: () => 'Automatic labels won’t come across. Frameleaf’s smart search finds things on its own.',
  LABEL_TAG_UNREPRESENTABLE: () => 'Some labels have names Frameleaf can’t use as tags, so they won’t come across.',
  TAG_NORMALIZED: () => 'Some tag names are tidied up, such as extra spaces removed.',
  RESTRICTED_SYSTEM_TAGS_ARCHIVED: (app) => `${app}'s system tags won’t come across.`,
  GLOBAL_PRIVACY_REQUIRES_QUALIFICATION: (app) => `${app}'s privacy settings won’t come across. Check who can see what in Frameleaf afterwards.`,
  LIVE_PHOTO_REQUIRES_QUALIFICATION: () => 'Live Photos come across as a separate photo and video.',
  ORIGINAL_NAME_ARCHIVED: () => 'Some original file names won’t come across.',
  SHARED_FILE_NOT_IMPORTED: () =>
    'Photos and videos other people shared with you stay in their library. Only your own come across.',
};
/** One short sentence per loss. Unknown codes still say which app and keep the code for support. */
export function lossText(code: string, kind: string) {
  const app = photoAppName(kind);
  if (code === UNTESTED_VERSION_LOSS) return `This version of ${app} hasn't been tested, so some details may not come across.`;
  const suffix = Object.keys(lossTexts)
    .filter((key) => code === key || code.endsWith('_' + key))
    .sort((a, b) => b.length - a.length)[0];
  return suffix ? lossTexts[suffix](app) : `Some ${app} details won't come across (${code}).`;
}

const restrictionTexts: Record<string, (app: string) => string> = {
  'account-disabled': (app) => `This account is turned off in ${app}.`,
  'password-login-disabled': (app) => `This account can't sign in with a password in ${app}.`,
  'second-factor-required': (app) => `This account uses two-step sign-in in ${app}.`,
  'external-identity-required': (app) => `This account signs in through another service in ${app}.`,
  'restricted-library-access': (app) => `This account can only see part of its library in ${app}.`,
  'other-source-restrictions': (app) => `This account has other limits in ${app}.`,
};
export const restrictionText = (code: string, kind: string) =>
  restrictionTexts[code]?.(photoAppName(kind)) ?? `This account has a limit in ${photoAppName(kind)} (${code}).`;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
/** Every imported account needs its own valid email; the message says what to fix, keyed by source id. */
export function ownerEmailProblems(owners: { sourceId: string; email: string }[]) {
  const problems: Record<string, string> = {};
  const seen = new Map<string, number>();
  for (const owner of owners) {
    const email = owner.email.trim().toLowerCase();
    if (email) seen.set(email, (seen.get(email) ?? 0) + 1);
  }
  for (const owner of owners) {
    const email = owner.email.trim().toLowerCase();
    if (!email) problems[owner.sourceId] = 'Enter an email address for this account.';
    else if (!EMAIL.test(email)) problems[owner.sourceId] = 'Enter a valid email address, like name@example.com.';
    else if ((seen.get(email) ?? 0) > 1) problems[owner.sourceId] = 'Each account needs its own email address.';
  }
  return problems;
}

/** A capture from another photo app that has not been approved for import yet. */
export const isPhotoAppCapture = (operation: JournalOperation | null | undefined) =>
  !!operation && operation.kind === 'import' && !!operation.photoApp && !operation.commonImport;
