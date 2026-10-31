import { ForbiddenException } from '@nestjs/common';
import { type KeyObject, createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Response } from 'express';
import type { AddressInfo } from 'node:net';
import { MlAdmissionRefusal } from 'src/enum.js';
import { BuddyBackupPeerService } from 'src/services/buddy-backup-peer.service.js';
import { BUDDY_BLOCK_BYTES, BUDDY_SEALED_OVERHEAD } from 'src/utils/buddy-backup-crypto.js';
import { FrameleafCloudError, ed25519Thumbprint } from 'src/utils/frameleaf-cloud.js';

vi.mock('src/services/base.service.js', () => ({ BaseService: class {} }));
vi.mock('src/utils/frameleaf-cloud-gateway.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readCloudLink: () => Promise.resolve({ linked: true, link: {} }),
}));

describe(BuddyBackupPeerService.name, () => {
  // Verification downloads whole files; a large file (the database dump) spans several full 8 MiB objects.
  it('streams a full-size object although each write commits before its drain wait begins', async () => {
    const block = randomBytes(BUDDY_BLOCK_BYTES + BUDDY_SEALED_OVERHEAD);
    const service = Object.assign(Object.create(BuddyBackupPeerService.prototype), {
      streamSlot: () => Promise.resolve(() => Promise.resolve()),
      throttle: () => Promise.resolve(),
      signed: () => ({ proof: 'proof' }),
      // Like the real dispatch: the action runs in a locked transaction whose commit takes a moment.
      dispatch: async (_access: unknown, _scope: string, action: () => Promise<unknown>) => {
        const result = await action();
        await sleep(5);
        return result;
      },
    }) as BuddyBackupPeerService;
    const access = { grant: { exp: Math.floor(Date.now() / 1000) + 300 }, vault: { read: () => block } };
    const server = createServer((_request, response) => {
      void service.download(access as never, response as unknown as Response, 'a'.repeat(64)).catch(() => {});
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const answer = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`, {
        signal: AbortSignal.timeout(20_000),
      });
      const received = Buffer.from(await answer.arrayBuffer());
      expect(received.equals(block)).toBe(true);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  }, 30_000);

  it('spends the shared request budget only on requests for a vault paired here', async () => {
    const hit = vi.fn().mockResolvedValue({ count: 1 });
    const service = Object.assign(Object.create(BuddyBackupPeerService.prototype), {
      rates: { hit },
      state: { state: () => Promise.resolve({ settings: {}, pairing: { state: 'active', vaults: [] } }) },
      identity: () => Promise.resolve({ instanceId: 'here' }),
    }) as BuddyBackupPeerService;
    const vaultId = '00000000-0000-4000-8000-000000000000';
    await expect(service.authorize({ headers: {} } as never, {} as never, vaultId, 'read')).rejects.toThrow(
      'Buddy capability and proof required',
    );
    await expect(
      service.authorize(
        { headers: { authorization: 'DPoP token', dpop: 'proof' } } as never,
        {} as never,
        vaultId,
        'read',
      ),
    ).rejects.toThrow('Buddy access is unavailable');
    expect(hit).not.toHaveBeenCalled();
  });
});

describe('live Buddy grant refusal', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'buddy-refusal-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const fixture = () => {
    const signer = generateKeyPairSync('ed25519');
    const source = generateKeyPairSync('ed25519');
    const destination = generateKeyPairSync('ed25519');
    const jwk = (key: typeof source.publicKey) => ({
      kty: 'OKP' as const,
      crv: 'Ed25519' as const,
      x: String(key.export({ format: 'jwk' }).x),
    });
    const sourceKey = jwk(source.publicKey),
      destinationKey = jwk(destination.publicKey);
    const issuer = 'https://cloud.example.test';
    const now = Math.floor(Date.now() / 1000);
    const sourceInstanceId = randomUUID(),
      destinationInstanceId = randomUUID(),
      vaultId = randomUUID(),
      pairId = randomUUID();
    const claims = {
      version: 1,
      iss: issuer,
      aud: 'frameleaf-buddy',
      sub: sourceInstanceId,
      jti: randomUUID(),
      iat: now,
      exp: now + 300,
      pairId,
      sourceInstanceId,
      destinationInstanceId,
      vaultId,
      scope: 'read',
      cnf: { jkt: ed25519Thumbprint(sourceKey), jwk: sourceKey },
      destinationKey,
    };
    const jwt = (header: unknown, payload: unknown, key: KeyObject) => {
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
      const body = `${encode(header)}.${encode(payload)}`;
      return `${body}.${sign(null, Buffer.from(body), key).toString('base64url')}`;
    };
    const token = jwt({ typ: 'buddy-grant+jwt', alg: 'EdDSA', kid: 'fixture' }, claims, signer.privateKey);
    const cloud = vi.fn();
    const admit = vi.fn().mockResolvedValue({ allowed: true, nonce: 'n'.repeat(43) });
    const state = {
      root: () => root,
      admit,
      locked: async (_name: string, action: () => Promise<unknown>) => action(),
      state: vi.fn().mockResolvedValue({
        settings: { directory: root, quotaBytes: 1024 ** 3 },
        pairing: {
          pairId,
          state: 'active',
          vaults: [
            { vaultId, sourceInstanceId, destinationInstanceId, sourceKey, destinationKey, quotaBytes: 1024 ** 3 },
          ],
        },
      }),
    };
    const service = Object.assign(Object.create(BuddyBackupPeerService.prototype), {
      state,
      cloud,
      rates: { hit: vi.fn().mockResolvedValue({ count: 1 }) },
      identity: vi.fn().mockResolvedValue({ instanceId: destinationInstanceId, publicJwk: destinationKey }),
      cloudTarget: vi.fn().mockResolvedValue({ api: issuer, token: {} }),
      frameleafCloudRepository: {
        requestJson: vi.fn().mockResolvedValue({ keys: [{ ...jwk(signer.publicKey), kid: 'fixture' }] }),
      },
    }) as BuddyBackupPeerService;
    const request = () => ({
      headers: {
        authorization: `DPoP ${token}`,
        dpop: jwt(
          { typ: 'dpop+jwt', alg: 'EdDSA', jwk: sourceKey },
          {
            jti: randomUUID(),
            htm: 'GET',
            htu: 'http://peer.example.test/snapshot',
            iat: now,
            ath: createHash('sha256').update(token).digest('base64url'),
          },
          source.privateKey,
        ),
      },
      method: 'GET',
      protocol: 'http',
      originalUrl: '/snapshot',
      get: () => 'peer.example.test',
    });
    const authorize = () => service.authorize(request() as never, { setHeader: vi.fn() } as never, vaultId, 'read');
    return { state, cloud, claims, authorize, admit };
  };

  it.each([401, 403, 404])(
    'returns a fixed 403 on first and cached Cloud refusal %s without changing retained bytes',
    async (status) => {
      const { cloud, claims, authorize, admit } = fixture();
      cloud.mockRejectedValue(
        new FrameleafCloudError(MlAdmissionRefusal.EntitlementMissing, status, 'private-test-sentinel'),
      );
      const retained = randomBytes(64),
        path = join(root, 'retained-ciphertext');
      await writeFile(path, retained);
      for (let attempt = 0; attempt < 2; attempt++) {
        const error = await authorize().catch((error: unknown) => error);
        expect(error).toBeInstanceOf(ForbiddenException);
        expect((error as ForbiddenException).getStatus()).toBe(403);
        expect((error as ForbiddenException).message).toBe('Buddy capability was revoked');
        expect(JSON.stringify((error as ForbiddenException).getResponse())).not.toContain('private-test-sentinel');
      }
      expect(cloud).toHaveBeenCalledTimes(1);
      expect(admit).not.toHaveBeenCalled();
      expect(JSON.parse(await readFile(join(root, 'revoked-grants.json'), 'utf8'))).toEqual({
        [claims.jti]: claims.exp * 1000,
      });
      expect(await readFile(path)).toEqual(retained);
    },
  );

  it.each([null, 503])('preserves signed cached grant admission during Cloud outage %s', async (status) => {
    const { cloud, claims, authorize, admit } = fixture();
    cloud.mockRejectedValue(new FrameleafCloudError(MlAdmissionRefusal.CloudUnavailable, status, 'unavailable'));
    expect((await authorize()).grant.jti).toBe(claims.jti);
    expect(admit).toHaveBeenCalledTimes(1);
    await expect(readFile(join(root, 'revoked-grants.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves an unexpected client failure rather than translating it to a grant refusal', async () => {
    const { cloud, authorize } = fixture();
    const failure = new Error('unexpected client failure');
    cloud.mockRejectedValue(failure);
    await expect(authorize()).rejects.toBe(failure);
  });

  it('fails closed on revocation persistence failure without claiming a completed revocation', async () => {
    const { cloud, authorize, state, admit } = fixture();
    cloud.mockRejectedValue(
      new FrameleafCloudError(MlAdmissionRefusal.EntitlementMissing, 403, 'private-test-sentinel'),
    );
    const failure = new Error('persistence failed');
    state.locked = async (name, action) => {
      if (name === 'peer-access') throw failure;
      return action();
    };
    await expect(authorize()).rejects.toBe(failure);
    expect(admit).not.toHaveBeenCalled();
    await expect(readFile(join(root, 'revoked-grants.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
