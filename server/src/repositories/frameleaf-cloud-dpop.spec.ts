import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import z from 'zod';
import { FrameleafCloudRepository } from 'src/repositories/frameleaf-cloud.repository.js';
import { InstanceIdentityRepository } from 'src/repositories/instance-identity.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { FrameleafCloudError, FrameleafDiscoveryDocument } from 'src/utils/frameleaf-cloud.js';
import { BoundTokenRefusedError, FrameleafKeySigner } from 'src/utils/frameleaf-dpop.js';
import {
  FakeCloud,
  FakeCloudRequest,
  USE_DPOP_NONCE_ENVELOPE,
  assertionKidOf,
  dpopTokenOf,
  mintToken,
  startFakeCloud,
  tokenAnswer,
  tokenClaims,
} from 'test/fake-frameleaf-cloud.js';

describe('Frameleaf Cloud DPoP-bound instance tokens (FL-178)', () => {
  let cloud: FakeCloud;
  let dirs: string[];
  let repository: FrameleafCloudRepository;
  let signer: FrameleafKeySigner;
  let document: FrameleafDiscoveryDocument;

  const newSigner = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'frameleaf-dpop-'));
    dirs.push(dir);
    const identity = new InstanceIdentityRepository();
    await identity.loadOrCreate(dir, null);
    return identity.currentSigner();
  };
  const tokenRequests = () => cloud.requests.filter(({ path }) => path === '/id/token');
  const claimsOf = (request: FakeCloudRequest) => request.dpop!.claims;
  const mint = () => repository.accessToken(document, 'instance-1', document.api, signer);
  const call = async (url = `${cloud.url}/api/v1/instance/thing`) =>
    repository.requestJson(z.unknown(), { method: 'POST', url, dpop: await mint(), body: {} });

  beforeEach(async () => {
    dirs = [];
    cloud = await startFakeCloud();
    repository = new FrameleafCloudRepository(LoggingRepository.create());
    signer = await newSigner();
    document = await repository.discovery(cloud.url);
    cloud.on('POST /id/token', (request) => tokenAnswer(request));
    cloud.on('POST /api/v1/instance/thing', () => ({ status: 200, body: {} }));
    cloud.requests.length = 0;
  });

  afterEach(async () => {
    await cloud.close();
    for (const dir of dirs) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  describe('token request', () => {
    it('sends a proof (no ath, no nonce) by the key that signs the client assertion, and gets a bound token', async () => {
      const token = await mint();

      const [request] = tokenRequests();
      expect(request.headers.authorization).toBeUndefined();
      expect(request.dpop).not.toBeNull();
      expect(request.dpop!.header).toEqual({ typ: 'dpop+jwt', alg: 'EdDSA', jwk: signer.publicJwk });
      expect(claimsOf(request)).toEqual({
        jti: expect.any(String),
        htm: 'POST',
        htu: `${cloud.url}/id/token`,
        iat: expect.any(Number),
      });
      expect(Math.abs((claimsOf(request).iat as number) - Date.now() / 1000)).toBeLessThanOrEqual(2);
      // one key: the proof, the client assertion and the token's cnf.jkt and frameleaf_kid
      expect(request.dpop!.jkt).toBe(signer.kid);
      expect(assertionKidOf(request)).toBe(signer.kid);
      const form = request.form();
      expect(form.get('grant_type')).toBe('client_credentials');
      expect(form.get('client_assertion_type')).toBe('urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
      expect(form.get('resource')).toBe(document.api);
      expect(token.signer).toBe(signer);
      expect(tokenClaims(token.accessToken)).toMatchObject({ cnf: { jkt: signer.kid }, frameleaf_kid: signer.kid });
    });

    it('retries once with the nonce the token endpoint asks for, a fresh proof and a fresh assertion', async () => {
      cloud.nonce = 'token-nonce-1';
      await mint();

      expect(cloud.refusals).toEqual([{ path: '/id/token', status: 400, code: 'use_dpop_nonce' }]);
      const requests = tokenRequests();
      expect(requests).toHaveLength(2);
      expect(requests[0].dpop).toBeNull();
      expect(claimsOf(requests[1]).nonce).toBe('token-nonce-1');
      expect(claimsOf(requests[1])).not.toHaveProperty('ath');
      const assertionJti = (request: FakeCloudRequest) =>
        tokenClaims(request.form().get('client_assertion') ?? undefined)?.jti;
      expect(assertionJti(requests[0])).not.toBe(assertionJti(requests[1]));
    });

    it('refuses a bearer token, or a token bound to another key, and does not keep it', async () => {
      const other = await newSigner();
      for (const answer of [
        (request: FakeCloudRequest) => ({
          status: 200,
          body: { access_token: mintToken(request), token_type: 'Bearer', expires_in: 600 },
        }),
        (request: FakeCloudRequest) => ({
          status: 200,
          body: {
            access_token: mintToken(request, 'api-token', { cnf: { jkt: other.kid } }),
            token_type: 'DPoP',
            expires_in: 600,
          },
        }),
        (request: FakeCloudRequest) => ({
          status: 200,
          body: {
            access_token: mintToken(request, 'api-token', { frameleaf_kid: other.kid }),
            token_type: 'DPoP',
            expires_in: 600,
          },
        }),
      ]) {
        cloud.on('POST /id/token', answer);
        const error = await mint().catch((error_: unknown) => error_);
        expect(error).toBeInstanceOf(BoundTokenRefusedError);
        expect((error as Error).message).toMatch(/token this server will not use/);
      }
      cloud.on('POST /id/token', (request) => tokenAnswer(request));
      await mint();
      expect(tokenRequests()).toHaveLength(4);
    });

    it('never marks a success status that is not a token response as an issued token', async () => {
      for (const answer of [
        { status: 200, raw: '<html>portal</html>', headers: { 'content-type': 'text/html' } },
        { status: 200, raw: '{"access_token": ' },
        { status: 200, body: { hello: 'portal' } },
        { status: 200, raw: `{"pad":"${'x'.repeat(300 * 1024)}"}` },
      ]) {
        cloud.on('POST /id/token', () => answer);
        const error = await mint().catch((error_: unknown) => error_);
        expect(error).toBeInstanceOf(FrameleafCloudError);
        expect(error).not.toBeInstanceOf(BoundTokenRefusedError);
      }
    });

    it('keeps tokens per key, and drops a token of a key a rotation replaced', async () => {
      await mint();
      await mint();
      expect(tokenRequests()).toHaveLength(1);
      const next = await newSigner();
      const second = await repository.accessToken(document, 'instance-1', document.api, next);

      expect(second.signer).toBe(next);
      expect(tokenClaims(second.accessToken)?.cnf.jkt).toBe(next.kid);
      expect(tokenRequests()).toHaveLength(2);
      // the replaced key's token is gone: asking with that key mints again
      const again = await mint();
      expect(tokenRequests()).toHaveLength(3);
      expect(tokenClaims(again.accessToken)?.cnf.jkt).toBe(signer.kid);
    });
  });

  describe('api and ml calls', () => {
    it('send Authorization: DPoP and a proof with ath over the token, htm and htu without the query', async () => {
      cloud.on('GET /ml-eu/v2/usage', () => ({ status: 200, body: {} }));
      const token = await mint();
      await repository.requestJson(z.unknown(), {
        url: `${cloud.url}/ml-eu/v2/usage?since=2026-09-01T00%3A00%3A00.000Z`,
        dpop: token,
      });

      const request = cloud.requests.find(({ path }) => path === '/ml-eu/v2/usage')!;
      expect(request.headers.authorization).toBe(`DPoP ${token.accessToken}`);
      expect(dpopTokenOf(request)).toBe(token.accessToken);
      expect(claimsOf(request)).toEqual({
        jti: expect.any(String),
        htm: 'GET',
        htu: `${cloud.url}/ml-eu/v2/usage`,
        iat: expect.any(Number),
        ath: createHash('sha256').update(token.accessToken).digest('base64url'),
      });
      expect(request.dpop!.jkt).toBe(signer.kid);
    });

    it('retry once on a use_dpop_nonce 401, keep the tokens, and reuse the nonce for that origin', async () => {
      await mint();
      cloud.nonce = 'api-nonce-1';
      await call();

      expect(cloud.refusals).toEqual([{ path: '/api/v1/instance/thing', status: 401, code: 'use_dpop_nonce' }]);
      const calls = cloud.requests.filter(({ path }) => path === '/api/v1/instance/thing');
      expect(calls).toHaveLength(2);
      expect(claimsOf(calls[1]).nonce).toBe('api-nonce-1');
      // the nonce challenge did not cost the token
      expect(tokenRequests()).toHaveLength(1);

      // the cached nonce goes with the next call at once
      await call();
      expect(cloud.refusals).toHaveLength(1);
      expect(tokenRequests()).toHaveLength(1);
      expect(claimsOf(cloud.requests.at(-1)!).nonce).toBe('api-nonce-1');
    });

    it('recognise the challenge from WWW-Authenticate alone', async () => {
      let answered = false;
      cloud.on('POST /api/v1/instance/thing', () => {
        if (answered) {
          return { status: 200, body: {} };
        }
        answered = true;
        return {
          status: 401,
          headers: { 'DPoP-Nonce': 'header-nonce', 'WWW-Authenticate': 'DPoP error="use_dpop_nonce"' },
        };
      });
      await call();
      expect(claimsOf(cloud.requests.at(-1)!).nonce).toBe('header-nonce');
      expect(tokenRequests()).toHaveLength(1);
    });

    it('replace the nonce whenever an answer carries a new one', async () => {
      cloud.on('POST /api/v1/instance/thing', () => ({ status: 200, body: {}, headers: { 'DPoP-Nonce': 'fresh-2' } }));
      await call();
      expect(claimsOf(cloud.requests.at(-1)!)).not.toHaveProperty('nonce');
      await call();
      expect(claimsOf(cloud.requests.at(-1)!).nonce).toBe('fresh-2');
      cloud.on('POST /api/v1/instance/thing', () => ({ status: 200, body: {}, headers: { 'DPoP-Nonce': 'fresh-3' } }));
      await call();
      await call();
      expect(claimsOf(cloud.requests.at(-1)!).nonce).toBe('fresh-3');
    });

    it('retry only once, and still keep the tokens, when the fresh nonce is refused too', async () => {
      let nonces = 0;
      cloud.on('POST /api/v1/instance/thing', () => ({
        status: 401,
        body: USE_DPOP_NONCE_ENVELOPE,
        headers: { 'DPoP-Nonce': `rotating-${++nonces}`, 'WWW-Authenticate': 'DPoP error="use_dpop_nonce"' },
      }));
      const error = await call().catch((error_: unknown) => error_);

      expect(error).toBeInstanceOf(FrameleafCloudError);
      expect((error as FrameleafCloudError).status).toBe(401);
      expect((error as FrameleafCloudError).envelope?.code).toBe('use_dpop_nonce');
      expect(cloud.requests.filter(({ path }) => path === '/api/v1/instance/thing')).toHaveLength(2);
      await mint();
      expect(tokenRequests()).toHaveLength(1);
    });

    it('retry with the nonce the challenge itself sent, even when a parallel call stored another one', async () => {
      await mint();
      // another call's answer lands between this challenge and its retry and replaces the origin's nonce
      const nonces = (repository as unknown as { nonces: Map<string, string> }).nonces;
      const set = nonces.set.bind(nonces);
      nonces.set = (origin, value) => set(origin, value === 'from-challenge' ? 'from-a-parallel-call' : value);
      cloud.on('POST /api/v1/instance/thing', (request) =>
        request.dpop?.claims.nonce === 'from-challenge'
          ? { status: 200, body: {} }
          : {
              status: 401,
              body: USE_DPOP_NONCE_ENVELOPE,
              headers: { 'DPoP-Nonce': 'from-challenge', 'WWW-Authenticate': 'DPoP error="use_dpop_nonce"' },
            },
      );

      await call();
      const calls = cloud.requests.filter(({ path }) => path === '/api/v1/instance/thing');
      expect(calls).toHaveLength(2);
      expect(claimsOf(calls[1]).nonce).toBe('from-challenge');
    });

    it('do not retry a challenge that brings no new nonce', async () => {
      cloud.on('POST /api/v1/instance/thing', () => ({ status: 401, body: USE_DPOP_NONCE_ENVELOPE }));
      await expect(call()).rejects.toBeInstanceOf(FrameleafCloudError);
      expect(cloud.requests.filter(({ path }) => path === '/api/v1/instance/thing')).toHaveLength(1);
    });

    it('drop the tokens on any other 401', async () => {
      cloud.on('POST /api/v1/instance/thing', () => ({
        status: 401,
        body: { code: 'key_retired', message: 'relink' },
      }));
      await expect(call()).rejects.toMatchObject({ status: 401 });
      await mint();
      expect(tokenRequests()).toHaveLength(2);
    });

    it('keep a nonce per origin', async () => {
      // another origin that accepts the tokens this cloud issued, as an ML region does
      const other = await startFakeCloud({ tokens: cloud.tokens });
      try {
        other.on('POST /v1/other', () => ({ status: 200, body: {} }));
        cloud.nonce = 'origin-a';
        await call();
        const token = await mint();
        await repository.requestJson(z.unknown(), { method: 'POST', url: `${other.url}/v1/other`, dpop: token });
        expect(other.requests[0].dpop!.claims).not.toHaveProperty('nonce');
        await call();
        expect(claimsOf(cloud.requests.at(-1)!).nonce).toBe('origin-a');
      } finally {
        await other.close();
      }
    });
  });

  describe('a proof without a token (registration)', () => {
    it('keeps a bearer credential and adds a proof without ath, retrying once on a nonce challenge', async () => {
      cloud.on('POST /api/v1/instances', () => ({ status: 200, body: {} }));
      cloud.nonce = 'register-nonce';
      await repository.requestJson(z.unknown(), {
        method: 'POST',
        url: `${cloud.url}/api/v1/instances`,
        bearer: 'link-token',
        dpop: { signer },
        body: {},
      });

      const requests = cloud.requests.filter(({ path }) => path === '/api/v1/instances');
      expect(requests).toHaveLength(2);
      // the cloud checks the proof and nonce before it consumes the link token, so the retry reuses it
      expect(requests[0].headers.authorization).toBe('Bearer link-token');
      expect(requests[1].headers.authorization).toBe('Bearer link-token');
      expect(claimsOf(requests[1])).toEqual({
        jti: expect.any(String),
        htm: 'POST',
        htu: `${cloud.url}/api/v1/instances`,
        iat: expect.any(Number),
        nonce: 'register-nonce',
      });
      expect(requests[1].dpop!.jkt).toBe(signer.kid);
    });
  });

  describe('the fake cloud is as strict as FC-66', () => {
    it('refuses a token request or a registration without a proof', async () => {
      cloud.on('POST /api/v1/instances', () => ({ status: 200, body: {} }));
      await expect(
        repository.requestJson(z.unknown(), {
          method: 'POST',
          url: `${cloud.url}/id/token`,
          form: { grant_type: 'client_credentials', client_id: 'instance-1' },
        }),
      ).rejects.toMatchObject({ status: 400, oauth: { error: 'invalid_dpop_proof' } });
      await expect(
        repository.requestJson(z.unknown(), {
          method: 'POST',
          url: `${cloud.url}/api/v1/instances`,
          bearer: 'link-token',
          body: {},
        }),
      ).rejects.toMatchObject({ status: 401, envelope: { code: 'invalid_dpop_proof' } });
    });

    it('refuses a proof whose key is not the client assertion’s', async () => {
      const other = await newSigner();
      // the assertion by one key, the proof by another
      const mixed: FrameleafKeySigner = {
        ...signer,
        sign: (header, payload) =>
          header.typ === 'dpop+jwt'
            ? other.sign({ ...header, jwk: other.publicJwk }, payload)
            : signer.sign(header, payload),
      };
      await expect(repository.accessToken(document, 'instance-1', document.api, mixed)).rejects.toMatchObject({
        status: 400,
        oauth: { error: 'invalid_dpop_proof' },
      });
    });

    it('refuses an instance token presented as a bearer, and a token it never minted', async () => {
      const token = await mint();
      await expect(
        repository.requestJson(z.unknown(), {
          method: 'POST',
          url: `${cloud.url}/api/v1/instance/thing`,
          bearer: token.accessToken,
          body: {},
        }),
      ).rejects.toMatchObject({ status: 401, envelope: { code: 'invalid_token' } });
      await expect(
        repository.requestJson(z.unknown(), {
          method: 'POST',
          url: `${cloud.url}/api/v1/instance/thing`,
          dpop: { signer, accessToken: `${token.accessToken}x` },
          body: {},
        }),
      ).rejects.toMatchObject({ status: 401, envelope: { code: 'invalid_token' } });
    });
  });
});
