import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

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
  Id: string;
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
export function containerView<T extends { Mounts: MountView[]; Config?: { Env: string[]; Labels: Record<string, string> } }>(
  container: T,
): T {
  if (!mappings.length) return container;
  const controller = container.Config?.Labels?.['app.frameleaf.manager.role'] === 'controller';
  return {
    ...container,
    // adoptOwnMounts may have corrected this Manager's own state path; comparisons must see the corrected value.
    ...(controller && {
      Config: {
        ...container.Config!,
        Env: container.Config!.Env.map((e) =>
          e.startsWith('MANAGER_DATA=') ? `MANAGER_DATA=${corrected(e.slice('MANAGER_DATA='.length))}` : e,
        ),
      },
    }),
    Mounts: container.Mounts.map((m) => {
      if (m.Type !== 'bind') return m;
      // One host folder can be mapped to two container paths; each of Manager's own mounts keeps its own.
      const own = mappings.some((x) => x.host === m.Source && x.container === m.Destination);
      return { ...m, Source: own ? m.Destination : toContainer(m.Source) };
    }),
  };
}

const shown = (path: string) => (toHost(path) === path ? path : `${path} (${toHost(path)} on your server)`);
/** Names the refused folder and the usable ones, so a refusal says what to change. */
export const folderDetail = (path: string, roots: string[] = []) =>
  `Folder: ${path ? shown(path) : 'none chosen'}.` + (roots.length ? ` Folders Manager can use: ${roots.map(shown).join(', ')}.` : '');

/** A path Manager can already reach stays put, even if a host folder has the same name. */
const corrected = (path: string) => (mappings.some((m) => inside(path, m.container)) ? path : toContainer(path));

const LOCATION_VARIABLES = [
  'MANAGER_BACKUP_ROOT',
  'MANAGER_STORAGE_ROOTS',
  'MANAGER_DATABASE_ROOTS',
  'MANAGER_APPDATA_ROOT',
  'MANAGER_MOUNT_ROOTS',
];

/** Unraid's folder picker adds a trailing slash, which the exact path checks would otherwise refuse. */
export function tidyLocations(env: Record<string, string | undefined> = process.env): void {
  for (const name of LOCATION_VARIABLES) {
    if (env[name]) {
      env[name] = env[name]!.split(':').filter(Boolean).map((p) => (isAbsolute(p) ? resolve(p) : p)).join(':');
    }
  }
}

/**
 * The running Manager containers using this state path. Two Managers can share a container path once host and
 * container paths may differ, so Docker's default hostname, the container's short id, picks out this one.
 */
export function ownControllers<T extends Pick<ControllerView, 'Id' | 'State' | 'Config'>>(
  containers: T[],
  state: string,
  hostname = process.env.HOSTNAME,
): T[] {
  const matches = containers.filter(
    (c) =>
      c.State.Running &&
      c.Config.Labels?.['app.frameleaf.manager.role'] === 'controller' &&
      c.Config.Env?.includes(`MANAGER_DATA=${state}`),
  );
  const self = hostname ? matches.filter((c) => c.Id.startsWith(hostname)) : [];
  return self.length === 1 ? self : matches;
}

/** Learn this Manager's mappings. A location given by its host path is corrected to where the container sees it. */
export function adoptOwnMounts(
  containers: ControllerView[],
  state: string,
  env: Record<string, string | undefined> = process.env,
): void {
  const self = ownControllers(containers, state, env.HOSTNAME);
  if (self.length !== 1) {
    console.error(`manager: found ${self.length} running Manager containers for ${state}; folder mappings were not read`);
    return;
  }
  // Identity binds stay in the table so a nested one wins over a differing parent; none differing means no translation.
  const binds = self[0].Mounts.filter(
    (m) => m.Type === 'bind' && m.Source.startsWith('/') && !inside(m.Destination, '/run/frameleaf-host'),
  ).map((m) => ({ host: m.Source, container: m.Destination }));
  mappings = binds.some((m) => m.host !== m.container) ? binds : [];
  // Runs before the state store opens: a host-side state path would otherwise be lost with the container.
  if (toContainer(state) !== state && !self[0].Mounts.some((m) => inside(state, m.Destination)))
    env.MANAGER_DATA = toContainer(state);
  for (const name of LOCATION_VARIABLES) {
    // A path Manager can already reach is a container path, even if a host folder has the same name.
    const reachable = (path: string) => self[0].Mounts.some((m) => inside(path, m.Destination));
    if (!env[name]) continue;
    env[name] = env[name]!.split(':').map((p) => (reachable(p) ? p : toContainer(p))).join(':');
    for (const path of env[name]!.split(':')) {
      if (!reachable(path)) console.error(`manager: ${name} is ${path}, which is not mapped into this container; map a folder there`);
    }
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
