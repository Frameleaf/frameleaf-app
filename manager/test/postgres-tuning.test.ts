import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkServiceOverrides, hostMemory, postgresTuning, renderCompose, retuneDatabase } from '../src/compose.js';
import type { Installation } from '../src/contracts.js';
import type { VerifiedRelease } from '../src/releases.js';

const GiB = 2 ** 30;
const settings = (bytes: number) => {
  const { shm_size, command } = postgresTuning(bytes);
  assert.equal(command[0], 'postgres');
  const pairs = command.slice(1).filter((_, i) => i % 2 === 1);
  assert.equal(pairs.length * 2, command.length - 1);
  return { shm_size, ...Object.fromEntries(pairs.map((p) => p.split('='))) };
};

test('Postgres memory follows host RAM within NAS-friendly caps', () => {
  assert.deepEqual(settings(4 * GiB), {
    shm_size: '512mb',
    shared_buffers: '256MB',
    effective_cache_size: '1024MB',
    maintenance_work_mem: '128MB',
    work_mem: '16MB',
    max_wal_size: '2GB',
    random_page_cost: '1.1',
  });
  // A "16 GB" host reports a little less; rounding keeps it in the 16 GB tier
  assert.deepEqual(settings(15.6 * GiB), {
    shm_size: '1024mb',
    shared_buffers: '1024MB',
    effective_cache_size: '4096MB',
    maintenance_work_mem: '256MB',
    work_mem: '32MB',
    max_wal_size: '4GB',
    random_page_cost: '1.1',
  });
  assert.deepEqual(settings(128 * GiB), {
    shm_size: '2048mb',
    shared_buffers: '8192MB',
    effective_cache_size: '32768MB',
    maintenance_work_mem: '2048MB',
    work_mem: '64MB',
    max_wal_size: '4GB',
    random_page_cost: '1.1',
  });
  assert.equal(settings(1024 * GiB).shared_buffers, '8192MB');
  assert.equal(settings(1024 * GiB).effective_cache_size, '32768MB');
  // An administrator limit under 1 GB shrinks everything to fit inside it
  assert.deepEqual(settings(128 * 2 ** 20), {
    shm_size: '32mb',
    shared_buffers: '32MB',
    effective_cache_size: '32MB',
    maintenance_work_mem: '16MB',
    work_mem: '1MB',
    max_wal_size: '2GB',
    random_page_cost: '1.1',
  });
  assert.equal(settings(512 * 2 ** 20).shared_buffers, '128MB');
  assert.deepEqual(postgresTuning(125.7 * GiB), postgresTuning(125.8 * GiB));
});

test('/dev/shm holds several parallel hash joins at the chosen work_mem', () => {
  const bytes = (s: string) => Number.parseInt(s);
  for (const gb of [0.25, 0.5, 1, 2, 4, 8, 16, 32, 64, 128, 512]) {
    const s = settings(gb * GiB);
    // work_mem × hash_mem_multiplier 2 × (2 parallel workers + leader)
    assert.ok(bytes(s.shm_size) >= 3 * Number.parseInt(s.work_mem) * 2 * 3, `${gb} GB`);
  }
});

test('host RAM comes from the Docker daemon, falling back to this container', async () => {
  assert.equal(await hostMemory(async () => String(64 * GiB)), 64 * GiB);
  assert.ok((await hostMemory(async () => { throw new Error('no docker'); })) > 0);
  assert.ok((await hostMemory(async () => 'null')) > 0);
  assert.ok((await hostMemory(async () => '')) > 0);
  assert.ok((await hostMemory(async () => 'not json')) > 0);
  assert.ok((await hostMemory(async () => 'true')) > 1);
  assert.ok((await hostMemory(async () => '"64"')) > 64);
});

test('the database service carries the tuning at install and is re-tuned on Start', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'manager-pg-tuning-'));
  try {
    const bundle = join(dir, 'bundle');
    await mkdir(bundle);
    await writeFile(
      join(bundle, 'docker-compose.yml'),
      JSON.stringify({ services: { database: {}, 'frameleaf-server': {}, 'frameleaf-machine-learning': {} } }),
    );
    const image = 'ghcr.io/frameleaf/server@sha256:' + 'a'.repeat(64);
    const release = {
      directory: bundle,
      nas: { images: { server: image, machineLearning: image, postgres: image } },
    } as VerifiedRelease;
    const installation = {
      id: 'a'.repeat(12),
      project: 'frameleaf-aaaaaaaaaaaa',
      port: 2290,
      ml: false,
      origin: 'new_library',
      mounts: [],
      databasePath: '/fixtures/db',
    } as unknown as Installation;
    const stack = join(dir, 'stack');
    const path = join(stack, 'compose.json');
    const read = async () => JSON.parse(await readFile(path, 'utf8'));
    await renderCompose(release, installation, 'pw', stack, undefined, 'cpu', 128 * GiB);
    const database = (await read()).services.database;
    assert.deepEqual({ shm_size: database.shm_size, command: database.command }, postgresTuning(128 * GiB));
    assert.ok(database.command.includes('shared_buffers=8192MB'));

    // A database memory limit set by the administrator caps the sizing
    await renderCompose(release, installation, 'pw', stack, {
      environment: {},
      settings: null,
      authority: 'database',
      services: { database: { environment: {}, mounts: [], memory: '4g' } },
    }, 'cpu', 128 * GiB);
    assert.deepEqual((await read()).services.database.command, postgresTuning(4 * GiB).command);

    // Postgres cannot run in a few MB: such a limit is refused before anything is written
    await assert.rejects(
      renderCompose(release, installation, 'pw', stack, {
        environment: {},
        settings: null,
        authority: 'database',
        services: { database: { environment: {}, mounts: [], memory: '8mb' } },
      }, 'cpu', 128 * GiB),
      (error: any) => error.code === 'service_override_conflict' && /256 MB/.test(error.detail),
    );
    assert.throws(() => checkServiceOverrides([], { database: { environment: {}, mounts: [], memory: '100m' } }), /service_override_conflict/);

    // Installations rendered before tuning existed get it on their next Start; an unchanged file is not rewritten
    const legacy = await read();
    legacy.services.database = { ...legacy.services.database, shm_size: '128mb', command: undefined, deploy: undefined };
    await writeFile(path, JSON.stringify(legacy));
    await retuneDatabase(stack, 16 * GiB);
    const tuned = await readFile(path, 'utf8');
    assert.deepEqual(JSON.parse(tuned).services.database.command, postgresTuning(16 * GiB).command);
    assert.equal(JSON.parse(tuned).services.database.shm_size, '1024mb');
    await retuneDatabase(stack, 16 * GiB);
    assert.equal(await readFile(path, 'utf8'), tuned);
    // A tiny limit saved before the 256 MB minimum keeps the untuned database rather than settings above it
    const tiny = JSON.parse(tuned);
    tiny.services.database.deploy = { resources: { limits: { memory: '8mb' } } };
    await writeFile(path, JSON.stringify(tiny));
    await retuneDatabase(stack, 16 * GiB);
    const kept = (await read()).services.database;
    assert.equal(kept.command, undefined);
    assert.equal(kept.shm_size, '128mb');
    await retuneDatabase(join(dir, 'missing'), 16 * GiB);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
