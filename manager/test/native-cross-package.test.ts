import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { digest, sha256 } from '../src/contracts.js';
import { Store } from '../src/store.js';
import {
  crossPackageRestoreAdmission,
  NATIVE_CROSS_PACKAGE_RESTORE,
  NativeRestoreSources,
} from '../src/runtime/native-cross-package.js';
import { NativeRecovery } from '../src/runtime/native-recovery.js';
import {
  NativeService,
  readNativeBootstrap,
} from '../src/runtime/native-service.js';
import type { NativeRuntime } from '../src/runtime/native.js';

const target = {
  release: 'frameleaf-v3.0.0-native.cccccccccccc-1',
  sourceRevision: 'c'.repeat(40),
  postgresMajor: '19',
};
const earlierRevision = '0'.repeat(40);
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
const declared = {
  sources: [{ sourceRevision: earlierRevision, postgresMajor: '19' }],
};
const earlier = () =>
  recovery('frameleaf-v2.9.4-native.000000000000-1', earlierRevision);

test('a backup from this package needs no declaration, and one from an earlier package needs that exact package declared', () => {
  assert.equal(
    crossPackageRestoreAdmission(
      recovery(target.release, target.sourceRevision),
      target,
    ),
    'same-package',
  );
  // Nothing declared: every other package is refused.
  assert.equal(crossPackageRestoreAdmission(earlier(), target), 'refused');
  assert.equal(
    crossPackageRestoreAdmission(earlier(), target, declared),
    'supported',
  );
  for (const [name, sources] of [
    // The backup's own source revision is not one the controller declared.
    ['another revision', [{ sourceRevision: '5'.repeat(40), postgresMajor: '19' }]],
    // The revision is declared, but for another Postgres than the one that wrote this backup.
    ['another Postgres', [{ sourceRevision: earlierRevision, postgresMajor: '18' }]],
  ] as const)
    assert.equal(
      crossPackageRestoreAdmission(earlier(), target, {
        sources: [...sources],
      }),
      'refused',
      name,
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
  for (const release of [
    // Newer than this package.
    'frameleaf-v3.0.1-native.000000000000-1',
    'frameleaf-v4.0.0',
    // The same version built from another revision: neither is known to be the older.
    'frameleaf-v3.0.0-native.000000000000-1',
    // The same release tag with another source revision.
    target.release,
  ])
    assert.equal(
      crossPackageRestoreAdmission(
        recovery(release, earlierRevision),
        target,
        declared,
      ),
      'refused',
      release,
    );
  // An older release that claims this package's own revision is not an earlier package.
  assert.equal(
    crossPackageRestoreAdmission(
      recovery('frameleaf-v2.0.0', target.sourceRevision),
      target,
      {
        sources: [
          { sourceRevision: target.sourceRevision, postgresMajor: '19' },
        ],
      },
    ),
    'refused',
  );
  for (const older of [
    'frameleaf-v2.99.99-native.000000000000-1',
    'frameleaf-v2.0.0-rc.1',
    'frameleaf-v1.2.21',
  ])
    assert.equal(
      crossPackageRestoreAdmission(
        recovery(older, earlierRevision),
        target,
        declared,
      ),
      'supported',
      older,
    );
});

test('a declaration that is not exactly a short list of revisions and Postgres majors declares nothing', () => {
  const source = declared.sources[0]!;
  for (const value of [
    {},
    { sources: [] },
    { sources: [{ postgresMajor: '19' }] },
    { sources: [{ ...source, postgresMajor: 19 }] },
    { sources: [{ ...source, postgresMajor: '9' }] },
    { sources: [{ ...source, sourceRevision: 'main' }] },
    { sources: [{ ...source, path: '/x' }] },
    { sources: [source], extra: true },
    { sources: Array.from({ length: 17 }, () => source) },
  ]) {
    assert.equal(NativeRestoreSources.safeParse(value).success, false);
    assert.equal(
      crossPackageRestoreAdmission(earlier(), target, value as never),
      'refused',
    );
  }
});

test('the service does not use the rule yet: an earlier package’s backup is refused before any operation exists, and nothing can switch that on', async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'frameleaf-cross-package-')),
  );
  try {
    const store = new Store(join(root, 'manager'));
    const controller = join(root, 'controller');
    await writeFile(controller, 'synthetic controller', { mode: 0o700 });
    const engine = join(root, 'backup-engine');
    await writeFile(engine, 'synthetic backup engine', { mode: 0o700 });
    const installation = {
      runtime: 'native' as const,
      id: 'a'.repeat(12),
      secureInstallationId: '11111111-1111-4111-8111-111111111111',
      controller,
      candidate: join(root, 'runtime'),
      state: join(root, 'state'),
      manifestSha256: 'b'.repeat(64),
      sourceRevision: target.sourceRevision,
      certified: false,
      databasePort: 54329,
      apiPort: 2283,
    };
    const bootstrap = {
      protocolVersion: 2 as const,
      backupKey: 'k'.repeat(43),
      installation,
      controllerSha256: sha256('synthetic controller'),
      backupEngine: {
        executable: engine,
        sha256: sha256('synthetic backup engine'),
      },
      tls: {
        certificatePem: 'synthetic certificate',
        privateKeyPem: 'synthetic private key',
      },
      name: 'Native library',
      release: target.release,
      password: 'synthetic native database password',
    };
    const effects: string[] = [];
    const unavailable = async (): Promise<never> => {
      effects.push('host');
      throw new Error('the host must not be reached');
    };
    const runtime = {
      status: () => ({ state: 'stopped' }),
      // The identity the restore operation itself checks, so nothing here fails early for
      // an unrelated reason.
      identity: {
        runtime: 'native',
        installationId: installation.id,
        fingerprint: digest(installation),
      },
      start: unavailable,
      stop: unavailable,
      checkpoint: unavailable,
      startRestorePreparation: unavailable,
      finalizeRestore: unavailable,
      selectRestore: unavailable,
      verifyRestore: unavailable,
      prepareRestore: unavailable,
      startCheckpointCleanup: unavailable,
      startDatabase: unavailable,
      cleanupCheckpoint: unavailable,
    } as unknown as NativeRuntime;
    const service = new NativeService(store, bootstrap, runtime, {} as never);
    const context = {
      installation,
      libraryId: installation.id,
      release: bootstrap.release,
    };
    const reviewId = randomUUID();
    const backup = earlier();
    store.set(`native-restore-review:${reviewId}`, {
      id: reviewId,
      state: 'prepared',
      snapshot: '2'.repeat(64),
      expires: Date.now() + 900_000,
      contextFingerprint: digest(context),
      recovery: backup,
    });
    // The rule itself would admit this backup for a controller that declared its package.
    assert.equal(
      crossPackageRestoreAdmission(backup, target, declared),
      'supported',
    );
    assert.equal(
      service.restoreReview(reviewId, installation.id).requiresRuntimeChange,
      true,
    );
    assert.throws(
      () => service.restore(reviewId, randomUUID(), installation.id),
      (error: any) => error.code === 'native_restore_runtime_change_required',
    );
    // Refused before an operation exists: nothing holds the single-operation lock, the host
    // was never asked for anything, and the next operation is free to start.
    assert.equal(store.history().length, 0);
    assert.equal(store.locked(), null);
    assert.deepEqual(effects, []);
    // No bootstrap can switch it on: a declaration is an unknown field and refuses the start.
    const read = (value: unknown) =>
      readNativeBootstrap(
        Readable.from([Buffer.from(JSON.stringify(value) + '\n')]),
      );
    assert.equal((await read(bootstrap)).release, bootstrap.release);
    await assert.rejects(
      read({ ...bootstrap, crossPackageRestore: declared }),
      (error: any) => error.code === 'native_bootstrap_invalid',
    );
    store.db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the capability is not declared', async () => {
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
