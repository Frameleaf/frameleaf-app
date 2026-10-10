import { posix } from 'node:path';
import { Docker, environment, mounts, type Container } from './docker.js';
import { Refusal, digest, type Source, type Mount } from './contracts.js';

const OFFICIAL = /^(?:ghcr\.io\/immich-app\/immich-(?:server|microservices))(?::|@)/;
const WORKER = /^(?:ghcr\.io\/immich-app\/immich-(?:server|microservices|machine-learning))(?::|@)/;
const SECRETS = [
  'DB_URL',
  'DB_HOSTNAME',
  'DB_PORT',
  'DB_USERNAME',
  'DB_PASSWORD',
  'DB_DATABASE_NAME',
  'IMMICH_CONFIG_FILE',
];
const SAFE_ENV = ['TZ', 'IMMICH_MEDIA_LOCATION', 'IMMICH_LOG_LEVEL'];
export const COMPATIBLE_SETTINGS = [
  'ffmpeg',
  'image',
  'job',
  'library',
  'logging',
  'machineLearning',
  'map',
  'metadata',
  'newVersionCheck',
  'notifications',
  'passwordLogin',
  'reverseGeocoding',
  'server',
  'storageTemplate',
  'trash',
  'user',
  'backup',
];
export function sourceFingerprint(containers: Container[]): string {
  return digest(
    containers
      .sort((a, b) => a.Id.localeCompare(b.Id))
      .map((c) => ({
        id: c.Id,
        image: c.Image,
        config: c.Config,
        mounts: c.Mounts,
        host: c.HostConfig,
        // Addresses change when a container stops; attachment names and aliases are configuration.
        networks: Object.fromEntries(
          Object.entries(c.NetworkSettings.Networks).map(([name, network]) => [
            name,
            { aliases: network.Aliases ?? [] },
          ]),
        ),
      })),
  );
}
export function databaseCandidates(app: Container, all: Container[], host: string): Container[] {
  return all.filter(
    (c) =>
      c.Id !== app.Id &&
      Object.entries(app.NetworkSettings.Networks).some(([network]) => {
        const target = c.NetworkSettings.Networks[network];
        return (
          target &&
          [target.IPAddress, c.Name.replace(/^\//, ''), ...(target.Aliases ?? []), ...(target.DNSNames ?? [])].includes(
            host,
          )
        );
      }),
  );
}
export function mediaMappings(app: Container, mediaRoot: string, externalPaths: string[]): Mount[] {
  const required = [mediaRoot, ...externalPaths];
  const result = mounts(app).filter((m) =>
    required.some((path) => path === m.target || path.startsWith(`${m.target}/`) || m.target.startsWith(`${path}/`)),
  );
  for (const path of required)
    if (!result.some((m) => path === m.target || path.startsWith(`${m.target}/`)))
      throw new Refusal('unmounted_media_path');
  for (const m of result) {
    if (
      !m.source ||
      m.target === '/' ||
      m.target === '/var/run' ||
      m.target.includes('docker.sock') ||
      posix.normalize(m.target) !== m.target ||
      m.source.includes('\n')
    )
      throw new Refusal('unsafe_media_mapping');
    const actual = app.Mounts.find((a) => a.Destination === m.target)!;
    if (actual.Propagation && !['rprivate', ''].includes(actual.Propagation))
      throw new Refusal('unsupported_mount_propagation');
  }
  return result;
}
export class Discovery {
  constructor(private docker: Docker) {}
  async list(): Promise<{ sources: Source[]; refused: { id: string; code: string }[] }> {
    const containers = await this.docker.inventory(),
      sources: Source[] = [],
      refused: { id: string; code: string }[] = [];
    const seen = new Set<string>();
    for (const app of containers.filter((c) => OFFICIAL.test(c.Config.Image) && c.State.Running)) {
      const project = app.Config.Labels?.['com.docker.compose.project'] ?? app.Id;
      if (seen.has(project)) continue;
      seen.add(project);
      try {
        sources.push(await this.inspect(app, containers));
      } catch (error) {
        refused.push({ id: app.Id, code: error instanceof Refusal ? error.code : 'source_inspection_failed' });
      }
    }
    return { sources, refused };
  }
  async inspect(app: Container, containers: Container[]): Promise<Source> {
    const env = environment(app);
    for (const key of SECRETS)
      if (env[`${key}_FILE`]) {
        if (env[key]) throw new Refusal('ambiguous_credential_reference');
        env[key] = (await this.docker.readFile(app.Id, env[`${key}_FILE`])).trimEnd();
      }
    const url = env.DB_URL ? new URL(env.DB_URL) : null;
    if (url && !['postgres:', 'postgresql:'].includes(url.protocol)) throw new Refusal('unsupported_database_url');
    if (url?.search) throw new Refusal('unsupported_database_connection_options');
    const host = url?.hostname ?? env.DB_HOSTNAME ?? 'database';
    const candidates = databaseCandidates(app, containers, host);
    if (candidates.length !== 1) throw new Refusal('database_connection_ambiguous');
    const dbContainer = candidates[0];
    const database = {
      container: dbContainer.Id,
      host,
      port: Number(url?.port || env.DB_PORT || 5432),
      name: decodeURIComponent(url?.pathname.slice(1) || env.DB_DATABASE_NAME || 'immich'),
      user: decodeURIComponent(url?.username || env.DB_USERNAME || 'postgres'),
      password: decodeURIComponent(url?.password || env.DB_PASSWORD || ''),
    };
    if (database.port !== 5432 || !database.password) throw new Refusal('unsupported_database_connection');
    const facts = JSON.parse(
      await this.docker.sql(
        database,
        `SELECT json_build_object(
      'postgres', json_build_object('version', current_setting('server_version'), 'major', current_setting('server_version_num')::int / 10000,
        'identity', (SELECT system_identifier::text FROM pg_control_system()) || ':' || current_database(),
        'extensions', (SELECT json_agg(json_build_object('name',extname,'version',extversion) ORDER BY extname) FROM pg_extension)),
      'summary', json_build_object('users', (SELECT count(*) FROM public.user), 'assets', (SELECT count(*) FROM public.asset),
        'albums', (SELECT count(*) FROM public.album), 'databaseBytes', pg_database_size(current_database())),
      'settings', (SELECT value FROM public.system_metadata WHERE key='system-config'),
      'paths', (SELECT coalesce(json_agg(path), '[]') FROM public.library CROSS JOIN LATERAL unnest("importPaths") path));`,
      ),
    );
    const version = (
      await this.docker.node(
        app.Id,
        `fetch('http://127.0.0.1:2283/api/server/version').then(r=>{if(!r.ok)throw Error();return r.json()}).then(v=>process.stdout.write('v'+v.major+'.'+v.minor+'.'+v.patch)).catch(()=>process.exit(1))`,
      )
    ).trim();
    if (!/^v\d+\.\d+\.\d+$/.test(version)) throw new Refusal('unknown_source_version');
    const project = app.Config.Labels?.['com.docker.compose.project'] ?? null;
    const workers = containers.filter(
      (c) =>
        WORKER.test(c.Config.Image) &&
        (project
          ? c.Config.Labels?.['com.docker.compose.project'] === project
          : c.Id === app.Id || databaseCandidates(c, [dbContainer], host).length === 1),
    );
    if (!workers.some((c) => c.Id === app.Id)) workers.push(app);
    const settings = env.IMMICH_CONFIG_FILE
      ? JSON.parse(await this.docker.readFile(app.Id, env.IMMICH_CONFIG_FILE))
      : (facts.settings ?? null);
    if (settings && (typeof settings !== 'object' || Array.isArray(settings)))
      throw new Refusal('invalid_source_settings');
    const mediaRoot =
      env.IMMICH_MEDIA_LOCATION ??
      (app.Mounts.some((m) => m.Destination === '/data') ? '/data' : '/usr/src/app/upload');
    const mappings = mediaMappings(app, mediaRoot, facts.paths);
    // DB volumes, secret files and host sockets are never carried across as media mounts.
    if (mappings.some((m) => mounts(dbContainer).some((d) => m.type === d.type && m.source === d.source)))
      throw new Refusal('database_and_media_overlap');
    return {
      id: app.Id,
      app: app.Id,
      project,
      version,
      image: app.Image,
      workers: workers.map((c) => c.Id),
      database,
      mounts: mappings,
      environment: Object.fromEntries(SAFE_ENV.filter((k) => env[k]).map((k) => [k, env[k]])),
      settings,
      settingsAuthority: env.IMMICH_CONFIG_FILE ? 'file' : 'database',
      unsupportedSettings: Object.keys(settings ?? {}).filter((k) => !COMPATIBLE_SETTINGS.includes(k)),
      fingerprint: sourceFingerprint([...workers, dbContainer]),
      platform: app.Config.Labels?.['net.unraid.docker.managed'] ? 'unraid' : 'docker',
      postgres: facts.postgres,
      summary: facts.summary,
      restart: Object.fromEntries(workers.map((c) => [c.Id, c.HostConfig.RestartPolicy])),
    };
  }
  async revalidate(source: Source, fencing = false): Promise<void> {
    const all = await this.docker.inventory();
    const relevant = [...source.workers, source.database.container].map((id) => all.find((c) => c.Id === id));
    if (relevant.some((c) => !c)) throw new Refusal('source_changed_review_again');
    const normalized = (relevant as Container[]).map((c) => {
      const original = source.restart[c.Id];
      if (!fencing || !original) return c;
      if (c.HostConfig.RestartPolicy.Name !== 'no' && digest(c.HostConfig.RestartPolicy) !== digest(original))
        throw new Refusal('source_changed_review_again');
      return { ...c, HostConfig: { ...c.HostConfig, RestartPolicy: original } };
    });
    if (sourceFingerprint(normalized) !== source.fingerprint) throw new Refusal('source_changed_review_again');
  }
}
