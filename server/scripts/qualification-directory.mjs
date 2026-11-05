import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync } from 'node:fs';

// Let a container's own account (for example www-data) write a bind-mounted path without root on the runner.
// The run's TMPDIR is created 0700, so the wider mode is only reachable through the container mount.
export const shareWithContainer = (path, mode = 0o777) => chmodSync(path, mode);

// Applications write files as their own accounts, which an unprivileged CI runner cannot delete. Hand the run
// directory back to the runner through a root container of an image this run already has; call it before any
// image is removed. Nothing is needed when the runner is root or no listed image is present (nothing ran).
export function reclaimQualificationDirectory(directory, images) {
  if (process.getuid() === 0 || !existsSync(directory)) return;
  const image = images.find(
    (candidate) => spawnSync('docker', ['image', 'inspect', candidate], { stdio: 'ignore' }).status === 0,
  );
  if (!image) return;
  const result = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      'none',
      '--user',
      '0:0',
      '--entrypoint',
      'chown',
      '--mount',
      `type=bind,source=${directory},target=/reclaim`,
      image,
      '-R',
      `${process.getuid()}:${process.getgid()}`,
      '/reclaim',
    ],
    { encoding: 'utf8', timeout: 120_000 },
  );
  if (result.status !== 0) throw new Error('Qualification directory ownership could not be reclaimed');
}
