import { posix, resolve } from 'node:path';
import { containerId, digest, Refusal, type Mount, type SourceFence } from './contracts.js';
import { databaseCandidates, sourceFingerprint } from './discovery.js';
import { environment, type Container } from './docker.js';

/**
 * FL-1149: other self-hosted photo apps the Manager can import (shown as Beta). Apps are recognised by image
 * repository, never by a pinned digest; an untested version imports best effort and the review says so.
 */
export const photoAppKinds = [
  'photoprism',
  'photoview',
  'pigallery2',
  'lychee',
  'nextcloud',
  'piwigo',
  'librephotos',
] as const;
export type PhotoAppKind = (typeof photoAppKinds)[number];
export type PhotoAppDatabase = 'sqlite' | 'mysql' | 'postgres' | 'unknown';
type ServerEngine = 'mysql' | 'postgres';

export const photoAppNames: Record<PhotoAppKind, string> = {
  photoprism: 'PhotoPrism',
  photoview: 'Photoview',
  pigallery2: 'PiGallery2',
  lychee: 'Lychee',
  nextcloud: 'Nextcloud',
  piwigo: 'Piwigo',
  librephotos: 'LibrePhotos',
};
/** The databases each server-side preparation adapter reads (server/src/library-import/preparation/<kind>.ts). */
export const photoAppDatabases: Record<PhotoAppKind, PhotoAppDatabase[]> = {
  photoprism: ['sqlite', 'mysql'],
  photoview: ['sqlite'],
  pigallery2: ['sqlite', 'mysql'],
  lychee: ['sqlite'],
  nextcloud: ['sqlite'],
  piwigo: ['mysql'],
  librephotos: ['postgres'],
};
const repositories: [RegExp, PhotoAppKind][] = [
  [/^photoprism\/photoprism$/u, 'photoprism'],
  [/^(?:photoview|viktorstrate)\/photoview$/u, 'photoview'],
  [/^bpatrik\/pigallery2$/u, 'pigallery2'],
  [/^(?:lycheeorg\/lychee(?:-laravel)?|linuxserver\/lychee)$/u, 'lychee'],
  [/^(?:nextcloud|linuxserver\/nextcloud)$/u, 'nextcloud'],
  [/^linuxserver\/piwigo$/u, 'piwigo'],
  [/^reallibrephotos\/librephotos(?:-backend)?$/u, 'librephotos'],
];

/** `ghcr.io/linuxserver/lychee:6.1@sha256:…` → `{ repository: 'linuxserver/lychee', tag: '6.1' }`. */
export function imageRepository(reference: string): {
  repository: string;
  tag: string | null;
} {
  let name = reference.split('@')[0];
  const slash = name.lastIndexOf('/'),
    colon = name.lastIndexOf(':');
  const tag = colon > slash ? name.slice(colon + 1) : null;
  if (colon > slash) name = name.slice(0, colon);
  const parts = name.toLowerCase().split('/');
  if (parts.length > 1 && (parts[0].includes('.') || parts[0].includes(':') || parts[0] === 'localhost')) parts.shift();
  if (parts.length > 1 && parts[0] === 'library') parts.shift();
  return { repository: parts.join('/'), tag: tag || null };
}
export function photoAppKind(container: Container): PhotoAppKind | null {
  const { repository } = imageRepository(container.Config.Image ?? '');
  return repositories.find(([pattern]) => pattern.test(repository))?.[1] ?? null;
}
/** A version-like image tag, else the image's OCI version label; `latest` and similar say nothing. */
export function photoAppVersion(container: Container): string | null {
  const { tag } = imageRepository(container.Config.Image ?? '');
  const label = container.Config.Labels?.['org.opencontainers.image.version'];
  for (const value of [tag, label]) if (value && /\d/u.test(value) && /^[\w.+-]{1,128}$/u.test(value)) return value;
  return null;
}
// Nextcloud's background-job sibling runs the same image; it is a writer, not a separate source.
const secondary = (container: Container) =>
  [...(container.Config.Entrypoint ?? []), ...(container.Config.Cmd ?? [])].some((part) =>
    /cron\.sh|busybox crond/u.test(part),
  );
const project = (container: Container) => container.Config.Labels?.['com.docker.compose.project'] ?? null;

type ServerConfig = {
  engine: ServerEngine;
  host: string | null;
  name?: string;
  user?: string;
  password?: string;
};
type DatabaseConfig = { engine: 'sqlite'; path: string } | ServerConfig | { engine: 'unknown' };
type AppLayout = { originals: string[]; database: DatabaseConfig };
/** Reads one small text file the app container sees at `path`; null when it cannot be read. */
export type ContainerFileReader = (container: Container, path: string) => Promise<string | null>;

const absolute = (value: string | undefined, base: string) =>
  !value ? null : value.startsWith('/') ? posix.normalize(value) : posix.join(base, value);
/** Go MySQL DSN, `user:pass@tcp(host:3306)/name?…`. */
function goDsn(value: string | undefined): Omit<ServerConfig, 'engine'> | null {
  const match = /^(?:([^:@/]*)(?::([^@]*))?@)?(?:tcp\(([^)]*)\))?\/([^?]*)/u.exec(value ?? '');
  if (!match) return null;
  return {
    user: match[1] || undefined,
    password: match[2],
    host: match[3]?.split(':')[0] || null,
    name: match[4] || undefined,
  };
}
function urlConfig(value: string | undefined): Omit<ServerConfig, 'engine'> | null {
  try {
    const url = new URL(value ?? '');
    return {
      host: url.hostname || null,
      user: decodeURIComponent(url.username) || undefined,
      password: url.password ? decodeURIComponent(url.password) : undefined,
      name: decodeURIComponent(url.pathname.slice(1)) || undefined,
    };
  } catch {
    return null;
  }
}
const engineOf = (driver: string | undefined): ServerEngine | 'sqlite' | null => {
  const value = (driver ?? '').toLowerCase();
  if (['sqlite', 'sqlite3'].includes(value)) return 'sqlite';
  if (['mysql', 'mariadb', 'mysqli'].includes(value)) return 'mysql';
  if (['postgres', 'postgresql', 'pgsql'].includes(value)) return 'postgres';
  return null;
};
const phpValue = (text: string, pattern: string) =>
  new RegExp(`${pattern}\\s*=>?\\s*(['"])((?:\\\\.|(?!\\1).)*)\\1`, 'u').exec(text)?.[2]?.replaceAll(/\\(.)/gu, '$1');

async function layout(kind: PhotoAppKind, container: Container, read: ContainerFileReader): Promise<AppLayout> {
  const env = environment(container);
  switch (kind) {
    case 'photoprism': {
      const storage = env.PHOTOPRISM_STORAGE_PATH || '/photoprism/storage';
      const originals = [env.PHOTOPRISM_ORIGINALS_PATH || '/photoprism/originals'];
      const driver = engineOf(env.PHOTOPRISM_DATABASE_DRIVER || 'sqlite');
      if (driver === 'sqlite') {
        const dsn = (env.PHOTOPRISM_DATABASE_DSN ?? '').split('?')[0];
        const path = dsn === '' || dsn === 'index.db' ? `${storage}/index.db` : dsn.startsWith('/') ? dsn : null;
        return {
          originals,
          database: path ? { engine: 'sqlite', path } : { engine: 'unknown' },
        };
      }
      if (driver === 'mysql') {
        const dsn = goDsn(env.PHOTOPRISM_DATABASE_DSN);
        return {
          originals,
          database: {
            engine: 'mysql',
            host: (env.PHOTOPRISM_DATABASE_SERVER ?? '').split(':')[0] || dsn?.host || null,
            name: env.PHOTOPRISM_DATABASE_NAME || dsn?.name || 'photoprism',
            user: env.PHOTOPRISM_DATABASE_USER || dsn?.user || 'photoprism',
            password: env.PHOTOPRISM_DATABASE_PASSWORD ?? dsn?.password,
          },
        };
      }
      return {
        originals,
        database: { engine: driver ?? 'unknown', host: null } as DatabaseConfig,
      };
    }
    case 'photoview': {
      const driver = engineOf(env.PHOTOVIEW_DATABASE_DRIVER || 'mysql');
      const originals = ['/photos'];
      if (driver === 'sqlite') {
        const path = absolute(env.PHOTOVIEW_SQLITE_PATH, '/app');
        return {
          originals,
          database: path ? { engine: 'sqlite', path } : { engine: 'unknown' },
        };
      }
      if (driver === 'mysql')
        return {
          originals,
          database: {
            engine: 'mysql',
            ...(goDsn(env.PHOTOVIEW_MYSQL_URL) ?? { host: null }),
          },
        };
      if (driver === 'postgres')
        return {
          originals,
          database: {
            engine: 'postgres',
            ...(urlConfig(env.PHOTOVIEW_POSTGRES_URL) ?? { host: null }),
          },
        };
      return { originals, database: { engine: 'unknown' } };
    }
    case 'pigallery2': {
      const setting = (name: string) =>
        Object.entries(env).find(([key]) => new RegExp(`^(?:server-)?${name}$`, 'iu').test(key))?.[1];
      let config: any = {};
      try {
        config = JSON.parse((await read(container, '/app/data/config/config.json')) ?? '{}');
      } catch {
        config = {};
      }
      const database = config?.Database ?? config?.Server?.Database ?? {};
      const media = config?.Media ?? config?.Server?.Media ?? {};
      const originals = [absolute(setting('Media-folder') ?? media.folder, '/app/data') ?? '/app/data/images'];
      const driver = engineOf(setting('Database-type') ?? database.type ?? 'sqlite');
      if (driver === 'sqlite') {
        const folder = absolute(setting('Database-dbFolder') ?? database.dbFolder, '/app/data') ?? '/app/data/db';
        return {
          originals,
          database: { engine: 'sqlite', path: `${folder}/sqlite.db` },
        };
      }
      if (driver === 'mysql') {
        const mysql = database.mysql ?? {};
        return {
          originals,
          database: {
            engine: 'mysql',
            host: setting('Database-mysql-host') ?? mysql.host ?? null,
            name: setting('Database-mysql-database') ?? mysql.database,
            user: setting('Database-mysql-username') ?? mysql.username,
            password: setting('Database-mysql-password') ?? mysql.password,
          },
        };
      }
      return { originals, database: { engine: 'unknown' } };
    }
    case 'lychee': {
      const linuxserver = imageRepository(container.Config.Image).repository.startsWith('linuxserver/');
      const originals = linuxserver ? ['/pictures'] : ['/app/public/uploads', '/uploads'];
      const driver = engineOf(env.DB_CONNECTION);
      if (driver === 'sqlite') {
        const path = absolute(env.DB_DATABASE || 'database/database.sqlite', '/app');
        return {
          originals,
          database: path ? { engine: 'sqlite', path } : { engine: 'unknown' },
        };
      }
      if (driver)
        return {
          originals,
          database: {
            engine: driver,
            host: env.DB_HOST || null,
            name: env.DB_DATABASE,
            user: env.DB_USERNAME,
            password: env.DB_PASSWORD,
          },
        };
      return { originals, database: { engine: 'unknown' } };
    }
    case 'nextcloud': {
      const linuxserver = imageRepository(container.Config.Image).repository.startsWith('linuxserver/');
      let config = '';
      for (const path of linuxserver
        ? ['/config/www/nextcloud/config/config.php']
        : ['/var/www/html/config/config.php'])
        config ||= (await read(container, path)) ?? '';
      const value = (key: string) => (config ? phpValue(config, `['"]${key}['"]`) : undefined);
      const dataDirectory =
        absolute(value('datadirectory') || env.NEXTCLOUD_DATA_DIR, '/') ??
        (linuxserver ? '/data' : '/var/www/html/data');
      const driver =
        engineOf(value('dbtype')) ??
        (env.SQLITE_DATABASE ? 'sqlite' : env.MYSQL_HOST ? 'mysql' : env.POSTGRES_HOST ? 'postgres' : null);
      const originals = [dataDirectory];
      if (driver === 'sqlite')
        return {
          originals,
          database: {
            engine: 'sqlite',
            path: `${dataDirectory}/${value('dbname') || env.SQLITE_DATABASE || 'nextcloud'}.db`,
          },
        };
      if (driver)
        return {
          originals,
          database: {
            engine: driver,
            host: (value('dbhost') || env.MYSQL_HOST || env.POSTGRES_HOST || '').split(':')[0] || null,
          },
        };
      return { originals, database: { engine: 'unknown' } };
    }
    case 'piwigo': {
      const originals = ['/gallery', '/config/www/gallery', '/var/www/html'];
      let config = '';
      for (const root of originals) config ||= (await read(container, `${root}/local/config/database.inc.php`)) ?? '';
      const value = (key: string) => (config ? phpValue(config, `\\$conf\\[['"]${key}['"]\\]`) : undefined);
      return {
        originals,
        database: {
          engine: 'mysql',
          host: (value('db_host') ?? '').split(':')[0] || null,
          name: value('db_base'),
          user: value('db_user'),
          password: value('db_password'),
        },
      };
    }
    case 'librephotos':
      return {
        originals: ['/data'],
        database: {
          engine: 'postgres',
          host: env.DB_HOST || 'db',
          name: env.DB_NAME,
          user: env.DB_USER,
          password: env.DB_PASS,
        },
      };
  }
}

/** The bind mount holding `path` (an app-container folder), with the host folder it maps to. */
function hostFolder(container: Container, path: string): { mount: Mount; path: string } {
  if (!path.startsWith('/') || path === '/' || posix.normalize(path) !== path)
    throw new Refusal('source_mount_unqualified');
  const containing = container.Mounts.filter(
    (m) => m.Destination === path || path.startsWith(`${m.Destination.replace(/\/$/u, '')}/`),
  );
  if (!containing.length) throw new Refusal('source_mount_missing');
  const depth = Math.max(...containing.map((m) => m.Destination.length));
  const best = containing.filter((m) => m.Destination.length === depth);
  const mount = best[0];
  if (best.length !== 1 || mount.Destination === '/') throw new Refusal('source_mount_unqualified');
  if (mount.Type !== 'bind') throw new Refusal('source_mount_unsupported');
  const host = mount.Source + path.slice(mount.Destination.length);
  if (
    mount.Source === '/' ||
    resolve(mount.Source) !== mount.Source ||
    resolve(host) !== host ||
    /[\x00-\x1f,]/u.test(host) ||
    // Every original must come from this one reviewed host folder.
    container.Mounts.some((other) => other !== mount && other.Destination.startsWith(`${path}/`))
  )
    throw new Refusal('source_mount_unqualified');
  return {
    mount: {
      type: 'bind',
      source: mount.Source,
      target: mount.Destination,
      readOnly: !mount.RW,
    },
    path: host,
  };
}

const mysqlImage = /(?:^|\/)(?:mariadb|mysql|percona(?:-server)?)$/u;
const postgresImage = /(?:^|\/)(?:postgres|postgis|pgvecto-rs|pgvector)$/u;
const userName = /^[A-Za-z0-9_.@-]{1,64}$/u;
const databaseName = /^[A-Za-z0-9_$-]{1,64}$/u;

/** Credentials stay in Manager memory and its private store; never in the journal, a log or a response. */
export type PhotoAppServerDatabase = {
  engine: ServerEngine;
  container: string;
  image: string;
  name: string;
  user: string;
  password: string;
};
export type PhotoAppSource = {
  container: string;
  kind: PhotoAppKind;
  name: string;
  version: string | null;
  database: PhotoAppDatabase;
  importable: boolean;
  reason?: string;
};
export type PhotoAppPlan = PhotoAppSource & {
  importable: true;
  fence: SourceFence;
  /** Host folder bound read-only at /import-media/source. */
  originalsPath: string;
  /** The app container's path for that folder (`sourceRootPath` in the preparation request). */
  sourceRootPath: string;
  sqlitePath?: string;
  server?: PhotoAppServerDatabase;
  /** App containers running when they were reviewed; cancelling starts them again. */
  running: string[];
};

function serverDatabase(app: Container, all: Container[], config: ServerConfig): PhotoAppServerDatabase {
  const host = config.host;
  if (!host || ['localhost', '127.0.0.1', '::1'].includes(host) || host.startsWith('/'))
    throw new Refusal('database_container_not_found');
  const candidates = databaseCandidates(app, all, host);
  if (candidates.length !== 1 || !containerId.safeParse(candidates[0].Id).success)
    throw new Refusal('database_container_not_found');
  const db = candidates[0];
  const { repository } = imageRepository(db.Config.Image ?? '');
  if (
    !(config.engine === 'mysql' ? mysqlImage : postgresImage).test(repository) ||
    !/^sha256:[a-f0-9]{64}$/u.test(db.Image)
  )
    throw new Refusal('database_image_unsupported');
  const env = environment(db);
  let user: string | undefined, password: string | undefined;
  if (config.engine === 'mysql') {
    const root = env.MARIADB_ROOT_PASSWORD ?? env.MYSQL_ROOT_PASSWORD;
    const emptyRoot = [env.MARIADB_ALLOW_EMPTY_ROOT_PASSWORD, env.MYSQL_ALLOW_EMPTY_PASSWORD].some(
      (v) => v && !['0', 'no', 'false'].includes(v.toLowerCase()),
    );
    if (root || emptyRoot) [user, password] = ['root', root ?? ''];
    else
      [user, password] = [
        env.MARIADB_USER ?? env.MYSQL_USER ?? config.user,
        env.MARIADB_PASSWORD ?? env.MYSQL_PASSWORD ?? config.password,
      ];
  } else {
    user = env.POSTGRES_USER ?? config.user ?? 'postgres';
    password = env.POSTGRES_PASSWORD ?? config.password ?? '';
  }
  const name =
    config.name ??
    (config.engine === 'mysql' ? (env.MARIADB_DATABASE ?? env.MYSQL_DATABASE) : (env.POSTGRES_DB ?? user));
  if (!user || password === undefined || !userName.test(user) || password.includes('\0'))
    throw new Refusal('database_credentials_unavailable');
  if (!name || !databaseName.test(name)) throw new Refusal('database_name_unsupported');
  return {
    engine: config.engine,
    container: db.Id,
    image: db.Image,
    name,
    user,
    password,
  };
}

/**
 * Work out one recognised app's fence and capture plan. Mount checks are the reviewed PhotoPrism SQLite rules,
 * generalised: every folder comes from exactly one canonical bind mount, with nothing mounted inside it.
 * Refusals carry the reason code the wizard shows.
 */
export async function identifyPhotoApp(
  app: Container,
  all: Container[],
  read: ContainerFileReader,
  recorded?: SourceFence,
): Promise<PhotoAppPlan> {
  const kind = photoAppKind(app);
  if (!kind || secondary(app) || !containerId.safeParse(app.Id).success) throw new Refusal('photo_app_not_recognised');
  const { originals, database } = await layout(kind, app, read);
  if (database.engine === 'unknown') throw new Refusal('database_unknown');
  if (!photoAppDatabases[kind].includes(database.engine)) throw new Refusal('database_unsupported');
  let media: { mount: Mount; path: string } | undefined,
    sourceRootPath = '';
  for (const candidate of originals) {
    try {
      media = hostFolder(app, candidate);
      sourceRootPath = candidate;
      break;
    } catch (error) {
      if (!(error instanceof Refusal && error.code === 'source_mount_missing') || candidate === originals.at(-1))
        throw error;
    }
  }
  const mounts = [media!.mount];
  let sqlitePath: string | undefined, server: PhotoAppServerDatabase | undefined;
  if (database.engine === 'sqlite') {
    const folder = hostFolder(app, posix.dirname(database.path));
    sqlitePath = `${folder.path}/${posix.basename(database.path)}`;
    if (folder.mount.source !== media!.mount.source) mounts.push(folder.mount);
  } else server = serverDatabase(app, all, database as ServerConfig);
  const [first, second] = mounts;
  if (second && (first.source.startsWith(second.source + '/') || second.source.startsWith(first.source + '/')))
    throw new Refusal('source_mount_unqualified');
  // Every container of this app in its Compose project writes the same library (Nextcloud's cron, for one).
  const workers = all.filter(
    (c) => c.Id === app.Id || (project(app) !== null && project(c) === project(app) && photoAppKind(c) === kind),
  );
  if (!workers.some((c) => c.Id === app.Id)) workers.unshift(app);
  const restartOf = (c: Container) => {
    const before = recorded?.restart[c.Id];
    return before && c.HostConfig.RestartPolicy.Name === 'no' ? before : c.HostConfig.RestartPolicy;
  };
  const containers = [...workers, ...(server ? [all.find((c) => c.Id === server.container)!] : [])];
  const fence: SourceFence = {
    id: digest([kind, app.Id]),
    containers: containers.map((c) => c.Id),
    workers: workers.map((c) => c.Id),
    mounts: mounts.sort((a, b) => a.target.localeCompare(b.target)),
    platform: app.Config.Labels?.['net.unraid.docker.managed'] ? 'unraid' : 'docker',
    restart: Object.fromEntries(workers.map((c) => [c.Id, restartOf(c)])),
    fingerprint: sourceFingerprint(
      containers.map((c) => ({
        ...c,
        HostConfig: {
          ...c.HostConfig,
          RestartPolicy: workers.includes(c) ? restartOf(c) : c.HostConfig.RestartPolicy,
        },
      })),
    ),
  };
  return {
    container: app.Id,
    kind,
    name: photoAppNames[kind],
    version: photoAppVersion(app),
    database: database.engine,
    importable: true,
    fence,
    originalsPath: media!.path,
    sourceRootPath,
    ...(sqlitePath && { sqlitePath }),
    ...(server && { server }),
    running: workers.filter((c) => c.State.Running).map((c) => c.Id),
  };
}

/** Every recognised app on this Docker host, importable or with the reason it is not. */
export async function detectPhotoApps(all: Container[], read: ContainerFileReader): Promise<PhotoAppSource[]> {
  const found: PhotoAppSource[] = [];
  for (const app of all) {
    const kind = photoAppKind(app);
    if (!kind || secondary(app)) continue;
    const base = {
      container: app.Id,
      kind,
      name: photoAppNames[kind],
      version: photoAppVersion(app),
    };
    try {
      const plan = await identifyPhotoApp(app, all, read);
      found.push({ ...base, database: plan.database, importable: true });
    } catch (error) {
      let database: PhotoAppDatabase = 'unknown';
      try {
        database = (await layout(kind, app, read)).database.engine;
      } catch {
        /* unreadable configuration stays unknown */
      }
      found.push({
        ...base,
        database,
        importable: false,
        reason: error instanceof Refusal ? error.code : 'photo_app_unreadable',
      });
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name) || a.container.localeCompare(b.container));
}
