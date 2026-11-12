import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Mount } from '../src/contracts.js';
import { THUMBNAIL_TARGET, importsFolder } from '../src/mounts.js';
import { applyServiceOverrides, withImportsHostPath } from '../src/compose.js';

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
