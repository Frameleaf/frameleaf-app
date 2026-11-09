import { access, readFile } from 'node:fs/promises';
import { totalmem } from 'node:os';
import { command, environment, type Docker } from './docker.js';
import { containerId } from './contracts.js';
import { DOCKERMAN_TEMPLATES } from './dockerman.js';
import { freeBytes } from './server-check.js';
import type { Acceleration } from './compose.js';

/**
 * FL-1318 What Check this server asks the host itself, beyond Docker's own answers. Each probe answers null (or
 * false) when it can't tell, so its check reports "couldn't check" and never blocks.
 */
export type HostProbes = {
  /** Free bytes in Docker's storage: Manager's own root filesystem is a layer there. Null when it can't be read. */
  dockerFree(): Promise<number | null>;
  /** True when `url`'s server answers at all (any HTTP status). */
  reaches(url: string): Promise<boolean>;
  /** Which of `ports` nothing on the host itself is listening on. Null when the helper can't run. */
  hostFreePorts(ports: number[]): Promise<number[] | null>;
  /** Unraid: the DockerMan templates folder is mapped into Manager. */
  dockermanMapped(): Promise<boolean>;
  /** The host's memory when Docker couldn't say (a container sees the host's total). Null when unknown. */
  memory(): number | null;
};

const GB = 1024 ** 3;
/**
 * Docker storage each image needs: unpacked, plus room for its download while it unpacks. The CPU images measure
 * about 2.4 GB (server), 0.65 GB (database) and 4 GB (machine learning) unpacked; GPU builds are larger.
 */
export const IMAGE_ROOM = { server: 3 * GB, postgres: GB, ml: { cpu: 4 * GB, openvino: 6 * GB, cuda: 10 * GB, rocm: 30 * GB } };
/** Docker storage this install needs: smaller without machine learning. */
export const dockerRoomNeeded = (ml: boolean, acceleration: Acceleration = 'cpu') =>
  IMAGE_ROOM.server + IMAGE_ROOM.postgres + (ml ? IMAGE_ROOM.ml[acceleration] : 0);
/**
 * Below this, faces and smart search can run out of memory. Docker reports the memory the kernel can use, which on a
 * machine sold as 8 GB is about 7.6 GB, so the line sits just under that.
 */
export const LOW_MEMORY = 7.5 * GB;
/** Where Frameleaf is downloaded from: the images (ghcr.io) and the signed release bundle (github.com). */
export const DOWNLOAD_HOSTS = ['ghcr.io', 'github.com'] as const;
const DOWNLOAD_URLS: Record<(typeof DOWNLOAD_HOSTS)[number], string> = { 'ghcr.io': 'https://ghcr.io/v2/', 'github.com': 'https://github.com/' };
export const downloadUrl = (host: (typeof DOWNLOAD_HOSTS)[number]) => DOWNLOAD_URLS[host];

/** Filesystems whose free space, seen from inside a container, is Docker's own storage. */
const LAYERED = new Set(['overlay', 'fuse-overlayfs', 'btrfs', 'zfs']);
/** Manager's root is a layer in Docker's storage when it runs in a container on a layered driver. */
export async function dockerStorageFree(mounts = '/proc/self/mounts', marker = '/.dockerenv', free = freeBytes): Promise<number | null> {
  if (!(await access(marker).then(() => true, () => false))) return null;
  const root = (await readFile(mounts, 'utf8').catch(() => ''))
    .split('\n')
    .map((line) => line.split(' '))
    .filter((fields) => fields[1] === '/')
    .at(-1);
  return root && LAYERED.has(root[2]) ? free('/') : null;
}

/** Tries to listen on each port on the host's own network, and reports the ones it could. */
export const hostPortScript = String.raw`
const net = require('node:net');
const ports = JSON.parse(process.argv[1]);
const free = (port) => new Promise((resolve) => {
  const server = net.createServer();
  server.once('error', () => resolve(false));
  server.listen({ port, host: '0.0.0.0', exclusive: true }, () => server.close(() => resolve(true)));
});
(async () => {
  const open = [];
  for (const port of ports) if (await free(port)) open.push(port);
  process.stdout.write(JSON.stringify(open));
})().catch(() => process.stdout.write('null'));
`;

/** The real probes. The port helper runs Manager's own image on the host network, as HostAutostart does. */
export function hostProbes(docker: Docker, directory: string, execute: typeof command = command): HostProbes {
  return {
    dockerFree: () => dockerStorageFree(),
    reaches: (url) =>
      fetch(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(10_000) }).then(() => true, () => false),
    dockermanMapped: () => access(DOCKERMAN_TEMPLATES).then(() => true, () => false),
    memory: () => totalmem() || null,
    hostFreePorts: async (ports) => {
      try {
        const containers = await docker.inventory();
        const controllers = containers.filter(
          (c) => c.State.Running && c.Config.Labels?.['app.frameleaf.manager.role'] === 'controller' && environment(c).MANAGER_DATA === directory,
        );
        if (controllers.length !== 1 || !/^sha256:[a-f0-9]{64}$/.test(controllers[0].Image)) return null;
        // A helper left by a Manager restart mid-check is removed first.
        for (const helper of containers.filter((c) => c.Config.Labels?.['app.frameleaf.manager.portcheck'] === directory))
          await execute('docker', ['rm', '--force', containerId.parse(helper.Id)]);
        const output = await execute('docker', [
          'run', '--rm', '--pull', 'never', '--network', 'host', '--read-only',
          '--label', `app.frameleaf.manager.portcheck=${directory}`,
          '--security-opt', 'no-new-privileges', '--cap-drop', 'ALL', '--pids-limit', '32', '--memory', '128m',
          '--entrypoint', 'node', controllers[0].Image, '-e', hostPortScript, JSON.stringify(ports),
        ], { timeout: 30_000 });
        const open = JSON.parse(output.trim());
        return Array.isArray(open) && open.every((port) => Number.isInteger(port)) ? open : null;
      } catch {
        return null;
      }
    },
  };
}
