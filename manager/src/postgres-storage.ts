import { chmod, access, lstat, mkdtemp, open, readFile, realpath, statfs } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { Refusal, type Installation } from './contracts.js';
import { environment, overlap, type Container, type Docker } from './docker.js';

const within = (path: string, parent: string) =>
  path === parent || path.startsWith(parent === '/' ? '/' : parent + '/');
const unescapeMount = (value: string) =>
  value.replace(/\\(040|011|012|134)/g, (_, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
export type FilesystemMount = {
  target: string;
  root: string;
  device: string;
  type: string;
  source: string;
  options: string[];
};
export function filesystemMounts(contents: string): FilesystemMount[] {
  return contents
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [before, after] = line.split(' - '),
        fields = before.split(' '),
        filesystem = after?.split(' ');
      if (fields.length < 6 || !filesystem || filesystem.length < 3) throw new Refusal('invalid_mount_information');
      return {
        target: unescapeMount(fields[4]),
        root: unescapeMount(fields[3]),
        device: fields[2],
        options: fields[5].split(','),
        type: filesystem[0],
        source: unescapeMount(filesystem[1]),
      };
    });
}

/** Evidence is the host engine's bind mapping AND the running Manager's kernel mount table. */
export function databaseMount(
  path: string,
  roots: string[],
  dockerRoot: string,
  manager: Container,
  mounts: FilesystemMount[],
  hostMounts: FilesystemMount[],
  unraid: boolean,
): FilesystemMount {
  if (!path.startsWith('/') || path !== resolve(path) || /[\x00-\x1f\x7f,:]/.test(path))
    throw new Refusal('invalid_database_path');
  if (!roots.some((root) => within(path, root))) throw new Refusal('database_path_not_mounted');
  if (!dockerRoot.startsWith('/') || overlap(path, dockerRoot)) throw new Refusal('database_in_docker_storage');
  const mapping = manager.Mounts.filter((m) => within(path, m.Destination)).sort(
    (a, b) => b.Destination.length - a.Destination.length,
  )[0];
  if (!mapping || mapping.Type !== 'bind' || !mapping.RW || mapping.Source !== mapping.Destination)
    throw new Refusal('database_requires_host_bind');
  const mount = mounts.filter((m) => within(path, m.target)).sort((a, b) => b.target.length - a.target.length)[0];
  if (!mount || mount.options.includes('ro')) throw new Refusal('database_storage_unavailable');
  const identity = (location: string) => {
    const host = hostMounts
      .filter((m) => within(location, m.target))
      .sort((a, b) => b.target.length - a.target.length)[0];
    if (!host) throw new Refusal('host_mount_information_required');
    return { device: host.device, path: resolve(host.root, relative(host.target, location)) };
  };
  const hostDatabase = identity(path),
    hostDocker = identity(dockerRoot);
  if (hostDatabase.device !== mount.device) throw new Refusal('host_database_mount_changed');
  if (hostDatabase.device === hostDocker.device && overlap(hostDatabase.path, hostDocker.path))
    throw new Refusal('database_in_docker_storage');
  // shfs is Unraid's host share filesystem, outside docker.img. Do not rewrite its paths to /mnt/cache.
  const share = unraid && ['fuse.shfs', 'fuse.unraid'].includes(mount.type) && mount.source === 'shfs';
  const localDisk =
    ['ext4', 'xfs', 'btrfs', 'zfs'].includes(mount.type) &&
    (mount.source.startsWith('/dev/') || mount.type === 'zfs') &&
    !/^\/dev\/(?:loop|ram|zram)/.test(mount.source);
  if (!localDisk && !share) throw new Refusal('database_requires_disk_storage');
  // Reject aliases of Docker's mounted image and bind paths into the Docker data root.
  if (
    mounts.some(
      (m) =>
        within(dockerRoot, m.target) && m.target !== '/' && m.device === mount.device && /^\/dev\/loop/.test(m.source),
    )
  ) {
    throw new Refusal('database_in_docker_storage');
  }
  return mount;
}

export class PostgresStorage {
  constructor(
    private docker: Docker,
    private managerDirectory: string,
    readonly roots: string[],
    private unraid: boolean,
  ) {}
  private async evidence(path: string, installationId?: string): Promise<FilesystemMount> {
    const [containers, compatibility, mountinfo] = await Promise.all([
      this.docker.inventory(),
      this.docker.compatibility(),
      readFile('/proc/self/mountinfo', 'utf8'),
    ]);
    const controllers = containers.filter(
      (c) =>
        c.State.Running &&
        c.Config.Labels?.['app.frameleaf.manager.role'] === 'controller' &&
        environment(c).MANAGER_DATA === this.managerDirectory,
    );
    if (controllers.length !== 1) throw new Refusal('manager_host_mounts_unverified');
    if (
      !controllers[0].Mounts.some(
        (m) =>
          m.Type === 'bind' &&
          m.Source === '/proc/1/mountinfo' &&
          m.Destination === '/run/frameleaf-host/mountinfo' &&
          !m.RW,
      )
    )
      throw new Refusal('host_mount_information_required');
    const hostMounts = filesystemMounts(await readFile('/run/frameleaf-host/mountinfo', 'utf8'));
    if (
      containers.some(
        (c) =>
          c.Id !== controllers[0].Id &&
          (!installationId || c.Config.Labels?.['app.frameleaf.manager'] !== installationId) &&
          c.Mounts.some((m) => m.Source.startsWith('/') && within(path, m.Source)),
      )
    )
      throw new Refusal('database_overlaps_existing_container_data');
    const mount = databaseMount(
      path,
      this.roots,
      compatibility.dataRoot,
      controllers[0],
      filesystemMounts(mountinfo),
      hostMounts,
      this.unraid,
    );
    return mount;
  }
  async validate(
    path: string,
    bytes: number,
    installationId?: string,
  ): Promise<{ root: string; filesystem: string; device: string }> {
    const mount = await this.evidence(path, installationId);
    // Resolve only the explicitly selected folder. Never enumerate a share or follow a path outside a mounted root.
    const actual = await realpath(path).catch(() => {
      throw new Refusal('database_directory_missing');
    });
    if (actual !== path) throw new Refusal('database_path_changed');
    await access(path, constants.R_OK | constants.W_OK | constants.X_OK).catch(() => {
      throw new Refusal('database_permissions');
    });
    const space = await statfs(path);
    if (bytes > 0 && space.bavail * space.bsize < bytes + 1024 ** 3) throw new Refusal('insufficient_database_space');
    return { root: path, filesystem: mount.type, device: mount.device };
  }
  async allocate(root: string, installationId: string, bytes: number): Promise<string> {
    if (!/^[a-f0-9]{12}$/.test(installationId)) throw new Refusal('invalid_installation');
    await this.validate(root, bytes);
    // mkdtemp is exclusive. Import, restore and interrupted attempts never reuse source physical data.
    const path = await mkdtemp(join(root, 'frameleaf-' + installationId + '-postgres-'));
    if ((await realpath(path)) !== path) throw new Refusal('database_path_changed');
    // PG19's entrypoint owns only 19/docker, not this bind parent. Permit traversal
    // without directory listing or writes; PGDATA itself remains postgres-owned 0700.
    await chmod(path, 0o711);
    const parent = await open(root, 'r');
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
    return path;
  }
  async verify(installation: Installation): Promise<void> {
    const child = relative(installation.databaseRoot, installation.databasePath);
    if (!new RegExp('^frameleaf-' + installation.id + '-postgres-[A-Za-z0-9]+$').test(child))
      throw new Refusal('invalid_database_directory');
    // PGDATA becomes postgres-owned 0700. Manager needs access to its parent, never its contents.
    await this.validate(installation.databaseRoot, 0, installation.id);
    await this.evidence(installation.databasePath, installation.id);
    const data = await lstat(installation.databasePath);
    if (
      !data.isDirectory() ||
      data.isSymbolicLink() ||
      (await realpath(installation.databasePath)) !== installation.databasePath
    )
      throw new Refusal('database_path_changed');
  }
}
