import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Mount } from '../src/contracts.js';
import { THUMBNAIL_TARGET, importsFolder } from '../src/mounts.js';

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
