// FL-1317 Check this server: the words for every check result Manager's review returns (manager/src/server-check.ts),
// with the fix for each host. Wording and layout follow the approved prototype (frameleaf-prototype PR 31, FL-1310).
import { readable } from './presentation';

export type CheckStatus = 'ok' | 'problem' | 'warning' | 'unknown';
export type CheckHost = 'unraid' | 'truenas' | 'hexos' | 'linux';
export type CheckResult = {
  id: string;
  status: CheckStatus;
  code?: string;
  detail?: string;
  facts?: Record<string, string | number | boolean | null>;
};
export type CheckFolder = 'media' | 'database' | 'backups';
/** Fixes Manager can make without leaving setup. After one, Manager checks again. */
export type CheckAction =
  | { kind: 'port'; port: number; label: string }
  | { kind: 'folder'; folder: CheckFolder; label: string }
  | { kind: 'ml'; label: string }
  /** FL-1320: a restore keeps thumbnails in the photos folder when their own drive is gone. */
  | { kind: 'thumbnails'; label: string }
  | { kind: 'recheck'; label: string };
export type CheckRow = {
  id: string;
  label: string;
  status: CheckStatus;
  value?: string;
  title?: string;
  detail?: string;
  steps?: string[];
  action?: CheckAction;
};
export type CheckContext = {
  host: CheckHost;
  /** Folders are chosen in Manager (new installs on Unraid, TrueNAS and plain Docker hosts with a folder root). */
  folderSetup: boolean;
  /** The folders this review checked, by check id. */
  paths: Partial<Record<CheckFolder, string>>;
  /** The folders this flow sends to the review, so choosing another one can fix it (an import keeps its media where it is). */
  chosen: CheckFolder[];
  /** A restore keeps the backup's port: Manager can't offer another one. */
  fixedPort?: boolean;
  /** A restore keeps the backup's machine learning setting: Manager can't offer to turn it off. */
  fixedMl?: boolean;
};

export const CHECK_LABELS: Record<string, string> = {
  docker: 'Docker',
  room: 'Room for Frameleaf',
  media: 'Photos and videos',
  thumbnails: 'Thumbnails',
  database: 'Database',
  backups: 'Backups',
  manager: 'Manager’s own folder',
  port: 'Frameleaf port',
  containers: 'Container settings',
  downloads: 'Downloads',
  release: 'Release signature',
  memory: 'Memory',
  unraid: 'Unraid Docker tab',
};
/** The checks in the order Manager runs them, for the list shown while it looks. */
export const checkOrder = (flow: 'install' | 'import' | 'restore', containers = false, host: CheckHost = 'linux') => [
  'docker',
  'room',
  'media',
  'database',
  ...(flow === 'restore' ? [] : ['backups', 'manager']),
  'port',
  ...(containers && flow !== 'restore' ? ['containers'] : []),
  'downloads',
  'release',
  'memory',
  ...(host === 'unraid' ? ['unraid'] : []),
];

export const CHECKING = { title: 'Checking this server', lead: 'Manager is only looking. Nothing is downloaded or changed.' };

const HOSTS: Record<CheckHost, string> = { unraid: 'Unraid', truenas: 'TrueNAS', hexos: 'HexOS', linux: '' };
const NOUNS: Record<CheckFolder, string> = { media: 'photos and videos folder', database: 'database folder', backups: 'backups folder' };
const ROOTS: Record<CheckFolder, string> = { media: 'MANAGER_STORAGE_ROOTS', database: 'MANAGER_DATABASE_ROOTS', backups: 'MANAGER_BACKUP_ROOT' };
const REOPEN = 'Open Manager again and check again.';
const AGAIN = 'Check again.';

/** "2.1 TB", "180 GB", "3.1 GB": what a person reads on their own server's storage page. */
export function size(bytes: number) {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1024) return `${(gb / 1024).toFixed(1)} TB`;
  return `${gb >= 10 ? Math.round(gb) : Number(gb.toFixed(1))} GB`;
}
const freeText = (facts: CheckResult['facts']) => (typeof facts?.free === 'number' ? ` · ${size(facts.free)} free` : '');

const dockerUpdateSteps: Record<CheckHost, string[]> = {
  unraid: ['In Unraid, open Tools, then Update OS, and install the latest version.', REOPEN],
  truenas: ['In TrueNAS, open System, then Update, and install the latest version.', REOPEN],
  hexos: ['Update HexOS to the latest version.', REOPEN],
  linux: ['Install the current Docker Engine, following docs.docker.com/engine/install.', REOPEN],
};
const dockerStartSteps: Record<CheckHost, string[]> = {
  unraid: ['In Unraid, open Settings, then Docker, and check Enable Docker is set to Yes.', REOPEN],
  truenas: ['In TrueNAS, open Apps and check a pool is chosen and Apps are running.', REOPEN],
  hexos: ['In HexOS, check Applications are running, or restart the server.', REOPEN],
  linux: ['Start Docker, for example with sudo systemctl start docker.', REOPEN],
};
const connectSteps = (host: CheckHost, folder: CheckFolder): string[] =>
  ({
    unraid: [
      'In Unraid’s Docker tab, click Frameleaf Manager and choose Edit.',
      'Choose Add another Path, Port, Variable, Label or Device, and set this folder as both the Container Path and the Host Path.',
      'Apply, then check again.',
    ],
    truenas: [
      'In TrueNAS, open Apps, choose Frameleaf Manager and click Edit.',
      `Add this folder under volumes, with the same path on both sides, and add it to ${ROOTS[folder]}.`,
      'Save, then check again.',
    ],
    hexos: [
      'Check the Applications location you chose for Frameleaf is on a drive inside this server.',
      'If you changed that location, choose it again for Frameleaf in HexOS, then check again.',
    ],
    linux: ['Stop Manager.', `Run the launcher again and give this folder as the ${folder === 'database' ? 'appdata' : folder === 'media' ? 'photos' : 'backups'} folder.`, REOPEN],
  })[host];
const permissionSteps: Record<CheckHost, string[]> = {
  unraid: ['In Unraid’s Docker tab, click Frameleaf Manager and choose Edit.', 'Set this folder’s Access Mode to Read/Write, then Apply.', REOPEN],
  truenas: [
    'In TrueNAS, open Datasets, choose the dataset that holds this folder, and click Edit under Permissions.',
    'Give the apps user read and write access, then check again.',
  ],
  hexos: ['In HexOS, open the folder’s settings and give Frameleaf read and write access.', AGAIN],
  linux: ['Check the folder isn’t on a read-only drive, or a network share that maps root to another user.', 'Fix the drive or share, then check again.'],
};
const managerRoomSteps: Record<CheckHost, string[]> = {
  unraid: ['Free some space on the drive that holds appdata, usually the cache pool.', AGAIN],
  truenas: ['Free some space on the pool that holds Frameleaf Manager’s data, or remove apps you no longer use.', AGAIN],
  hexos: ['Free some space on the drive that holds your applications, or remove apps you no longer use.', AGAIN],
  linux: ['Free some space on the drive that holds Manager’s state folder.', AGAIN],
};
/** FL-1320: a folder whose drive is disconnected or not mounted. */
const reconnectSteps: Record<CheckHost, string[]> = {
  unraid: ['In Unraid, open Main and check the drive or pool that holds this folder is mounted. For an Unassigned Devices drive, click Mount.', AGAIN],
  truenas: ['In TrueNAS, open Storage and check the pool that holds this folder is online.', AGAIN],
  hexos: ['In HexOS, check the drive that holds this folder is connected and healthy.', AGAIN],
  linux: ['Connect the drive and mount it at the same place, for example with sudo mount -a.', AGAIN],
};
/** FL-1318: Docker's own storage is full. Unraid keeps it in a fixed-size docker.img. */
const dockerRoomSteps: Record<CheckHost, string[]> = {
  unraid: [
    'In Unraid, open Settings, then Docker, and set Enable Docker to No. Your containers stop while Docker is off.',
    'Raise Docker vDisk size to at least 40 GB, then turn Docker back on.',
    REOPEN,
  ],
  truenas: ['In TrueNAS, open Apps, then Configuration, then Choose Pool, to see which pool holds your apps.', 'Free some space on that pool, or remove apps you no longer use.'],
  hexos: ['Free some space on the drive that holds your applications, or remove apps you no longer use.'],
  linux: ['Free some space on the drive that holds /var/lib/docker.', 'To clear images no container uses, run docker image prune -a.'],
};
const DOWNLOAD_STEPS = ['Check this server is connected to the internet.', 'If your network uses a VPN, DNS filter or ad blocker, allow ghcr.io and github.com.'];
const DOCKERMAN_STEPS = [
  'In Unraid’s Docker tab, click Frameleaf and choose Edit.',
  'Choose Add another Path, Port, Variable, Label or Device, and set Config Type to Path.',
  'Set Container Path to /run/frameleaf-host/templates-user and Host Path to /boot/config/plugins/dockerMan/templates-user, then Apply.',
];
const gigabytes = (bytes: number) => `${Math.round(bytes / 1024 ** 3)} GB`;
const portSteps = (host: CheckHost, port: number): string[] =>
  ({
    unraid: [`In Unraid’s Docker tab, find the app using port ${port}, and stop it or change its port.`, AGAIN],
    truenas: [`In TrueNAS, open Apps, find the app using port ${port}, and stop it or change its port.`, AGAIN],
    hexos: [`In HexOS, find the application using port ${port}, and stop it or change its port.`, AGAIN],
    linux: [`Find the app using port ${port} with sudo ss -ltnp, and stop it or change its port.`, AGAIN],
  })[host];

const UNREACHABLE = new Set([
  'storage_inaccessible',
  'storage_outside_approved_roots',
  'storage_volume_missing',
  'invalid_storage_path',
  'database_directory_missing',
  'database_path_changed',
]);
const DOWNLOADS = new Set(['check_failed', 'release_download_failed', 'release_service_unavailable', 'release_verification_timeout']);

type Words = Pick<CheckRow, 'title' | 'detail' | 'steps' | 'action'>;

function folderProblem(folder: CheckFolder, code: string, context: CheckContext, detail?: string): Words {
  const path = context.paths[folder] ?? '';
  const pick = context.folderSetup && context.chosen.includes(folder);
  const choose = pick ? { action: { kind: 'folder' as const, folder, label: 'Choose another folder' } } : {};
  if (UNREACHABLE.has(code))
    return pick
      ? { title: `Manager can’t reach the ${NOUNS[folder]}`, detail: `${path} isn’t on a drive Manager can use.`, ...choose }
      : { title: `Manager can’t reach the ${NOUNS[folder]}`, detail: `${path} isn’t connected to Manager yet.`, steps: connectSteps(context.host, folder) };
  if (code === 'storage_permissions' || code === 'database_permissions')
    return { title: `Manager can’t save in the ${NOUNS[folder]}`, detail: `${path} is read-only to Manager.`, steps: permissionSteps[context.host], ...choose };
  if (code === 'insufficient_disk_space' || code === 'insufficient_database_space')
    return {
      title: `Not enough room in the ${NOUNS[folder]}`,
      detail: `The drive that holds ${path} is nearly full.`,
      steps: [pick ? 'Free some space on that drive, or choose a folder on a bigger drive.' : 'Free some space on that drive, then check again.'],
      ...choose,
    };
  if (code === 'chosen_folders_overlap' || code === 'external_folder_holds_frameleaf_data')
    return {
      title: 'These folders overlap',
      detail: 'Photos and videos, the database, backups and Manager’s own settings each need their own separate folder.',
      ...(pick ? choose : { steps: [AGAIN] }),
    };
  return generic(folder, code, detail);
}

function generic(id: string, code: string, detail?: string): Words {
  return {
    title: `Manager found a problem with ${(CHECK_LABELS[id] ?? id).toLowerCase()}`,
    detail: readable(code, detail),
    steps: ['Fix it on the server, then check again.'],
  };
}

function problem(result: CheckResult, context: CheckContext): Words {
  const code = result.code ?? 'check_failed';
  const host = context.host;
  switch (result.id) {
    case 'docker':
      if (code === 'unsupported_docker_version_or_architecture')
        return { title: 'This version of Docker is too old', detail: 'Frameleaf needs Docker 24 or newer, on a 64-bit Intel, AMD or ARM processor.', steps: dockerUpdateSteps[host] };
      if (code === 'compose_v2_required')
        return {
          title: 'Docker Compose is too old',
          detail: 'Frameleaf needs Docker Compose 2 or newer.',
          steps: host === 'linux' ? ['Install the current Docker Engine and its Compose plugin, following docs.docker.com/engine/install.', REOPEN] : dockerUpdateSteps[host],
        };
      if (code === 'unsupported_docker_host')
        return { title: 'Docker is part of a swarm', detail: 'Frameleaf runs on a single Docker server, not a swarm.', steps: ['On this server, run docker swarm leave --force. Apps the swarm runs stop.', REOPEN] };
      return { title: 'Manager can’t use Docker', detail: 'Docker didn’t answer when Manager asked about this server.', steps: dockerStartSteps[host] };
    case 'room': {
      const needed = Number(result.facts?.needed ?? 0),
        free = Number(result.facts?.free ?? 0);
      if (code !== 'insufficient_docker_space') return generic('room', code, result.detail);
      return { title: 'Not enough room in Docker’s storage', detail: `Frameleaf needs about ${size(needed)} there, and only ${size(free)} is free.`, steps: dockerRoomSteps[host] };
    }
    case 'downloads':
      return {
        title: 'Manager can’t reach Frameleaf’s downloads',
        detail: `This server couldn’t connect to ${result.detail === 'github.com' ? 'github.com' : 'ghcr.io'}, where Frameleaf is downloaded from.`,
        steps: DOWNLOAD_STEPS,
      };
    case 'thumbnails': {
      const folder = typeof result.facts?.folder === 'string' ? result.facts.folder : null;
      return {
        title: 'The thumbnails drive isn’t connected',
        detail: `${result.facts?.missing ?? result.detail ?? 'The thumbnails folder'} isn’t there. Your photos are untouched.${folder ? ' Reconnect the drive, or keep thumbnails with your photos and Frameleaf makes any missing ones again.' : ''}`,
        steps: reconnectSteps[host],
        ...(folder && { action: { kind: 'thumbnails' as const, label: 'Keep thumbnails with your photos' } }),
      };
    }
    case 'media':
    case 'database':
    case 'backups':
      if (code === 'media_folder_missing')
        return { title: 'The photos drive isn’t connected', detail: 'A photos folder isn’t there. Its drive may be disconnected or not mounted. Nothing has been changed.', steps: reconnectSteps[host] };
      if (code === 'mounted_folder_missing' || code === 'thumbnail_folder_missing')
        return { title: 'A folder Frameleaf uses isn’t there', detail: 'Its drive may be disconnected or not mounted. Nothing has been changed.', steps: reconnectSteps[host] };
      if (code === 'external_media_volume_unavailable')
        return { title: 'A media volume is missing', detail: `The Docker volume ${result.detail ?? ''} isn’t on this server.`, steps: ['Create or restore that Docker volume, then check again.'] };
      return folderProblem(result.id, code, context, result.detail);
    case 'port': {
      const port = Number(result.facts?.port ?? 0),
        free = typeof result.facts?.free === 'number' ? result.facts.free : null;
      if (code !== 'port_in_use') return generic('port', code, result.detail);
      return free && !context.fixedPort
        ? { title: `Port ${port} is in use`, detail: `Another app on this server is already using the port Frameleaf would open on. Port ${free} is free.`, action: { kind: 'port', port: free, label: `Use port ${free}` } }
        : { title: `Port ${port} is in use`, detail: 'Another app on this server is already using the port Frameleaf would open on.', steps: portSteps(host, port) };
    }
    case 'manager':
      if (code === 'insufficient_disk_space')
        return { title: 'Not enough room in Manager’s own folder', detail: 'Manager saves each database backup there before it moves to your backups folder.', steps: managerRoomSteps[host] };
      if (code === 'storage_permissions')
        return { title: 'Manager can’t save in its own folder', detail: 'Manager’s own folder is read-only.', steps: permissionSteps[host] };
      return generic('manager', code, result.detail);
    case 'containers':
      return { title: 'A container setting can’t be used', detail: readable(code, result.detail), steps: ['Go back, open Advanced container settings, and change or remove it.'] };
    case 'release':
      if (code === 'release_architecture_unavailable')
        return { title: 'This release doesn’t run on this server', detail: `It has no build for this server’s processor (${result.detail ?? 'unknown'}).`, steps: ['Go back and choose another release.'] };
      if (DOWNLOADS.has(code))
        return {
          title: 'Manager can’t reach Frameleaf’s downloads',
          detail: 'This server couldn’t connect to github.com, where Frameleaf is downloaded from.',
          steps: DOWNLOAD_STEPS,
        };
      return { title: 'The release couldn’t be verified', detail: 'Manager checks every release’s signature before it installs anything, and this one didn’t pass.', steps: ['Go back and choose another release, or check again later.'] };
  }
  return generic(result.id, code, result.detail);
}

function notice(result: CheckResult, context: CheckContext): Words {
  if (result.id === 'room' && result.status === 'unknown')
    return {
      title: 'Couldn’t check Docker’s storage',
      detail: `Manager couldn’t see how much room Docker has here. Frameleaf needs about ${size(Number(result.facts?.needed ?? 0))}. If it runs out, the install stops at that point and tells you.`,
      action: { kind: 'recheck', label: 'Check again' },
    };
  if (result.id === 'memory') {
    if (result.status === 'unknown')
      return { title: 'Couldn’t check memory', detail: 'Manager couldn’t tell how much memory this server has. Faces and smart search can run out of memory with less than 8 GB.' };
    return {
      title: `This server has ${gigabytes(Number(result.facts?.bytes ?? 0))} of memory`,
      detail: 'Frameleaf will work, but faces and smart search can run out of memory with less than 8 GB.',
      ...(!context.fixedMl && { action: { kind: 'ml' as const, label: 'Turn off faces and smart search' } }),
    };
  }
  if (result.id === 'unraid' && result.status === 'warning')
    return {
      title: 'Frameleaf won’t be editable from Unraid’s Docker tab',
      detail: 'Frameleaf will still install and run. A folder Unraid uses to save its container settings isn’t connected to Manager.',
      steps: DOCKERMAN_STEPS,
    };
  if (result.id === 'port' && result.status === 'unknown') {
    const port = result.facts?.port ?? '';
    return {
      title: 'Couldn’t check the port',
      detail: `Manager couldn’t test port ${port} from here. If another app is using it, the install stops at that point and tells you.`,
      action: { kind: 'recheck', label: 'Check again' },
    };
  }
  return {
    title: result.status === 'unknown' ? `Couldn’t check ${(CHECK_LABELS[result.id] ?? result.id).toLowerCase()}` : (CHECK_LABELS[result.id] ?? result.id),
    detail: result.code ? readable(result.code, result.detail) : (result.detail ?? ''),
    action: { kind: 'recheck', label: 'Check again' },
  };
}

function value(result: CheckResult, host: CheckHost): string {
  const facts = result.facts;
  switch (result.id) {
    case 'docker':
      return [HOSTS[host], facts?.version ? `Docker ${facts.version}` : 'Docker'].filter(Boolean).join(' · ');
    case 'media':
      if (typeof facts?.folders === 'number') return `${facts.folders} ${facts.folders === 1 ? 'folder stays' : 'folders stay'} where ${facts.folders === 1 ? 'it is' : 'they are'}`;
      return `Can save here${freeText(facts)}`;
    case 'database':
      return `On this server${freeText(facts)}`;
    case 'backups':
    case 'manager':
      return `Can save here${freeText(facts)}`;
    case 'room':
      return typeof facts?.needed === 'number' && typeof facts.free === 'number' ? `${size(facts.needed)} needed · ${size(facts.free)} free` : 'Ready';
    case 'port':
      return `${facts?.port} is free`;
    case 'downloads':
      return 'Frameleaf’s download server answered';
    case 'memory':
      return typeof facts?.bytes === 'number' ? gigabytes(facts.bytes) : 'Ready';
    case 'containers':
      return 'Can be applied';
    case 'release':
      return 'Verified';
  }
  return 'Ready';
}

/** Every check as the step shows it: what needs attention carries a title, why, and the fix for this host. */
export function checkRows(results: CheckResult[], context: CheckContext): CheckRow[] {
  return results.map((result) => {
    const label = CHECK_LABELS[result.id] ?? result.id;
    if (result.status === 'ok') return { id: result.id, label, status: 'ok', value: value(result, context.host) };
    const words = result.status === 'problem' ? problem(result, context) : notice(result, context);
    return { id: result.id, label, status: result.status, ...words };
  });
}

/** What needs attention, problems first; then what is fine. */
export const attention = (rows: CheckRow[]) =>
  rows.filter((row) => row.status !== 'ok').sort((a, b) => (a.status === 'problem' ? 0 : 1) - (b.status === 'problem' ? 0 : 1));

/**
 * What the step says once every check has finished. Only a problem stops the install. The prototype's words are
 * for an install, which an import also is; a restore says what it does.
 */
export function checkSummary(rows: CheckRow[], flow: 'install' | 'import' | 'restore' = 'install') {
  const doing = flow === 'restore' ? 'restoring' : 'installing',
    can = flow === 'restore' ? 'restore' : 'install';
  const problems = rows.filter((row) => row.status === 'problem').length;
  const notes = rows.filter((row) => row.status === 'warning' || row.status === 'unknown').length;
  if (problems)
    return {
      problems,
      notes,
      title: `${problems === 1 ? '1 thing' : `${problems} things`} to fix before ${doing}`,
      lead: 'Nothing has been downloaded or changed yet. Fix these, then check again.',
    };
  if (notes)
    return { problems, notes, title: 'This server is ready', lead: `Frameleaf can ${can}. ${notes === 1 ? 'There’s one thing' : `There are ${notes} things`} worth knowing first.` };
  return { problems, notes, title: 'This server is ready', lead: 'Manager checked Docker, storage, the network and the signed release.' };
}
