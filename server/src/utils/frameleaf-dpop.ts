import type { FrameleafKeySigner } from '@frameleaf/backup-core';
import { MlAdmissionRefusal } from 'src/enum.js';
import { FrameleafCloudError } from 'src/utils/frameleaf-cloud.js';

/**
 * RFC 9449 (DPoP) for Frameleaf Cloud instance tokens (FL-178, the app side of FC-66). The cloud
 * accepts bearer instance tokens only while its `instance.bearer_compat` flag is on, which it is not
 * in production, so every instance token is bound to this server's identity key:
 *
 * - The token request (`POST {issuer}/token`) carries a proof and keeps its `private_key_jwt` client
 *   assertion; both are signed by the same key, and the token's `cnf.jkt` is that key's thumbprint.
 * - Every api and ml call sends `Authorization: DPoP <token>` and a fresh proof with `ath`.
 * - `POST {api}/v1/instances` carries a proof by the key being linked, without `ath`.
 */

// The proofs themselves are shared with Manager, which links to Frameleaf Cloud the same way.
export {
  DPOP_NONCE_HEADER,
  USE_DPOP_NONCE,
  boundTokenProblem,
  createDpopProof,
  dpopAth,
  dpopHtu,
  isNonceChallenge,
  isUsableNonce,
  jwsSigningInput,
  signClientAssertion,
} from '@frameleaf/backup-core';
export type { Ed25519PublicJwk, FrameleafKeySigner } from '@frameleaf/backup-core';

/** An instance access token and the key it is bound to (`cnf.jkt`). */
export type FrameleafInstanceToken = { accessToken: string; signer: FrameleafKeySigner };

/**
 * The token endpoint answered with a token response this server parsed, but will not use: not
 * DPoP-bound, or bound to (or minted for) another key (FL-178). Thrown only by `accessToken`, after
 * the answer passed `tokenResponseSchema`, so it proves the cloud checked the client assertion and
 * issued a token for that key. Any other failure, including a 200 that is not a token response (a
 * captive portal's HTML, invalid JSON, an oversized body), is a plain `FrameleafCloudError`.
 */
export class BoundTokenRefusedError extends FrameleafCloudError {
  constructor(problem: string) {
    super(
      MlAdmissionRefusal.CloudUnavailable,
      200,
      `Frameleaf Cloud issued a token this server will not use: ${problem}`,
    );
    this.name = 'BoundTokenRefusedError';
  }
}
