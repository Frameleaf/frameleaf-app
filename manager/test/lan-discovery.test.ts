import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renderCompose } from '../src/compose.js';
import type { Installation } from '../src/contracts.js';
import type { VerifiedRelease } from '../src/releases.js';

test('LAN discovery gets host networking and only the published port, never database credentials or media', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'manager-lan-'));
  const previous = process.env.MANAGER_BIND_ADDRESS;
  try {
    const bundle = join(dir, 'bundle');
    await mkdir(bundle);
    const services: Record<string, unknown> = {
      database: {},
      'frameleaf-server': {},
      'frameleaf-machine-learning': {},
      'frameleaf-lan-discovery': {},
    };
    await writeFile(
      join(bundle, 'docker-compose.yml'),
      JSON.stringify({ services }),
    );
    const image = 'ghcr.io/frameleaf/server@sha256:' + 'a'.repeat(64);
    const release = {
      directory: bundle,
      nas: {
        images: { server: image, machineLearning: image, postgres: image },
      },
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
    process.env.MANAGER_BIND_ADDRESS = '0.0.0.0';
    await renderCompose(
      release,
      installation,
      'private-password',
      stack,
      undefined,
      'cpu',
    );
    const compose = JSON.parse(
      await readFile(join(stack, 'compose.json'), 'utf8'),
    );
    const lan = compose.services['frameleaf-lan-discovery'];
    assert.equal(lan?.network_mode, 'host');
    assert.equal(lan.image, image);
    assert.deepEqual(lan.environment, {
      FRAMELEAF_DISCOVERY_URL: 'http://127.0.0.1:2290',
    });
    assert.equal(lan.volumes, undefined);
    assert.equal(lan.privileged, undefined);
    assert.deepEqual(lan.cap_drop, ['ALL']);
    assert.equal(lan.read_only, true);
    assert.deepEqual(lan.healthcheck.test, ['CMD', 'node', '-e', '']);
    assert.equal(compose.services.database.network_mode, undefined);
    assert.equal(compose.services.database.ports, undefined);
    assert.equal(compose.services['frameleaf-server'].network_mode, undefined);
    assert.equal(JSON.stringify(lan).includes('private-password'), false);
    process.env.MANAGER_BIND_ADDRESS = '127.0.0.1';
    await renderCompose(release, installation, 'pw', stack, undefined, 'cpu');
    assert.equal(
      JSON.parse(await readFile(join(stack, 'compose.json'), 'utf8')).services[
        'frameleaf-lan-discovery'
      ],
      undefined,
    );
    process.env.MANAGER_BIND_ADDRESS = '0.0.0.0';
    delete services['frameleaf-lan-discovery'];
    await writeFile(
      join(bundle, 'docker-compose.yml'),
      JSON.stringify({ services }),
    );
    await renderCompose(release, installation, 'pw', stack, undefined, 'cpu');
    assert.equal(
      JSON.parse(await readFile(join(stack, 'compose.json'), 'utf8')).services[
        'frameleaf-lan-discovery'
      ],
      undefined,
    );
  } finally {
    if (previous === undefined) delete process.env.MANAGER_BIND_ADDRESS;
    else process.env.MANAGER_BIND_ADDRESS = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
