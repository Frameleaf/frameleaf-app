import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { recordNativePackage, verifyNativeFiles } from './verify-darktable.mjs';
const pins = JSON.parse(readFileSync(new URL('./sources/darktable.json', import.meta.url)));

test('native manifest refuses tampering, missing resources, unpatched modules and wrong revision', () => {
  const prefix = mkdtempSync(join(tmpdir(), 'frameleaf-native-package-'));
  const put = (name, data) => {
    const parts = name.split('/');
    parts.pop();
    mkdirSync(join(prefix, ...parts), { recursive: true });
    writeFileSync(join(prefix, name), data);
  };
  try {
    for (const name of [
      'bin/darktable',
      'bin/darktable-cli',
      'share/darktable/darktablerc',
      'share/darktable/noiseprofiles.json',
      'share/darktable/rawspeed/cameras.xml',
      'share/lensfun/version_1/test.xml',
      'share/frameleaf/licenses/darktable-LICENSE',
      'lib/liblensfun.so.1',
    ])
      put(name, 'fixture');
    put('lib/darktable/plugins/liblens.so', 'frameleaf-lens-calibration:');
    put('lib/darktable/plugins/librotatepixels.so', 'frameleaf-native-mask-geometry:rotatepixels:1');
    recordNativePackage(prefix, pins);
    assert.equal(verifyNativeFiles(prefix).source.revision, pins.revision);
    put('share/lensfun/version_1/test.xml', 'tampered');
    assert.throws(() => verifyNativeFiles(prefix), /Native package changed/);
    recordNativePackage(prefix, pins);
    rmSync(join(prefix, 'share/darktable/rawspeed/cameras.xml'));
    assert.throws(() => verifyNativeFiles(prefix));
    put('share/darktable/rawspeed/cameras.xml', 'fixture');
    put('lib/darktable/plugins/liblens.so', 'unpatched');
    recordNativePackage(prefix, pins);
    assert.throws(() => verifyNativeFiles(prefix));
    recordNativePackage(prefix, { ...pins, revision: 'bad' });
    assert.throws(() => verifyNativeFiles(prefix));
  } finally {
    rmSync(prefix, { recursive: true, force: true });
  }
});
