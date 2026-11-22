import { randomUUID } from 'node:crypto';
import { ed25519Thumbprint } from 'src/utils/frameleaf-cloud.js';
import { HouseholdClient, HouseholdKeyChanged } from 'src/utils/household-client.js';
import { signHouseholdResponse, verifyHouseholdProof } from 'src/utils/household-protocol.js';
import { householdSigner } from 'test/fixtures/household-servers.js';

const connection = (uri: string, kind = 'wan') => ({
  kind,
  uri,
  protocol: 'https',
  address: 'x',
  port: 443,
  local: kind === 'local',
  relay: kind === 'relay',
  ipv6: false,
  custom: false,
  dnsRebindingProtection: false,
  httpsRequired: true,
  verified: true,
});

const fixture = (uris: Array<[string, string?]> = [['https://peer.example']]) => {
  const self = householdSigner();
  const peer = householdSigner();
  const link = { cloudLinkId: randomUUID(), peerInstanceId: randomUUID(), peerPublicKey: peer.publicJwk.x };
  const grant = (change: Record<string, unknown> = {}, lifetime = 300) => {
    const iat = Math.floor(Date.now() / 1000);
    const sub = randomUUID();
    const claims = {
      version: 1 as const,
      iss: 'https://api.frameleaf.test',
      aud: 'frameleaf-household' as const,
      sub,
      jti: randomUUID(),
      iat,
      exp: iat + lifetime,
      linkId: link.cloudLinkId,
      sourceInstanceId: sub,
      destinationInstanceId: link.peerInstanceId,
      cnf: { jkt: ed25519Thumbprint(self.publicJwk), jwk: self.publicJwk },
      destinationKey: peer.publicJwk,
      ...change,
    };
    return {
      version: 1 as const,
      token: `grant-${claims.jti}`,
      expiresAt: new Date(claims.exp * 1000).toISOString(),
      claims,
      connections: uris.map(([uri, kind]) => connection(uri, kind)),
    };
  };
  const issue = vi.fn(() => Promise.resolve(grant()));
  const client = new HouseholdClient(link, issue as never, () => self);
  /** Answers as the peer does: verifies nothing, signs the reply for the request it was sent. */
  const answer = (signer = peer) =>
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const headers = init!.headers as Record<string, string>;
      const requestId = JSON.parse(Buffer.from(headers.DPoP.split('.', 2)[1], 'base64url').toString()).jti;
      const claims = (await issue.mock.results.at(-1)!.value).claims;
      return Response.json(signHouseholdResponse(signer, claims, requestId, { version: 1 }));
    });
  return { self, peer, link, grant, issue, client, answer };
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe(HouseholdClient.name, () => {
  it('sends the grant and a proof for exactly this address, and returns the signed reply', async () => {
    const { client, answer, self, issue } = fixture();
    const fetch = answer();
    await expect(client.get('handshake')).resolves.toEqual({ version: 1 });
    expect(client.connection).toBe('wan');

    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    const { claims, token } = await issue.mock.results[0].value;
    expect(url).toBe(`https://peer.example/api/household/v1/links/${claims.linkId}/handshake`);
    expect(init.redirect).toBe('error');
    expect(init.method ?? 'GET').toBe('GET');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`DPoP ${token}`);
    expect(() => verifyHouseholdProof(headers.DPoP, token, claims, 'GET', url)).not.toThrow();
    expect(claims.cnf.jwk.x).toBe(self.publicJwk.x);
  });

  it('tries the grant’s addresses in order, only over https and without credentials, and remembers which answered', async () => {
    const { client, peer, issue } = fixture([
      ['http://192.168.1.20:2283', 'local'],
      ['https://user:secret@peer.example', 'wan'],
      ['https://peer.example/?next=https://evil.example', 'wan'],
      ['not a url', 'wan'],
      ['https://192.168.1.20:2283', 'local'],
      ['https://direct.peer.example', 'wan'],
      ['https://relay.frameleaf.example', 'relay'],
    ]);
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith('https://192.168.1.20:2283')) throw new TypeError('fetch failed');
      if (url.startsWith('https://direct.peer.example')) return new Response('busy', { status: 503 });
      const requestId = JSON.parse(
        Buffer.from((init!.headers as Record<string, string>).DPoP.split('.', 2)[1], 'base64url').toString(),
      ).jti;
      return Response.json(
        signHouseholdResponse(peer, (await issue.mock.results[0].value).claims, requestId, { ok: true }),
      );
    });
    await expect(client.get('handshake')).resolves.toEqual({ ok: true });
    expect(fetch.mock.calls.map(([url]) => new URL(String(url)).origin)).toEqual([
      'https://192.168.1.20:2283',
      'https://direct.peer.example',
      'https://relay.frameleaf.example',
    ]);
    expect(client.connection).toBe('relay');
    expect(client.connections).toHaveLength(7);
  });

  it('refuses a redirect instead of following it', async () => {
    const { client } = fixture();
    // what fetch does with `redirect: 'error'` when the address answers 302
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation((_input, init) =>
        init?.redirect === 'error'
          ? Promise.reject(new TypeError('fetch failed', { cause: new Error('unexpected redirect') }))
          : Promise.resolve(Response.json({ data: { version: 1 }, proof: 'x' })),
      );
    await expect(client.get('handshake')).rejects.toThrow('fetch failed');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(client.connection).toBeNull();

    // and a 3xx handed back as it is carries no reply either
    fetch.mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }));
    await expect(client.get('handshake')).rejects.toMatchObject({ status: 302 });
    expect(fetch.mock.calls.every(([url]) => String(url).startsWith('https://peer.example/'))).toBe(true);
  });

  it('refuses a reply signed by another key, an unsigned reply and a changed reply', async () => {
    const { client, answer, peer, issue } = fixture();
    answer(householdSigner());
    await expect(client.get('handshake')).rejects.toThrow('Household reply proof rejected');
    expect(client.connection).toBeNull();

    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ version: 1, name: 'Mallory' }));
    await expect(client.get('handshake')).rejects.toThrow();

    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const requestId = JSON.parse(
        Buffer.from((init!.headers as Record<string, string>).DPoP.split('.', 2)[1], 'base64url').toString(),
      ).jti;
      const signed = signHouseholdResponse(peer, (await issue.mock.results.at(-1)!.value).claims, requestId, {
        name: 'Anna',
      });
      return Response.json({ ...signed, data: { name: 'Mallory' } });
    });
    await expect(client.get('handshake')).rejects.toThrow('Household reply proof rejected');
  });

  it('does not send anything when the grant names another server or key than the one stored at pairing', async () => {
    const { client, issue, grant } = fixture();
    const fetch = vi.spyOn(globalThis, 'fetch');
    issue.mockResolvedValueOnce(grant({ destinationKey: householdSigner().publicJwk }));
    await expect(client.get('handshake')).rejects.toBeInstanceOf(HouseholdKeyChanged);
    issue.mockResolvedValueOnce(grant({ destinationInstanceId: randomUUID() }));
    await expect(client.get('handshake')).rejects.toBeInstanceOf(HouseholdKeyChanged);
    issue.mockResolvedValueOnce(grant({ linkId: randomUUID() }));
    await expect(client.get('handshake')).rejects.toMatchObject({ status: 403 });
    issue.mockResolvedValueOnce(grant({ cnf: { jkt: 'x', jwk: householdSigner().publicJwk } }));
    await expect(client.get('handshake')).rejects.toMatchObject({ status: 403 });
    issue.mockResolvedValueOnce(grant({}, -10));
    await expect(client.get('handshake')).rejects.toMatchObject({ status: 403 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps a grant until fewer than 60 seconds remain, then asks for a new one', async () => {
    const { client, answer, issue } = fixture();
    answer();
    vi.useFakeTimers({ toFake: ['Date'] });
    await client.get('handshake');
    vi.setSystemTime(Date.now() + 239_000);
    await client.get('handshake');
    expect(issue).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 2000);
    await client.get('handshake');
    expect(issue).toHaveBeenCalledTimes(2);
  });

  it('passes on Cloud’s refusal of a grant, and asks again next time', async () => {
    const { client, answer, issue } = fixture();
    const fetch = answer();
    issue.mockRejectedValueOnce(new Error('Cloud refused'));
    await expect(client.get('handshake')).rejects.toThrow('Cloud refused');
    expect(fetch).not.toHaveBeenCalled();
    await expect(client.get('handshake')).resolves.toEqual({ version: 1 });
  });

  it('only calls this link’s routes, and reads no more than the protocol allows', async () => {
    const { client } = fixture();
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('x'.repeat(4 * 1024 * 1024 + 1)));
    for (const path of ['../admin/users', '/handshake', 'handshake?x=1', 'a//b', 'https://evil.example', ''])
      await expect(client.get(path)).rejects.toThrow('Invalid household route');
    expect(fetch).not.toHaveBeenCalled();
    await expect(client.get('handshake')).rejects.toMatchObject({ status: 502 });
  });

  it('says the other household is offline when the grant lists no usable address', async () => {
    const { client } = fixture([['http://192.168.1.20:2283', 'local']]);
    const fetch = vi.spyOn(globalThis, 'fetch');
    await expect(client.get('handshake')).rejects.toMatchObject({ status: 503 });
    expect(fetch).not.toHaveBeenCalled();
  });
});
