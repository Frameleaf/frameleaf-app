import { createHash } from 'node:crypto';
import type { ZodType } from 'zod';
import { MailSignInProvider, MlAdmissionRefusal } from 'src/enum.js';
import { FrameleafCloudError, errorEnvelopeSchema } from 'src/utils/frameleaf-cloud.js';
import {
  type MailBrokerTarget,
  claimMailSignIn,
  connectedSender,
  isMailGrantInvalid,
  isMailSendNotAllowed,
  isMailSignInNotFound,
  isMailSignInUnavailable,
  mailAddressOf,
  mailRevokeRequestSchema,
  mailRevokeResponseSchema,
  mailSealKey,
  mailServicesResponseSchema,
  mailSignInClaimResponseSchema,
  mailSignInStartRequestSchema,
  mailSignInStartResponseSchema,
  mailTokenRequestSchema,
  mailTokenResponseSchema,
  newMailState,
  newPkceVerifier,
  openMailSecret,
  pkceChallenge,
  readMailProviders,
  requestMailToken,
  revokeMailToken,
  sealMailSecret,
  startMailSignIn,
} from 'src/utils/frameleaf-mail.js';
import { cloudContractFixture } from 'test/fixtures/frameleaf-cloud-contracts.js';

type Exchange = {
  request: { method: string; url: string; body: Record<string, unknown> | null };
  status: number;
  body: Record<string, unknown>;
};
const fixture = (name: string) => cloudContractFixture<Exchange>(`mail/${name}.json`);

const target = { api: 'https://api.frameleaf.cloud/', token: { accessToken: 'instance-token' } } as MailBrokerTarget;

/** A cloud client that answers with a fixture's body and records what it was asked. */
const answering = (exchange: Exchange) => {
  const requestJson = vi.fn((schema: ZodType, _request: unknown) => Promise.resolve(schema.parse(exchange.body)));
  return { cloud: { requestJson } as never, sent: () => requestJson.mock.calls[0][1] as Record<string, unknown> };
};

const refusal = (name: string) => {
  const exchange = fixture(name);
  return new FrameleafCloudError(
    MlAdmissionRefusal.CloudUnavailable,
    exchange.status,
    'refused',
    errorEnvelopeSchema.parse(exchange.body),
  );
};

/**
 * FL-379 against the mail broker contract Frameleaf Cloud publishes (FC-160, v1.2;
 * `test/fixtures/frameleaf-cloud-contracts/mail`, see SOURCE.md): every request this server builds
 * is the published request, and every published answer is read.
 */
describe('Frameleaf Cloud mail broker contract', () => {
  it('reads which services are offered, under this server’s provider names', async () => {
    const exchange = fixture('services');
    const { cloud, sent } = answering(exchange);

    await expect(readMailProviders(cloud, target)).resolves.toEqual([MailSignInProvider.Gmail]);

    expect(sent()).toEqual({ url: exchange.request.url, dpop: target.token });
    expect(mailServicesResponseSchema.parse(exchange.body)).toEqual(exchange.body);
  });

  it.each(['sign-in-start-google', 'sign-in-start-microsoft'])('starts a sign-in as published: %s', async (name) => {
    const exchange = fixture(name);
    const { cloud, sent } = answering(exchange);
    const request = mailSignInStartRequestSchema.parse(exchange.request.body);

    await expect(startMailSignIn(cloud, target, request)).resolves.toEqual(exchange.body);

    expect(exchange.status).toBe(201);
    expect(sent()).toEqual({
      method: 'POST',
      url: exchange.request.url,
      dpop: target.token,
      body: exchange.request.body,
    });
    expect(mailSignInStartResponseSchema.parse(exchange.body)).toEqual(exchange.body);
  });

  it.each(['claim-pending', 'claim-ready', 'claim-denied'])('claims without a body and reads %s', async (name) => {
    const exchange = fixture(name);
    const { cloud, sent } = answering(exchange);
    const signInId = exchange.request.url.split('/').at(-2)!;

    await expect(claimMailSignIn(cloud, target, signInId)).resolves.toEqual(exchange.body);

    expect(exchange.request.body).toBeNull();
    expect(sent()).toEqual({ method: 'POST', url: exchange.request.url, dpop: target.token });
    expect(mailSignInClaimResponseSchema.parse(exchange.body)).toEqual(exchange.body);
  });

  it.each(['token-exchange-google', 'token-exchange-microsoft', 'token-refresh-google', 'token-refresh-microsoft'])(
    'asks for tokens as published: %s',
    async (name) => {
      const exchange = fixture(name);
      const { cloud, sent } = answering(exchange);
      const request = mailTokenRequestSchema.parse(exchange.request.body);

      await expect(requestMailToken(cloud, target, request)).resolves.toEqual(exchange.body);

      expect(sent()).toEqual({
        method: 'POST',
        url: exchange.request.url,
        dpop: target.token,
        body: exchange.request.body,
      });
      expect(mailTokenResponseSchema.parse(exchange.body)).toEqual(exchange.body);
    },
  );

  it('gets the address from Google’s exchange only, and a rotated refresh token from Microsoft’s refresh', () => {
    expect(fixture('token-exchange-google').body.email).toEqual(expect.any(String));
    expect(fixture('token-exchange-microsoft').body.email).toBeUndefined();
    expect(fixture('token-refresh-google').body.refreshToken).toBeUndefined();
    expect(fixture('token-refresh-microsoft').body.refreshToken).toEqual(expect.any(String));
  });

  it.each([
    ['revoke-google', 'revoked'],
    ['revoke-microsoft', 'not-supported'],
  ])('revokes as published: %s answers %s', async (name, status) => {
    const exchange = fixture(name);
    const { cloud, sent } = answering(exchange);
    const request = mailRevokeRequestSchema.parse(exchange.request.body);

    await expect(revokeMailToken(cloud, target, request)).resolves.toEqual({ status });

    expect(sent()).toMatchObject({ method: 'POST', url: exchange.request.url, body: exchange.request.body });
    expect(mailRevokeResponseSchema.parse(exchange.body)).toEqual(exchange.body);
  });

  it('refuses to send a request the contract does not allow', () => {
    const start = fixture('sign-in-start-google').request.body!;
    expect(() => mailSignInStartRequestSchema.parse({ ...start, provider: 'google' })).toThrow();
    expect(() => mailSignInStartRequestSchema.parse({ ...start, codeChallenge: 'too-short' })).toThrow();
    expect(() => mailSignInStartRequestSchema.parse({ ...start, service: 'yahoo' })).toThrow();
    const exchange = fixture('token-exchange-google').request.body!;
    expect(() => mailTokenRequestSchema.parse({ ...exchange, signInId: 'x' })).toThrow();
    expect(() => mailTokenRequestSchema.parse({ ...exchange, codeVerifier: 'short' })).toThrow();
  });

  describe('refusals', () => {
    const kinds = { isMailGrantInvalid, isMailSignInNotFound, isMailSignInUnavailable };
    it.each([
      ['error-grant-invalid', 'isMailGrantInvalid'],
      ['error-sign-in-not-found', 'isMailSignInNotFound'],
      ['error-sign-in-unavailable', 'isMailSignInUnavailable'],
      ['error-provider-unavailable', null],
      ['error-rate-limited', null],
      ['error-request-invalid', null],
    ] as const)('%s is %s and nothing else', (name, expected) => {
      const error = refusal(name);
      for (const [kind, is] of Object.entries(kinds)) {
        expect(is(error), kind).toBe(kind === expected);
      }
    });

    it('marks an account as needing sign-in only for the published grant refusal', () => {
      expect(isMailGrantInvalid(refusal('error-provider-unavailable'))).toBe(false);
      expect(isMailGrantInvalid(new Error('mail-grant-invalid'))).toBe(false);
      expect(isMailSendNotAllowed(refusal('error-grant-invalid'))).toBe(false);
    });

    it('tells a sign-in that did not allow sending from a dead grant', () => {
      const { body, status } = fixture('error-grant-invalid');
      const error = new FrameleafCloudError(
        MlAdmissionRefusal.CloudUnavailable,
        status,
        'refused',
        errorEnvelopeSchema.parse({ ...body, detail: 'send-scope-missing' }),
      );
      expect(isMailSendNotAllowed(error)).toBe(true);
    });
  });
});

describe('mail sign-in secrets', () => {
  const key = mailSealKey('server keyed hash');

  it('makes a state and a verifier the contract accepts, and the S256 challenge of the verifier', () => {
    const verifier = newPkceVerifier();
    const request = { service: 'google', state: newMailState(), codeChallenge: pkceChallenge(verifier) };
    expect(() => mailSignInStartRequestSchema.parse(request)).not.toThrow();
    expect(request.codeChallenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
    expect(newMailState()).not.toBe(request.state);
    // RFC 7636 appendix B
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('seals a secret so it cannot be read, and opens it again', () => {
    const sealed = sealMailSecret(key, 'connection-1', 'refresh-token');
    expect(sealed).not.toContain('refresh-token');
    expect(Buffer.from(sealed, 'base64').toString('latin1')).not.toContain('refresh-token');
    expect(sealMailSecret(key, 'connection-1', 'refresh-token')).not.toBe(sealed);
    expect(openMailSecret(key, 'connection-1', sealed)).toBe('refresh-token');
  });

  it('does not open for another record, another server’s key, or a damaged value', () => {
    const sealed = sealMailSecret(key, 'connection-1', 'refresh-token');
    expect(openMailSecret(key, 'connection-2', sealed)).toBeNull();
    expect(openMailSecret(mailSealKey('another server'), 'connection-1', sealed)).toBeNull();
    const damaged = Buffer.from(sealed, 'base64');
    damaged[damaged.length - 1] ^= 1;
    expect(openMailSecret(key, 'connection-1', damaged.toString('base64'))).toBeNull();
    expect(openMailSecret(key, 'connection-1', 'short')).toBeNull();
  });
});

describe('the sender of a connected account', () => {
  it('reads the address out of a sender with a name', () => {
    expect(mailAddressOf('Rivera photos <Photos@Example.com>')).toBe('photos@example.com');
    expect(mailAddressOf(' photos@example.com ')).toBe('photos@example.com');
  });

  it('keeps a saved sender for the account’s own address and replaces any other', () => {
    expect(connectedSender('Rivera photos <rivera@gmail.com>', 'rivera@gmail.com')).toBe(
      'Rivera photos <rivera@gmail.com>',
    );
    expect(connectedSender('old@example.com', 'rivera@gmail.com')).toBe('rivera@gmail.com');
    expect(connectedSender('', 'rivera@gmail.com')).toBe('rivera@gmail.com');
  });
});
