import { command, environment, type Docker } from './docker.js';
import { containerId } from './contracts.js';

/**
 * FL-1322 Resolves host paths as the host sees them, links included, under a read-only mapping of the host's `/`
 * at argv[1]. A link's absolute target is followed inside that root, never in the helper's own filesystem. A path
 * whose tail does not exist yet resolves its existing part and keeps the rest; any other error answers null.
 */
export const hostRealpathScript = String.raw`
const fs = require('node:fs'), { posix } = require('node:path');
const [root, list] = process.argv.slice(1);
const resolve = (path) => {
  let parts = path.split('/').filter(Boolean), done = '/', hops = 0;
  while (parts.length) {
    const part = parts.shift();
    if (part === '.') continue;
    if (part === '..') { done = posix.dirname(done); continue; }
    const next = posix.join(done, part);
    let entry;
    try { entry = fs.lstatSync(root + next); } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return posix.join(next, ...parts);
      throw error;
    }
    if (entry.isSymbolicLink()) {
      if (++hops > 40) throw new Error('ELOOP');
      const target = fs.readlinkSync(root + next);
      parts = [...target.split('/').filter(Boolean), ...parts];
      if (target.startsWith('/')) done = '/';
      continue;
    }
    done = next;
  }
  return done;
};
process.stdout.write(JSON.stringify(JSON.parse(list).map((path) => { try { return resolve(path); } catch { return null; } })));
`;

/** Each path's real location on the host (null where it can't be told), or null when the helper can't run. */
export type HostRealpaths = (paths: string[]) => Promise<(string | null)[] | null>;

/** Runs the resolver in Manager's own image with the host's `/` mapped read-only, no network and no write access. */
export function hostRealpaths(docker: Docker, directory: string, execute: typeof command = command): HostRealpaths {
  return async (paths) => {
    try {
      const containers = await docker.inventory();
      const controllers = containers.filter(
        (c) => c.State.Running && c.Config.Labels?.['app.frameleaf.manager.role'] === 'controller' && environment(c).MANAGER_DATA === directory,
      );
      if (controllers.length !== 1 || !/^sha256:[a-f0-9]{64}$/.test(controllers[0].Image)) return null;
      // A helper left by a Manager restart mid-check is removed first.
      for (const helper of containers.filter((c) => c.Config.Labels?.['app.frameleaf.manager.pathcheck'] === directory))
        await execute('docker', ['rm', '--force', containerId.parse(helper.Id)]);
      const output = await execute('docker', [
        'run', '--rm', '--pull', 'never', '--network', 'none', '--read-only',
        '--label', `app.frameleaf.manager.pathcheck=${directory}`,
        '--volume', '/:/host:ro',
        // Reading folders other users own (an app's 0700 data) needs only DAC_READ_SEARCH; nothing can be written.
        '--security-opt', 'no-new-privileges', '--cap-drop', 'ALL', '--cap-add', 'DAC_READ_SEARCH',
        '--pids-limit', '32', '--memory', '128m',
        '--entrypoint', 'node', controllers[0].Image, '-e', hostRealpathScript, '/host', JSON.stringify(paths),
      ], { timeout: 60_000 });
      const resolved = JSON.parse(output.trim());
      return Array.isArray(resolved) && resolved.length === paths.length &&
        resolved.every((path) => path === null || (typeof path === 'string' && path.startsWith('/')))
        ? resolved
        : null;
    } catch {
      return null;
    }
  };
}
