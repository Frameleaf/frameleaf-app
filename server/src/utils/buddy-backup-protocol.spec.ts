import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import type { BuddySignedSnapshot } from 'src/utils/buddy-backup-vault.js';
import type { BuddyGrantClaims } from 'src/utils/frameleaf-buddy.js';
import { assertBuddyCommitReceipt, buddyCommitReceipt, verifyBuddyResponse } from 'src/utils/buddy-backup-protocol.js';
import { buddyDigest } from 'src/utils/buddy-backup-vault.js';

it('refuses a real reservation acknowledgement replayed for a later commit under the same grant', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const now = Date.now();
  const grant = {
    vaultId: randomUUID(),
    jti: randomUUID(),
    exp: Math.floor(now / 1000) + 300,
    destinationKey: publicKey.export({ format: 'jwk' }),
  } as BuddyGrantClaims;
  const requestId = randomUUID();
  const data = { ok: true };
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const input = `${encode({ typ: 'buddy-response+jwt', alg: 'EdDSA' })}.${encode({
    vaultId: grant.vaultId,
    grantId: grant.jti,
    requestId,
    digest: buddyDigest(Buffer.from(JSON.stringify(data))),
    iat: Math.floor(now / 1000),
    exp: grant.exp,
  })}`;
  const proof = `${input}.${sign(null, Buffer.from(input), privateKey).toString('base64url')}`;
  expect(() => verifyBuddyResponse(proof, grant, data, requestId, now)).not.toThrow();
  expect(() => verifyBuddyResponse(proof, grant, data, randomUUID(), now)).toThrow('destination proof rejected');
});

it('rejects an old signed snapshot body substituted under a fresh request proof', () => {
  const old = {
    snapshot: { id: randomUUID(), sequence: 1, previous: null },
    signature: 'old-valid-signature',
  } as BuddySignedSnapshot;
  const current = { ...old, snapshot: { ...old.snapshot, id: randomUUID(), sequence: 2, previous: old.snapshot.id } };
  expect(() => assertBuddyCommitReceipt(buddyCommitReceipt(old), current)).toThrow('different snapshot');
  expect(() => assertBuddyCommitReceipt(buddyCommitReceipt(current), current)).not.toThrow();
});
