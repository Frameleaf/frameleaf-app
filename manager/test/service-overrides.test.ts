import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ApplicationConfig, ServiceOverrides, applyServiceOverrides, renderCompose } from '../src/compose.js';
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
    assert.equal(compose.services['frameleaf-server'].environment.DB_PASSWORD, 'pw');
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
