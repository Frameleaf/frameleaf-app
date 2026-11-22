import { randomUUID } from 'node:crypto';
import { ed25519Thumbprint } from 'src/utils/frameleaf-cloud.js';
import { createDpopProof } from 'src/utils/frameleaf-dpop.js';
import {
  signHouseholdResponse,
  verifyHouseholdGrant,
  verifyHouseholdProof,
  verifyHouseholdResponse,
} from 'src/utils/household-protocol.js';
import { householdSigner } from 'test/fixtures/household-servers.js';

const issuer = 'https://api.frameleaf.test';
const fixture = () => {
  const cloud = householdSigner();
  const source = householdSigner();
  const destination = householdSigner();
  const now = Date.now();
  const iat = Math.floor(now / 1000);
  const claims = {
    version: 1 as const,
    iss: issuer,
    aud: 'frameleaf-household' as const,
    sub: randomUUID(),
    jti: randomUUID(),
    iat,
    exp: iat + 300,
    linkId: randomUUID(),
    sourceInstanceId: '',
    destinationInstanceId: randomUUID(),
    cnf: { jkt: ed25519Thumbprint(source.publicJwk), jwk: source.publicJwk },
    destinationKey: destination.publicJwk,
  };
  claims.sourceInstanceId = claims.sub;
  const jwks = { keys: [{ ...cloud.publicJwk, kid: 'k1' }] };
  const grant = (change: Record<string, unknown> = {}, header: Record<string, unknown> = {}, signer = cloud) =>
    signer.sign({ alg: 'EdDSA', typ: 'household-grant+jwt', kid: 'k1', ...header }, { ...claims, ...change });
  return { cloud, source, destination, claims, jwks, grant, now };
};

describe('household grant', () => {
  it('accepts a grant Frameleaf Cloud signed for this issuer', () => {
    const { grant, jwks, claims } = fixture();
    expect(verifyHouseholdGrant(grant(), jwks, issuer)).toEqual(claims);
  });

  it.each([
    ['a Buddy grant type', {}, { typ: 'buddy-grant+jwt' }],
    ['an access token type', {}, { typ: 'at+jwt' }],
    ['another algorithm', {}, { alg: 'HS256' }],
    ['an unknown signing key', {}, { kid: 'k2' }],
    ['the Buddy audience', { aud: 'frameleaf-buddy' }, {}],
    ['another issuer', { iss: 'https://evil.example' }, {}],
    ['a lifetime over 300 seconds', { exp: 301 }, {}],
    ['an expired grant', { iat: -400, exp: -100 }, {}],
    ['a grant from the future', { iat: 120, exp: 300 }, {}],
    ['a subject that is not the source server', { sub: randomUUID() }, {}],
    ['a thumbprint of another key', { cnf: { jkt: 'A'.repeat(43), jwk: householdSigner().publicJwk } }, {}],
    ['an extra claim', { scope: 'write' }, {}],
    ['a missing link', { linkId: undefined }, {}],
  ])('refuses %s', (_name, change, header) => {
    const { grant, jwks, claims } = fixture();
    // `iat` and `exp` above are seconds from now
    const moved = Object.fromEntries(
      Object.entries(change).map(([name, value]) => [name, typeof value === 'number' ? claims.iat + value : value]),
    );
    expect(() => verifyHouseholdGrant(grant(moved, header), jwks, issuer)).toThrow();
  });

  it('refuses a grant signed by any key but Cloud’s, and one whose claims were changed after signing', () => {
    const { grant, jwks, source } = fixture();
    expect(() => verifyHouseholdGrant(grant({}, {}, source), jwks, issuer)).toThrow('Household grant rejected');
    const [header, , signature] = grant().split('.', 3);
    const forged = Buffer.from(JSON.stringify({ ...fixture().claims })).toString('base64url');
    expect(() => verifyHouseholdGrant(`${header}.${forged}.${signature}`, jwks, issuer)).toThrow(
      'Household grant rejected',
    );
    expect(() => verifyHouseholdGrant('not-a-jwt', jwks, issuer)).toThrow();
    expect(() => verifyHouseholdGrant(`${'a'.repeat(9000)}.b.c`, jwks, issuer)).toThrow();
  });
});

describe('household request proof', () => {
  const url = 'https://anna.example/api/household/v1/links/1/handshake';
  it('accepts a proof by the grant’s key for this method, address and grant, and nothing else', () => {
    const { grant, claims, source, destination } = fixture();
    const token = grant();
    const proof = createDpopProof(source, { htm: 'GET', htu: url, accessToken: token });
    expect(verifyHouseholdProof(proof, token, claims, 'GET', url).jti).toMatch(/^[\da-f-]{36}$/);
    expect(verifyHouseholdProof(proof, token, claims, 'GET', `${url}?cursor=4`).jti).toBeTruthy();

    expect(() => verifyHouseholdProof(proof, token, claims, 'POST', url)).toThrow('proof rejected');
    expect(() => verifyHouseholdProof(proof, token, claims, 'GET', url.replace('handshake', 'shares'))).toThrow();
    expect(() => verifyHouseholdProof(proof, token, claims, 'GET', url.replace('anna', 'ben'))).toThrow();
    expect(() => verifyHouseholdProof(proof, token, claims, 'GET', url.replace('https', 'http'))).toThrow();
    // the same proof with another grant
    expect(() => verifyHouseholdProof(proof, grant({ jti: randomUUID() }), claims, 'GET', url)).toThrow();
    // too old
    expect(() => verifyHouseholdProof(proof, token, claims, 'GET', url, Date.now() + 61_000)).toThrow();
    // signed by another key
    const other = createDpopProof(destination, { htm: 'GET', htu: url, accessToken: token });
    expect(() => verifyHouseholdProof(other, token, claims, 'GET', url)).toThrow('proof rejected');
  });
});

describe('household signed reply', () => {
  const reply = () => {
    const { claims, destination, source } = fixture();
    const requestId = randomUUID();
    const data = { version: 1, name: 'Anna', maxOriginalBytes: 20 * 1024 ** 3 };
    return {
      claims,
      destination,
      source,
      requestId,
      data,
      signed: signHouseholdResponse(destination, claims, requestId, data),
    };
  };

  it('accepts the reply the linked server signed for this request', () => {
    const { claims, destination, requestId, data, signed } = reply();
    expect(signed.data).toBe(data);
    expect(() =>
      verifyHouseholdResponse(
        signed.proof,
        claims,
        destination.publicJwk.x,
        JSON.parse(JSON.stringify(data)),
        requestId,
      ),
    ).not.toThrow();
  });

  it('refuses a changed body, another request, another grant, another link and an old reply', () => {
    const { claims, destination, requestId, data, signed } = reply();
    const key = destination.publicJwk.x;
    const refused = 'Household reply proof rejected';
    expect(() => verifyHouseholdResponse(signed.proof, claims, key, { ...data, name: 'Mallory' }, requestId)).toThrow(
      refused,
    );
    expect(() => verifyHouseholdResponse(signed.proof, claims, key, data, randomUUID())).toThrow(refused);
    expect(() => verifyHouseholdResponse(signed.proof, { ...claims, jti: randomUUID() }, key, data, requestId)).toThrow(
      refused,
    );
    expect(() =>
      verifyHouseholdResponse(signed.proof, { ...claims, linkId: randomUUID() }, key, data, requestId),
    ).toThrow(refused);
    expect(() => verifyHouseholdResponse(signed.proof, claims, key, data, requestId, Date.now() + 61_000)).toThrow(
      refused,
    );
    expect(() => verifyHouseholdResponse(signed.proof, claims, key, data, requestId, claims.exp * 1000)).toThrow(
      refused,
    );
  });

  it('refuses a reply signed by any key but the one stored at pairing, whatever the grant says', () => {
    const { claims, destination, source, requestId, data } = reply();
    // someone else answers at the address and signs with their own key
    const forged = signHouseholdResponse(source, claims, requestId, data);
    expect(() => verifyHouseholdResponse(forged.proof, claims, destination.publicJwk.x, data, requestId)).toThrow();
    // a grant naming that other key does not help: the stored key decides
    const swapped = { ...claims, destinationKey: source.publicJwk };
    expect(() => verifyHouseholdResponse(forged.proof, swapped, destination.publicJwk.x, data, requestId)).toThrow();
    // a Buddy reply type is not a household reply
    const buddy = destination.sign(
      { typ: 'buddy-response+jwt', alg: 'EdDSA' },
      JSON.parse(
        Buffer.from(
          signHouseholdResponse(destination, claims, requestId, data).proof.split('.', 2)[1],
          'base64url',
        ).toString(),
      ),
    );
    expect(() => verifyHouseholdResponse(buddy, claims, destination.publicJwk.x, data, requestId)).toThrow();
  });
});
