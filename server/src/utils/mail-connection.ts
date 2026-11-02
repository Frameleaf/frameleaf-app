import type { CryptoRepository } from 'src/repositories/crypto.repository.js';
import type { EmailRepository, SendEmailOptions, SendEmailResponse } from 'src/repositories/email.repository.js';
import type { EventRepository } from 'src/repositories/event.repository.js';
import type { LoggingRepository } from 'src/repositories/logging.repository.js';
import type { FrameleafMailConnection } from 'src/types.js';
import type { SystemNotificationTemplate } from 'src/utils/notification-locale.js';
import {
  DatabaseLock,
  MailConnectionStatus,
  MailSignInProvider,
  MailSignInUnavailableReason,
  MailTransportType,
  NotificationLevel,
  NotificationType,
  SystemMetadataKey,
} from 'src/enum.js';
import { MailApiError } from 'src/repositories/email.repository.js';
import {
  type CloudGatewayDeps,
  identityDirectory,
  loadInstanceIdentity,
  readCloudLink,
} from 'src/utils/frameleaf-cloud-gateway.js';
import {
  MAIL_SEAL_KEY_NAME,
  MAIL_SEAL_PURPOSE,
  type MailBrokerTarget,
  cloudMailProvider,
  connectedSender,
  isMailGrantInvalid,
  mailSealKey,
  openMailSecret,
  requestMailToken,
  sealMailSecret,
} from 'src/utils/frameleaf-mail.js';

/**
 * FL-379: the connected mail account as the rest of the server uses it: where the broker is, the
 * sealing key, a current access token (renewed through Frameleaf Cloud when it ran out), and the one
 * send path for Gmail and Microsoft. Used by the mail job, the test email and the connection
 * endpoints, so all three treat a refused renewal the same way.
 */
export type MailConnectionDeps = CloudGatewayDeps & {
  cryptoRepository: Pick<CryptoRepository, 'serverKeyedHash'>;
  emailRepository: Pick<EmailRepository, 'sendEmailWithAccount'>;
  eventRepository: Pick<EventRepository, 'emit'>;
  logger: Pick<LoggingRepository, 'warn'>;
};

export const MAIL_PROVIDER_NAMES: Record<MailSignInProvider, string> = {
  [MailSignInProvider.Gmail]: 'Gmail',
  [MailSignInProvider.Microsoft]: 'Microsoft',
};

/** The sign-in provider a transport type sends through, or null for a mail server entered by hand. */
export const signInProviderOf = (type: MailTransportType | undefined): MailSignInProvider | null => {
  switch (type) {
    case MailTransportType.Gmail: {
      return MailSignInProvider.Gmail;
    }
    case MailTransportType.Microsoft: {
      return MailSignInProvider.Microsoft;
    }
    default: {
      return null;
    }
  }
};

/** One-click sign-in cannot be used from this server right now. */
export class MailSignInUnavailableError extends Error {
  constructor(
    readonly reason: MailSignInUnavailableReason,
    message: string,
  ) {
    super(message);
    this.name = 'MailSignInUnavailableError';
  }
}

/** Email is set to go through a provider no account is connected for. */
export class MailAccountNotConnectedError extends Error {
  constructor(readonly provider: MailSignInProvider) {
    super(
      `This server is set to send email through ${MAIL_PROVIDER_NAMES[provider]}, but no ${MAIL_PROVIDER_NAMES[provider]} account is connected. Sign in under Notifications > Email delivery first.`,
    );
    this.name = 'MailAccountNotConnectedError';
  }
}

/** The provider refused to renew access: the administrator has to sign in again. */
export class MailNeedsSignInError extends Error {
  constructor(readonly provider: MailSignInProvider) {
    super(
      `${MAIL_PROVIDER_NAMES[provider]} is asking you to sign in again. Email is not sent until an administrator signs in again under Notifications > Email delivery.`,
    );
    this.name = 'MailNeedsSignInError';
  }
}

/** What administrators are told, once a day at most, when the provider refuses to renew access. */
export const mailNeedsSignInNotice = (provider: MailSignInProvider) => ({
  type: NotificationType.SystemMessage,
  level: NotificationLevel.Error,
  title: `Email stopped: sign in to ${MAIL_PROVIDER_NAMES[provider]} again`,
  description: `${MAIL_PROVIDER_NAMES[provider]} is asking you to sign in again, because the account’s password changed or Frameleaf’s access was removed. Emails are not sent until you do; invitations and album updates appear in the app only. Open Settings > Notifications > Email delivery and choose Sign in again.`,
  systemTemplate: {
    version: 1,
    key: 'mail-needs-sign-in',
    args: { provider: MAIL_PROVIDER_NAMES[provider] },
  } satisfies SystemNotificationTemplate,
  dedupeKey: 'frameleaf-mail:needs-sign-in',
  dedupeDays: 1,
});

/** Access tokens by connection id, kept in this process only and never stored. */
const accessTokens = new Map<string, { accessToken: string; expiresAt: number }>();
/** A token is not used in its last minute. */
const ACCESS_TOKEN_MARGIN_MS = 60_000;

/** Forget cached access tokens (a disconnect, a new connection, and specs). */
export const forgetMailAccessTokens = () => accessTokens.clear();

/** The key the refresh token and a pending sign-in are sealed with, from the server's own secret file. */
export const mailSealingKey = async (deps: Pick<MailConnectionDeps, 'cryptoRepository' | 'configRepository'>) =>
  mailSealKey(
    await deps.cryptoRepository.serverKeyedHash(
      identityDirectory(deps.configRepository),
      MAIL_SEAL_PURPOSE,
      MAIL_SEAL_KEY_NAME,
    ),
  );

/**
 * Where the mail broker is and an instance token for it. Only a server linked to a Frameleaf Cloud
 * account gets one (a free account is enough); nothing is contacted otherwise.
 */
export const mailBrokerTarget = async (deps: CloudGatewayDeps): Promise<MailBrokerTarget> => {
  const { cloudUrl, link, linked } = await readCloudLink(deps);
  if (!cloudUrl) {
    throw new MailSignInUnavailableError(
      MailSignInUnavailableReason.NotConfigured,
      'Frameleaf Cloud is not configured on this server',
    );
  }
  if (!linked || !link?.instanceId) {
    throw new MailSignInUnavailableError(
      MailSignInUnavailableReason.NotLinked,
      'Signing in with a mail account needs this server to be linked to a Frameleaf account',
    );
  }
  const document = await deps.frameleafCloudRepository.discovery(cloudUrl);
  await loadInstanceIdentity(deps);
  const api = document.api.replace(/\/+$/, '');
  const token = await deps.frameleafCloudRepository.accessToken(
    document,
    link.instanceId,
    api,
    deps.instanceIdentityRepository.currentSigner(),
  );
  return { api, token };
};

export const readMailConnection = (deps: Pick<MailConnectionDeps, 'systemMetadataRepository'>) =>
  deps.systemMetadataRepository.get(SystemMetadataKey.FrameleafMailConnection);

/**
 * Record that the provider refused to renew access and tell the administrators. The connection is
 * kept (its address is shown beside "Sign in again"); nothing is sent through it until a new sign-in.
 */
const markNeedsSignIn = async (deps: MailConnectionDeps, connection: FrameleafMailConnection) => {
  accessTokens.delete(connection.id);
  await deps.systemMetadataRepository.set(SystemMetadataKey.FrameleafMailConnection, {
    ...connection,
    status: MailConnectionStatus.NeedsSignIn,
    needsSignInSince: new Date().toISOString(),
  });
  try {
    await deps.eventRepository.emit('AdminNotify', mailNeedsSignInNotice(connection.provider));
  } catch (error) {
    deps.logger.warn(`Could not notify administrators that email needs a new sign-in: ${error}`);
  }
};

/**
 * A current access token for the connected account of `provider`. A cached one is used until its
 * last minute; otherwise the refresh token is opened and renewed through Frameleaf Cloud, one worker
 * at a time. Only the cloud's `mail-grant-invalid` (the provider's `invalid_grant`) marks the
 * connection as needing sign-in; an unreachable cloud or provider is an ordinary failure to retry.
 */
export const mailAccessToken = async (
  deps: MailConnectionDeps,
  provider: MailSignInProvider,
  { force = false, now = Date.now() }: { force?: boolean; now?: number } = {},
): Promise<string> => {
  const usable = (connection: FrameleafMailConnection | null): FrameleafMailConnection => {
    if (!connection || connection.provider !== provider) {
      throw new MailAccountNotConnectedError(provider);
    }
    if (connection.status === MailConnectionStatus.NeedsSignIn) {
      throw new MailNeedsSignInError(provider);
    }
    return connection;
  };
  const cachedFor = ({ id }: FrameleafMailConnection) => {
    const cached = accessTokens.get(id);
    return cached && cached.expiresAt - ACCESS_TOKEN_MARGIN_MS > now ? cached.accessToken : null;
  };

  const seen = usable(await readMailConnection(deps));
  if (!force) {
    const cached = cachedFor(seen);
    if (cached) {
      return cached;
    }
  }

  // resolved before the lock: it takes the identity lock itself
  const target = await mailBrokerTarget(deps);
  const key = await mailSealingKey(deps);
  return deps.databaseRepository.withLock(DatabaseLock.FrameleafMailConnection, async () => {
    const connection = usable(await readMailConnection(deps));
    if (!force) {
      // another request renewed it while this one waited
      const cached = cachedFor(connection);
      if (cached) {
        return cached;
      }
    }
    const refreshToken = openMailSecret<string>(key, connection.id, connection.sealedRefreshToken);
    if (!refreshToken) {
      // sealed with another server's secret file (a restored database on a new identity folder)
      await markNeedsSignIn(deps, connection);
      throw new MailNeedsSignInError(provider);
    }
    let answer;
    try {
      answer = await requestMailToken(deps.frameleafCloudRepository, target, {
        grant: 'refresh_token',
        service: cloudMailProvider(provider),
        refreshToken,
      });
    } catch (error) {
      if (isMailGrantInvalid(error)) {
        await markNeedsSignIn(deps, connection);
        throw new MailNeedsSignInError(provider);
      }
      throw error;
    }
    if (answer.refreshToken && answer.refreshToken !== refreshToken) {
      // the provider rotated it (Microsoft does): the old one stops working
      await deps.systemMetadataRepository.set(SystemMetadataKey.FrameleafMailConnection, {
        ...connection,
        sealedRefreshToken: sealMailSecret(key, connection.id, answer.refreshToken),
      });
    }
    accessTokens.set(connection.id, {
      accessToken: answer.accessToken,
      expiresAt: now + answer.expiresInSec * 1000,
    });
    return answer.accessToken;
  });
};

/** Keep an access token the sign-in itself returned, so the first send needs no renewal. */
export const rememberMailAccessToken = (id: string, accessToken: string, expiresInSec: number, now = Date.now()) =>
  accessTokens.set(id, { accessToken, expiresAt: now + expiresInSec * 1000 });

/**
 * Send one email through the connected account. An access token the provider no longer accepts
 * (401) is renewed once and the send repeated; every other failure is the caller's to report, so
 * mail is never dropped without an error.
 */
export const sendConnectedEmail = async (
  deps: MailConnectionDeps,
  provider: MailSignInProvider,
  message: Omit<SendEmailOptions, 'smtp'>,
): Promise<SendEmailResponse> => {
  const connection = await readMailConnection(deps);
  const from = connection?.provider === provider ? connectedSender(message.from, connection.email) : message.from;
  const send = async (force: boolean) =>
    deps.emailRepository.sendEmailWithAccount({
      ...message,
      from,
      account: { provider, accessToken: await mailAccessToken(deps, provider, { force }) },
    });
  try {
    return await send(false);
  } catch (error) {
    if (error instanceof MailApiError && error.status === 401) {
      return send(true);
    }
    throw error;
  }
};
