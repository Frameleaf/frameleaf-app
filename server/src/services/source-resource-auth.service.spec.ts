import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { SourceGrantRequestDto, sourceGrantMessage, sourceResourceMessage } from 'src/dtos/source-resource.dto.js';
import { SourceResourceAuthService } from 'src/services/source-resource-auth.service.js';

const id = '11111111-1111-4111-8111-111111111111';
const ownerId = '22222222-2222-4222-8222-222222222222';
const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
const token = `flsrc1_${'a'.repeat(64)}`;
const auth = { user: { id: ownerId }, session: { id } } as unknown as AuthDto;
const binding = { ownerId, sourceId: id, scopeFingerprint: 'a'.repeat(64), authorizationEpoch: 7 };
const credential = {
  ...binding,
  grantId: id,
  deviceId: id,
  photoSessionId: id,
  publicKey,
  credentialHash: createHash('sha256').update(token).digest(),
  expiresAt: new Date(Date.now() + 3_600_000),
};
const repository = { device: vi.fn(), issue: vi.fn(), session: vi.fn(), consume: vi.fn() };
const metadata = { get: vi.fn().mockResolvedValue({ id: 'server' }) };
let service: SourceResourceAuthService;
const initial = (): SourceGrantRequestDto => {
  const request = {
    sourceId: id,
    deviceId: id,
    scopeFingerprint: binding.scopeFingerprint,
    requestId: id,
    timestamp: Date.now(),
    signature: '',
  };
  request.signature = sign(null, Buffer.from(sourceGrantMessage('server', ownerId, request)), keys.privateKey).toString(
    'base64',
  );
  return request;
};
const proof = (operation = 'poll', payload = '{}', timestamp = Date.now()) => {
  const value = { grantId: id, sequence: 1, timestamp, signature: '' };
  value.signature = sign(
    null,
    Buffer.from(sourceResourceMessage({ ...binding, serverId: 'server' }, token, value, operation, payload)),
    keys.privateKey,
  ).toString('base64');
  return Buffer.from(JSON.stringify(value)).toString('base64');
};
beforeEach(() => {
  vi.clearAllMocks();
  repository.device.mockResolvedValue(credential);
  repository.issue.mockResolvedValue(credential);
  repository.session.mockResolvedValue(credential);
  repository.consume.mockResolvedValue(credential);
  service = new SourceResourceAuthService(repository as never, metadata as never);
});
it('issues source-only scope after a photo session and exact installation proof', async () => {
  const response = await service.issue(auth, initial());
  expect(response).toMatchObject({
    grantId: id,
    sourceId: id,
    ownerId,
    deviceId: id,
    scopes: ['source-original-read'],
    authorizationEpoch: 7,
  });
  expect(response.sourceToken).toMatch(/^flsrc1_[a-f0-9]{64}$/);
  expect(repository.issue.mock.calls[0][0].tokenHash).toEqual(
    createHash('sha256').update(response.sourceToken).digest(),
  );
  expect(response).not.toHaveProperty('workerToken');
  for (const forbidden of [
    { user: { id: ownerId }, apiKey: {} },
    { ...auth, sharedLink: {} },
    { ...auth, system: {} },
  ]) {
    await expect(service.issue(forbidden as never, initial())).rejects.toThrow('source_photo_session_required');
  }
});
it('refuses missing, changed, stale or revoked source authority before issuing a credential', async () => {
  repository.device.mockResolvedValueOnce(undefined);
  await expect(service.issue(auth, initial())).rejects.toThrow('source_credential_invalid');
  await expect(service.issue(auth, { ...initial(), scopeFingerprint: 'b'.repeat(64) })).rejects.toThrow(
    'source_credential_invalid',
  );
  await expect(service.issue(auth, { ...initial(), timestamp: Date.now() - 120_001 })).rejects.toThrow(
    'source_credential_invalid',
  );
  repository.issue.mockResolvedValueOnce(undefined);
  await expect(service.issue(auth, initial())).rejects.toThrow('source_credential_invalid');
});
it('authenticates a source request without accepting inference or photo bearer tokens', async () => {
  expect(await service.authenticate('Bearer ' + token, proof(), 'poll', '{}')).toMatchObject(binding);
  for (const bearer of ['a'.repeat(64), 'photo-session', token + '\n']) {
    repository.session.mockClear();
    await expect(service.authenticate('Bearer ' + bearer, proof(), 'poll', '{}')).rejects.toThrow(
      'source_credential_invalid',
    );
    expect(repository.session).not.toHaveBeenCalled();
  }
});
it('refuses changed operations, payloads, oversized control messages and stale proofs', async () => {
  for (const [header, operation, payload] of [
    [proof(), 'deliver', '{}'],
    [proof(), 'poll', '{"changed":true}'],
    [proof('poll', '{}', Date.now() - 120_001), 'poll', '{}'],
    [proof(), 'admin', '{}'],
    [proof(), 'poll', '界'.repeat(32_768)],
  ]) {
    await expect(service.authenticate('Bearer ' + token, header, operation, payload)).rejects.toThrow(
      'source_credential_invalid',
    );
  }
});
it('requires fresh atomic sequence consumption after cryptographic verification', async () => {
  repository.consume.mockResolvedValueOnce(undefined);
  await expect(service.authenticate('Bearer ' + token, proof(), 'poll', '{}')).rejects.toThrow(
    'source_credential_invalid',
  );
  repository.session.mockResolvedValueOnce(undefined);
  await expect(service.authenticate('Bearer ' + token, proof(), 'poll', '{}')).rejects.toThrow(
    'source_credential_invalid',
  );
  expect(await service.authenticate('Bearer ' + token, proof(), 'poll', '{}')).toMatchObject(binding);
  expect(repository.consume).toHaveBeenLastCalledWith(credential, 1);
});
