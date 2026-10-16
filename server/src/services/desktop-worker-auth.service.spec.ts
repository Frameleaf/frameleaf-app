import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import { desktopSessionMessage, desktopWorkerMessage } from 'src/dtos/desktop-worker.dto.js';
import { DesktopWorkerAuthService } from 'src/services/desktop-worker-auth.service.js';

const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
const deviceId = '445bc2b6-f4cd-439e-b8bb-7e84d7ee0550';
const sessionId = '1117c1ca-0495-46e9-b579-f321520c2b1a';
const auth = { user: { id: 'account', isAdmin: true }, session: { id: 'photo-session' } } as never;
const repository = { device: vi.fn(), issue: vi.fn(), session: vi.fn(), consume: vi.fn(), rotate: vi.fn() };
const metadata = { get: vi.fn().mockResolvedValue({ id: 'server' }) };
let service: DesktopWorkerAuthService;
const token = 'a'.repeat(64);
const initial = () => {
  const request = { deviceId, requestId: 'd621bd72-ad35-4199-95ab-76300756a38e', timestamp: Date.now(), signature: '' };
  request.signature = sign(
    null,
    Buffer.from(desktopSessionMessage('server', 'account', request)),
    keys.privateKey,
  ).toString('base64');
  return request;
};
const proof = (operation = 'claim', payload = '{}') => {
  const request = { sessionId, sequence: 1, timestamp: Date.now(), signature: '' };
  request.signature = sign(
    null,
    Buffer.from(desktopWorkerMessage('server', 7, token, request, operation, payload)),
    keys.privateKey,
  ).toString('base64');
  return Buffer.from(JSON.stringify(request)).toString('base64');
};
beforeEach(() => {
  vi.clearAllMocks();
  repository.device.mockResolvedValue({ id: deviceId, publicKey, authorizationEpoch: 7 });
  repository.issue.mockImplementation(() =>
    Promise.resolve({
      id: sessionId,
      deviceId,
      authorizationEpoch: 7,
      expiresAt: new Date(Date.now() + 3_600_000),
      modelKeys: [],
    }),
  );
  repository.session.mockResolvedValue({ id: sessionId, publicKey, authorizationEpoch: 7 });
  repository.consume.mockResolvedValue({
    sessionId,
    deviceId,
    authorizationEpoch: 7,
    credentialHash: createHash('sha256').update(token).digest(),
  });
  service = new DesktopWorkerAuthService(repository as never, metadata as never);
});
it('requires an admitted device, photo session and possession of the installation key for initial issuance', async () => {
  const result = await service.issue(auth, initial());
  expect(result).toMatchObject({ sessionId, authorizationEpoch: 7, modelKeys: [], scopes: ['library-inference'] });
  expect(result.workerToken).toMatch(/^[a-f0-9]{64}$/);
  expect(repository.issue.mock.calls[0][0].tokenHash).not.toEqual(Buffer.from(result.workerToken));
  repository.device.mockResolvedValueOnce(undefined);
  await expect(
    service.issue({ user: { id: 'account', isAdmin: false }, session: {} } as never, initial()),
  ).rejects.toThrow();
  await expect(
    service.issue({ user: { id: 'account', isAdmin: true }, apiKey: {} } as never, initial()),
  ).rejects.toThrow();
});
it('issues only inference scope to a policy-admitted member device', async () => {
  const member = { user: { id: 'account', isAdmin: false }, session: { id: 'photo-session' } } as never;
  expect(await service.issue(member, initial())).toMatchObject({ scopes: ['library-inference'], modelKeys: [] });
  expect(repository.device).toHaveBeenCalledWith('account', deviceId);
});
it('rejects cross-server, cross-account and changed-device issuance proofs', async () => {
  await expect(service.issue(auth, { ...initial(), deviceId: sessionId })).rejects.toThrow();
  await expect(
    service.issue({ user: { id: 'different', isAdmin: true }, session: {} } as never, initial()),
  ).rejects.toThrow();
  const request = initial();
  request.signature = sign(
    null,
    Buffer.from(desktopSessionMessage('different-server', 'account', request)),
    keys.privateKey,
  ).toString('base64');
  await expect(service.issue(auth, request)).rejects.toThrow();
});
it('requires both the worker token and a proof bound to the exact operation and payload', async () => {
  expect(await service.authenticate('Bearer ' + token, proof(), 'claim', '{}')).toMatchObject({ deviceId, sessionId });
  await expect(service.authenticate('Bearer ' + token, proof(), 'heartbeat', '{}')).rejects.toThrow();
  await expect(service.authenticate('Bearer ' + token, proof(), 'claim', '{"changed":true}')).rejects.toThrow();
  await expect(service.authenticate('Bearer ' + 'b'.repeat(64), proof(), 'claim', '{}')).rejects.toThrow();
});
it('rejects expired proof timestamps and malformed or replayed requests', async () => {
  const request = initial();
  request.timestamp -= 180_000;
  request.signature = sign(
    null,
    Buffer.from(desktopSessionMessage('server', 'account', request)),
    keys.privateKey,
  ).toString('base64');
  await expect(service.issue(auth, request)).rejects.toThrow();
  await expect(service.authenticate('Bearer ' + token, '!bad base64!', 'claim', '{}')).rejects.toThrow();
  repository.consume.mockResolvedValue(undefined);
  await expect(service.authenticate('Bearer ' + token, proof(), 'claim', '{}')).rejects.toThrow();
});
it('never authenticates a photo session as a worker session and does not consume a failed signature', async () => {
  await expect(service.authenticate('Bearer photo-token', proof(), 'claim', '{}')).rejects.toThrow();
  await expect(service.authenticate('Bearer ' + token, proof('input:other'), 'claim', '{}')).rejects.toThrow();
  expect(repository.consume).not.toHaveBeenCalled();
});

it('matches the native UTF-8 request-signing protocol fixture', () => {
  expect(
    desktopWorkerMessage(
      'server',
      3,
      'token',
      { sessionId: 'session', sequence: 2, timestamp: 100, signature: '' },
      'claim',
      '{"name":"été"}',
    ),
  ).toBe(
    'frameleaf-desktop/request/v1\nserver\nsession\n3\n2\n100\nclaim\n8c30d66008a6ca268ddecf90c9bd57efe675508f1121bfe0fa49d6a22b8f0f14\n3c469e9d6c5875d37a43f353d4f88e61fcf812c66eee3457465a40b0da4153e0',
  );
});
