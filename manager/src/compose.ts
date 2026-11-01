import { readFile, readdir, writeFile, mkdir, realpath, statfs, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { load } from 'js-yaml';
import { z } from 'zod';
import { Refusal, imageDigest, type Installation, type Mount, type NasManifest, type Source } from './contracts.js';
import type { VerifiedRelease } from './releases.js';
import { atomicJson } from './files.js';
import { command, environment, type Container } from './docker.js';
import { UNRAID_ICON } from './dockerman.js';

export type Acceleration = 'cpu' | 'cuda' | 'rocm' | 'openvino';
/** Match hwaccel.transcoding.yml; video acceleration does not require an ML variant or AMD's KFD. */
export async function detectTranscoding(
  sys = '/sys',
  runtimes = () => command('docker', ['info', '--format', '{{json .Runtimes}}'], { timeout: 10_000 }),
): Promise<Record<string, unknown>> {
  const nvidia = (await readdir(join(sys, 'bus/pci/drivers/nvidia')).catch(() => []))
    .some((node) => /^[a-f0-9]{4}:[a-f0-9]{2}:[a-f0-9]{2}\.[0-7]$/i.test(node));
  const docker = nvidia ? await runtimes().then((value) => JSON.parse(value || '{}') ?? {}, () => ({})) : {};
  if (nvidia && Object.hasOwn(docker, 'nvidia')) return {
    deploy: { resources: { reservations: { devices: [{ driver: 'nvidia', count: 1, capabilities: ['gpu', 'compute', 'video'] }] } } },
  };
  const nodes = (await readdir(join(sys, 'class/drm')).catch(() => [])).filter((node) => /^renderD\d+$/.test(node));
  const vendors = await Promise.all(nodes.map((node) => readFile(join(sys, 'class/drm', node, 'device/vendor'), 'utf8')
    .then((value) => value.trim(), () => '')));
  return vendors.some((vendor) => vendor === '0x8086' || vendor === '0x1002') ? { devices: ['/dev/dri:/dev/dri'] } : {};
}

/** Refresh saved installations too; starting an older stack must not retain missing or stale GPU mappings. */
// `up --wait` rejects a disabled healthcheck on some Compose releases (Unraid); report healthy once running.
const LAN_DISCOVERY_HEALTHCHECK = { test: ['CMD', 'node', '-e', ''], interval: '30s', timeout: '10s', retries: 3 };
export async function configureUnraidCompose(directory: string, hardware?: Record<string, unknown>): Promise<void> {
  const path = join(directory, 'compose.json');
  const compose = JSON.parse(await readFile(path, 'utf8'));
  if (!/^frameleaf-[a-f0-9]{12}$/.test(compose.name)) throw new Refusal('invalid_managed_project');
  for (const [name, service] of Object.entries(compose.services) as [string, any][]) {
    if (service.labels?.['app.frameleaf.manager'] !== compose.name.slice(10)) throw new Refusal('invalid_managed_project');
    service.labels = { ...service.labels, 'net.unraid.docker.managed': 'dockerman', 'net.unraid.docker.icon': UNRAID_ICON,
      ...(name === 'frameleaf-server' ? { 'net.unraid.docker.webui': 'http://[IP]:[PORT:2283]' } : {}) };
  }
  // Saved projects from earlier releases still disable it; resumes and restarts reuse compose.json.
  const lan = compose.services['frameleaf-lan-discovery'];
  if (lan) lan.healthcheck = LAN_DISCOVERY_HEALTHCHECK;
  const server = compose.services['frameleaf-server'];
  if (server) {
    const detected: any = hardware ?? await detectTranscoding();
    server.devices = [...(server.devices ?? []).filter((device: any) =>
      (typeof device === 'string' ? device.split(':')[0] : device.source) !== '/dev/dri'), ...(detected.devices ?? [])];
    const reservations = server.deploy?.resources?.reservations;
    if (reservations?.devices) reservations.devices = reservations.devices.filter((device: any) => device.driver !== 'nvidia');
    if (detected.deploy) {
      server.deploy ??= {};
      server.deploy.resources ??= {};
      server.deploy.resources.reservations ??= {};
      server.deploy.resources.reservations.devices = [
        ...(reservations?.devices ?? []), ...detected.deploy.resources.reservations.devices,
      ];
    }
  }
  await atomicJson(path, compose);
}
/** Device passthrough per variant, matching docker/hwaccel.ml.yml. */
const ACCELERATION_SERVICE: Record<Exclude<Acceleration, 'cpu'>, Record<string, unknown>> = {
  cuda: { deploy: { resources: { reservations: { devices: [{ driver: 'nvidia', count: 1, capabilities: ['gpu'] }] } } } },
  rocm: { group_add: ['video'], devices: ['/dev/dri:/dev/dri', '/dev/kfd:/dev/kfd'] },
  openvino: { device_cgroup_rules: ['c 189:* rmw'], devices: ['/dev/dri:/dev/dri'] },
};
/**
 * Picks the ML variant for this host: NVIDIA (Docker has the nvidia runtime), then AMD (render node + ROCm
 * kfd), then Intel (render node). Docker mounts host sysfs read-only in every container, so Manager needs
 * no /dev mapping to detect. Unraid also passes visible DRI devices to the server for video acceleration. The CUDA, ROCm and OpenVINO images
 * are amd64 only. MANAGER_ML_ACCELERATION overrides detection.
 */
export async function detectAcceleration(
  sys = '/sys',
  runtimes = () => command('docker', ['info', '--format', '{{json .Runtimes}}'], { timeout: 10_000 }),
  arch = process.arch,
): Promise<Acceleration> {
  const forced = process.env.MANAGER_ML_ACCELERATION;
  if (forced === 'cpu' || forced === 'cuda' || forced === 'rocm' || forced === 'openvino') return forced;
  if (arch !== 'x64') return 'cpu';
  const docker = await runtimes().then((r) => JSON.parse(r || '{}') ?? {}, () => ({}));
  if (Object.hasOwn(docker, 'nvidia')) return 'cuda';
  const nodes = (await readdir(join(sys, 'class/drm')).catch(() => [])).filter((n) => n.startsWith('renderD'));
  const vendors = await Promise.all(
    nodes.map((n) => readFile(join(sys, 'class/drm', n, 'device/vendor'), 'utf8').then((v) => v.trim(), () => '')),
  );
  const kfd = await access(join(sys, 'class/kfd')).then(() => true, () => false);
  if (kfd && vendors.includes('0x1002')) return 'rocm';
  if (vendors.includes('0x8086')) return 'openvino';
  return 'cpu';
}

/** The attested ML variant digest for this acceleration; undefined keeps the CPU image rather than an unverified tag. */
function mlVariant(images: NasManifest['images'], accel: Acceleration): string | undefined {
  return accel === 'cpu' ? undefined : images.machineLearningVariants?.[accel];
}
/**
 * Every image renderCompose references on this host, so the download step pulls exactly what `up --pull never`
 * runs: no ML image when machine learning is off, and only the attested GPU variant (not the CPU image) when one
 * is chosen.
 */
export async function releaseImages(
  images: NasManifest['images'],
  installation: Pick<Installation, 'ml'>,
  acceleration?: Acceleration,
): Promise<string[]> {
  if (!installation.ml) return [images.server, images.postgres];
  const variant = mlVariant(images, acceleration ?? (await detectAcceleration()));
  return [images.server, images.postgres, variant ?? images.machineLearning];
}

/** Names Manager sets itself; an advanced setting may not rewire the stack or move the media. */
export const RESERVED_ENVIRONMENT = /^(DB_|POSTGRES_|FRAMELEAF_MANAGER_|IMMICH_CONFIG_FILE$|IMMICH_MEDIA_LOCATION$)/;
/** Container paths Manager mounts itself; an extra folder may not shadow them. */
const RESERVED_TARGETS = ['/run/frameleaf', '/var/lib/postgresql', '/cache'];
export const OVERRIDABLE_SERVICES = ['frameleaf-server', 'frameleaf-machine-learning', 'database'] as const;
const containerPath = z.string().regex(/^\/(?!$)[^\n\0:]+$/).max(4096);
/** What a home-lab administrator may add to one container on top of Manager's own compose service. */
export const ServiceOverride = z
  .object({
    environment: z
      .record(z.string().regex(/^[A-Z][A-Z0-9_]*$/).refine((name) => !RESERVED_ENVIRONMENT.test(name)), z.string().max(4096))
      .default({}),
    mounts: z.array(z.object({ source: containerPath, target: containerPath, readOnly: z.boolean() }).strict()).max(32).default([]),
    memory: z.string().regex(/^\d+(\.\d+)?[kmg]b?$/i).optional(),
    cpus: z.number().positive().max(1024).optional(),
  })
  .strict();
export const ServiceOverrides = z.partialRecord(z.enum(OVERRIDABLE_SERVICES), ServiceOverride);
export type ServiceOverrides = z.infer<typeof ServiceOverrides>;
export const ApplicationConfig = z
  .object({
    environment: z
      .object({
        TZ: z.string().optional(),
        IMMICH_MEDIA_LOCATION: z.string().startsWith('/').optional(),
        IMMICH_LOG_LEVEL: z.string().optional(),
      })
      .strict(),
    settings: z.record(z.string(), z.unknown()).nullable(),
    authority: z.enum(['database', 'file']).default('database'),
    /** Advanced container settings chosen at setup; re-applied whenever the stack is regenerated. */
    services: ServiceOverrides.default({}),
  })
  .strict();
/**
 * Adds the administrator's extra folders, environment and limits to the generated services. Manager's
 * own mounts win: a folder that shadows one is refused with the service and path named. An override for a
 * service that is not part of this stack (machine learning off) is kept for when it is.
 */
export function applyServiceOverrides(services: Record<string, unknown>, overrides: ServiceOverrides): void {
  for (const [name, override] of Object.entries(overrides)) {
    const service = services[name] as Record<string, any> | undefined;
    if (!service || !override) continue;
    const targets = new Set<string>((service.volumes ?? []).map((mount: { target: string }) => mount.target));
    for (const mount of override.mounts) {
      if (targets.has(mount.target) || RESERVED_TARGETS.some((r) => mount.target === r || mount.target.startsWith(`${r}/`)))
        throw new Refusal('service_override_conflict', 409, `${name}: ${mount.target} is managed by Frameleaf.`);
      targets.add(mount.target);
      service.volumes = [
        ...(service.volumes ?? []),
        { type: 'bind', source: mount.source, target: mount.target, read_only: mount.readOnly, bind: { create_host_path: false } },
      ];
    }
    // Reserved names never reach here (schema); the rest of the administrator's values win over source defaults.
    if (Object.keys(override.environment).length) service.environment = { ...service.environment, ...override.environment };
    if (override.memory || override.cpus) {
      service.deploy ??= {};
      service.deploy.resources ??= {};
      service.deploy.resources.limits = {
        ...(override.memory ? { memory: override.memory } : {}),
        ...(override.cpus ? { cpus: String(override.cpus) } : {}),
      };
    }
  }
}
export type ApplicationConfig = z.infer<typeof ApplicationConfig>;
/** The conflict check renderCompose runs, against the media targets this installation has, before anything is journaled. */
export function checkServiceOverrides(mediaTargets: string[], overrides: ServiceOverrides): void {
  applyServiceOverrides(
    {
      'frameleaf-server': { volumes: mediaTargets.map((target) => ({ target })) },
      'frameleaf-machine-learning': { volumes: [] },
      database: { volumes: [] },
    },
    overrides,
  );
}

/** Paths are explicitly mounted into Manager at the same absolute host path by the launcher. */
export async function storagePath(path: string, roots: string[], bytes: number): Promise<string> {
  if (!path.startsWith('/') || /[\n\0]/.test(path) || path !== resolve(path)) throw new Refusal('invalid_storage_path');
  const actual = await realpath(path).catch(() => {
    throw new Refusal('storage_inaccessible');
  });
  if (!roots.some((root) => actual === root || actual.startsWith(`${root}/`)) || actual !== path)
    throw new Refusal('storage_outside_approved_roots');
  await access(actual, constants.R_OK | constants.W_OK | constants.X_OK).catch(() => {
    throw new Refusal('storage_permissions');
  });
  const space = await statfs(actual);
  if (space.bavail * space.bsize < bytes + 64 * 1024 * 1024) throw new Refusal('insufficient_disk_space');
  return actual;
}
/** FL-408: the bundled Studio worker's enrolment, shared by the server (rw) and machine learning (ro). */
export const STUDIO_WORKER_VOLUME = 'studio-worker';
export const STUDIO_WORKER_TARGET = '/run/frameleaf/studio-worker';
function composeMount(m: Mount, volumes: Record<string, unknown>, index: number) {
  if (m.type === 'bind')
    return {
      type: 'bind',
      source: m.source,
      target: m.target,
      read_only: m.readOnly,
      bind: { create_host_path: false },
    };
  const key = `source-media-${index}`;
  volumes[key] = { external: true, name: m.source };
  return { type: 'volume', source: key, target: m.target, read_only: m.readOnly, volume: { nocopy: true } };
}
export const LIBRARY_NAME_LABEL = 'app.frameleaf.library-name';
export const MANAGER_DATA_LABEL = 'app.frameleaf.manager-data';
const hostPort = (c: Container | undefined, port: number) => {
  const value = Number(c?.HostConfig.PortBindings?.[`${port}/tcp`]?.[0]?.HostPort);
  return value > 0 ? value : null;
};
/** Every Frameleaf library on this Docker host, with a link to its own Manager when its stack names one. */
export function hostInstallations(containers: Container[], currentId: string | undefined, origin: string) {
  const seen = new Set<string>();
  return containers
    .filter((c) => c.Config.Labels?.['com.docker.compose.service'] === 'frameleaf-server')
    .sort((a, b) => Number(b.State.Running) - Number(a.State.Running))
    .flatMap((c) => {
      const labels = c.Config.Labels,
        id = labels['app.frameleaf.manager'];
      if (!/^[a-f0-9]{12}$/.test(id ?? '') || seen.has(id)) return [];
      seen.add(id);
      const controller = labels[MANAGER_DATA_LABEL]
        ? containers.find((m) => m.Config.Labels?.['app.frameleaf.manager.role'] === 'controller' &&
            environment(m).MANAGER_DATA === labels[MANAGER_DATA_LABEL])
        : undefined;
      const managerPort = hostPort(controller, 9443),
        url = new URL(origin);
      if (managerPort) url.port = String(managerPort);
      return [{
        name: labels[LIBRARY_NAME_LABEL] || 'Frameleaf library',
        current: id === currentId,
        running: c.State.Running,
        appPort: hostPort(c, 2283),
        managerUrl: managerPort ? url.origin : null,
      }];
    });
}
/** First port from 2283 that no container on this host publishes and Manager itself does not use. */
export function suggestedPort(containers: Container[], reserved: number[] = []): number {
  const used = new Set([
    ...reserved,
    ...containers.flatMap((c) =>
      Object.values(c.HostConfig.PortBindings ?? {}).flatMap((bindings) => (bindings ?? []).map((b) => Number(b.HostPort))),
    ),
  ]);
  let port = 2283;
  while (used.has(port)) port++;
  return port;
}
export async function renderCompose(
  release: VerifiedRelease,
  installation: Installation,
  password: string,
  directory: string,
  config?: ApplicationConfig,
  acceleration?: Acceleration,
): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const template = load(await readFile(join(release.directory, 'docker-compose.yml'), 'utf8')) as any;
  if (
    !template?.services ||
    !['database', 'frameleaf-server'].every((k) => template.services[k]) ||
    !(template.services['frameleaf-machine-learning'] || template.services['immich-machine-learning'])
  )
    throw new Refusal('unsupported_compose_bundle');
  const { server, machineLearning, postgres } = release.nas.images;
  [server, machineLearning, postgres].forEach((i) => imageDigest.parse(i));
  // FL-408: the server writes the bundled Studio worker's enrolment here; machine learning reads it.
  const volumes: Record<string, unknown> = { 'model-cache': {}, [STUDIO_WORKER_VOLUME]: {} };
  const media = installation.mounts.map((m, i) => composeMount(m, volumes, i));
  const labels: Record<string, string> = {
    'app.frameleaf.manager': installation.id,
    // Lets Managers of other libraries on this host list this one and link to its Manager.
    [MANAGER_DATA_LABEL]: process.env.MANAGER_DATA ?? '',
    ...(installation.name ? { [LIBRARY_NAME_LABEL]: installation.name } : {}),
  };
  const application = ApplicationConfig.parse(config ?? { environment: {}, settings: null });
  const environment: Record<string, string> = {
    ...application.environment,
    DB_HOSTNAME: 'database',
    DB_PORT: '5432',
    DB_USERNAME: 'frameleaf',
    DB_DATABASE_NAME: 'frameleaf',
    DB_PASSWORD: password,
    FRAMELEAF_MANAGER_INSTALLATION: installation.id,
    FRAMELEAF_MANAGER_ORIGIN: installation.origin,
    FRAMELEAF_MANAGER_TOKEN_FILE: '/run/frameleaf/manager-token',
    FRAMELEAF_MANAGER_URL: process.env.MANAGER_ORIGIN ?? '',
  };
  if (installation.origin === 'restored_library' && installation.importInstallation) {
    if (!/^[a-f0-9]{12}$/.test(installation.importInstallation)) throw new Refusal('invalid_restore_import_identity');
    environment.FRAMELEAF_MANAGER_IMPORT_INSTALLATION = installation.importInstallation;
  }
  media.push({
    type: 'bind',
    source: join(directory, 'manager-token'),
    target: '/run/frameleaf/manager-token',
    read_only: true,
    bind: { create_host_path: false },
  });
  media.push({
    type: 'volume',
    source: STUDIO_WORKER_VOLUME,
    target: STUDIO_WORKER_TARGET,
    read_only: false,
    volume: { nocopy: true },
  });
  if (application.authority === 'file') {
    const settings = {
      ...application.settings,
      machineLearning: {
        ...(application.settings?.machineLearning as Record<string, unknown> | undefined),
        enabled: installation.ml,
        urls: ['http://frameleaf-machine-learning:3003'],
      },
    };
    await atomicJson(join(directory, 'application-settings.json'), settings);
    environment.IMMICH_CONFIG_FILE = '/run/frameleaf/settings.json';
    // Manager's host state path is explicit; no container-private path is passed to the host engine.
    media.push({
      type: 'bind',
      source: join(directory, 'application-settings.json'),
      target: '/run/frameleaf/settings.json',
      read_only: true,
      bind: { create_host_path: false },
    });
  } else if (installation.origin !== 'restored_library') {
    // Apply the initial choice through the application's configuration writer. Database-backed
    // installations retain their normal settings editor and credential rotation controls.
    environment.FRAMELEAF_MANAGER_ML_ENABLED = String(installation.ml);
  }
  const services: Record<string, unknown> = {
    database: {
      image: postgres,
      labels,
      restart: 'unless-stopped',
      shm_size: '128mb',
      environment: {
        POSTGRES_USER: 'frameleaf',
        POSTGRES_PASSWORD: password,
        POSTGRES_DB: 'frameleaf',
        POSTGRES_INITDB_ARGS: '--data-checksums',
      },
      volumes: [
        {
          type: 'bind',
          source: installation.databasePath,
          target: '/var/lib/postgresql',
          bind: { create_host_path: false },
        },
      ],
      healthcheck: {
        test: ['CMD-SHELL', 'pg_isready -U frameleaf -d frameleaf'],
        interval: '5s',
        timeout: '5s',
        retries: 60,
      },
    },
    'frameleaf-server': {
      image: server,
      labels,
      restart: 'unless-stopped',
      environment,
      volumes: media,
      ports: [
        {
          target: 2283,
          published: String(installation.port),
          host_ip: process.env.MANAGER_BIND_ADDRESS ?? '127.0.0.1',
        },
      ],
      depends_on: { database: { condition: 'service_healthy' } },
      stop_grace_period: '60s',
      // FL-721: encrypted Locked files are decrypted into /dev/shm (RAM); Docker's 64 MB default is too small
      shm_size: '2gb',
      healthcheck: template.services['frameleaf-server'].healthcheck,
    },
  };
  // Older signed bundles do not contain the companion. Loopback-only installations stay private.
  const bindAddress = process.env.MANAGER_BIND_ADDRESS ?? '127.0.0.1';
  if (
    template.services['frameleaf-lan-discovery'] &&
    !(/^(127\.|::ffff:127\.)/.test(bindAddress) || bindAddress === '::1')
  ) {
    const host =
      bindAddress === '0.0.0.0'
        ? '127.0.0.1'
        : bindAddress === '::'
          ? '[::1]'
          : bindAddress.includes(':')
            ? `[${bindAddress}]`
            : bindAddress;
    services['frameleaf-lan-discovery'] = {
      image: server,
      labels,
      entrypoint: [
        'node',
        '/usr/src/app/server/bin/frameleaf-lan-discovery.mjs',
      ],
      network_mode: 'host',
      user: '65534:65534',
      restart: 'unless-stopped',
      read_only: true,
      cap_drop: ['ALL'],
      security_opt: ['no-new-privileges:true'],
      environment: {
        FRAMELEAF_DISCOVERY_URL: `http://${host}:${installation.port}`,
      },
      healthcheck: LAN_DISCOVERY_HEALTHCHECK,
      depends_on: { 'frameleaf-server': { condition: 'service_started' } },
    };
  }
  if (installation.ml) {
    const accel = acceleration ?? (await detectAcceleration());
    const variant = mlVariant(release.nas.images, accel);
    if (variant) imageDigest.parse(variant);
    services['frameleaf-machine-learning'] = {
      networks: { default: { aliases: ['immich-machine-learning'] } },
      image: variant ?? machineLearning,
      ...(variant && ACCELERATION_SERVICE[accel as Exclude<Acceleration, 'cpu'>]),
      labels,
      restart: 'unless-stopped',
      volumes: [
        { type: 'volume', source: 'model-cache', target: '/cache' },
        { type: 'volume', source: STUDIO_WORKER_VOLUME, target: STUDIO_WORKER_TARGET, read_only: true },
      ],
    };
  }
  applyServiceOverrides(services, application.services);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const compose = JSON.parse(
    JSON.stringify(
      { name: installation.project, services, volumes, networks: { default: { labels } } },
      (_key, value) => (typeof value === 'string' ? value.replaceAll('$', () => '$$') : value),
    ),
  );
  await atomicJson(join(directory, 'compose.json'), compose);
  if (process.env.MANAGER_PLATFORM === 'unraid') await configureUnraidCompose(directory);
}
