import { BadRequestException, Injectable, InternalServerErrorException } from '@nestjs/common';
import { type JWTPayload, JWTVerifyGetKey, createRemoteJWKSet, errors as joseErrors, jwtVerify } from 'jose';
import {
  AuthorizationResponseError,
  type ClientAuth,
  ClientError,
  ClientSecretBasic,
  ClientSecretPost,
  None,
  ResponseBodyError,
  type UserInfoResponse,
  allowInsecureRequests as allowInsecureRequestsExecute,
  authorizationCodeGrant,
  buildAuthorizationUrl,
  calculatePKCECodeChallenge,
  discovery,
  fetchUserInfo,
  randomPKCECodeVerifier,
  randomState,
  skipSubjectCheck,
} from 'openid-client';
import { OAuthTokenEndpointAuthMethod } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';

export type OAuthConfig = {
  clientId: string;
  clientSecret?: string;
  issuerUrl: string;
  accountManagementUrl: string;
  endSessionEndpoint: string;
  mobileOverrideEnabled: boolean;
  mobileRedirectUri: string;
  profileSigningAlgorithm: string;
  prompt: string;
  scope: string;
  signingAlgorithm: string;
  tokenEndpointAuthMethod: OAuthTokenEndpointAuthMethod;
  timeout: number;
  allowInsecureRequests: boolean;
  /**
   * FL-158: a client authentication of the caller's own, used instead of the secret-based methods.
   * Sign in with Frameleaf authenticates with a `private_key_jwt` assertion signed by this server's
   * identity key, which never leaves the identity repository.
   */
  clientAuth?: ClientAuth;
};
export type OAuthProfile = UserInfoResponse;

/**
 * FL-230: why a provider-minted token was refused: the provider could not be reached (`unavailable`),
 * it expired or is too old (`expired`), it names another audience (`audience`), or anything else
 * (signature, issuer, type, a missing claim: `invalid`).
 */
export class ClientTokenRejection extends Error {
  constructor(
    public readonly reason: 'unavailable' | 'expired' | 'audience' | 'invalid',
    detail: string,
  ) {
    super(`Token refused (${reason}): ${detail}`);
    this.name = 'ClientTokenRejection';
  }
}

/**
 * FL-80: a callback that must not sign anyone in is the visitor's problem, not the server's: the
 * provider refused (`error=access_denied`), the state (or issuer) belongs to another sign-in, or the code expired,
 * was used already or does not match the PKCE verifier. Each becomes a 400 with a fixed message; the
 * provider's own text is never repeated, since anyone can put it in the address.
 */
const callbackRefusal = (error: unknown): string | undefined => {
  if (error instanceof AuthorizationResponseError) {
    return 'The identity provider did not approve the sign-in. Try again.';
  }
  if (
    error instanceof ClientError &&
    error.code === 'OAUTH_INVALID_RESPONSE' &&
    error.cause instanceof Error &&
    /"(state|iss)"/.test(error.cause.message)
  ) {
    return 'This sign-in was started somewhere else or has expired. Sign in again.';
  }
  if (error instanceof ResponseBodyError && error.error === 'invalid_grant') {
    return 'This sign-in link has expired or was already used. Sign in again.';
  }
};

@Injectable()
export class OAuthRepository {
  constructor(private logger: LoggingRepository) {
    this.logger.setContext(OAuthRepository.name);
  }

  async authorize(config: OAuthConfig, redirectUrl: string, state?: string, codeChallenge?: string) {
    const client = await this.getClient(config);
    state ??= randomState();

    let codeVerifier: string | null;
    if (codeChallenge) {
      codeVerifier = null;
    } else {
      codeVerifier = randomPKCECodeVerifier();
      codeChallenge = await calculatePKCECodeChallenge(codeVerifier);
    }

    const params: Record<string, string> = {
      redirect_uri: redirectUrl,
      scope: config.scope,
      state,
    };

    if (config.prompt) {
      params.prompt = config.prompt;
    }

    if (client.serverMetadata().supportsPKCE()) {
      params.code_challenge = codeChallenge;
      params.code_challenge_method = 'S256';
    }

    const url = buildAuthorizationUrl(client, params).href;

    return { url, state, codeVerifier };
  }

  async getLogoutEndpoint(config: OAuthConfig) {
    const client = await this.getClient(config);
    return client.serverMetadata().end_session_endpoint;
  }

  async getProfileAndOAuthSid(
    config: OAuthConfig,
    url: string,
    expectedState: string,
    codeVerifier: string,
  ): Promise<{ profile: OAuthProfile; sid?: string; idToken?: string }> {
    const client = await this.getClient(config);
    const pkceCodeVerifier = client.serverMetadata().supportsPKCE() ? codeVerifier : undefined;

    try {
      const tokens = await authorizationCodeGrant(client, new URL(url), { expectedState, pkceCodeVerifier });

      let profile: OAuthProfile;
      const tokenClaims = tokens.claims();
      if (tokenClaims && 'email' in tokenClaims) {
        this.logger.debug('Using ID token claims instead of userinfo endpoint');
        profile = tokenClaims as OAuthProfile;
      } else {
        profile = await fetchUserInfo(client, tokens.access_token, skipSubjectCheck);
      }

      if (!profile.sub) {
        throw new Error('Unexpected profile response, no `sub`');
      }

      let sid: string | undefined;
      if (tokens.id_token) {
        const claims = tokens.claims();
        if (typeof claims?.sid === 'string') {
          sid = claims.sid;
        }
      }

      return { profile, sid, idToken: tokens.id_token };
    } catch (error: any) {
      const refusal = callbackRefusal(error);
      if (refusal) {
        this.logger.warn(`OAuth callback refused: ${error.message}`);
        throw new BadRequestException(refusal);
      }

      if (error.message.includes('unexpected JWT alg received')) {
        this.logger.warn(
          [
            'Algorithm mismatch. Make sure the signing algorithm is set correctly in the OAuth settings.',
            'Or, that you have specified a signing key in your OAuth provider.',
          ].join(' '),
        );
      }

      this.logger.error('OAuth login failed', error);

      throw new Error('OAuth login failed', { cause: error });
    }
  }

  async getProfilePicture(url: string) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch picture: ${response.statusText}`);
    }

    return response.arrayBuffer();
  }

  private jwksClients: Map<string, JWTVerifyGetKey> = new Map(); // useful for caching and performnce

  /**
   * The issuer, key (or key set) and algorithms a JWT from this provider is verified with: the
   * configured algorithm, or (FL-158) for a client without one the issuer's advertised ID token
   * algorithms, never a shared-secret or unsigned one. Shared by logout tokens and (FL-230)
   * Sign in with Frameleaf exchange tokens.
   */
  private async getVerification(config: OAuthConfig) {
    const client = await this.getClient(config);
    const configured = client.clientMetadata().id_token_signed_response_alg;
    const algorithms = configured
      ? [configured]
      : (client.serverMetadata().id_token_signing_alg_values_supported ?? ['RS256']).filter(
          (value) => value !== 'none' && !value.startsWith('HS'),
        );
    const algorithm = algorithms[0] ?? 'RS256';
    let key: Uint8Array | JWTVerifyGetKey;
    if (algorithm.startsWith('HS')) {
      key = new TextEncoder().encode(config.clientSecret);
    } else {
      const jwksUri = client.serverMetadata().jwks_uri;
      if (!jwksUri) {
        throw new Error('Unable to get JWKS URI');
      }

      if (!this.jwksClients.has(jwksUri)) {
        this.jwksClients.set(jwksUri, createRemoteJWKSet(new URL(jwksUri)));
      }
      key = this.jwksClients.get(jwksUri) as JWTVerifyGetKey;
    }
    return {
      issuer: client.serverMetadata().issuer,
      key,
      algorithms: algorithm.startsWith('HS') ? [algorithm] : algorithms,
    };
  }

  /**
   * FL-230 (NAPI-006): verify a token the provider minted for this client (`aud` = client id) like
   * its ID tokens (issuer, audience, signature from the issuer's JWKS, expiry), with an explicit
   * `typ`, a maximum age and the claims it must carry. A refusal says which check failed.
   */
  async verifyClientToken(
    config: OAuthConfig,
    token: string,
    options: { typ: string; maxTokenAgeSeconds: number; clockToleranceSeconds: number; requiredClaims: string[] },
  ): Promise<JWTPayload> {
    let verification;
    try {
      verification = await this.getVerification(config);
    } catch (error: any) {
      throw new ClientTokenRejection('unavailable', error?.message ?? String(error));
    }
    try {
      const { payload } = await jwtVerify(token, verification.key as any, {
        issuer: verification.issuer,
        audience: config.clientId,
        algorithms: verification.algorithms,
        typ: options.typ,
        maxTokenAge: options.maxTokenAgeSeconds,
        clockTolerance: options.clockToleranceSeconds,
        requiredClaims: options.requiredClaims,
      });
      return payload;
    } catch (error: any) {
      if (error instanceof joseErrors.JWKSTimeout) {
        throw new ClientTokenRejection('unavailable', error.message);
      }
      if (error instanceof joseErrors.JWTExpired) {
        throw new ClientTokenRejection('expired', error.message);
      }
      if (error instanceof joseErrors.JWTClaimValidationFailed && error.claim === 'aud') {
        throw new ClientTokenRejection('audience', error.message);
      }
      throw new ClientTokenRejection('invalid', error?.message ?? String(error));
    }
  }

  async validateLogoutToken(config: OAuthConfig, logoutToken: string): Promise<{ sub?: string; sid?: string } | null> {
    try {
      const { issuer, key, algorithms } = await this.getVerification(config);
      const { payload } = await jwtVerify(logoutToken, key as any, {
        issuer,
        audience: config.clientId,
        algorithms,
        maxTokenAge: '2m',
        clockTolerance: '5s',
      });

      // Validate specific Logout Token claims (RFC 8963):
      // "events" claim must exist and contain the backchannel-logout event
      const events = payload.events as Record<string, any> | undefined;
      // eslint-disable-next-line unicorn/prefer-https
      if (!events || !events['http://schemas.openid.net/event/backchannel-logout']) {
        throw new Error('Missing backchannel-logout event claim');
      }

      // "nonce" must not be present
      if (payload.nonce) {
        throw new Error('Logout token must not contain a nonce');
      }

      return {
        sub: payload.sub,
        sid: payload.sid as string | undefined,
      };
    } catch (error: any) {
      this.logger.error(`Error validating JWT logout token: ${error.message}`);
      this.logger.error(error);

      throw new Error('Error validating JWT logout token', { cause: error });
    }
  }

  private async getClient({
    issuerUrl,
    clientId,
    clientSecret,
    profileSigningAlgorithm,
    signingAlgorithm,
    tokenEndpointAuthMethod,
    timeout,
    allowInsecureRequests,
    clientAuth,
  }: OAuthConfig) {
    try {
      return await discovery(
        new URL(issuerUrl),
        clientId,
        {
          client_secret: clientSecret,
          response_types: ['code'],
          userinfo_signed_response_alg: profileSigningAlgorithm === 'none' ? undefined : profileSigningAlgorithm,
          // FL-158: empty leaves the choice to the issuer's advertised algorithms
          id_token_signed_response_alg: signingAlgorithm || undefined,
        },
        clientAuth ?? this.getTokenAuthMethod(tokenEndpointAuthMethod, clientSecret),
        {
          execute: allowInsecureRequests ? [allowInsecureRequestsExecute] : [],
          timeout,
        },
      );
    } catch (error: any | AggregateError) {
      this.logger.error('Error in OAuth discovery', error);
      throw new InternalServerErrorException(`Error in OAuth discovery: ${error}`, { cause: error });
    }
  }

  private getTokenAuthMethod(tokenEndpointAuthMethod: OAuthTokenEndpointAuthMethod, clientSecret?: string) {
    if (!clientSecret) {
      return None();
    }

    switch (tokenEndpointAuthMethod) {
      case OAuthTokenEndpointAuthMethod.ClientSecretPost: {
        return ClientSecretPost(clientSecret);
      }

      case OAuthTokenEndpointAuthMethod.ClientSecretBasic: {
        return ClientSecretBasic(clientSecret);
      }

      default: {
        return None();
      }
    }
  }
}
