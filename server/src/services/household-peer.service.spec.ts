import { HttpException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { SystemMetadataKey } from 'src/enum.js';
import { HouseholdPeerService } from 'src/services/household-peer.service.js';
import { ed25519Thumbprint } from 'src/utils/frameleaf-cloud.js';
import { createDpopProof } from 'src/utils/frameleaf-dpop.js';
import { HouseholdGrantResponse } from 'src/utils/frameleaf-household.js';
import { verifyHouseholdResponse } from 'src/utils/household-protocol.js';
import {
  type HouseholdCloud,
  type HouseholdServer,
  householdRequest,
  householdSigner,
  startHouseholdCloud,
  startHouseholdServer,
} from 'test/fixtures/household-servers.js';

// the system config is the one thing read from the database here: each fixture server answers with its own name
vi.mock('src/utils/config.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getConfig: (repos: { configRepo: { serverName: string } }) =>
    Promise.resolve({ server: { name: repos.configRepo.serverName } }),
}));

/**
 * FL-952, design section 2 and threat model T1 to T5: what Anna's server does with a request that claims to
 * come from a linked household. Ben is linked with Anna; Cara is linked with Anna too, on another link. Grants
 * come from the fake Frameleaf Cloud, signed with a real key; nothing in the checks is mocked.
 */
describe(HouseholdPeerService.name, () => {
  let fixture: HouseholdCloud;
  let anna: HouseholdServer;
  let ben: HouseholdServer;
  let cara: HouseholdServer;
  /** The link's id at Cloud (the id in the peer path), by peer. */
  let link: { ben: string; cara: string };

  const status = (promise: Promise<unknown>) =>
    promise
      .then(() => 200)
      .catch((error: unknown) => {
        if (error instanceof HttpException) return error.getStatus();
        throw error;
      });
  const url = (linkId: string, route = 'handshake') => `https://${anna.host}/api/household/v1/links/${linkId}/${route}`;
  const grantFor = (server: HouseholdServer, linkId: string) =>
    server.peer.cloud(HouseholdGrantResponse, 'grants', { version: 1, linkId });
  const proofBy = (signer: Parameters<typeof createDpopProof>[0], token: string, htu: string, htm = 'GET') =>
    createDpopProof(signer, { htm, htu, accessToken: token });
  /** A request to Anna as `server` would send it, with anything replaced. */
  const send = async (
    server: HouseholdServer,
    linkId: string,
    change: {
      token?: string;
      proof?: string;
      path?: string;
      method?: string;
      address?: string;
      headers?: Record<string, string>;
    } = {},
  ) => {
    const token = change.token ?? (await grantFor(server, linkId)).token;
    const target = url(change.path ?? linkId);
    const headers = change.headers ?? {
      Authorization: `DPoP ${token}`,
      DPoP: change.proof ?? proofBy(server.peer.signer(), token, target, change.method),
    };
    return anna.peer.authorize(
      householdRequest(target, headers, { method: change.method, address: change.address }),
      change.path ?? linkId,
    );
  };
  const cloudCalls = (path?: string) =>
    fixture.cloud.requests.filter((request) => !path || request.path === path).length;
  const warnings = () => anna.logger.warn.mock.calls.map(([message]) => String(message));
  const annaLinkId = (cloudLinkId: string) => anna.links.rows.find((row) => row.cloudLinkId === cloudLinkId)!.id;

  beforeEach(async () => {
    fixture = await startHouseholdCloud();
    anna = await startHouseholdServer(fixture, 'Anna');
    ben = await startHouseholdServer(fixture, 'Ben');
    cara = await startHouseholdServer(fixture, 'Cara');
    const ids: string[] = [];
    for (const server of [ben, cara]) {
      const { token } = await anna.service.invite();
      await server.service.accept(token);
      ids.push(server.links.rows[0].cloudLinkId);
    }
    await anna.service.reconcile();
    link = { ben: ids[0], cara: ids[1] };
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await Promise.all([anna.close(), ben.close(), cara.close(), fixture.cloud.close()]);
  });

  it('admits a linked household’s signed request and signs the reply with this server’s key', async () => {
    const granted = await grantFor(ben, link.ben);
    const target = url(link.ben);
    const access = await anna.peer.authorize(
      householdRequest(target, {
        Authorization: `DPoP ${granted.token}`,
        DPoP: proofBy(ben.peer.signer(), granted.token, target),
      }),
      link.ben,
    );
    expect(access.link).toMatchObject({ cloudLinkId: link.ben, peerInstanceId: ben.identity.instanceId });
    expect(access.grant.jti).toBe(granted.claims.jti);
    expect(anna.counts.get(`household:${access.link.id}`)).toBe(1);
    expect(anna.links.admitted.values().toArray()).toEqual([
      { linkId: access.link.id, expiresAt: new Date(granted.claims.exp * 1000) },
    ]);

    const reply = anna.peer.signed(access, await anna.peer.handshake());
    expect(reply.data).toEqual({ version: 1, name: 'Anna', maxOriginalBytes: 20 * 1024 ** 3 });
    expect(() =>
      verifyHouseholdResponse(reply.proof, granted.claims, anna.identity.publicJwk.x, reply.data, access.requestId),
    ).not.toThrow();
    expect(anna.logger.warn).not.toHaveBeenCalled();
  });

  it('T1: answers 403 for a link it does not hold before doing anything else', async () => {
    const { token } = await grantFor(ben, link.ben);
    const before = cloudCalls();
    const identity = vi.spyOn(anna.peer, 'identity');
    for (const path of [randomUUID(), 'not-a-link', `${link.ben}x`, '../admin'])
      await expect(status(send(ben, link.ben, { token, path }))).resolves.toBe(403);
    // no Cloud call, no key loaded, no budget spent, no proof admitted
    expect(cloudCalls()).toBe(before);
    expect(identity).not.toHaveBeenCalled();
    expect(
      anna.counts
        .keys()
        .filter((key) => !key.startsWith('household:refused:'))
        .toArray(),
    ).toEqual([]);
    expect(anna.links.admitted.size).toBe(0);
  });

  it('T1: answers 401 when the grant or the proof is missing', async () => {
    const { token } = await grantFor(ben, link.ben);
    const before = cloudCalls();
    for (const headers of [
      {},
      { Authorization: `DPoP ${token}` },
      { DPoP: proofBy(ben.peer.signer(), token, url(link.ben)) },
      { Authorization: `Bearer ${token}`, DPoP: proofBy(ben.peer.signer(), token, url(link.ben)) },
    ])
      await expect(status(send(ben, link.ben, { token, headers }))).resolves.toBe(401);
    expect(cloudCalls()).toBe(before);
  });

  it('T2: refuses and logs a request signed by another key', async () => {
    const { token } = await grantFor(ben, link.ben);
    const stolen = proofBy(householdSigner(), token, url(link.ben));
    await expect(status(send(ben, link.ben, { token, proof: stolen }))).resolves.toBe(401);
    // signed by another linked household's real key
    await expect(
      status(send(ben, link.ben, { token, proof: proofBy(cara.peer.signer(), token, url(link.ben)) })),
    ).resolves.toBe(401);

    expect(warnings()).toHaveLength(2);
    expect(warnings()[0]).toContain(annaLinkId(link.ben));
    // the log names the link and never carries the grant or the proof
    expect(warnings().join(' ')).not.toContain(token);
    expect(warnings().join(' ')).not.toContain(stolen);
    expect(cloudCalls('/v1/households/grants/verify')).toBe(0);
    expect(anna.links.admitted.size).toBe(0);
  });

  it('T2: refuses and logs a grant issued for another link, another server or another key', async () => {
    // Cara's own valid grant and proof, on Ben's link
    const caras = await grantFor(cara, link.cara);
    await expect(
      status(
        send(cara, link.ben, { token: caras.token, proof: proofBy(cara.peer.signer(), caras.token, url(link.ben)) }),
      ),
    ).resolves.toBe(403);

    const { households } = fixture;
    const benLink = households.links.get(link.ben)!;
    const claims = households.grantClaims(benLink, ben.registered, anna.registered);
    const crafted = (change: Record<string, unknown>, signer = ben.peer.signer()) => {
      const token = households.signGrant({ ...claims, jti: randomUUID(), ...change });
      return { token, proof: proofBy(signer, token, url(link.ben)) };
    };
    // Cloud-signed, but for another destination server
    await expect(status(send(ben, link.ben, crafted({ destinationInstanceId: randomUUID() })))).resolves.toBe(403);
    // for a destination key that is not this server's
    await expect(status(send(ben, link.ben, crafted({ destinationKey: cara.identity.publicJwk })))).resolves.toBe(403);
    // from a source that is not the linked server
    const stranger = randomUUID();
    await expect(status(send(ben, link.ben, crafted({ sub: stranger, sourceInstanceId: stranger })))).resolves.toBe(
      403,
    );
    // bound to a key that is not the one stored for Ben at pairing, with a proof by that key
    const other = householdSigner();
    await expect(
      status(
        send(ben, link.ben, crafted({ cnf: { jkt: ed25519Thumbprint(other.publicJwk), jwk: other.publicJwk } }, other)),
      ),
    ).resolves.toBe(403);

    expect(warnings()).toHaveLength(5);
    expect(warnings().every((message) => message.includes(annaLinkId(link.ben)))).toBe(true);
    expect(cloudCalls('/v1/households/grants/verify')).toBe(0);
    expect(anna.links.admitted.size).toBe(0);
  });

  it('refuses a grant Cloud did not sign, of another type, for another audience or longer than 300 seconds', async () => {
    const { households } = fixture;
    const benLink = households.links.get(link.ben)!;
    const claims = households.grantClaims(benLink, ben.registered, anna.registered);
    const forged = householdSigner().sign(
      { alg: 'EdDSA', typ: 'household-grant+jwt', kid: 'household-fixture' },
      claims,
    );
    const tokens = [
      forged,
      ben.peer.signer().sign({ alg: 'EdDSA', typ: 'household-grant+jwt', kid: 'household-fixture' }, claims),
      households.signGrant(claims, { typ: 'buddy-grant+jwt' }),
      households.signGrant({ ...claims, aud: 'frameleaf-buddy' }),
      households.signGrant({ ...claims, exp: claims.iat + 301 }),
      households.signGrant({ ...claims, iss: 'https://other.example/api' }),
      households.signGrant({ ...claims, iat: claims.iat - 600, exp: claims.iat - 300 }),
      'garbage',
    ];
    for (const token of tokens) await expect(status(send(ben, link.ben, { token }))).resolves.toBe(401);
    expect(cloudCalls('/v1/households/grants/verify')).toBe(0);
    expect(anna.links.admitted.size).toBe(0);
  });

  it('T3: admits a proof once: the same request a second time is 401', async () => {
    const { token } = await grantFor(ben, link.ben);
    const proof = proofBy(ben.peer.signer(), token, url(link.ben));
    await expect(status(send(ben, link.ben, { token, proof }))).resolves.toBe(200);
    await expect(status(send(ben, link.ben, { token, proof }))).resolves.toBe(401);
    // a fresh proof under the same grant is a new request
    await expect(status(send(ben, link.ben, { token }))).resolves.toBe(200);
  });

  it('T3: refuses a proof made for another address or another method', async () => {
    const { token } = await grantFor(ben, link.ben);
    const signer = ben.peer.signer();
    for (const proof of [
      proofBy(signer, token, url(link.ben, 'shares')),
      proofBy(signer, token, url(link.cara)),
      proofBy(signer, token, url(link.ben).replace(anna.host, 'evil.example')),
      proofBy(signer, token, url(link.ben).replace('https:', 'http:')),
      proofBy(signer, token, url(link.ben), 'POST'),
      // made for another grant
      proofBy(signer, (await grantFor(ben, link.ben)).token, url(link.ben)),
    ])
      await expect(status(send(ben, link.ben, { token, proof }))).resolves.toBe(401);
    expect(anna.links.admitted.size).toBe(0);
    expect(warnings()).toHaveLength(6);
  });

  it('T4: answers 403 for an ended or paused link, although its grant is still live', async () => {
    const { token } = await grantFor(ben, link.ben);
    await anna.links.update(annaLinkId(link.ben), { state: 'paused' });
    await expect(status(send(ben, link.ben, { token }))).resolves.toBe(403);

    await anna.service.end(annaLinkId(link.ben));
    const before = cloudCalls();
    await expect(status(send(ben, link.ben, { token }))).resolves.toBe(403);
    expect(cloudCalls()).toBe(before);
    // the other link is untouched
    await expect(status(send(cara, link.cara))).resolves.toBe(200);
  });

  it('T4: refuses when this server is no longer linked to Frameleaf Cloud, or Cloud suspects a copy of it', async () => {
    const { token } = await grantFor(ben, link.ben);
    const record = anna.metadata.get(SystemMetadataKey.FrameleafCloudLink) as object;
    anna.metadata.set(SystemMetadataKey.FrameleafCloudLink, { ...record, heartbeat: { cloneSuspected: true } });
    await expect(status(send(ben, link.ben, { token }))).resolves.toBe(403);
    anna.metadata.clear();
    await expect(status(send(ben, link.ben, { token }))).resolves.toBe(403);
  });

  it('T4: asks Cloud about every request, and remembers a refusal until the grant expires', async () => {
    const { token } = await grantFor(ben, link.ben);
    await expect(status(send(ben, link.ben, { token }))).resolves.toBe(200);
    expect(cloudCalls('/v1/households/grants/verify')).toBe(1);

    // the link ends at Cloud; Anna has not heard yet
    fixture.households.end(fixture.households.links.get(link.ben)!, ben.identity.instanceId);
    await expect(status(send(ben, link.ben, { token }))).resolves.toBe(403);
    expect(cloudCalls('/v1/households/grants/verify')).toBe(2);
    expect(warnings().at(-1)).toContain(annaLinkId(link.ben));

    // refused again without asking, even if Cloud would now answer yes
    fixture.households.links.get(link.ben)!.endedAt = null;
    await expect(status(send(ben, link.ben, { token }))).resolves.toBe(403);
    expect(cloudCalls('/v1/households/grants/verify')).toBe(2);
    expect(anna.links.admitted.size).toBe(1);
  });

  it('refuses a grant Cloud verifies as a different grant', async () => {
    const { token } = await grantFor(ben, link.ben);
    const other = await grantFor(ben, link.ben);
    fixture.cloud.on('POST /v1/households/grants/verify', () => ({
      status: 200,
      body: { version: 1, claims: other.claims },
    }));
    await expect(status(send(ben, link.ben, { token }))).resolves.toBe(403);
  });

  describe('T5: when Frameleaf Cloud is unreachable', () => {
    const down = () => {
      for (const route of ['POST /v1/households/grants/verify', 'GET /v1/households/jwks', 'POST /id/token'])
        fixture.cloud.on(route, () => ({ status: 503, body: { code: 'unavailable', message: 'down' } }));
    };

    it('accepts a live grant on its own checks, and still admits each proof once', async () => {
      const { token } = await grantFor(ben, link.ben);
      await expect(status(send(ben, link.ben, { token }))).resolves.toBe(200);
      down();
      const proof = proofBy(ben.peer.signer(), token, url(link.ben));
      await expect(status(send(ben, link.ben, { token, proof }))).resolves.toBe(200);
      await expect(status(send(ben, link.ben, { token, proof }))).resolves.toBe(401);
      // every other check still applies
      await expect(
        status(send(ben, link.ben, { token, proof: proofBy(householdSigner(), token, url(link.ben)) })),
      ).resolves.toBe(401);
    });

    it('refuses an expired grant', async () => {
      const { token } = await grantFor(ben, link.ben);
      await expect(status(send(ben, link.ben, { token }))).resolves.toBe(200);
      down();
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 301_000);
      await expect(status(send(ben, link.ben, { token }))).resolves.toBe(401);
    });

    it('refuses when Cloud answers with a refusal instead of an outage', async () => {
      const first = await grantFor(ben, link.ben);
      await expect(status(send(ben, link.ben, { token: first.token }))).resolves.toBe(200);
      const verify = fixture.cloud.routes.get('POST /v1/households/grants/verify')!;
      let token = '';
      for (const code of [400, 401, 403, 404, 409, 429]) {
        ({ token } = await grantFor(ben, link.ben));
        fixture.cloud.on('POST /v1/households/grants/verify', () => ({
          status: code,
          body: { code: 'forbidden', message: 'no' },
        }));
        await expect(status(send(ben, link.ben, { token }))).resolves.toBe(403);
        fixture.cloud.on('POST /v1/households/grants/verify', verify);
      }
      // and a refusal is never retried as if it were an outage
      down();
      await expect(status(send(ben, link.ben, { token }))).resolves.toBe(403);
    });

    it('refuses everyone when it never fetched Cloud’s grant keys', async () => {
      const { token } = await grantFor(ben, link.ben);
      fixture.cloud.on('GET /v1/households/jwks', () => ({
        status: 503,
        body: { code: 'unavailable', message: 'down' },
      }));
      await expect(send(ben, link.ben, { token })).rejects.toThrow();
      expect(anna.links.admitted.size).toBe(0);
    });
  });

  it('T15: answers 429 to request 121 on a link within a minute, without touching the other link', async () => {
    const key = `household:${annaLinkId(link.ben)}`;
    anna.counts.set(key, 119);
    const { token } = await grantFor(ben, link.ben);
    await expect(status(send(ben, link.ben, { token }))).resolves.toBe(200);
    expect(anna.counts.get(key)).toBe(120);
    const verified = cloudCalls('/v1/households/grants/verify');
    await expect(status(send(ben, link.ben, { token }))).resolves.toBe(429);
    expect(cloudCalls('/v1/households/grants/verify')).toBe(verified);
    expect(anna.rates.hit).toHaveBeenCalledWith(key, 60);
    await expect(status(send(cara, link.cara))).resolves.toBe(200);
  });

  it('answers 429 to an address after 30 refused requests in a minute, before looking at anything', async () => {
    const address = '198.51.100.7';
    for (let attempt = 0; attempt < 30; attempt++)
      await expect(status(send(ben, link.ben, { path: randomUUID(), token: 'x', address }))).resolves.toBe(403);
    const lookups = vi.spyOn(anna.links, 'getByCloudLinkId');
    // even a request that would be valid
    await expect(status(send(ben, link.ben, { address }))).resolves.toBe(429);
    expect(lookups).not.toHaveBeenCalled();
    // another address is not affected
    await expect(status(send(ben, link.ben, { address: '198.51.100.8' }))).resolves.toBe(200);
  });
});
