import { generateKeyPairSync, sign } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import z from 'zod';
import { DesktopEnrollmentSchema, enrollmentMessage } from 'src/dtos/desktop.dto.js';
import { DesktopDeviceService } from 'src/services/desktop-device.service.js';

const accountId = '8da8d162-c2c3-4d1d-b6e1-9148b0bfd327';
const installationId = '431cfab8-ea69-40e0-aee0-f47f64d2914d';
const pair = generateKeyPairSync('ed25519');
const publicKey = pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
const auth = { user: { id: accountId, isAdmin: true }, session: { id: 'session' } } as never;
const request = () => {
  const dto = {
    protocolVersion: 1 as const,
    installationId,
    requestId: 'c0a91b28-552b-4ed9-960a-11ba7a69a7d2',
    publicKey,
    name: 'My Mac',
    platform: 'macos' as const,
    architecture: 'arm64' as const,
    mode: 'client-worker' as const,
    timestamp: Date.now(),
    signature: '',
  };
  dto.signature = sign(null, Buffer.from(enrollmentMessage('server', accountId, dto)), pair.privateKey).toString(
    'base64',
  );
  return dto;
};

describe('desktop enrollment authority', () => {
  it('publishes the protocol version as a bounded integer in OpenAPI', () => {
    expect(z.toJSONSchema(DesktopEnrollmentSchema).properties?.protocolVersion).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 1,
    });
  });
  let service: DesktopDeviceService;
  const policy = { enable: vi.fn() };
  const repository = { enroll: vi.fn(), list: vi.fn(), revoke: vi.fn(), endSession: vi.fn() };
  const metadata = { get: vi.fn().mockResolvedValue({ id: 'server' }) };
  beforeEach(() => {
    vi.clearAllMocks();
    policy.enable.mockResolvedValue(undefined);
    service = new DesktopDeviceService(repository as never, metadata as never, policy as never);
  });
  it('rejects unknown protocols and unbounded or newline-bearing display names', () => {
    expect(DesktopEnrollmentSchema.safeParse({ ...request(), protocolVersion: 2 }).success).toBe(false);
    expect(DesktopEnrollmentSchema.safeParse({ ...request(), name: 'Mac\nforged' }).success).toBe(false);
    expect(DesktopEnrollmentSchema.safeParse({ ...request(), name: 'x'.repeat(129) }).success).toBe(false);
  });
  it('enrolls an administrator as preparing without claiming GPU or changing routes', async () => {
    repository.enroll.mockImplementation((row) =>
      Promise.resolve({
        ...row,
        id: 'device',
        revokedAt: null,
        createdAt: new Date(),
      }),
    );
    const result = await service.enroll(auth, request());
    expect(policy.enable).toHaveBeenCalledWith(accountId);
    expect(result).toMatchObject({ id: 'device', state: 'preparing', routeEffects: { changed: [], preserved: 'all' } });
    expect(result).not.toHaveProperty('publicKey');
    expect(result).not.toHaveProperty('workerToken');
  });
  it('does not select NAS assistance for local-server mode', async () => {
    repository.enroll.mockImplementation((row) =>
      Promise.resolve({ ...row, id: 'device', revokedAt: null, createdAt: new Date() }),
    );
    const dto = { ...request(), mode: 'local-server' as const, signature: '' };
    dto.signature = sign(null, Buffer.from(enrollmentMessage('server', accountId, dto)), pair.privateKey).toString(
      'base64',
    );
    await service.enroll(auth, dto);
    expect(policy.enable).not.toHaveBeenCalled();
  });
  it('records ordinary accounts as awaiting approval', async () => {
    repository.enroll.mockImplementation((row) =>
      Promise.resolve({
        ...row,
        id: 'device',
        revokedAt: null,
        createdAt: new Date(),
      }),
    );
    expect(
      await service.enroll({ user: { id: accountId, isAdmin: false }, session: { id: 'session' } } as never, request()),
    ).toMatchObject({ state: 'awaiting-approval' });
    expect(policy.enable).not.toHaveBeenCalled();
  });
  it('refuses an enrollment replayed for another account or server', async () => {
    await expect(
      service.enroll({ user: { id: 'other', isAdmin: true }, session: { id: 'session' } } as never, request()),
    ).rejects.toThrow('device_proof_invalid');
    metadata.get.mockResolvedValueOnce({ id: 'another-server' });
    await expect(service.enroll(auth, request())).rejects.toThrow('device_proof_invalid');
  });
  it('refuses stale proof before any database write', async () => {
    const dto = request();
    dto.timestamp -= 180_000;
    await expect(service.enroll(auth, dto)).rejects.toThrow('device_proof_expired');
    expect(repository.enroll).not.toHaveBeenCalled();
  });
  it('does not enroll shared links or API keys', async () => {
    await expect(service.enroll({ user: { id: accountId }, apiKey: {} } as never, request())).rejects.toThrow(
      'desktop_photo_session_required',
    );
  });
  it('reports unreleased worker and source features honestly', async () => {
    expect(await service.capabilities(auth)).toMatchObject({
      protocolVersion: 1,
      serverId: 'server',
      features: { enrollment: true, worker: false, sources: false, nativeHost: false },
    });
  });
  it('ends a signed-in association without permanently revoking its installation', async () => {
    repository.endSession.mockResolvedValue(true);
    await expect(service.endSession(auth, 'device')).resolves.toBeUndefined();
  });
  it('cannot end another account association', async () => {
    repository.endSession.mockResolvedValue(false);
    await expect(service.endSession(auth, 'other-device')).rejects.toThrow('Desktop device not found');
  });
  it('cannot revoke another account device', async () => {
    repository.revoke.mockResolvedValue(false);
    await expect(service.revoke(auth, 'other-device')).rejects.toThrow('Desktop device not found');
  });
});
