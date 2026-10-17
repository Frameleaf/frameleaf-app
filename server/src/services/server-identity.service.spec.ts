import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SystemMetadataKey } from 'src/enum.js';
import { InstanceIdentityRepository } from 'src/repositories/instance-identity.repository.js';
import { ServerService } from 'src/services/server.service.js';
import { verifyLanIdentity } from 'src/utils/frameleaf-server-identity-proof.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const nonce = 'bm9uY2Utbm9uY2Utbm9uY2Utbm9uY2U';
const origin = 'http://192.168.1.20:2283';

describe('server identity (FL-430)', () => {
  let sut: ServerService;
  let mocks: ServiceMocks;
  let identity: InstanceIdentityRepository;
  let dir: string;
  let metadata: Map<string, unknown>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fl-430-'));
    identity = new InstanceIdentityRepository();
    ({ sut, mocks } = newTestService(ServerService, { instanceIdentity: identity }));
    const env = mockEnvData({});
    mocks.config.getEnv.mockReturnValue({ ...env, frameleafCloud: { ...env.frameleafCloud, identityDir: dir } });
    metadata = new Map<string, unknown>([
      [SystemMetadataKey.FrameleafServerId, { id: 'local-server-1', createdAt: '2026-10-01T00:00:00.000Z' }],
    ]);
    mocks.systemMetadata.get.mockImplementation((key) => Promise.resolve((metadata.get(key) ?? null) as never));
    mocks.systemMetadata.set.mockImplementation((key, value) => {
      metadata.set(key, value);
      return Promise.resolve();
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates the identity key at boot on an unlinked server', async () => {
    await sut.onBootstrap();
    const stored = metadata.get(SystemMetadataKey.FrameleafInstance) as { kid: string } | undefined;
    expect(stored?.kid).toMatch(/^[\w-]{43}$/);
    const { identityKeys } = await sut.getIdentity();
    expect(identityKeys).toEqual([{ kid: stored!.kid, jwk: { kty: 'OKP', crv: 'Ed25519', x: expect.any(String) } }]);
  });

  it('publishes the key as {kid, jwk} and signs a challenge that verifies with it', async () => {
    const published = await sut.getIdentity();
    expect(published).toMatchObject({ instanceId: 'local-server-1', linked: false });
    expect(Buffer.from(published.identityKeys[0].jwk.x, 'base64url')).toHaveLength(32);

    const response = await sut.identityChallenge(nonce, origin);
    expect(response).toMatchObject({ instanceId: 'local-server-1', origin });
    expect(response.retiringProof).toBeUndefined();
    expect(verifyLanIdentity(response.proof, published.identityKeys)).toEqual({
      instanceId: 'local-server-1',
      nonce,
      iat: response.iat,
      origin,
    });
  });

  it('signs with the cloud instance id while linked', async () => {
    metadata.set(SystemMetadataKey.FrameleafCloudLink, {
      status: 'linked',
      cloudUrl: 'https://api.frameleaf.cloud',
      instanceId: 'instance-1',
    });
    const env = mockEnvData({});
    mocks.config.getEnv.mockReturnValue({
      ...env,
      frameleafCloud: { ...env.frameleafCloud, identityDir: dir, url: 'https://api.frameleaf.cloud' },
    });
    const response = await sut.identityChallenge(nonce, origin);
    expect(verifyLanIdentity(response.proof, (await sut.getIdentity()).identityKeys)?.instanceId).toBe('instance-1');
  });

  it('exposes the retiring key and a retiring-key proof during a rotation overlap', async () => {
    const before = await sut.getIdentity();
    const loaded = metadata.get(SystemMetadataKey.FrameleafInstance) as never;
    const rotated = await identity.rotate(loaded, () => Promise.resolve(), 24);
    metadata.set(SystemMetadataKey.FrameleafInstance, rotated);

    const after = await sut.getIdentity();
    expect(after.identityKeys.map(({ kid }) => kid)).toEqual([rotated.kid, before.identityKeys[0].kid]);

    const response = await sut.identityChallenge(nonce, origin);
    // an app that pinned only the old key still verifies, through the retiring proof
    expect(verifyLanIdentity(response.proof, before.identityKeys)).toBeNull();
    expect(verifyLanIdentity(response.retiringProof!, before.identityKeys)).toMatchObject({ nonce, origin });
    expect(verifyLanIdentity(response.proof, after.identityKeys)).toMatchObject({ nonce, origin });
  });

  it('drops the retiring key once its overlap ended', async () => {
    await sut.getIdentity();
    const loaded = metadata.get(SystemMetadataKey.FrameleafInstance) as never;
    const rotated = await identity.rotate(loaded, () => Promise.resolve(), 24);
    metadata.set(SystemMetadataKey.FrameleafInstance, {
      ...rotated,
      retiring: { ...rotated.retiring!, until: new Date(Date.now() - 1000).toISOString() },
    });
    expect((await sut.getIdentity()).identityKeys).toHaveLength(1);
    expect((await sut.identityChallenge(nonce, origin)).retiringProof).toBeUndefined();
  });

  it('rejects an invalid nonce', async () => {
    await expect(sut.identityChallenge('short', origin)).rejects.toThrow(/nonce/);
    await expect(sut.identityChallenge('a'.repeat(129), origin)).rejects.toThrow(/nonce/);
  });
});
