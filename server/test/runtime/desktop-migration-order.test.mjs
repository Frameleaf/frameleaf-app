import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('desktop migrations append after the released Cloud Backup chain', () => {
  const order = readFileSync(new URL('../../src/schema/migrations/ORDER', import.meta.url), 'utf8')
    .trim()
    .split(/\r?\n/);
  const released = order.indexOf('2100000002990-CloudBackupSelection');
  assert.ok(released >= 0);
  const desktop = new Set([
    'DesktopDevice',
    'DesktopMlBroker',
    'DesktopWorkerSession',
    'DesktopWorkerChallenge',
    'DesktopWorkerQualification',
    'MlRouteOrigin',
    'ClipProducerIdentity',
    'AllClipProducerIdentity',
    'DesktopClipIndex',
    'DesktopWorkerPresence',
    'DesktopMlDisclosure',
    'PhotoSources',
  ]);
  const additions = order.filter((name) => desktop.has(name.slice(14)));
  assert.equal(additions.length, desktop.size);
  for (const name of additions) assert.ok(order.indexOf(name) > released, `${name} precedes released migrations`);
});
