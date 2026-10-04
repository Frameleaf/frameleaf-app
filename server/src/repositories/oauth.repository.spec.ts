import { BadRequestException } from '@nestjs/common';
import * as openidClient from 'openid-client';
import { OAuthTokenEndpointAuthMethod } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { OAuthConfig, OAuthRepository } from 'src/repositories/oauth.repository.js';
import { automock } from 'test/utils.js';

vi.mock('openid-client', async (importOriginal) => {
  const original = await importOriginal<typeof import('openid-client')>();
  return { ...original, discovery: vi.fn(), authorizationCodeGrant: vi.fn() };
});

const config: OAuthConfig = {
  clientId: 'client',
  clientSecret: 'secret',
  issuerUrl: 'https://issuer.example.com/.well-known/openid-configuration',
  accountManagementUrl: '',
  endSessionEndpoint: '',
  mobileOverrideEnabled: false,
  mobileRedirectUri: '',
  profileSigningAlgorithm: 'none',
  scope: 'openid email profile',
  signingAlgorithm: 'RS256',
  tokenEndpointAuthMethod: OAuthTokenEndpointAuthMethod.ClientSecretPost,
  timeout: 1000,
  allowInsecureRequests: false,
} as OAuthConfig;

const callbackUrl = 'https://photos.example.com/auth/login?code=abc&state=expected';

/** The errors openid-client raises for a callback that must not sign anyone in. */
const refusal = (error: Error) => {
  vi.mocked(openidClient.authorizationCodeGrant).mockRejectedValue(error);
};

describe(OAuthRepository.name, () => {
  let sut: OAuthRepository;

  beforeEach(() => {
    sut = new OAuthRepository(
      automock(LoggingRepository, { args: [undefined, { getEnv: () => ({}) }], strict: false }),
    );
    vi.mocked(openidClient.discovery).mockResolvedValue({
      serverMetadata: () => ({ supportsPKCE: () => true }),
    } as unknown as openidClient.Configuration);
  });

  describe('getProfileAndOAuthSid (FL-80 callback refusals)', () => {
    it('checks the state and the PKCE verifier of the sign-in that started', async () => {
      refusal(new Error('stop'));
      await expect(sut.getProfileAndOAuthSid(config, callbackUrl, 'expected', 'verifier')).rejects.toThrow();
      expect(openidClient.authorizationCodeGrant).toHaveBeenCalledWith(expect.anything(), new URL(callbackUrl), {
        expectedState: 'expected',
        pkceCodeVerifier: 'verifier',
      });
    });

    it('answers a provider refusal (error=access_denied) with a 400 that says so', async () => {
      refusal(
        new openidClient.AuthorizationResponseError('authorization response from the server is an error', {
          cause: new URLSearchParams({ error: 'access_denied', state: 'expected' }),
        }),
      );
      const promise = sut.getProfileAndOAuthSid(config, callbackUrl, 'expected', 'verifier');
      await expect(promise).rejects.toBeInstanceOf(BadRequestException);
      await expect(promise).rejects.toThrow('The identity provider did not approve the sign-in. Try again.');
    });

    it('never repeats text the provider or the address put in the refusal', async () => {
      refusal(
        new openidClient.AuthorizationResponseError('authorization response from the server is an error', {
          cause: new URLSearchParams({ error: 'access_denied', error_description: '<script>alert(1)</script>' }),
        }),
      );
      await expect(sut.getProfileAndOAuthSid(config, callbackUrl, 'expected', 'verifier')).rejects.not.toThrow(
        /script/,
      );
    });

    it('answers a state that belongs to another sign-in with a 400', async () => {
      refusal(
        new openidClient.ClientError('invalid response encountered', {
          code: 'OAUTH_INVALID_RESPONSE',
          cause: new Error('unexpected "state" response parameter value'),
        } as ErrorOptions),
      );
      const promise = sut.getProfileAndOAuthSid(config, callbackUrl, 'other', 'verifier');
      await expect(promise).rejects.toBeInstanceOf(BadRequestException);
      await expect(promise).rejects.toThrow('This sign-in was started somewhere else or has expired. Sign in again.');
    });

    it('answers a callback from another issuer (a mix-up) with the same 400', async () => {
      refusal(
        new openidClient.ClientError('invalid response encountered', {
          code: 'OAUTH_INVALID_RESPONSE',
          cause: new Error('unexpected "iss" (issuer) response parameter value'),
        } as ErrorOptions),
      );
      await expect(sut.getProfileAndOAuthSid(config, callbackUrl, 'expected', 'verifier')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('answers an expired, reused or mismatched code (invalid_grant) with a 400', async () => {
      refusal(
        new openidClient.ResponseBodyError('server responded with an error in the response body', {
          cause: { error: 'invalid_grant' },
          response: new Response(null, { status: 400 }),
        }),
      );
      const promise = sut.getProfileAndOAuthSid(config, callbackUrl, 'expected', 'wrong-verifier');
      await expect(promise).rejects.toBeInstanceOf(BadRequestException);
      await expect(promise).rejects.toThrow('This sign-in link has expired or was already used. Sign in again.');
    });

    it('keeps other failures (a misconfigured or unreachable provider) as server errors', async () => {
      refusal(new TypeError('fetch failed'));
      const promise = sut.getProfileAndOAuthSid(config, callbackUrl, 'expected', 'verifier');
      await expect(promise).rejects.not.toBeInstanceOf(BadRequestException);
      await expect(promise).rejects.toThrow('OAuth login failed');
    });
  });
});
