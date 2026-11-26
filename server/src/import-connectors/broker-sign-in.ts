import type { CryptoRepository } from 'src/repositories/crypto.repository.js';
import type { CloudGatewayDeps } from 'src/utils/frameleaf-cloud-gateway.js';
import { MailSignInUnavailableReason } from 'src/enum.js';
import {
  RemoteSourceAuthError,
  RemoteSourceError,
  type RemoteSourceSession,
  RemoteSourceUnavailableError,
} from 'src/import-connectors/remote-source.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { FrameleafCloudError } from 'src/utils/frameleaf-cloud.js';
import {
  type MailBrokerTarget,
  type MailTokenResponse,
  mailRevokeResponseSchema,
  mailServicesResponseSchema,
  mailSignInClaimResponseSchema,
  mailSignInStartResponseSchema,
  mailTokenResponseSchema,
  newMailState,
  newPkceVerifier,
  pkceChallenge,
} from 'src/utils/frameleaf-mail.js';
import { openImportSignIn, sealImportSignIn } from 'src/utils/import-connector.js';
import { MailSignInUnavailableError, mailBrokerTarget } from 'src/utils/mail-connection.js';

/**
 * Signing in to a file provider through the Frameleaf Cloud broker (FL-946, FL-959). Dropbox uses it
 * now; OneDrive and Google Drive pass their own service name and need nothing else here.
 *
 * The provider only returns a sign-in to Cloud's fixed address and wants a client secret, which Cloud
 * holds. This server makes the state and the PKCE verifier and checks the state before the verifier
 * is sent. The refresh token is stored on this server only, sealed; Cloud keeps no token. Any server
 * linked to a Frameleaf account may use the broker (owner decision FL-896): there is no licence check.
 */

/** Exactly what Cloud asks each provider for. Anything else is refused there as `scope-mismatch`. */
export const BROKER_SCOPES = {
  dropbox: ['files.metadata.read', 'files.content.read', 'account_info.read'],
  'microsoft-files': ['https://graph.microsoft.com/Files.Read', 'offline_access', 'openid', 'email'],
  'google-drive': ['https://www.googleapis.com/auth/drive.file', 'openid', 'email'],
} as const;
export type BrokerService = keyof typeof BROKER_SCOPES;

const LABELS: Record<BrokerService, string> = {
  dropbox: 'Dropbox',
  'microsoft-files': 'OneDrive',
  'google-drive': 'Google Drive',
};

export const isBrokerService = (service: string): service is BrokerService => Object.hasOwn(BROKER_SCOPES, service);

export type BrokerDeps = CloudGatewayDeps & { cryptoRepository: CryptoRepository; configRepository: ConfigRepository };

/** Why signing in is not on offer. A plain string in the API, so a new reason is never a new enum value. */
export type BrokerAvailability = {
  available: boolean;
  reason: 'not-linked' | 'not-configured' | 'not-offered' | 'cloud-unreachable' | null;
};

export type BrokerSignInStart = { authorizationUrl: string; expiresAt: string; signInToken: string };

export type BrokerSignInResult =
  | { state: 'pending' | 'denied' | 'expired' }
  | {
      state: 'ready';
      tokens: MailTokenResponse & { refreshToken: string };
      /** The connection this sign-in renews, when it was started from one. */
      connectionId: string | null;
    };

type SealedSignIn = {
  signInId: string;
  service: BrokerService;
  state: string;
  verifier: string;
  connectionId: string | null;
  expiresAt: string;
};

const cloudCode = (error: unknown, status: number, code: string) =>
  error instanceof FrameleafCloudError && error.status === status && error.envelope?.code === code;
const isGrantInvalid = (error: unknown) => cloudCode(error, 400, 'provider-grant-invalid');
const isNotFound = (error: unknown) => cloudCode(error, 404, 'provider-sign-in-not-found');
const isUnavailable = (error: unknown) => cloudCode(error, 503, 'provider-sign-in-unavailable');
const isInstanceRevoked = (error: unknown) => cloudCode(error, 401, 'instance_revoked');

const CLOUD_DOWN = 'Frameleaf Cloud could not be reached. Try again in a few minutes.';
export const LINK_FIRST = 'Link this server to a Frameleaf account first, then sign in.';

export class ProviderSignInBroker {
  constructor(private deps: BrokerDeps) {}

  private get seal() {
    return { crypto: this.deps.cryptoRepository, config: this.deps.configRepository };
  }

  private url(target: MailBrokerTarget, path: string) {
    return `${target.api.replace(/\/+$/, '')}/v1/instance/provider-sign-in/${path}`;
  }

  /** Where the broker is. An unlinked server gets the owner's next step, and nothing is contacted. */
  async target(): Promise<MailBrokerTarget> {
    try {
      return await mailBrokerTarget(this.deps);
    } catch (error) {
      if (error instanceof MailSignInUnavailableError) {
        throw new RemoteSourceUnavailableError(
          error.reason === MailSignInUnavailableReason.NotLinked
            ? LINK_FIRST
            : 'Frameleaf Cloud is not configured on this server.',
        );
      }
      throw new RemoteSourceUnavailableError(CLOUD_DOWN);
    }
  }

  /** Whether signing in to `service` can work from this server right now. Never throws for a cloud failure. */
  async availability(service: BrokerService): Promise<BrokerAvailability> {
    let target;
    try {
      target = await mailBrokerTarget(this.deps);
    } catch (error) {
      if (error instanceof MailSignInUnavailableError) {
        const linked = error.reason !== MailSignInUnavailableReason.NotLinked;
        return { available: false, reason: linked ? 'not-configured' : 'not-linked' };
      }
      return { available: false, reason: 'cloud-unreachable' };
    }
    try {
      const { services } = await this.deps.frameleafCloudRepository.requestJson(mailServicesResponseSchema, {
        url: this.url(target, 'services'),
        dpop: target.token,
      });
      return services.some((row) => row.service === service && row.available)
        ? { available: true, reason: null }
        : { available: false, reason: 'not-offered' };
    } catch {
      return { available: false, reason: 'cloud-unreachable' };
    }
  }

  /** Start a sign-in. The answer's page opens in the owner's browser; `signInToken` comes back to `finish`. */
  async start(
    service: BrokerService,
    { userId, connectionId = null }: { userId: string; connectionId?: string | null },
  ): Promise<BrokerSignInStart> {
    const target = await this.target();
    const state = newMailState();
    const verifier = newPkceVerifier();
    let started;
    try {
      started = await this.deps.frameleafCloudRepository.requestJson(mailSignInStartResponseSchema, {
        method: 'POST',
        url: this.url(target, 'sign-ins'),
        dpop: target.token,
        body: { service, state, codeChallenge: pkceChallenge(verifier), scopes: [...BROKER_SCOPES[service]] },
      });
    } catch (error) {
      throw new RemoteSourceError(
        isUnavailable(error) ? `Frameleaf Cloud does not offer signing in with ${LABELS[service]} yet.` : CLOUD_DOWN,
      );
    }
    const sealed: SealedSignIn = {
      signInId: started.signInId,
      service,
      state,
      verifier,
      connectionId,
      expiresAt: started.expiresAt,
    };
    return {
      authorizationUrl: started.authorizationUrl,
      expiresAt: started.expiresAt,
      signInToken: await sealImportSignIn(this.seal, userId, sealed),
    };
  }

  /**
   * Ask whether the sign-in has finished, and when it has, check the state and exchange the code. The
   * code is handed out once, so of two calls at once only one can come back `ready`.
   */
  async finish(service: BrokerService, userId: string, signInToken: string): Promise<BrokerSignInResult> {
    const pending = await openImportSignIn<SealedSignIn>(this.seal, userId, signInToken);
    if (!pending || pending.service !== service) {
      throw new RemoteSourceError('This sign-in was not started here. Start again.');
    }
    if (Date.parse(pending.expiresAt) <= Date.now()) {
      return { state: 'expired' };
    }
    const target = await this.target();
    let claim;
    try {
      claim = await this.deps.frameleafCloudRepository.requestJson(mailSignInClaimResponseSchema, {
        method: 'POST',
        url: this.url(target, `sign-ins/${encodeURIComponent(pending.signInId)}/claim`),
        dpop: target.token,
      });
    } catch (error) {
      if (isNotFound(error)) {
        return { state: 'expired' };
      }
      throw new RemoteSourceError(CLOUD_DOWN);
    }
    if (claim.status === 'pending') {
      return { state: 'pending' };
    }
    if (claim.state !== pending.state) {
      // Not the answer to the sign-in this server started: the verifier is never sent for it.
      throw new RemoteSourceError('The sign-in answer did not match the one this server started. Start again.');
    }
    if (claim.status === 'denied') {
      return { state: 'denied' };
    }
    let tokens;
    try {
      tokens = await this.deps.frameleafCloudRepository.requestJson(mailTokenResponseSchema, {
        method: 'POST',
        url: this.url(target, 'token'),
        dpop: target.token,
        body: { grant: 'authorization_code', service, code: claim.code, codeVerifier: pending.verifier },
      });
    } catch (error) {
      if (isGrantInvalid(error)) {
        if ((error as FrameleafCloudError).envelope?.detail === 'scope-missing') {
          throw new RemoteSourceError(
            `${LABELS[service]} signed you in, but Frameleaf was not allowed to read your files. Start again and allow it.`,
          );
        }
        return { state: 'expired' };
      }
      throw new RemoteSourceError(CLOUD_DOWN);
    }
    if (!tokens.refreshToken) {
      throw new RemoteSourceError(`${LABELS[service]} did not give this server lasting access. Start again.`);
    }
    return {
      state: 'ready',
      tokens: { ...tokens, refreshToken: tokens.refreshToken },
      connectionId: pending.connectionId,
    };
  }

  /** A new access token. A refused grant is `RemoteSourceAuthError`; anything else can be tried again later. */
  async refresh(service: BrokerService, refreshToken: string, known?: MailBrokerTarget): Promise<MailTokenResponse> {
    const target = known ?? (await this.target());
    try {
      return await this.deps.frameleafCloudRepository.requestJson(mailTokenResponseSchema, {
        method: 'POST',
        url: this.url(target, 'token'),
        dpop: target.token,
        body: { grant: 'refresh_token', service, refreshToken },
      });
    } catch (error) {
      if (isGrantInvalid(error)) {
        throw new RemoteSourceAuthError(`${LABELS[service]} no longer accepts this sign-in. Sign in again.`);
      }
      throw new RemoteSourceUnavailableError(isInstanceRevoked(error) ? LINK_FIRST : CLOUD_DOWN);
    }
  }

  /** Revoke at the provider through Cloud, where the provider allows it. */
  async revoke(service: BrokerService, refreshToken: string): Promise<'revoked' | 'not-supported'> {
    const target = await this.target();
    const { status } = await this.deps.frameleafCloudRepository.requestJson(mailRevokeResponseSchema, {
      method: 'POST',
      url: this.url(target, 'revoke'),
      dpop: target.token,
      body: { service, refreshToken },
    });
    return status;
  }
}

/** A token is not used in its last minute. */
const ACCESS_TOKEN_MARGIN_MS = 60_000;

/**
 * The access token a source reads with: kept in memory, renewed through the broker when it runs out,
 * and a rotated refresh token saved through the connection's `renewCredentials` hook.
 */
export class BrokerAccessToken {
  private token?: string;
  private expiresAt = 0;
  private renewing?: Promise<string>;

  constructor(
    private broker: Pick<ProviderSignInBroker, 'target' | 'refresh'>,
    private service: BrokerService,
    private session: RemoteSourceSession,
    private now: () => number = Date.now,
  ) {}

  /** A usable token. Pass the one that was just refused to get a different one. */
  get(refused?: string): Promise<string> {
    const shared = this.session.accessToken?.read();
    if (shared && shared.expiresAt > this.expiresAt) {
      this.token = shared.token;
      this.expiresAt = shared.expiresAt;
    }
    if (this.token && this.token !== refused && this.expiresAt - ACCESS_TOKEN_MARGIN_MS > this.now()) {
      return Promise.resolve(this.token);
    }
    this.renewing ??= this.renew().finally(() => {
      this.renewing = undefined;
    });
    return this.renewing;
  }

  private async renew(): Promise<string> {
    // Resolved before the row is locked: it takes the identity lock itself.
    const target = await this.broker.target();
    let accessToken: string | undefined;
    let expiresAt = 0;
    try {
      await this.session.renewCredentials(async (current) => {
        if (typeof current.refreshToken !== 'string') {
          throw new RemoteSourceAuthError('The saved sign-in can no longer be read. Sign in again.');
        }
        const answer = await this.broker.refresh(this.service, current.refreshToken, target);
        accessToken = answer.accessToken;
        expiresAt = this.now() + answer.expiresInSec * 1000;
        return answer.refreshToken && answer.refreshToken !== current.refreshToken
          ? { ...current, refreshToken: answer.refreshToken }
          : null;
      });
    } catch (error) {
      // A lock or database failure while renewing says nothing about the file being read.
      throw error instanceof RemoteSourceError ? error : new RemoteSourceUnavailableError(CLOUD_DOWN);
    }
    if (!accessToken) {
      throw new RemoteSourceUnavailableError(CLOUD_DOWN);
    }
    // Set together, once saved: an old token must never be read as good until the new expiry.
    this.token = accessToken;
    this.expiresAt = expiresAt;
    this.session.accessToken?.write({ token: accessToken, expiresAt });
    return accessToken;
  }
}
