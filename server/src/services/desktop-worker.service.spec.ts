import { DesktopWorkerService } from 'src/services/desktop-worker.service.js';

const grant = { deviceId: 'device', sessionId: 'session', authorizationEpoch: 2 };
const auth = { authenticate: vi.fn(), renew: vi.fn() };
const broker = { claim: vi.fn(), input: vi.fn(), heartbeatLease: vi.fn(), complete: vi.fn(), fail: vi.fn() };
const sessions = { revoke: vi.fn() };
let service: DesktopWorkerService;
beforeEach(() => {
  vi.resetAllMocks();
  auth.authenticate.mockResolvedValue(grant);
  service = new DesktopWorkerService(auth as never, broker as never, sessions as never);
});
it('authenticates the exact claim bytes and returns only immutable task/lease metadata', async () => {
  broker.claim.mockResolvedValue({
    task: {
      id: 'task',
      modelKey: 'model',
      config: { z: 1, a: 2 },
      configSha256: 'config-hash',
      inputSha256: 'input-hash',
      inputKind: 'text',
      deadlineAt: new Date('2026-10-15T21:00:00Z'),
      input: Buffer.from('private'),
      ownerId: 'private-owner',
    },
    attempt: { id: 'attempt', generation: 3, expiresAt: new Date('2026-10-15T20:59:00Z') },
  });
  const payload = '{"modelKeys":["model"],"waitMs":0}';
  const result = await service.claim('token', 'proof', payload, new AbortController().signal);
  expect(auth.authenticate).toHaveBeenCalledWith('token', 'proof', 'claim', payload);
  expect(broker.claim).toHaveBeenCalledWith(grant, ['model']);
  expect(result.task).toMatchObject({
    id: 'attempt',
    taskId: 'task',
    sessionId: 'session',
    authorizationEpoch: 2,
    configJson: '{"a":2,"z":1}',
    generation: 3,
    maxInputBytes: 16_777_216,
  });
  expect(result.task).not.toHaveProperty('input');
  expect(result.task).not.toHaveProperty('ownerId');
});
it('returns an empty claim without retrying an empty model scope', async () => {
  expect(
    await service.claim('token', 'proof', '{"modelKeys":[],"waitMs":20000}', new AbortController().signal),
  ).toEqual({ task: null });
  expect(broker.claim).not.toHaveBeenCalled();
});
it('bounds claim windows and rejects unknown or malformed payloads', async () => {
  for (const payload of ['not json', '{"modelKeys":["m"],"waitMs":20001}', '{"modelKeys":["m"],"url":"https://other"}'])
    await expect(service.claim('token', 'proof', payload, new AbortController().signal)).rejects.toThrow();
  expect(broker.claim).not.toHaveBeenCalled();
});
it('cancels a waiting claim when the outbound connection closes', async () => {
  broker.claim.mockResolvedValue(undefined);
  const controller = new AbortController();
  const result = service.claim('token', 'proof', '{"modelKeys":["m"],"waitMs":20000}', controller.signal);
  await vi.waitFor(() => expect(broker.claim).toHaveBeenCalledTimes(1));
  controller.abort();
  await expect(result).rejects.toThrow();
});
it('binds input and result proofs to the exact attempt and passes only scoped input', async () => {
  broker.input.mockResolvedValue(Buffer.from('fixture'));
  broker.complete.mockResolvedValue(true);
  expect(await service.input('token', 'proof', 'attempt')).toEqual(Buffer.from('fixture'));
  expect(auth.authenticate).toHaveBeenLastCalledWith('token', 'proof', 'input:attempt', '');
  expect(await service.complete('token', 'proof', 'attempt', '{"result":{"clip":"value"}}')).toEqual({
    accepted: true,
  });
  expect(auth.authenticate).toHaveBeenLastCalledWith('token', 'proof', 'result:attempt', '{"result":{"clip":"value"}}');
  expect(broker.complete).toHaveBeenCalledWith(grant, 'attempt', { clip: 'value' });
});
it('rejects stale input and malformed/nonfinite/oversized result envelopes', async () => {
  broker.input.mockResolvedValue(undefined);
  await expect(service.input('token', 'proof', 'attempt')).rejects.toThrow('desktop_lease_invalid');
  for (const payload of [
    '{"result":{"x":1e999}}',
    '{"result":[],"extra":1}',
    '{"result":{"x":"' + 'a'.repeat(4 * 1024 * 1024) + '"}}',
  ])
    await expect(service.complete('token', 'proof', 'attempt', payload)).rejects.toThrow();
  expect(broker.complete).not.toHaveBeenCalled();
});
it('requires signed bounded heartbeat/failure/renewal/revocation operations', async () => {
  broker.heartbeatLease.mockResolvedValue(new Date('2026-10-15T21:00:00Z'));
  broker.fail.mockResolvedValue(false);
  sessions.revoke.mockResolvedValue(true);
  expect(await service.heartbeat('token', 'proof', '{"id":"445bc2b6-f4cd-439e-b8bb-7e84d7ee0550"}')).toEqual({
    accepted: true,
    expiresAt: '2026-10-15T21:00:00.000Z',
  });
  expect(await service.fail('token', 'proof', 'attempt', '{"code":"inference-failed"}')).toEqual({ accepted: false });
  expect(auth.authenticate).toHaveBeenLastCalledWith('token', 'proof', 'fail:attempt', '{"code":"inference-failed"}');
  await expect(service.fail('token', 'proof', 'attempt', '{"code":"run-shell"}')).rejects.toThrow();
  expect(await service.revoke('token', 'proof')).toEqual({ accepted: true });
  expect(auth.authenticate).toHaveBeenLastCalledWith('token', 'proof', 'revoke', '');
  await service.renew('token', 'proof', '{}');
  expect(auth.renew).toHaveBeenCalledWith('token', 'proof', '{}');
});
it('never invokes the broker when credential authentication fails', async () => {
  auth.authenticate.mockRejectedValue(new Error('invalid credential'));
  await expect(
    service.claim('photo-token', 'proof', '{"modelKeys":["m"],"waitMs":0}', new AbortController().signal),
  ).rejects.toThrow();
  expect(broker.claim).not.toHaveBeenCalled();
});
