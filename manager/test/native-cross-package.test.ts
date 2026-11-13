import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  crossPackageRestoreAdmission,
  NATIVE_CROSS_PACKAGE_RESTORE,
  NativeRestoreSources,
} from '../src/runtime/native-cross-package.js';
import { NativeRecovery } from '../src/runtime/native-recovery.js';

const target = {
  release: 'frameleaf-v3.0.0-native.cccccccccccc-1',
  sourceRevision: 'c'.repeat(40),
  postgresMajor: '19',
};
function recovery(release: string, sourceRevision: string) {
  return NativeRecovery.parse({
    schemaVersion: 1,
    runtime: 'native',
    mediaIncluded: false,
    databaseFormat: 'frameleaf-canonical',
    libraryId: 'a'.repeat(12),
    createdAt: 1,
    installation: { id: 'a'.repeat(12), name: 'Library', release },
    checkpoint: {
      protocolVersion: 1,
      state: 'checkpoint',
      schemaVersion: 1,
      operationId: randomUUID(),
      manifestSha256: '9'.repeat(64),
      sourceRevision,
      postgresMajor: '19',
      databaseFormat: 'frameleaf-canonical',
      dump: { bytes: 20, sha256: '1'.repeat(64) },
    },
  });
}
const declared = { sources: [{ postgresMajor: '19' }] };
const earlier = () =>
  recovery('frameleaf-v2.9.4-native.000000000000-1', '0'.repeat(40));

test('a backup from this package needs no declaration, and one from an earlier package needs its Postgres declared', () => {
  assert.equal(
    crossPackageRestoreAdmission(
      recovery(target.release, target.sourceRevision),
      target,
    ),
    'same-package',
  );
  // Today's behaviour: nothing declared, every other package is refused.
  assert.equal(crossPackageRestoreAdmission(earlier(), target), 'refused');
  assert.equal(
    crossPackageRestoreAdmission(earlier(), target, declared),
    'supported',
  );
  // Declared, but not for the Postgres that wrote this backup.
  assert.equal(
    crossPackageRestoreAdmission(earlier(), target, {
      sources: [{ postgresMajor: '18' }],
    }),
    'refused',
  );
  // A package whose own Postgres is older than the backup's never reads it.
  assert.equal(
    crossPackageRestoreAdmission(
      earlier(),
      { ...target, postgresMajor: '18' },
      declared,
    ),
    'refused',
  );
});

test('a restore only goes forward, and what cannot be ordered is refused', () => {
  for (const [release, sourceRevision] of [
    // Newer than this package.
    ['frameleaf-v3.0.1-native.000000000000-1', '0'.repeat(40)],
    ['frameleaf-v4.0.0', '0'.repeat(40)],
    // The same version built from another revision: neither is known to be the older.
    ['frameleaf-v3.0.0-native.000000000000-1', '0'.repeat(40)],
    // The same release tag with another source revision.
    [target.release, '0'.repeat(40)],
  ] as const)
    assert.equal(
      crossPackageRestoreAdmission(
        recovery(release, sourceRevision),
        target,
        declared,
      ),
      'refused',
      release,
    );
  for (const older of [
    'frameleaf-v2.99.99-native.000000000000-1',
    'frameleaf-v3.0.0-rc.1'.replace('3.0.0', '2.0.0'),
    'frameleaf-v1.2.21',
  ])
    assert.equal(
      crossPackageRestoreAdmission(
        recovery(older, '0'.repeat(40)),
        target,
        declared,
      ),
      'supported',
      older,
    );
});

test('a declaration that is not exactly a short list of Postgres majors declares nothing', () => {
  for (const value of [
    {},
    { sources: [] },
    { sources: [{ postgresMajor: 19 }] },
    { sources: [{ postgresMajor: '9' }] },
    { sources: [{ postgresMajor: '19', path: '/x' }] },
    { sources: [{ postgresMajor: '19' }], extra: true },
    { sources: Array.from({ length: 17 }, () => ({ postgresMajor: '19' })) },
  ]) {
    assert.equal(NativeRestoreSources.safeParse(value).success, false);
    assert.equal(
      crossPackageRestoreAdmission(earlier(), target, value as never),
      'refused',
    );
  }
});

test('the capability stays undeclared until the controller side has been run end to end', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );
  assert.equal(
    (manifest.frameleaf?.nativeCapabilities ?? []).includes(
      NATIVE_CROSS_PACKAGE_RESTORE,
    ),
    false,
  );
});
