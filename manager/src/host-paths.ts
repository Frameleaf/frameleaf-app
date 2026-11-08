import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

/**
 * Manager works in the paths it sees inside its own container; Docker needs the host's. These two views differ when
 * an administrator maps a folder to another container path (Unraid's Community Applications rewrites only the host
 * side of a template to a custom appdata location). Every translation happens at the Docker boundary.
 *
 * ponytail: one process-wide table, because a Manager process has exactly one set of mounts. A foreign container bound
 * to a host folder that shares a name with one of Manager's container paths would be mistranslated on the way out.
 */
type Mapping = { host: string; container: string };
type MountView = { Type: string; Source: string; Destination: string };
type ControllerView = {
  State: { Running: boolean };
  Config: { Env: string[]; Labels: Record<string, string> };
  Mounts: MountView[];
};

let mappings: Mapping[] = [];

const inside = (path: string, parent: string) => path === parent || path.startsWith(`${parent}/`);
function swap(path: string, from: 'host' | 'container', to: 'host' | 'container'): string {
  const mapping = mappings
    .filter((m) => inside(path, m[from]))
    .sort((a, b) => b[from].length - a[from].length)[0];
  return mapping ? mapping[to] + path.slice(mapping[from].length) : path;
}
export const toHost = (path: string) => swap(path, 'container', 'host');
export const toContainer = (path: string) => swap(path, 'host', 'container');

/** A container as Manager's own filesystem sees it, so mount comparisons stay in one set of paths. */
export function containerView<T extends { Mounts: MountView[] }>(container: T): T {
  if (!mappings.length) return container;
  return {
    ...container,
    Mounts: container.Mounts.map((m) => {
      if (m.Type !== 'bind') return m;
      // One host folder can be mapped to two container paths; each of Manager's own mounts keeps its own.
      const own = mappings.some((x) => x.host === m.Source && x.container === m.Destination);
      return { ...m, Source: own ? m.Destination : toContainer(m.Source) };
    }),
  };
}

const LOCATION_VARIABLES = [
  'MANAGER_BACKUP_ROOT',
  'MANAGER_STORAGE_ROOTS',
  'MANAGER_DATABASE_ROOTS',
  'MANAGER_APPDATA_ROOT',
  'MANAGER_MOUNT_ROOTS',
];

/** Learn this Manager's mappings. A location given by its host path is corrected to where the container sees it. */
export function adoptOwnMounts(
  containers: ControllerView[],
  state: string,
  env: Record<string, string | undefined> = process.env,
): void {
  const self = containers.filter(
    (c) =>
      c.State.Running &&
      c.Config.Labels?.['app.frameleaf.manager.role'] === 'controller' &&
      c.Config.Env?.includes(`MANAGER_DATA=${state}`),
  );
  if (self.length !== 1) {
    console.error(`manager: found ${self.length} running Manager containers for ${state}; folder mappings were not read`);
    return;
  }
  mappings = self[0].Mounts.filter(
    (m) =>
      m.Type === 'bind' &&
      m.Source !== m.Destination &&
      m.Source.startsWith('/') &&
      !inside(m.Destination, '/run/frameleaf-host'),
  ).map((m) => ({ host: m.Source, container: m.Destination }));
  // The state store is already open by now, and a path that is only the host side would be lost with the container.
  const misplaced = mappings.find((m) => inside(state, m.host));
  if (misplaced && !self[0].Mounts.some((m) => inside(state, m.Destination)))
    throw new Error(`MANAGER_DATA is ${state}, the host side of a folder mapping. Set it to ${toContainer(state)}.`);
  for (const name of LOCATION_VARIABLES) {
    if (env[name]) env[name] = env[name]!.split(':').map(toContainer).join(':');
  }
}

/** Rewrite the bind sources of one `docker` invocation, including the Compose file it reads, for the host. */
export async function dockerArguments(args: string[], cwd?: string): Promise<string[]> {
  if (!mappings.length) return args;
  const translated = args.map((arg) =>
    arg.startsWith('type=bind,')
      ? arg.replace(/(^|,)(src|source)=([^,]+)/, (_, lead, key, path) => `${lead}${key}=${toHost(path)}`)
      : arg,
  );
  const flag = translated.indexOf('--file');
  if (translated[0] !== 'compose' || flag < 0 || !cwd) return translated;
  const file = resolve(cwd, translated[flag + 1]);
  const compose = JSON.parse(await readFile(file, 'utf8')) as {
    services: Record<string, { volumes?: ({ type?: string; source?: string } | string)[] }>;
  };
  for (const service of Object.values(compose.services)) {
    for (const volume of service.volumes ?? []) {
      if (typeof volume === 'object' && volume.type === 'bind' && volume.source) volume.source = toHost(volume.source);
    }
  }
  const hostFile = join(dirname(file), `host-${basename(file)}`);
  await writeFile(hostFile, JSON.stringify(compose), { mode: 0o600 });
  translated[flag + 1] = hostFile;
  return translated;
}
