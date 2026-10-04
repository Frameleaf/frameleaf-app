import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BuddyBackupClient, BuddyExecutionError, BuddyPeerUnavailable } from 'src/utils/buddy-backup-client.js';
import { verifyBuddyProof } from 'src/utils/buddy-backup-protocol.js';
import { BuddyVault } from 'src/utils/buddy-backup-vault.js';
import { BuddyGrantClaims, BuddyGrantResponse } from 'src/utils/frameleaf-buddy.js';
import { ed25519Thumbprint } from 'src/utils/frameleaf-cloud.js';
import { FrameleafKeySigner, jwsSigningInput } from 'src/utils/frameleaf-dpop.js';

const newSigner = (): FrameleafKeySigner => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicJwk = { kty: 'OKP', crv: 'Ed25519', x: publicKey.export({ format: 'jwk' }).x! } as const;
  return {
    kid: ed25519Thumbprint(publicJwk),
    publicJwk,
    sign: (header, payload) => {
      const input = jwsSigningInput(header, payload);
      return `${input}.${sign(null, Buffer.from(input), privateKey).toString('base64url')}`;
    },
  };
};

const signedReply = (grant: BuddyGrantClaims, requestId: string, data: unknown, signer: FrameleafKeySigner) => ({
  data,
  proof: signer.sign(
    { typ: 'buddy-response+jwt', alg: 'EdDSA' },
    {
      vaultId: grant.vaultId,
      grantId: grant.jti,
      requestId,
      digest: createHash('sha256').update(JSON.stringify(data)).digest('hex'),
      iat: Math.floor(Date.now() / 1000),
      exp: grant.exp,
    },
  ),
});

const createFixture = () => {
  const source = newSigner();
  const destination = newSigner();
  const cloud = newSigner();
  const sourceInstanceId = randomUUID();
  const iat = Math.floor(Date.now() / 1000);
  const claims = BuddyGrantClaims.parse({
    version: 1,
    iss: 'https://api.cloud.test',
    aud: 'frameleaf-buddy',
    sub: sourceInstanceId,
    jti: randomUUID(),
    iat,
    exp: iat + 300,
    pairId: randomUUID(),
    sourceInstanceId,
    destinationInstanceId: randomUUID(),
    vaultId: randomUUID(),
    scope: 'write',
    cnf: { jkt: source.kid, jwk: source.publicJwk },
    destinationKey: destination.publicJwk,
  });
  const grant = BuddyGrantResponse.parse({
    version: 1,
    token: cloud.sign({ typ: 'buddy-grant+jwt', alg: 'EdDSA', kid: cloud.kid }, claims),
    expiresAt: new Date(claims.exp * 1000).toISOString(),
    claims,
    connections: [
      {
        kind: 'local',
        uri: 'https://buddy.peer.test:2443',
        protocol: 'https',
        address: 'buddy.peer.test',
        port: 2443,
        local: true,
        relay: false,
        ipv6: false,
        custom: false,
        dnsRebindingProtection: true,
        httpsRequired: true,
        verified: true,
      },
    ],
  });
  const throttle = vi.fn(() => Promise.resolve());
  const client = new BuddyBackupClient(
    () => Promise.resolve(grant),
    () => source,
    throttle,
  );
  const url = (path: string) => `${grant.connections[0].uri}/api/buddy/v1/vaults/${grant.claims.vaultId}/${path}`;
  const requestProof = (input: string | URL | Request, options?: RequestInit) => {
    const headers = new Headers(options?.headers);
    expect(headers.get('authorization')).toBe(`DPoP ${grant.token}`);
    expect(options?.redirect).toBe('error');
    return verifyBuddyProof(
      headers.get('dpop') ?? '',
      grant.token,
      grant.claims,
      options?.method ?? 'GET',
      String(input),
    );
  };
  return { source, destination, grant, client, throttle, url, requestProof };
};

describe('Buddy peer fetch authentication (FL-310, FC-100)', () => {
  let fixture: ReturnType<typeof createFixture>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-28T12:00:00.000Z'));
    fixture = createFixture();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each(['GET', 'POST', 'PUT'] as const)('signs every %s request with a fresh source-key proof', async (method) => {
    const { client, destination, grant, requestProof, throttle, url } = fixture;
    const block = Buffer.from('synthetic sealed Buddy block');
    const path = { GET: 'snapshots', POST: 'inventory', PUT: `objects/${'a'.repeat(64)}` }[method];
    const body = method === 'POST' ? { ids: [] } : undefined;
    const proofs: Array<ReturnType<typeof verifyBuddyProof>> = [];
    const data = { ok: true };
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
      expect(String(input)).toBe(url(path));
      expect(options?.method).toBe(method);
      const proof = requestProof(input, options);
      proofs.push(proof);
      if (method === 'PUT') {
        const chunks: Buffer[] = [];
        for await (const chunk of options!.body as unknown as Readable) {
          chunks.push(Buffer.from(chunk));
        }
        expect(Buffer.concat(chunks)).toEqual(block);
      } else {
        expect(options?.body).toBe(body === undefined ? undefined : JSON.stringify(body));
      }
      return Response.json(signedReply(grant.claims, proof.jti, data, destination));
    });

    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(client.request(method, path, body, method === 'PUT' ? block : undefined)).resolves.toEqual(data);
    }
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(new Set(proofs.map(({ jti }) => jti)).size).toBe(2);
    expect(client.connection).toBe('local');
    if (method === 'PUT') {
      expect(throttle).toHaveBeenCalledWith(block.length, 'upload');
    }
  });

  it('signs a new proof for the nonce retry and retains the nonce for the next request', async () => {
    const { client, destination, grant, requestProof } = fixture;
    const nonce = 'n'.repeat(43);
    const proofs: Array<ReturnType<typeof verifyBuddyProof>> = [];
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((input, options) => {
      const proof = requestProof(input, options);
      proofs.push(proof);
      return Promise.resolve(
        proofs.length === 1
          ? new Response(null, { status: 401, headers: { 'DPoP-Nonce': nonce } })
          : Response.json(signedReply(grant.claims, proof.jti, { ok: true }, destination)),
      );
    });

    await expect(client.request('GET', 'handshake')).resolves.toEqual({ ok: true });
    await expect(client.request('GET', 'snapshots')).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(proofs[0]).not.toHaveProperty('nonce');
    expect(proofs.slice(1).map(({ nonce }) => nonce)).toEqual([nonce, nonce]);
    expect(new Set(proofs.map(({ jti }) => jti)).size).toBe(3);
  });

  it.each(['destination', 'body', 'vault', 'grant', 'request', 'expiry'] as const)(
    'rejects a response with a different %s binding',
    async (changed) => {
      const { client, destination, grant, requestProof, source } = fixture;
      const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((input, options) => {
        const proof = requestProof(input, options);
        const claims = {
          ...grant.claims,
          ...(changed === 'vault' && { vaultId: randomUUID() }),
          ...(changed === 'grant' && { jti: randomUUID() }),
          ...(changed === 'expiry' && { exp: grant.claims.exp + 1 }),
        };
        const reply = signedReply(
          claims,
          changed === 'request' ? randomUUID() : proof.jti,
          { ok: true },
          changed === 'destination' ? source : destination,
        );
        if (changed === 'body') {
          reply.data = { ok: false };
        }
        return Promise.resolve(Response.json(reply));
      });

      await expect(client.request('GET', 'snapshots')).rejects.toThrow('Buddy destination proof rejected');
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(client.connection).toBeNull();
    },
  );

  it.each(['valid', 'different object', 'different bytes'] as const)(
    'checks the signed binary receipt against the downloaded object: %s',
    async (receipt) => {
      const { client, destination, grant, requestProof, throttle } = fixture;
      const id = 'a'.repeat(64);
      const bytes = Buffer.from('synthetic sealed Buddy block');
      vi.spyOn(globalThis, 'fetch').mockImplementation((input, options) => {
        const { jti } = requestProof(input, options);
        const data = BuddyVault.receipt(
          receipt === 'different object' ? 'b'.repeat(64) : id,
          receipt === 'different bytes' ? Buffer.from('tampered sealed Buddy block') : bytes,
        );
        const { proof } = signedReply(grant.claims, jti, data, destination);
        return Promise.resolve(
          new Response(new Uint8Array(bytes), {
            headers: { 'Content-Type': 'application/octet-stream', 'Buddy-Proof': proof },
          }),
        );
      });

      const response = client.request<Buffer>('GET', `objects/${id}`);
      if (receipt === 'valid') {
        await expect(response).resolves.toEqual(bytes);
        expect(client.connection).toBe('local');
        expect(throttle).toHaveBeenCalledWith(bytes.length, 'download');
      } else {
        await expect(response).rejects.toThrow('Buddy destination proof rejected');
        expect(client.connection).toBeNull();
      }
    },
  );

  it.each(['TimeoutError', 'AbortError'])(
    'classifies a %s as a failed execution, not a prerequisite wait',
    async (name) => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new DOMException('request stopped', name));
      await expect(fixture.client.request('GET', 'snapshots')).rejects.toBeInstanceOf(BuddyExecutionError);
    },
  );

  it('retains an explicit quota refusal as a prerequisite wait', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 507 }));
    await expect(fixture.client.request('GET', 'snapshots')).rejects.toBeInstanceOf(BuddyPeerUnavailable);
  });

  it('sends nothing if the source key cannot sign', async () => {
    const { client, source } = fixture;
    vi.spyOn(source, 'sign').mockImplementation(() => {
      throw new Error('Source key unavailable');
    });
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected peer request'));

    await expect(client.request('GET', 'snapshots')).rejects.toThrow('Source key unavailable');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['ECONNRESET', 'UND_ERR_SOCKET'])(
    'preserves retry ownership when a response body ends with %s',
    async (code) => {
      const { client } = fixture;
      const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"data":'));
              controller.error(new TypeError('terminated', { cause: { code } }));
            },
          }),
          { headers: { 'content-type': 'application/vnd.frameleaf.buddy+json' } },
        ),
      );

      await expect(client.request('GET', 'handshake')).rejects.toBeInstanceOf(BuddyExecutionError);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(client.connection).toBeNull();
    },
  );

  it('keeps malformed complete replies as terminal protocol failures', async () => {
    const { client } = fixture;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"data":'));
    await expect(client.request('GET', 'handshake')).rejects.toBeInstanceOf(SyntaxError);
    expect(client.connection).toBeNull();
  });

  it('sends nothing when the grant has expired', async () => {
    const { client, grant } = fixture;
    vi.setSystemTime(grant.claims.exp * 1000);
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected peer request'));

    await expect(client.request('GET', 'snapshots')).rejects.toThrow('Buddy authorization expired');
    expect(fetch).not.toHaveBeenCalled();
  });
});
