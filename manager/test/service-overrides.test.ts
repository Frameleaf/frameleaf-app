import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ApplicationConfig, DATABASE_PASSWORD_TARGET, DENIED_MOUNT_SOURCES, ServiceOverrides, applyServiceOverrides, checkServiceOverrides, renderCompose } from '../src/compose.js';
import type { Installation } from '../src/contracts.js';
import type { VerifiedRelease } from '../src/releases.js';
import { ReviewInput } from '../src/operations.js';
import { containerOverrides, containerSummary, emptyContainers, parseContainerSettings } from '../ui/src/presentation.js';

// Advanced container settings: a home-lab administrator's extras ride on top of Manager's own services.

test('an override may not rewire the stack: reserved names, relative paths and unknown services are refused', () => {
  assert.ok(ServiceOverrides.safeParse({ 'frameleaf-server': { environment: { TZ: 'UTC' } } }).success);
  for (const name of ['DB_PASSWORD', 'POSTGRES_USER', 'FRAMELEAF_MANAGER_URL', 'IMMICH_CONFIG_FILE', 'IMMICH_MEDIA_LOCATION', 'lower'])
    assert.equal(ServiceOverrides.safeParse({ 'frameleaf-server': { environment: { [name]: 'x' } } }).success, false, name);
  assert.equal(ServiceOverrides.safeParse({ 'frameleaf-server': { mounts: [{ source: 'relative', target: '/x', readOnly: true }] } }).success, false);
  assert.equal(ServiceOverrides.safeParse({ 'frameleaf-lan-discovery': {} }).success, false);
  assert.equal(ServiceOverrides.safeParse({ database: { memory: 'lots' } }).success, false);
  // The review input carries it, and older application configs still parse without it.
  assert.ok(ReviewInput.shape.services.safeParse({ database: { cpus: 1.5 } }).success);
  assert.deepEqual(ApplicationConfig.parse({ environment: {}, settings: null }).services, {});
});

test('overrides add folders, variables and limits without touching what Manager mounts', () => {
  const services: Record<string, any> = {
    'frameleaf-server': { environment: { TZ: 'UTC', DB_HOSTNAME: 'database' }, volumes: [{ target: '/data' }, { target: '/run/frameleaf/manager-token' }] },
    database: { volumes: [{ target: '/var/lib/postgresql' }], deploy: { resources: { reservations: { devices: [] } } } },
  };
  applyServiceOverrides(services, {
    'frameleaf-server': { environment: { TZ: 'America/Toronto', IMMICH_LOG_LEVEL: 'verbose' }, mounts: [{ source: '/mnt/user/archive', target: '/archive', readOnly: true }], memory: '4g' },
    database: { environment: {}, mounts: [], cpus: 2 },
    'frameleaf-machine-learning': { environment: { X: '1' }, mounts: [] },
  });
  assert.deepEqual(services['frameleaf-server'].environment, { TZ: 'America/Toronto', DB_HOSTNAME: 'database', IMMICH_LOG_LEVEL: 'verbose' });
  assert.deepEqual(services['frameleaf-server'].volumes.at(-1), {
    type: 'bind', source: '/mnt/user/archive', target: '/archive', read_only: true, bind: { create_host_path: false },
  });
  assert.deepEqual(services['frameleaf-server'].deploy, { resources: { limits: { memory: '4g' } } });
  assert.deepEqual(services.database.deploy.resources, { reservations: { devices: [] }, limits: { cpus: '2' } });
  assert.equal(services['frameleaf-machine-learning'], undefined);
  for (const target of ['/data', '/run/frameleaf/anything', '/var/lib/postgresql', '/cache'])
    assert.throws(
      () => applyServiceOverrides(services, { 'frameleaf-server': { environment: {}, mounts: [{ source: '/x', target, readOnly: false }] } }),
      (error: any) => error.code === 'service_override_conflict' && error.detail.includes(target),
      target,
    );
});

test('the rendered stack carries the overrides and nothing else changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'manager-overrides-'));
  try {
    const bundle = join(dir, 'bundle');
    await mkdir(bundle);
    await writeFile(join(bundle, 'docker-compose.yml'), JSON.stringify({ services: { database: {}, 'frameleaf-server': {}, 'frameleaf-machine-learning': {} } }));
    const image = 'ghcr.io/frameleaf/server@sha256:' + 'a'.repeat(64);
    const release = { directory: bundle, nas: { images: { server: image, machineLearning: image, postgres: image } } } as VerifiedRelease;
    const installation = {
      id: 'a'.repeat(12), project: 'frameleaf-aaaaaaaaaaaa', port: 2283, ml: true, origin: 'new_library',
      mounts: [{ type: 'bind', source: '/mnt/user/photos', target: '/data', readOnly: false }], databasePath: '/fixtures/db',
    } as unknown as Installation;
    const stack = join(dir, 'stack');
    const config = ApplicationConfig.parse({
      environment: {}, settings: null,
      services: { 'frameleaf-server': { mounts: [{ source: '/mnt/user/archive', target: '/archive', readOnly: true }] }, 'frameleaf-machine-learning': { memory: '6g' } },
    });
    await renderCompose(release, installation, 'pw', stack, config, 'cpu');
    const compose = JSON.parse(await readFile(join(stack, 'compose.json'), 'utf8'));
    assert.ok(compose.services['frameleaf-server'].volumes.some((m: any) => m.target === '/archive' && m.read_only && m.bind.create_host_path === false));
    assert.deepEqual(compose.services['frameleaf-machine-learning'].deploy, { resources: { limits: { memory: '6g' } } });
    assert.equal(compose.services.database.deploy, undefined);
    // Review L9: the password is a mounted 0600 file, not an environment value DockerMan would persist to flash.
    assert.equal(compose.services['frameleaf-server'].environment.DB_PASSWORD, undefined);
    assert.equal(compose.services['frameleaf-server'].environment.DB_PASSWORD_FILE, DATABASE_PASSWORD_TARGET);
    assert.equal(compose.services.database.environment.POSTGRES_PASSWORD, undefined);
    assert.equal(compose.services.database.environment.POSTGRES_PASSWORD_FILE, DATABASE_PASSWORD_TARGET);
    for (const service of ['frameleaf-server', 'database'])
      assert.ok(compose.services[service].volumes.some((m: any) => m.target === DATABASE_PASSWORD_TARGET && m.read_only && m.source === join(stack, 'database-password')), service);
    assert.equal(await readFile(join(stack, 'database-password'), 'utf8'), 'pw');
    assert.equal(((await stat(join(stack, 'database-password'))).mode & 0o777), 0o600);
    assert.ok(!JSON.stringify(compose).includes('"pw"'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the setup form turns text into the review request and keeps invalid lines out of it', () => {
  const containers = emptyContainers();
  containers['frameleaf-server'] = { environment: 'TZ=America/Toronto\nDB_PASSWORD=x', mounts: '/mnt/user/archive:/archive:ro', memory: '4g', cpus: '' };
  containers['frameleaf-machine-learning'] = { environment: '', mounts: '', memory: '6g', cpus: '2' };
  const parsed = parseContainerSettings(containers['frameleaf-server']);
  assert.deepEqual(parsed.errors, ['DB_PASSWORD is set by Manager']);
  assert.equal(containerSummary(parsed), '1 variable · 1 folder · 4g memory');
  assert.equal(containerOverrides(containers, true).invalid, true);
  containers['frameleaf-server'].environment = 'TZ=America/Toronto';
  assert.deepEqual(containerOverrides(containers, true), {
    invalid: false,
    services: {
      'frameleaf-server': { environment: { TZ: 'America/Toronto' }, mounts: [{ source: '/mnt/user/archive', target: '/archive', readOnly: true }], memory: '4g' },
      'frameleaf-machine-learning': { environment: {}, mounts: [], memory: '6g', cpus: 2 },
    },
  });
  // Machine learning off: its settings wait, and never block the review.
  assert.deepEqual(Object.keys(containerOverrides(containers, false).services), ['frameleaf-server']);
  assert.ok(ServiceOverrides.safeParse(containerOverrides(containers, true).services).success);
  assert.deepEqual(containerOverrides(emptyContainers(), true), { services: {}, invalid: false });
});

// Review L4: an extra folder may not hand the network-exposed server the Docker socket, the host root or Manager's state.
test('host system paths, Manager state and folders outside the allowed roots are refused as extra folder sources', () => {
  const previous = process.env.MANAGER_DATA;
  process.env.MANAGER_DATA = '/mnt/user/appdata/frameleaf-manager';
  try {
    const mount = (source: string) => ({ 'frameleaf-server': { environment: {}, mounts: [{ source, target: '/extra', readOnly: true }] } });
    for (const source of [
      ...DENIED_MOUNT_SOURCES,
      '/etc/passwd', '/proc/1', '/sys/class', '/dev/sda', '/var/lib/docker/volumes', '/boot/config', '/run/docker.sock', '/root/.ssh',
      '/mnt/user/appdata/frameleaf-manager', '/mnt/user/appdata/frameleaf-manager/stack', '/mnt/user/../../etc', '/mnt/user/archive/',
    ])
      assert.throws(
        () => applyServiceOverrides({ 'frameleaf-server': { volumes: [] } }, mount(source)),
        (error: any) => error.code === 'service_override_unsafe_source' && error.detail.includes('frameleaf-server'),
        source,
      );
    for (const source of ['/mnt/user/archive', '/mnt/user/appdata/frameleaf-manager-two', '/etcetera', '/devices', '/srv/photos'])
      assert.doesNotThrow(() => applyServiceOverrides({ 'frameleaf-server': { volumes: [] } }, mount(source)), source);
    // The allow-list: media and database roots plus MANAGER_MOUNT_ROOTS; no roots means no allow-list check.
    const roots = ['/mnt/user/appdata/frameleaf-media', '/mnt/user/appdata/frameleaf-databases', '/mnt/disk2/archive'];
    assert.doesNotThrow(() => checkServiceOverrides(['/data'], mount('/mnt/disk2/archive/2024'), roots));
    assert.doesNotThrow(() => checkServiceOverrides(['/data'], mount('/mnt/disk2/archive'), roots));
    assert.doesNotThrow(() => checkServiceOverrides(['/data'], mount('/srv/photos'), []));
    assert.throws(
      () => checkServiceOverrides(['/data'], mount('/mnt/disk2/archive-old'), roots),
      (error: any) => error.code === 'service_override_source_outside_roots' && error.detail.includes('MANAGER_MOUNT_ROOTS'),
    );
    assert.throws(() => checkServiceOverrides(['/data'], mount('/var/run/docker.sock'), ['/']), /service_override_unsafe_source/);
    assert.throws(() => checkServiceOverrides(['/data'], mount('/mnt/user/appdata/frameleaf-manager'), ['/mnt/user']), /service_override_unsafe_source/);
  } finally {
    if (previous === undefined) delete process.env.MANAGER_DATA;
    else process.env.MANAGER_DATA = previous;
  }
});

// Review: resolve() keeps symlinks, so a link under an approved root could hand the stack /etc or Manager's state.
test('an extra folder is checked by its real path: links to denied paths, Manager state or elsewhere are refused', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'manager-override-links-')));
  const previous = process.env.MANAGER_DATA;
  process.env.MANAGER_DATA = join(dir, 'manager');
  try {
    await mkdir(join(dir, 'real'));
    await mkdir(join(dir, 'manager'));
    await mkdir(join(dir, 'nested'));
    await symlink('/etc', join(dir, 'etc-link'));
    await symlink(join(dir, 'manager'), join(dir, 'manager-link'));
    await symlink(join(dir, 'real'), join(dir, 'nested', 'alias'));
    await symlink(join(dir, 'loop'), join(dir, 'loop'));
    const mount = (source: string) => ({ 'frameleaf-server': { environment: {}, mounts: [{ source, target: '/extra', readOnly: true }] } });
    const refused = (source: string, detail: RegExp) =>
      assert.throws(
        () => applyServiceOverrides({ 'frameleaf-server': { volumes: [] } }, mount(source)),
        (error: any) => error.code === 'service_override_unsafe_source' && detail.test(error.detail),
        source,
      );
    refused(join(dir, 'etc-link'), /host system path/);
    refused(join(dir, 'etc-link', 'passwd'), /host system path/);
    refused(join(dir, 'etc-link', 'does-not-exist'), /host system path/); // the linked parent is still seen
    refused(join(dir, 'manager-link'), /host system path/);
    refused(join(dir, 'manager-link', 'stack'), /host system path/);
    refused(join(dir, 'nested', 'alias'), /symbolic link/);
    refused(join(dir, 'nested', 'alias', 'photos'), /symbolic link/);
    refused(join(dir, 'loop'), /cannot be resolved/);
    for (const source of [join(dir, 'real'), join(dir, 'real', 'not-yet-created'), join(dir, 'nested')])
      assert.doesNotThrow(() => applyServiceOverrides({ 'frameleaf-server': { volumes: [] } }, mount(source)), source);
    // The allow-list sees the real path too: a link inside a root that leaves it is refused.
    await symlink(join(dir, 'nested'), join(dir, 'real', 'escape'));
    assert.throws(() => checkServiceOverrides(['/data'], mount(join(dir, 'real', 'escape')), [join(dir, 'real')]), /service_override_unsafe_source/);
    assert.throws(() => checkServiceOverrides(['/data'], mount(join(dir, 'real', 'escape', 'x')), [join(dir, 'real')]), /service_override_unsafe_source/);
    assert.doesNotThrow(() => checkServiceOverrides(['/data'], mount(join(dir, 'real', 'x')), [join(dir, 'real')]));
  } finally {
    if (previous === undefined) delete process.env.MANAGER_DATA;
    else process.env.MANAGER_DATA = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
