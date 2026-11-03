import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { desktopWorkerMessage } from 'src/dtos/desktop-worker.dto.js';
import {
  SourceGrantRequestDto,
  SourceGrantTokenSchema,
  SourceResourceProofSchema,
  sourceGrantMessage,
  sourceResourceMessage,
} from 'src/dtos/source-resource.dto.js';

const id = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const request = {
  sourceId: id,
  deviceId: id,
  scopeFingerprint: 'a'.repeat(64),
  requestId: id,
  timestamp: 1_800_000_000_000,
  signature: Buffer.alloc(64).toString('base64'),
};

it('accepts only a source-bound installation proof without filesystem or worker authority', () => {
  expect(SourceGrantRequestDto.schema.parse(request)).toEqual(request);
  for (const changed of [
    { root: '/private/photos' },
    { workerToken: 'a'.repeat(64) },
    { scopeFingerprint: '../photos' },
    { scopeFingerprint: 'a'.repeat(64) + '\n' },
    { sourceId: '../other' },
    { timestamp: 0 },
    { timestamp: Number.MAX_SAFE_INTEGER + 1 },
    { signature: Buffer.alloc(64).toString('base64').replace(/=+$/, '') },
  ]) {
    expect(SourceGrantRequestDto.schema.safeParse({ ...request, ...changed }).success).toBe(false);
  }
});

it('gives source credentials a distinct exact grammar from inference credentials', () => {
  const token = `flsrc1_${'a'.repeat(64)}`;
  expect(SourceGrantTokenSchema.parse(token)).toBe(token);
  for (const value of ['a'.repeat(64), `${token}\n`, token.toUpperCase(), token + 'a', 'Bearer ' + token]) {
    expect(SourceGrantTokenSchema.safeParse(value).success).toBe(false);
  }
});

it('binds source approval to the exact account, source, device, scope, nonce and timestamp', () => {
  const key = generateKeyPairSync('ed25519');
  const message = sourceGrantMessage('server', 'owner', request);
  const signature = sign(null, Buffer.from(message), key.privateKey);
  expect(verify(null, Buffer.from(message), key.publicKey, signature)).toBe(true);
  for (const changed of [
    { sourceId: other },
    { deviceId: other },
    { scopeFingerprint: 'b'.repeat(64) },
    { requestId: other },
    { timestamp: request.timestamp + 1 },
  ]) {
    expect(
      verify(
        null,
        Buffer.from(sourceGrantMessage('server', 'owner', { ...request, ...changed })),
        key.publicKey,
        signature,
      ),
    ).toBe(false);
  }
  expect(verify(null, Buffer.from(sourceGrantMessage('other', 'owner', request)), key.publicKey, signature)).toBe(
    false,
  );
  expect(verify(null, Buffer.from(sourceGrantMessage('server', 'other', request)), key.publicKey, signature)).toBe(
    false,
  );
});

it('binds delivery proofs to a single source grant, credential, operation and payload', () => {
  const key = generateKeyPairSync('ed25519');
  const proof = SourceResourceProofSchema.parse({
    grantId: id,
    sequence: 1,
    timestamp: request.timestamp,
    signature: request.signature,
  });
  const token = SourceGrantTokenSchema.parse(`flsrc1_${'a'.repeat(64)}`);
  const binding = {
    serverId: 'server',
    ownerId: 'owner',
    sourceId: id,
    scopeFingerprint: request.scopeFingerprint,
    authorizationEpoch: 1,
  };
  const message = sourceResourceMessage(binding, token, proof, 'deliver', '{"bytes":42}');
  const signature = sign(null, Buffer.from(message), key.privateKey);
  expect(verify(null, Buffer.from(message), key.publicKey, signature)).toBe(true);
  const alternatives = [
    sourceResourceMessage({ ...binding, serverId: 'other' }, token, proof, 'deliver', '{"bytes":42}'),
    sourceResourceMessage({ ...binding, ownerId: 'other' }, token, proof, 'deliver', '{"bytes":42}'),
    sourceResourceMessage({ ...binding, sourceId: other }, token, proof, 'deliver', '{"bytes":42}'),
    sourceResourceMessage({ ...binding, scopeFingerprint: 'b'.repeat(64) }, token, proof, 'deliver', '{"bytes":42}'),
    sourceResourceMessage({ ...binding, authorizationEpoch: 2 }, token, proof, 'deliver', '{"bytes":42}'),
    sourceResourceMessage(binding, token, { ...proof, grantId: other }, 'deliver', '{"bytes":42}'),
    sourceResourceMessage(binding, token, { ...proof, sequence: 2 }, 'deliver', '{"bytes":42}'),
    sourceResourceMessage(binding, token, { ...proof, timestamp: proof.timestamp + 1 }, 'deliver', '{"bytes":42}'),
    sourceResourceMessage(binding, `flsrc1_${'b'.repeat(64)}`, proof, 'deliver', '{"bytes":42}'),
    sourceResourceMessage(binding, token, proof, 'poll', '{"bytes":42}'),
    sourceResourceMessage(binding, token, proof, 'deliver', '{"bytes":43}'),
    desktopWorkerMessage('server', 1, token, { ...proof, sessionId: id }, 'deliver', '{"bytes":42}'),
  ];
  for (const alternative of alternatives) {
    expect(verify(null, Buffer.from(alternative), key.publicKey, signature)).toBe(false);
  }
  for (const change of [{ sequence: 0 }, { sequence: 2 ** 31 }, { sequence: 1.5 }, { path: '/private' }]) {
    expect(SourceResourceProofSchema.safeParse({ ...proof, ...change }).success).toBe(false);
  }
});
