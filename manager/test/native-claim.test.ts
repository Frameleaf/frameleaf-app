import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { publishNativeClaimProof, requireNativeClaimProof } from '../src/runtime/native-claim.js';

test('the native claim proof is private and a replacement listener rejects stale or missing proof', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'frameleaf-native-claim-'));
  try {
    const path = join(directory, 'claim-key');
    const oldProof = randomBytes(32);
    const proof = randomBytes(32);
    await publishNativeClaimProof(directory, oldProof);
    await publishNativeClaimProof(directory, proof);
    assert.deepEqual(await readdir(directory), ['claim-key']);
    const supplied = await readFile(path, 'utf8');
    assert.equal(supplied, proof.toString('hex'));
    const metadata = await stat(path);
    assert.equal(metadata.nlink, 1);
    if (process.platform !== 'win32') assert.equal(metadata.mode & 0o777, 0o600);
    requireNativeClaimProof(proof, supplied);
    for (const invalid of [undefined, oldProof.toString('hex'), supplied + '\n']) {
      assert.throws(() => requireNativeClaimProof(proof, invalid), /invalid_claim_proof/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
