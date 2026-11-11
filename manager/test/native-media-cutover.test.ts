import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { digest, Refusal } from '../src/contracts.js';
import {
  runNativeMediaCutover,
  type NativeMediaMoveAuthority,
} from '../src/runtime/native-media-cutover.js';
import { NativeInstallationSchema } from '../src/runtime/native.js';
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
