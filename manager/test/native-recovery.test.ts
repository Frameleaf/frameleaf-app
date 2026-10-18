import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createNativeRecovery,
  NativeRecovery,
} from '../src/runtime/native-recovery.js';

const operation = {
  id: '11111111-1111-4111-8111-111111111111',
  createdAt: 1760000000000,
};
const context = {
  operation,
  libraryId: 'dddddddddddd',
  name: 'Native library',
  release: 'frameleaf-v3.0.0-1',
  installation: {
    runtime: 'native' as const,
    id: 'aaaaaaaaaaaa',
    controller: '/private/controller',
    candidate: '/private/runtime',
    state: '/private/state',
    manifestSha256: 'b'.repeat(64),
    sourceRevision: 'c'.repeat(40),
    certified: false,
    databasePort: 54329,
    apiPort: 2283,
  },
};
const checkpoint = {
  protocolVersion: 1,
  state: 'checkpoint',
  schemaVersion: 1,
  operationId: operation.id,
  manifestSha256: 'b'.repeat(64),
  sourceRevision: 'c'.repeat(40),
  postgresMajor: '19',
  databaseFormat: 'frameleaf-canonical',
  dump: { bytes: 17, sha256: 'e'.repeat(64) },
};

test('native recovery preserves stable library lineage and exact logical checkpoint provenance without Compose, physical paths or secrets', () => {
  const recovery = createNativeRecovery(context, checkpoint);
  assert.equal(recovery.runtime, 'native');
  assert.equal(recovery.schemaVersion, 1);
  assert.equal(recovery.mediaIncluded, false);
  assert.equal(recovery.databaseFormat, 'frameleaf-canonical');
  assert.equal(recovery.libraryId, context.libraryId);
  assert.equal(recovery.createdAt, operation.createdAt);
  assert.deepEqual(recovery.installation, {
    id: context.installation.id,
    name: context.name,
    release: context.release,
  });
  assert.deepEqual(recovery.checkpoint, checkpoint);
  assert.deepEqual(createNativeRecovery(context, checkpoint), recovery);
  const serialized = JSON.stringify(recovery);
  for (const forbidden of [
    'databasePassword',
    'backupKey',
    'project',
    'mounts',
    '/private/',
  ])
    assert.ok(!serialized.includes(forbidden));
});

test('native recovery refuses a foreign operation, runtime revision or malformed dump before staging', () => {
  for (const change of [
    { operationId: '22222222-2222-4222-8222-222222222222' },
    { manifestSha256: 'f'.repeat(64) },
    { sourceRevision: 'f'.repeat(40) },
    { postgresMajor: '20' },
    { databaseFormat: 'immich-source' },
    { dump: { bytes: 0, sha256: 'e'.repeat(64) } },
    { dump: { bytes: Number.MAX_SAFE_INTEGER + 1, sha256: 'e'.repeat(64) } },
    { dump: { bytes: 17, sha256: 'wrong' } },
    { password: 'must not survive' },
  ])
    assert.throws(
      () => createNativeRecovery(context, { ...checkpoint, ...change }),
      /native_recovery_invalid/,
    );
  for (const change of [
    { libraryId: '' },
    { release: 'latest' },
    { operation: { ...operation, createdAt: -1 } },
  ])
    assert.throws(
      () => createNativeRecovery({ ...context, ...change }, checkpoint),
      /native_recovery_invalid/,
    );
});

test('native recovery parsing refuses Docker-shaped, secret-bearing and ambiguous records', () => {
  const valid = createNativeRecovery(context, checkpoint);
  assert.ok(
    NativeRecovery.safeParse(JSON.parse(JSON.stringify(valid))).success,
  );
  for (const invalid of [
    { ...valid, runtime: 'docker' },
    { ...valid, schemaVersion: 2 },
    { ...valid, mediaIncluded: true },
    { ...valid, databasePassword: 'secret' },
    { ...valid, backupKey: 'k'.repeat(43) },
    { ...valid, project: 'frameleaf-aaaaaaaaaaaa' },
    {
      ...valid,
      installation: {
        ...valid.installation,
        databasePath: '/private/database',
      },
    },
    { ...valid, checkpoint: { ...checkpoint, extra: true } },
  ])
    assert.equal(NativeRecovery.safeParse(invalid).success, false);
});

test('native recovery does not relabel an erased foreign runtime or serialize extra context secrets', () => {
  const foreign = {
    ...context,
    installation: { ...context.installation, runtime: 'docker' },
  };
  assert.throws(
    () =>
      createNativeRecovery(foreign as unknown as typeof context, checkpoint),
    /native_recovery_invalid/,
  );
  const extra = {
    ...context,
    backupKey: 'secret-backup-key',
    installation: {
      ...context.installation,
      password: 'secret-database-password',
    },
  };
  const recovery = JSON.stringify(createNativeRecovery(extra, checkpoint));
  assert.ok(
    !recovery.includes('secret-backup-key') &&
      !recovery.includes('secret-database-password'),
  );
});
