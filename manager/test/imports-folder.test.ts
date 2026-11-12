import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Installation } from '../src/contracts.js';
import type { VerifiedRelease } from '../src/releases.js';
import type { Mount } from '../src/contracts.js';
import { THUMBNAIL_TARGET, importsFolder } from '../src/mounts.js';
import { applyServiceOverrides, renderCompose, withImportsHostPath } from '../src/compose.js';

const library = (source: string): Mount => ({ type: 'bind', source, target: '/data', readOnly: false });

test('FL-1477: the Imports folder is `imports` inside the library folder on the host', () => {
  const thumbs: Mount = { type: 'bind', source: '/mnt/fast/thumbs', target: THUMBNAIL_TARGET, readOnly: false };
  assert.equal(importsFolder([library('/mnt/user/appdata/frameleaf')]), '/mnt/user/appdata/frameleaf/imports');
  assert.equal(importsFolder([library('/mnt/user/photos'), thumbs]), '/mnt/user/photos/imports');
});

test('FL-1477: no host path for a library that is a volume, or no library at all', () => {
  assert.equal(importsFolder([{ type: 'volume', source: 'photos', target: '/data', readOnly: false }]), null);
  assert.equal(importsFolder([]), null);
});

test('FL-1477: the Imports folder follows a media location set inside the library mount', () => {
  const mounts = [library('/mnt/user/photos')];
  assert.equal(importsFolder(mounts, '/data/custom'), '/mnt/user/photos/custom/imports');
  assert.equal(importsFolder(mounts, '/data/'), '/mnt/user/photos/imports');
  assert.equal(importsFolder(mounts, '/usr/src/app/upload'), null);
  assert.equal(importsFolder(mounts, '/data/../etc'), null);
});

test('FL-1477: compose names Imports from the server environment after overrides', () => {
  const mounts = [library('/mnt/user/photos')];
  const services: Record<string, any> = { 'frameleaf-server': { environment: { DB_PORT: '5432' } } };
  applyServiceOverrides(services, {
    'frameleaf-server': { environment: { FRAMELEAF_MEDIA_LOCATION: '/data/custom' }, mounts: [] },
  } as never);
  withImportsHostPath(services['frameleaf-server'], mounts);
  assert.equal(services['frameleaf-server'].environment.FRAMELEAF_IMPORTS_HOST_PATH, '/mnt/user/photos/custom/imports');

  const plain: Record<string, any> = { environment: {} };
  withImportsHostPath(plain, mounts);
  assert.equal(plain.environment.FRAMELEAF_IMPORTS_HOST_PATH, '/mnt/user/photos/imports');

  const own: Record<string, any> = { environment: { FRAMELEAF_IMPORTS_HOST_PATH: '/srv/imports' } };
  withImportsHostPath(own, mounts);
  assert.equal(own.environment.FRAMELEAF_IMPORTS_HOST_PATH, '/srv/imports');
});

test('FL-1477: the rendered stack names Imports inside the media location Manager sets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'manager-imports-'));
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
      mounts: [library('/mnt/user/photos')],
      databasePath: '/fixtures/db',
    } as unknown as Installation;
    const stack = join(dir, 'stack');
    const render = async (environment: Record<string, string>) => {
      await renderCompose(release, installation, 'pw', stack, { environment, settings: null } as never, 'cpu');
      const compose = JSON.parse(await readFile(join(stack, 'compose.json'), 'utf8'));
      return compose.services['frameleaf-server'].environment.FRAMELEAF_IMPORTS_HOST_PATH;
    };

    assert.equal(await render({}), '/mnt/user/photos/imports');
    assert.equal(await render({ IMMICH_MEDIA_LOCATION: '/data/custom' }), '/mnt/user/photos/custom/imports');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
