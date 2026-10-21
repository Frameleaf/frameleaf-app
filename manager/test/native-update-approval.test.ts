import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  readFile,
  realpath,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { Store } from '../src/store.js';
import { digest } from '../src/contracts.js';
import { approveNativeUpdate } from '../src/runtime/native-update-approval.js';
async function fixture(run: (f: any) => Promise<void>) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'frameleaf-update-approval-')),
  );
  const store = new Store(join(root, 'manager'));
  const installation = {
    runtime: 'native',
    id: 'a'.repeat(12),
    secureInstallationId: '11111111-1111-4111-8111-111111111111',
    controller: join(root, 'controller'),
    candidate: join(root, 'candidate'),
    state: join(root, 'state'),
    manifestSha256: 'b'.repeat(64),
    sourceRevision: 'c'.repeat(40),
    certified: false,
    databasePort: 54329,
    apiPort: 2283,
  };
  await mkdir(installation.state, { mode: 0o700 });
  const journal = {
    schemaVersion: 2,
    secureInstallationId: installation.secureInstallationId,
    installationId: installation.id,
    manifestSha256: installation.manifestSha256,
    profileIdentity: 'd'.repeat(64),
    generation: randomUUID(),
    phase: 'stopped',
    restorePending: false,
  };
  const path = join(installation.state, 'controller-state.json');
  await writeFile(path, JSON.stringify(journal), { mode: 0o600 });
  const context = {
    installation,
    libraryId: installation.id,
    name: 'Synthetic',
    release: 'frameleaf-v3.0.0-1',
    managerFingerprint: '',
  };
  const runtime = {
    identity: {
      runtime: 'native',
      installationId: installation.id,
      fingerprint: digest(installation),
    },
    status: () => ({ state: 'stopped' }),
  };
  const descriptor = { installation };
  store.set('native-installation', {
    fingerprint: digest(descriptor),
    descriptor,
  });
  store.set('native-library-id', context.libraryId);
  context.managerFingerprint = digest(descriptor);
  const { operation } = store.start('backup', randomUUID(), runtime.identity);
  const checkpoint = {
    protocolVersion: 1,
    state: 'checkpoint',
    schemaVersion: 1,
    operationId: operation.id,
    manifestSha256: installation.manifestSha256,
    sourceRevision: installation.sourceRevision,
    postgresMajor: '19',
    databaseFormat: 'frameleaf-canonical',
    dump: { bytes: 123, sha256: 'e'.repeat(64) },
  };
  const recovery = {
    schemaVersion: 1,
    runtime: 'native',
    mediaIncluded: false,
    databaseFormat: 'frameleaf-canonical',
    libraryId: context.libraryId,
    createdAt: operation.createdAt,
    installation: {
      id: installation.id,
      name: context.name,
      release: context.release,
    },
    checkpoint,
  };
  const result = { snapshotId: 'f'.repeat(64), recovery };
  operation.receipts = {
    'native-backup-database-intent': runtime.identity,
    'native-backup-start-database': {
      protocolVersion: 1,
      state: 'database-ready',
      secureInstallationId: installation.secureInstallationId,
      manifestSha256: installation.manifestSha256,
      sourceRevision: installation.sourceRevision,
      certified: false,
    },
    'native-backup-checkpoint': checkpoint,
    'native-backup-encrypt': result,
    'native-backup-verified': result,
    'native-backup-owner-cleaned': {
      ...checkpoint,
      state: 'checkpoint-cleaned',
    },
    'native-backup-stage-cleaned': {
      directory: join(store.directory, 'native-backup-staging', operation.id),
      recoverySha256: digest(recovery),
    },
    'native-backup-stop-database': { protocolVersion: 1, state: 'stopped' },
  };
  // Intent is saved before execution; only executed steps enter completed.
  operation.completed = Object.keys(operation.receipts).filter(
    (key) => key !== 'native-backup-database-intent',
  );
  operation.state = 'complete';
  store.save(operation);
  const request = {
    backupOperationId: operation.id,
    targetManifestSha256: '1'.repeat(64),
    migrationsApproved: true,
    key: randomUUID(),
  };
  const key = 'k'.repeat(43);
  try {
    await run({
      root,
      store,
      context,
      runtime,
      operation,
      request,
      key,
      path,
      journal,
    });
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}
test('fresh stopped-maintenance backup approval is target bound, sealed and idempotent without expiry refresh', async () => {
  await fixture(async ({ store, context, runtime, request, key, path }) => {
    const first = await approveNativeUpdate(
      store,
      runtime,
      context,
      key,
      request,
    );
    const [encoded, mac] = first.approval.split('.');
    const raw = Buffer.from(encoded, 'base64url');
    const payload = JSON.parse(raw.toString());
    assert.equal(
      mac,
      createHmac('sha256', key)
        .update('frameleaf-native-update-approval-v1\0')
        .update(raw)
        .digest('hex'),
    );
    assert.equal(payload.targetManifestSha256, request.targetManifestSha256);
    assert.equal(payload.backupOperationId, request.backupOperationId);
    assert.equal(
      payload.controllerStateSha256,
      digest(JSON.parse((await readFile(path)).toString())),
    );
    assert.equal(payload.expiresAt - payload.issuedAt, 300000);
    assert.equal(payload.migrationsApproved, true);
    assert.deepEqual(
      await approveNativeUpdate(store, runtime, context, key, request),
      first,
    );
    assert.ok(!JSON.stringify(first).includes(key));
    await assert.rejects(
      approveNativeUpdate(store, runtime, context, key, {
        ...request,
        targetManifestSha256: '2'.repeat(64),
      }),
    );
  });
});
test('approval refuses live, stale, incomplete, foreign and superseded backup evidence without writes', async () => {
  await fixture(
    async ({
      store,
      context,
      runtime,
      request,
      key,
      operation,
      path,
      journal,
    }) => {
      const original = JSON.stringify(operation);
      const snapshot = () =>
        JSON.stringify(
          store.db.prepare('SELECT * FROM settings ORDER BY key').all(),
        );
      const before = snapshot();
      for (const field of [
        'native-backup-database-intent',
        'native-backup-verified',
        'native-backup-owner-cleaned',
        'native-backup-stop-database',
      ]) {
        const changed = JSON.parse(original);
        delete changed.receipts[field];
        store.db
          .prepare('UPDATE operations SET value=? WHERE id=?')
          .run(JSON.stringify(changed), operation.id);
        await assert.rejects(
          approveNativeUpdate(store, runtime, context, key, request),
        );
        assert.equal(snapshot(), before);
      }
      store.db
        .prepare('UPDATE operations SET value=? WHERE id=?')
        .run(original, operation.id);
      await assert.rejects(
        approveNativeUpdate(
          store,
          { ...runtime, status: () => ({ state: 'running' }) },
          context,
          key,
          request,
        ),
      );
      await assert.rejects(
        approveNativeUpdate(store, runtime, context, key, {
          ...request,
          migrationsApproved: false,
        }),
      );
      await writeFile(path, JSON.stringify({ ...journal, phase: 'active' }));
      await assert.rejects(
        approveNativeUpdate(store, runtime, context, key, request),
      );
      await writeFile(path, JSON.stringify(journal));
      const stale = JSON.parse(original);
      stale.updatedAt = Date.now() - 600001;
      store.db
        .prepare('UPDATE operations SET value=? WHERE id=?')
        .run(JSON.stringify(stale), operation.id);
      await assert.rejects(
        approveNativeUpdate(store, runtime, context, key, request),
      );
      store.db
        .prepare('UPDATE operations SET value=? WHERE id=?')
        .run(original, operation.id);
      store.start('start', randomUUID(), runtime.identity);
      await assert.rejects(
        approveNativeUpdate(store, runtime, context, key, request),
      );
      assert.equal(snapshot(), before);
    },
  );
});

test('approval rechecks intervening lifecycle writes after async journal reads', async () => {
  await fixture(async ({ store, context, runtime, request, key }) => {
    let first = true;
    const changing = {
      ...runtime,
      status: () => {
        if (first) {
          first = false;
          queueMicrotask(() =>
            store.start('start', randomUUID(), runtime.identity),
          );
        }
        return { state: 'stopped' };
      },
    };
    await assert.rejects(
      approveNativeUpdate(store, changing, context, key, request),
    );
    assert.equal(store.get('native-update-approval:' + request.key), null);
  });
});
test('approval retry refuses changed stopped journal, tampered stored token and expired approval', async () => {
  await fixture(
    async ({ store, context, runtime, request, key, path, journal }) => {
      const first = await approveNativeUpdate(
        store,
        runtime,
        context,
        key,
        request,
      );
      const account = 'native-update-approval:' + request.key;
      const original = store.get<any>(account);
      await writeFile(
        path,
        JSON.stringify({ ...journal, generation: randomUUID() }),
      );
      await assert.rejects(
        approveNativeUpdate(store, runtime, context, key, request),
      );
      await writeFile(path, JSON.stringify(journal));
      store.set(account, {
        ...original,
        approval:
          first.approval.slice(0, -1) +
          (first.approval.endsWith('0') ? '1' : '0'),
      });
      await assert.rejects(
        approveNativeUpdate(store, runtime, context, key, request),
      );
      store.set(account, {
        ...original,
        issuedAt: Date.now() - 300001,
        expiresAt: Date.now() - 1,
      });
      await assert.rejects(
        approveNativeUpdate(store, runtime, context, key, request),
      );
      store.set(account, original);
      const secondConnection = new Store(store.directory);
      try {
        assert.deepEqual(
          await approveNativeUpdate(
            secondConnection,
            runtime,
            context,
            key,
            request,
          ),
          first,
        );
      } finally {
        secondConnection.close();
      }
    },
  );
});

test('a stale Manager cannot approve a newer stored descriptor using its old runtime and backup', async () => {
  await fixture(async ({ store, context, runtime, request, key }) => {
    const current = store.get<any>('native-installation');
    const descriptor = {
      ...current.descriptor,
      release: 'frameleaf-v3.0.0-99',
    };
    store.set('native-installation', {
      fingerprint: digest(descriptor),
      descriptor,
    });
    await assert.rejects(
      approveNativeUpdate(store, runtime, context, key, request),
    );
    assert.equal(store.get('native-update-approval:' + request.key), null);
  });
});
