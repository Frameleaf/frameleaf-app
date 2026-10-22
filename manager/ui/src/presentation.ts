import { isNewerRelease } from '../../src/release-order.js';

export type JournalOperation = {
  kind: string;
  state: string;
  step: string | null;
  completed: string[];
  error: string | null;
  detail?: string | null;
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
  'fence-source': 'Stop Immich and disable automatic restart',
  'start-database': 'Start the new PostgreSQL database',
  'capture-fenced-settings': 'Preserve the stopped source settings',
  'copy-current-database': 'Copy the current stopped database',
  'database-backup': 'Create and verify a database backup',
  'configure-offline-import': 'Prepare the offline importer',
  'import-canonical-database': 'Import into Frameleaf',
  'verify-import': 'Verify the imported library',
  'import-settings': 'Apply compatible settings',
  'retire-source-services': "Stop Immich's database and Redis",
  'start-frameleaf': 'Start Frameleaf',
  'prepare-library': 'Begin library preparation',
  'stop-application': 'Pause application writes',
  'database-checkpoint': 'Create a database recovery point',
  'apply-release': 'Apply and verify the update',
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
  reconfigure: ['apply-container-settings', 'start'],
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
  container_settings_invalid: 'Fix the advanced container settings marked below, then try again.',
  service_override_conflict: 'An extra folder would replace one Frameleaf manages. Choose another path inside the container.',
  settings_not_json: 'Settings must be a JSON object. Check for a missing comma or bracket, then save again.',
  masked_secret_missing: 'A secret value can only be kept as [unchanged] where it already exists. Enter the value, or restore the original line.',
  incompatible_settings_require_review: 'Some Immich settings aren’t recognised by Frameleaf. Review them in Advanced settings on the next step.',
  release_service_unavailable: 'Manager could not reach GitHub to check Frameleaf releases. Check this server can reach github.com, then try again.',
  select_a_new_release: 'Choose a release newer than the one this server runs. To go back to an older release, restore a database recovery point taken on it from Backups.',
  release_not_eligible:'This Frameleaf release is not offered to this server. Choose another release.',
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
    'Another container can write inside this database folder. Change that container’s mapping to read-only or a narrower folder, or choose a database folder outside it.',
  unraid_autostart_file_required:
    'Importing on Unraid needs Unraid’s autostart list, so Immich can’t start again at boot. Edit the Frameleaf Manager container and set “Unraid autostart file” to the existing unraid-autostart file in Docker’s data folder (usually /var/lib/docker/unraid-autostart; check with docker info --format "{{.DockerRootDir}}"), then apply and try again.',
  database_path_not_mounted:
    'Manager can only use a database folder inside one of its mapped database folders. Add the folder to Manager’s “Database parent” mapping and database roots, or choose one listed in the field.',
  source_version_unreachable:
    'Manager found this Immich server but could not ask it for its version. Check that it is running and healthy; Manager uses its IMMICH_PORT and IMMICH_HOST settings.',
  database_connection_ambiguous:
    'Manager could not tell which container holds this Immich database. Its DB_HOSTNAME must name or address the database container.',
  unsupported_database_connection: 'This Immich database connection is not supported yet: it needs a password.',
  operation_failed:
    'This step stopped with an unexpected error. The Manager container log has the details. Completed steps are kept, so you can resume.',
};
export const readable = (value: string, detail?: string) => {
  const refused = /^server_refused_(\d{3})$/.exec(value);
  if (refused) return `The Frameleaf server refused Manager's request (${refused[1]}). Check the server logs, then resume.`;
  const text = stepNames[value] ?? moveRefusals[value] ?? refusals[value] ?? value.replaceAll(/[_-]/g, ' ');
  return detail ? `${text} ${detail}` : text;
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
