import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { Mock } from 'vitest';
import {
  RemoteSourceError,
  registerRemoteSource,
  unregisterRemoteSource,
} from 'src/import-connectors/remote-source.js';
import { ImportSignInService } from 'src/services/import-sign-in.service.js';
import { readImportCredentials, sealImportCredentials } from 'src/utils/import-connector.js';
import { authStub } from 'test/fixtures/auth.stub.js';

const connectionId = '0195e2a0-0000-7000-8000-0000000000c1';
const ownerId = authStub.user1.user.id;
const seal = {
  crypto: { serverKeyedHash: vi.fn().mockResolvedValue('keyed-hash') },
  config: { getEnv: () => ({ frameleafCloud: { identityDir: '/identity' } }) },
};
const ready = (id: string | null = null) => ({
  state: 'ready',
  connectionId: id,
  tokens: { accessToken: 'access-secret', expiresInSec: 14_400, refreshToken: 'refresh-secret' },
});

describe(ImportSignInService.name, () => {
  let sut: ImportSignInService;
  let repository: Record<string, any>;
  let broker: Record<string, any>;
  let revoke: Mock<(credentials: Record<string, unknown>) => Promise<void>>;

  beforeEach(() => {
    repository = { create: vi.fn(), update: vi.fn(), get: vi.fn() };
    broker = { availability: vi.fn(), start: vi.fn(), finish: vi.fn() };
    revoke = vi.fn<(credentials: Record<string, unknown>) => Promise<void>>().mockResolvedValue(undefined);
    sut = new ImportSignInService(
      { setContext: vi.fn(), log: vi.fn(), warn: vi.fn() } as never,
      repository as never,
      { ...seal.crypto, randomUUID: () => connectionId } as never,
      seal.config as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    (sut as unknown as { broker: unknown }).broker = broker;
    registerRemoteSource({
      provider: 'dropbox',
      credentials: () => {
        throw new RemoteSourceError('Connect Dropbox by signing in');
      },
      open: () => ({}) as never,
      revoke,
      signIn: {
        service: 'dropbox',
        label: 'Dropbox',
        account: () => Promise.resolve({ id: 'dbid:sam', name: 'Sam' }),
      },
    });
  });

  afterEach(() => unregisterRemoteSource('dropbox'));

  it('answers the picker settings of a provider that has them, and null otherwise', async () => {
    broker.availability.mockResolvedValue({ available: true, reason: null });
    await expect(sut.availability('dropbox')).resolves.toEqual({ available: true, reason: null, picker: null });
    registerRemoteSource({
      provider: 'google-drive',
      credentials: () => ({}),
      open: () => ({}) as never,
      signIn: {
        service: 'google-drive',
        label: 'Google Drive',
        account: () => Promise.resolve({ id: 'p', name: 'Sam' }),
        picker: () => ({ apiKey: 'browser-key', appId: '123' }),
      },
    });
    await expect(sut.availability('google-drive')).resolves.toMatchObject({
      picker: { apiKey: 'browser-key', appId: '123' },
    });
    unregisterRemoteSource('google-drive');
  });

  const complete = () => sut.complete(authStub.user1, 'dropbox', { signInToken: 't', roots: [], dailyCheck: false });

  it('refuses a provider that does not sign in', async () => {
    await expect(sut.start(authStub.user1, 'webdav', {})).rejects.toBeInstanceOf(BadRequestException);
  });

  it('passes on the link-first message for an unlinked server', async () => {
    broker.start.mockRejectedValue(
      new RemoteSourceError('Link this server to a Frameleaf account first, then sign in.'),
    );
    await expect(sut.start(authStub.user1, 'dropbox', {})).rejects.toThrow('Link this server');
  });

  it('does not start a sign-in for someone else’s connection', async () => {
    repository.get.mockResolvedValue(undefined);
    await expect(sut.start(authStub.user1, 'dropbox', { connectionId })).rejects.toBeInstanceOf(NotFoundException);
    expect(broker.start).not.toHaveBeenCalled();
  });

  it('answers a sign-in still waiting without creating anything', async () => {
    broker.finish.mockResolvedValue({ state: 'pending' });
    await expect(complete()).resolves.toEqual({ state: 'pending', connectionId: null });
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('creates a connection with the token sealed and none in the answer', async () => {
    broker.finish.mockResolvedValue(ready());
    const answer = await complete();
    expect(answer).toEqual({ state: 'connected', connectionId });
    const created = repository.create.mock.calls[0][0];
    expect(created.displayName).toBe('Dropbox (Sam)');
    expect(created.sealedCredentials.toString('latin1')).not.toContain('refresh-secret');
    await expect(
      readImportCredentials(seal as never, { id: connectionId, sealedCredentials: created.sealedCredentials }),
    ).resolves.toEqual({ refreshToken: 'refresh-secret', accountId: 'dbid:sam', accountName: 'Sam' });
    expect(JSON.stringify(answer)).not.toContain('secret');
  });

  it('signs an existing connection in again', async () => {
    const sealedCredentials = await sealImportCredentials(seal as never, connectionId, { accountId: 'dbid:sam' });
    repository.get.mockResolvedValue({ id: connectionId, ownerId, provider: 'dropbox', sealedCredentials });
    broker.finish.mockResolvedValue(ready(connectionId));
    await expect(complete()).resolves.toEqual({ state: 'connected', connectionId });
    expect(repository.update).toHaveBeenCalledWith(connectionId, { sealedCredentials: expect.any(Buffer) });
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('refuses a different account and gives the new access back', async () => {
    const sealedCredentials = await sealImportCredentials(seal as never, connectionId, { accountId: 'dbid:other' });
    repository.get.mockResolvedValue({ id: connectionId, ownerId, provider: 'dropbox', sealedCredentials });
    broker.finish.mockResolvedValue(ready(connectionId));
    await expect(complete()).rejects.toThrow('different Dropbox account');
    expect(repository.update).not.toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledTimes(1);
  });
});
