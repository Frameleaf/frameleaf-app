import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { digest, Refusal } from '../src/contracts.js';
import {
  runNativeMediaCutover,
  completeNativeMediaCutover,
  nativeActiveMediaIdentity,
  nativeMediaMoveAdmission,
  type NativeMediaMoveAuthority,
} from '../src/runtime/native-media-cutover.js';
import { NativeHost, NativeInstallationSchema, NativeOperations } from '../src/runtime/native.js';
import { Store } from '../src/store.js';

const intentKey = 'native-media-cutover-intent';
const resultKey = 'native-media-cutover-receipt';

async function fixture(
  decision: 'target' | 'original',
  run: (input: ReturnType<typeof setup>) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), 'manager-native-media-move-'));
  const store = new Store(directory);
  try {
    await run(setup(store, directory, decision));
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function setup(
  store: Store,
  directory: string,
  decision: 'target' | 'original',
) {
  const installation = NativeInstallationSchema.parse({
    runtime: 'native',
    id: 'a'.repeat(12),
    secureInstallationId: randomUUID(),
    controller: join(directory, 'controller'),
    candidate: join(directory, 'candidate'),
    state: join(directory, 'state'),
    manifestSha256: 'b'.repeat(64),
    sourceRevision: 'c'.repeat(40),
    certified: false,
    databasePort: 15432,
    apiPort: 13001,
  });
  const identity = {
    runtime: 'native' as const,
    installationId: installation.id,
    fingerprint: digest(installation),
  };
  const binding = {
    moveId: randomUUID(),
    secureInstallationId: installation.secureInstallationId,
    manifestSha256: installation.manifestSha256,
    libraryId: 'd'.repeat(12),
    profileIdentity: '1'.repeat(64),
    sourceGeneration: randomUUID(),
    sourceIdentity: '2'.repeat(64),
    targetIdentity: '3'.repeat(64),
    stagedIdentity: '4'.repeat(64),
    approvalSha256: '5'.repeat(64),
    copyReceiptSha256: '6'.repeat(64),
  };
  store.set('native-library-id', binding.libraryId);
  const { operation } = store.start('move-library', 'fixture', {
    ...identity,
    binding,
    decision,
  });
  const selection = {
    protocolVersion: 1,
    operationId: operation.id,
    binding,
    state: 'selected-fenced',
    writerFence: 'held',
  };
  const finalized = {
    ...selection,
    state: decision === 'target' ? 'target-admitted' : 'original-restored',
    writerFence: 'released',
    activeMediaIdentity:
      decision === 'target' ? binding.stagedIdentity : binding.sourceIdentity,
    generation: decision === 'target' ? randomUUID() : binding.sourceGeneration,
  };
  let receipt: unknown = selection;
  let calls = 0;
  const owner: NativeMediaMoveAuthority = {
    identity,
    inspect: async (request) => {
      assert.deepEqual(request.binding, binding);
      assert.equal(request.operationId, operation.id);
      return receipt;
    },
    apply: async (proof, chosen) => {
      calls++;
      assert.deepEqual(proof, selection);
      assert.equal(chosen, decision);
      assert.deepEqual(store.locked()?.receipts[intentKey], {
        request: { protocolVersion: 1, operationId: operation.id, binding },
        decision,
        sourceMediaIdentity: store.get(`native-active-media:${installation.secureInstallationId}`),
      });
      receipt = finalized;
      return receipt;
    },
  };
  return {
    store,
    operation,
    installation,
    owner,
    selection,
    finalized,
    setReceipt: (value: unknown) => {
      receipt = value;
    },
    calls: () => calls,
    execute: () => runNativeMediaCutover(store, owner, installation, operation),
  };
}

for (const decision of ['target', 'original'] as const) {
  test(`media cutover journals only the reviewed ${decision} and keeps the lifecycle lock`, async () => {
    await fixture(decision, async (f) => {
      assert.deepEqual(await f.execute(), f.finalized);
      assert.deepEqual(await f.execute(), f.finalized);
      assert.equal(f.calls(), 1);
      assert.deepEqual(f.store.locked()?.receipts[resultKey], f.finalized);
      assert.equal(f.store.locked()?.state, 'running');
    });
  });
}

test('an interrupted writer admission is reconciled without a second apply', async () => {
  await fixture('target', async (f) => {
    const apply = f.owner.apply;
    f.owner.apply = async (...args) => {
      await apply(...args);
      throw new Error('lost acknowledgement');
    };
    await assert.rejects(f.execute(), /lost acknowledgement/);
    assert.equal(f.store.locked()?.receipts[resultKey], undefined);
    f.store.interrupt();
    const resumed = f.store.locked()!;
    assert.equal(resumed.state, 'interrupted');
    resumed.state = 'running';
    resumed.error = null;
    f.store.save(resumed);
    const result = await runNativeMediaCutover(
      f.store,
      f.owner,
      f.installation,
      resumed,
    );
    assert.deepEqual(result, f.finalized);
    assert.equal(f.calls(), 1);
  });
});

test('a foreign or unfenced selection, unsolicited final receipt, and cancellation never apply', async () => {
  await fixture('target', async (f) => {
    for (const receipt of [
      { ...f.selection, operationId: randomUUID() },
      { ...f.selection, writerFence: 'released' },
      {
        ...f.selection,
        binding: { ...f.selection.binding, approvalSha256: '0'.repeat(64) },
      },
      f.finalized,
    ]) {
      f.setReceipt(receipt);
      await assert.rejects(
        f.execute(),
        (error: unknown) =>
          error instanceof Refusal &&
          error.code === 'native_media_cutover_unconfirmed',
      );
    }
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      runNativeMediaCutover(
        f.store,
        f.owner,
        f.installation,
        f.operation,
        controller.signal,
      ),
      (error: unknown) =>
        error instanceof Refusal && error.code === 'native_media_cutover_cancelled',
    );
    assert.equal(f.calls(), 0);
    assert.equal(f.store.locked()?.receipts[intentKey], undefined);
  });
});

test('a wrong post-activation media identity never becomes a durable final receipt', async () => {
  await fixture('target', async (f) => {
    const apply = f.owner.apply;
    f.owner.apply = async (...args) => {
      await apply(...args);
      const changed = {
        ...f.finalized,
        activeMediaIdentity: f.selection.binding.sourceIdentity,
      };
      f.setReceipt(changed);
      return changed;
    };
    await assert.rejects(f.execute(), /native_media_cutover_unconfirmed/);
    await assert.rejects(f.execute(), /native_media_cutover_unconfirmed/);
    assert.equal(f.calls(), 1);
    assert.equal(f.store.locked()?.receipts[resultKey], undefined);
    assert.ok(f.store.locked()?.receipts[intentKey]);
  });
});


test('recovery keeps the operation lock until exact relocated readiness and retains the expected root for later starts', async () => {
  await fixture('target', async (f) => {
    const runtime = new NativeHost(f.installation, async () => '');
    const exact = f.finalized.activeMediaIdentity;
    let actual: string | undefined;
    let starts = 0;
    const lifecycle = new NativeOperations(
      f.store, runtime, undefined, undefined,
      (operation) => completeNativeMediaCutover(f.store, f.owner, f.installation, operation, async () => {
        assert.equal(nativeActiveMediaIdentity(f.store, f.installation), exact);
        assert.equal(f.store.locked()?.id, operation.id);
        starts++;
        return {
          protocolVersion: 1,
          state: 'running',
          secureInstallationId: f.installation.secureInstallationId,
          manifestSha256: f.installation.manifestSha256,
          sourceRevision: f.installation.sourceRevision,
          certified: f.installation.certified,
          ...(actual ? { activeMediaIdentity: actual } : {}),
        };
      }),
    );
    f.store.interrupt();
    for (const identity of [undefined, f.selection.binding.sourceIdentity]) {
      actual = identity;
      lifecycle.resume(f.operation.id);
      const refused = await lifecycle.wait(f.operation.id);
      assert.equal(refused.state, 'failed');
      assert.equal(refused.error, 'native_media_startup_unconfirmed');
      assert.equal(f.store.locked()?.id, f.operation.id);
      assert.equal(f.store.locked()?.receipts['native-media-cutover-startup'], undefined);
    }
    // The native generation changes on startup. The final cutover receipt was
    // persisted before the first startup, so recovery cannot inspect it again.
    f.owner.inspect = async () => { throw new Error('owner no longer quiescent'); };
    actual = exact;
    lifecycle.resume(f.operation.id);
    const complete = await lifecycle.wait(f.operation.id);
    assert.equal(complete.state, 'complete');
    assert.equal(f.store.locked(), null);
    assert.equal(starts, 3);
    assert.equal(f.calls(), 1);
    assert.equal(nativeActiveMediaIdentity(f.store, f.installation), exact);
  });
});


test('candidate admission needs verified backup readback and exact explicit confirmation', async () => {
  await fixture('target', async (f) => {
    f.operation.state = 'complete';
    f.store.save(f.operation);
    const backup = f.store.start('backup', 'safety', { ...f.owner.identity }).operation;
    const recovery = {
      schemaVersion: 1, runtime: 'native', mediaIncluded: false,
      databaseFormat: 'frameleaf-canonical', libraryId: f.selection.binding.libraryId,
      createdAt: Date.now(),
      installation: { id: f.installation.id, name: 'Fixture', release: 'frameleaf-v3.0.0-1' },
      checkpoint: {
        protocolVersion: 1, state: 'checkpoint', schemaVersion: 1,
        operationId: backup.id, manifestSha256: f.installation.manifestSha256,
        sourceRevision: f.installation.sourceRevision, postgresMajor: '19',
        databaseFormat: 'frameleaf-canonical', dump: { bytes: 12, sha256: 'b'.repeat(64) },
      },
    };
    let nativeReview = true;
    let inspections = 0;
    const admission = nativeMediaMoveAdmission(
      f.store,
      {
        ...f.owner,
        inspectAdmission: async (request, reviewed) => {
          assert.equal(reviewed.recoverySha256, digest(recovery));
          assert.equal(reviewed.checkpoint.operationId, backup.id);
          assert.equal('state' in reviewed.checkpoint, false);
          inspections++;
          return { ...request, state: 'selected-fenced', writerFence: nativeReview ? 'held' : 'released' };
        },
      },
      f.installation,
      f.selection.binding.libraryId,
      (key, input) => f.store.start('move-library', key, input).operation,
    );
    const reviewId = randomUUID();
    const input = { binding: f.selection.binding, backupOperationId: backup.id, decision: 'target' as const };
    await assert.rejects(admission.review(input, reviewId), /native_media_backup_unverified/);
    assert.equal(inspections, 0);
    backup.receipts['native-backup-verified'] = { snapshotId: 'a'.repeat(64), recovery };
    backup.completed.push('native-backup-verified', 'native-backup-owner-cleaned');
    backup.state = 'complete';
    f.store.save(backup);
    const review = await admission.review(input, reviewId);
    assert.equal(f.store.locked(), null);
    const key = randomUUID();
    await assert.rejects(
      admission.confirm({ reviewId, reviewSha256: '0'.repeat(64), key }),
      /native_media_review_changed/,
    );
    nativeReview = false;
    const confirmation = { reviewId, reviewSha256: review.reviewSha256, key };
    await assert.rejects(admission.confirm(confirmation), /native_media_cutover_unconfirmed/);
    assert.equal(f.store.locked(), null);
    nativeReview = true;
    const admitted = await admission.confirm(confirmation);
    assert.equal(f.store.locked()?.id, admitted.id);
    assert.deepEqual(await admission.confirm(confirmation), admitted);
    assert.equal(inspections, 3);
  });
});


test('refuses a foreign active media identity before recording or calling the owner', async () => {
  await fixture('target', async (f) => {
    f.store.set(`native-active-media:${f.installation.secureInstallationId}`, 'f'.repeat(64));
    f.owner.inspect = async () => { throw Error('owner inspection must not run'); };
    await assert.rejects(f.execute(), /native_media_cutover_journal_invalid/);
    assert.equal(f.store.locked()?.receipts[intentKey], undefined);
    assert.equal(f.calls(), 0);
  });
});

for (const [decision, previouslyRelocated] of [
  ['target', true],
  ['original', true],
  ['original', false],
] as const) {
  test(`replays ${decision} startup with an exact identity (relocated source: ${previouslyRelocated})`, async () => {
    await fixture(decision, async (f) => {
      const source = previouslyRelocated ? f.selection.binding.sourceIdentity : undefined;
      const expected = decision === 'target' ? f.finalized.activeMediaIdentity : source;
      if (source)
        f.store.set(`native-active-media:${f.installation.secureInstallationId}`, source);

      const complete = (start: NativeHost['start']) =>
        completeNativeMediaCutover(f.store, f.owner, f.installation, f.operation, start);
      await assert.rejects(complete(async () => {
        assert.equal(nativeActiveMediaIdentity(f.store, f.installation), expected);
        throw Error('lost startup acknowledgement');
      }), /lost startup acknowledgement/);
      assert.ok(f.store.locked()?.receipts[resultKey]);
      f.owner.inspect = async () => { throw Error('already finalized'); };

      await complete(async () => ({
        protocolVersion: 1,
        state: 'running',
        secureInstallationId: f.installation.secureInstallationId,
        manifestSha256: f.installation.manifestSha256,
        sourceRevision: f.installation.sourceRevision,
        certified: f.installation.certified,
        ...(expected ? { activeMediaIdentity: expected } : {}),
      }));
      assert.equal(nativeActiveMediaIdentity(f.store, f.installation), expected);
      assert.equal(f.calls(), 1);
      assert.ok(f.store.locked()?.receipts['native-media-cutover-startup']);
    });
  });
}
