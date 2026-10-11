import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { SystemConfig } from 'src/dtos/config.dto.js';
import type { FrameleafMailConnection, FrameleafMailSignIn } from 'src/types.js';
import {
  MailConnectionDto,
  MailConnectionStateDto,
  MailDisconnectResponseDto,
  MailSignInCompleteResponseDto,
  MailSignInStartDto,
  MailSignInStartResponseDto,
} from 'src/dtos/mail-connection.dto.js';
import {
  DatabaseLock,
  MailConnectionStatus,
  MailSignInProvider,
  MailSignInState,
  MailSignInUnavailableReason,
  MailTransportType,
  SystemMetadataKey,
} from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { FrameleafCloudError } from 'src/utils/frameleaf-cloud.js';
import {
  type MailBrokerTarget,
  claimMailSignIn,
  cloudMailProvider,
  isMailGrantInvalid,
  isMailSendNotAllowed,
  isMailSignInNotFound,
  isMailSignInUnavailable,
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
import {
  MAIL_PROVIDER_NAMES,
  MailSignInUnavailableError,
  forgetMailAccessTokens,
  mailBrokerTarget,
  mailSealingKey,
  readMailConnection,
  rememberMailAccessToken,
} from 'src/utils/mail-connection.js';

type SealedSignIn = { state: string; verifier: string };

const TRANSPORT_OF: Record<MailSignInProvider, MailTransportType> = {
  [MailSignInProvider.Gmail]: MailTransportType.Gmail,
  [MailSignInProvider.Microsoft]: MailTransportType.Microsoft,
};

const mapConnection = (connection: FrameleafMailConnection): MailConnectionDto => ({
  provider: connection.provider,
  email: connection.email,
  status: connection.status,
  connectedAt: connection.connectedAt,
  ...(connection.needsSignInSince && { needsSignInSince: connection.needsSignInSince }),
});

const sameText = (a: string, b: string) => {
  const [left, right] = [Buffer.from(a), Buffer.from(b)];
  return left.length === right.length && timingSafeEqual(left, right);
};

/**
 * FL-379: connecting the Gmail or Microsoft account this server sends email from, by signing in.
 *
 * The provider only returns a sign-in to Frameleaf Cloud's public address, so the cloud's broker
 * (FC-160) holds the one-time code until this server asks for it. The server makes the state value
 * and the PKCE verifier, keeps both sealed here, and checks the state before the verifier is ever
 * sent. The cloud adds the client secret for the exchange and keeps nothing; the refresh token is
 * stored here only, sealed, and is never part of any answer or log line.
 */
@Injectable()
export class MailConnectionService extends BaseService {
  /** What the Email delivery page needs: who is connected, and whether signing in is on offer. */
  async getState(): Promise<MailConnectionStateDto> {
    const [connection, pending] = await Promise.all([readMailConnection(this.mailDeps), this.readPending()]);
    const base = {
      connection: connection ? mapConnection(connection) : null,
      signIn: pending ? MailSignInState.Pending : MailSignInState.None,
      ...(pending && { signInProvider: pending.provider }),
    };
    try {
      const target = await mailBrokerTarget(this.mailDeps);
      const providers = await readMailProviders(this.frameleafCloudRepository, target);
      return { ...base, available: providers.length > 0, providers };
    } catch (error) {
      if (error instanceof MailSignInUnavailableError) {
        return { ...base, available: false, unavailableReason: error.reason, providers: [] };
      }
      if (error instanceof FrameleafCloudError) {
        this.logger.warn(`Could not ask Frameleaf Cloud which mail sign-ins it offers: ${error.message}`);
        return {
          ...base,
          available: false,
          unavailableReason: MailSignInUnavailableReason.CloudUnreachable,
          providers: [],
        };
      }
      throw error;
    }
  }

  /** Start a sign-in: the answer is the provider's page to open in the administrator's browser. */
  async start(auth: AuthDto, dto: MailSignInStartDto): Promise<MailSignInStartResponseDto> {
    const target = await this.target();
    const sealed: SealedSignIn = { state: newMailState(), verifier: newPkceVerifier() };
    let started;
    try {
      started = await startMailSignIn(this.frameleafCloudRepository, target, {
        service: cloudMailProvider(dto.provider),
        state: sealed.state,
        codeChallenge: pkceChallenge(sealed.verifier),
      });
    } catch (error) {
      if (isMailSignInUnavailable(error)) {
        throw new BadRequestException(
          `Frameleaf Cloud does not offer signing in with ${MAIL_PROVIDER_NAMES[dto.provider]} yet`,
        );
      }
      throw this.cloudFailure(error, 'start signing in');
    }
    const key = await mailSealingKey(this.mailDeps);
    // one sign-in at a time: a new one replaces any that was waiting, whose code is then never asked for
    await this.systemMetadataRepository.set(SystemMetadataKey.FrameleafMailSignIn, {
      signInId: started.signInId,
      provider: dto.provider,
      userId: auth.user.id,
      sealed: sealMailSecret(key, started.signInId, sealed),
      expiresAt: started.expiresAt,
    });
    return { authorizationUrl: started.authorizationUrl, expiresAt: started.expiresAt };
  }

  /**
   * Ask whether the sign-in in progress has finished, and finish it when it has: claim the code,
   * check the state, exchange the code and keep the account. Called by the page while it waits.
   */
  async complete(auth: AuthDto): Promise<MailSignInCompleteResponseDto> {
    if (!(await this.readPending())) {
      return this.noSignIn();
    }
    const target = await this.target();
    const key = await mailSealingKey(this.mailDeps);
    // one worker finishes a sign-in: the code is handed out once
    let connected: MailSignInProvider | undefined;
    const result = await this.databaseRepository.withLock(DatabaseLock.FrameleafMailConnection, () =>
      this.finish(target, key, (provider) => (connected = provider)),
    );
    // only the request that connected the account changes the settings, and outside the lock
    if (connected) {
      await this.useTransport(auth, TRANSPORT_OF[connected], true);
    }
    return result;
  }

  /** Stop sending from the connected account: revoke at the provider where it can be, and forget the token. */
  async disconnect(auth: AuthDto): Promise<MailDisconnectResponseDto> {
    const connection = await readMailConnection(this.mailDeps);
    if (!connection) {
      throw new BadRequestException('No mail account is connected');
    }
    const revoked = await this.revoke(connection);
    await this.databaseRepository.withLock(DatabaseLock.FrameleafMailConnection, async () => {
      await this.systemMetadataRepository.delete(SystemMetadataKey.FrameleafMailConnection);
      await this.systemMetadataRepository.delete(SystemMetadataKey.FrameleafMailSignIn);
    });
    forgetMailAccessTokens();
    // nothing is sent until another way of sending is set up and switched on
    await this.useTransport(auth, MailTransportType.Smtp, false);
    return { provider: connection.provider, revoked };
  }

  private async finish(
    target: MailBrokerTarget,
    key: Buffer,
    onConnected: (provider: MailSignInProvider) => void,
  ): Promise<MailSignInCompleteResponseDto> {
    const pending = await this.readPending();
    if (!pending) {
      // another request finished it while this one waited
      return this.noSignIn();
    }
    const forget = () => this.systemMetadataRepository.delete(SystemMetadataKey.FrameleafMailSignIn);
    const ended = async (state: MailSignInState): Promise<MailSignInCompleteResponseDto> => {
      await forget();
      return { state, connection: null };
    };

    let claim;
    try {
      claim = await claimMailSignIn(this.frameleafCloudRepository, target, pending.signInId);
    } catch (error) {
      if (isMailSignInNotFound(error)) {
        // too late, already used, or not started by this server: the cloud does not say which
        return ended(MailSignInState.Expired);
      }
      throw this.cloudFailure(error, 'finish signing in');
    }
    if (claim.status === 'pending') {
      return { state: MailSignInState.Pending, connection: null };
    }

    const secret = openMailSecret<SealedSignIn>(key, pending.signInId, pending.sealed);
    if (!secret || !sameText(secret.state, claim.state)) {
      // not the answer to the sign-in this server started: the verifier is never sent for it
      await forget();
      this.logger.warn('A mail sign-in answer did not carry the state this server created; it was discarded');
      throw new BadRequestException('The sign-in answer did not match the one this server started. Start again.');
    }
    if (claim.status === 'denied') {
      return ended(MailSignInState.Denied);
    }

    // the code is spent whatever happens next
    await forget();
    let tokens;
    try {
      tokens = await requestMailToken(this.frameleafCloudRepository, target, {
        grant: 'authorization_code',
        service: cloudMailProvider(pending.provider),
        code: claim.code,
        codeVerifier: secret.verifier,
      });
    } catch (error) {
      if (isMailSendNotAllowed(error)) {
        // the person signed in but left "send email" unticked (Google lets them)
        throw new BadRequestException(
          `${MAIL_PROVIDER_NAMES[pending.provider]} signed you in, but Frameleaf was not allowed to send email. Start again and allow Frameleaf to send email.`,
        );
      }
      if (isMailGrantInvalid(error)) {
        return { state: MailSignInState.Expired, connection: null };
      }
      throw this.cloudFailure(error, 'finish signing in');
    }
    if (!tokens.refreshToken) {
      throw new ServiceUnavailableException(
        `${MAIL_PROVIDER_NAMES[pending.provider]} did not give this server lasting access. Start again.`,
      );
    }
    const email =
      tokens.email ??
      (pending.provider === MailSignInProvider.Microsoft
        ? await this.emailRepository.readMicrosoftAddress(tokens.accessToken)
        : undefined);
    if (!email) {
      throw new ServiceUnavailableException(
        `${MAIL_PROVIDER_NAMES[pending.provider]} did not say which address signed in. Start again.`,
      );
    }

    const previous = await readMailConnection(this.mailDeps);
    const id = this.cryptoRepository.randomUUID();
    const connection: FrameleafMailConnection = {
      id,
      provider: pending.provider,
      email,
      status: MailConnectionStatus.Connected,
      sealedRefreshToken: sealMailSecret(key, id, tokens.refreshToken),
      connectedAt: new Date().toISOString(),
    };
    await this.systemMetadataRepository.set(SystemMetadataKey.FrameleafMailConnection, connection);
    forgetMailAccessTokens();
    rememberMailAccessToken(id, tokens.accessToken, tokens.expiresInSec);
    if (previous) {
      // the account this one replaces no longer needs access; a failure here changes nothing
      await this.revoke(previous, { target, key });
    }
    onConnected(connection.provider);
    return { state: MailSignInState.Connected, connection: mapConnection(connection) };
  }

  /** Revoke a connection's refresh token at the provider through the cloud. Never throws. */
  private async revoke(
    connection: FrameleafMailConnection,
    known?: { target: MailBrokerTarget; key: Buffer },
  ): Promise<boolean> {
    try {
      const key = known?.key ?? (await mailSealingKey(this.mailDeps));
      const refreshToken = openMailSecret<string>(key, connection.id, connection.sealedRefreshToken);
      if (!refreshToken) {
        return false;
      }
      const target = known?.target ?? (await mailBrokerTarget(this.mailDeps));
      const { status } = await revokeMailToken(this.frameleafCloudRepository, target, {
        service: cloudMailProvider(connection.provider),
        refreshToken,
      });
      return status === 'revoked';
    } catch (error) {
      // the token is forgotten here either way; the administrator can remove access at the provider
      this.logger.warn(
        `Could not revoke ${MAIL_PROVIDER_NAMES[connection.provider]} access at the provider: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  /**
   * Point email delivery at `type` and switch sending on or off, as its own entry in the settings
   * change history. A server whose settings come from a configuration file is left as it is: the
   * file decides, and the account stays connected for it to use.
   */
  private async useTransport(auth: AuthDto, type: MailTransportType, enabled: boolean) {
    if (this.configRepository.getEnv().configFile) {
      return;
    }
    const title =
      type === MailTransportType.Smtp
        ? 'Disconnected the email account'
        : `Connected ${type === MailTransportType.Gmail ? 'Gmail' : 'Microsoft'} for email`;
    const result = (await this.updateConfigExclusively((config) => {
      config.notifications.smtp.transport.type = type;
      config.notifications.smtp.enabled = enabled;
    })) as { oldConfig: SystemConfig; newConfig: SystemConfig };
    await this.recordConfigChange(result.oldConfig, result.newConfig, auth, { kind: 'settings', title });
    await this.eventRepository.emit('ConfigUpdate', { newConfig: result.newConfig, oldConfig: result.oldConfig });
  }

  private async readPending(): Promise<FrameleafMailSignIn | null> {
    const pending = await this.systemMetadataRepository.get(SystemMetadataKey.FrameleafMailSignIn);
    if (!pending) {
      return null;
    }
    if (Date.parse(pending.expiresAt) <= Date.now()) {
      await this.systemMetadataRepository.delete(SystemMetadataKey.FrameleafMailSignIn);
      return null;
    }
    return pending;
  }

  /** No sign-in is waiting: say so, with the account when one is connected (a finish in another tab). */
  private async noSignIn(): Promise<MailSignInCompleteResponseDto> {
    const connection = await readMailConnection(this.mailDeps);
    return connection?.status === MailConnectionStatus.Connected
      ? { state: MailSignInState.Connected, connection: mapConnection(connection) }
      : { state: MailSignInState.None, connection: null };
  }

  private async target(): Promise<MailBrokerTarget> {
    try {
      return await mailBrokerTarget(this.mailDeps);
    } catch (error) {
      if (error instanceof MailSignInUnavailableError) {
        throw new BadRequestException(error.message);
      }
      throw this.cloudFailure(error, 'reach Frameleaf Cloud');
    }
  }

  /** A failed cloud call as an answer an administrator can read; anything else is passed on as it is. */
  private cloudFailure(error: unknown, doing: string): unknown {
    return error instanceof FrameleafCloudError
      ? new ServiceUnavailableException(`Could not ${doing}: ${error.message}`, { cause: error })
      : error;
  }
}
