import { HttpException, HttpStatus, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { UserAdmin } from 'src/database.js';
import type { LoginDetails } from 'src/services/auth.service.js';
import { mapNotification } from 'src/dtos/notification.dto.js';
import { FrameleafEnvironment, JobName, NotificationLevel, NotificationType } from 'src/enum.js';
import { RATE_LIMITED_MESSAGE, rateLimitAddress } from 'src/middleware/rate-limit.guard.js';
import { EmailTemplate } from 'src/repositories/email.repository.js';
import { RateLimitRepository, type SignInAttempt } from 'src/repositories/rate-limit.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { identityDirectory } from 'src/utils/frameleaf-cloud-gateway.js';
import { isHomeAddress, isRemoteVia } from 'src/utils/frameleaf-sign-in.js';
import { getPreferences } from 'src/utils/preferences.js';
import { SIGN_IN_SECURITY_URL, signInNetwork } from 'src/utils/sign-in-security.js';

type BackoffKind = 'password' | 'two-factor' | 'passkey' | 'shared-link';
type AlertUser = Pick<UserAdmin, 'id' | 'email' | 'metadata'>;
const SIGN_IN_FAILURE_TITLE = 'Someone tried to sign in to your account';
const SIGN_IN_FAILURE_DESCRIPTION =
  'There were repeated unsuccessful sign-in attempts. If they weren’t yours, review your signed-in devices and change your password.';
const NEW_SIGN_IN_TITLE = 'New sign-in to your Frameleaf Library';

@Injectable()
export class SignInSecurityService extends BaseService {
  @Inject(RateLimitRepository)
  private counters!: RateLimitRepository;

  async attempt<T>(
    kind: BackoffKind,
    principal: string,
    details: LoginDetails | undefined,
    verify: (attempt?: SignInAttempt) => Promise<T>,
  ): Promise<T> {
    const attempt = details && (await this.check(kind, principal, details));
    try {
      return await verify(attempt);
    } finally {
      await attempt?.release();
    }
  }

  private async check(kind: BackoffKind, principal: string, details: LoginDetails): Promise<SignInAttempt | undefined> {
    if (this.configRepository.getEnv().environment === FrameleafEnvironment.Testing) return;

    let attempt: SignInAttempt | undefined;
    let wait: number;
    try {
      const hash = await this.key(
        'sign-in-backoff',
        JSON.stringify([kind, principal, rateLimitAddress(details.securityClientIp ?? details.clientIp)]),
      );
      attempt = await this.counters.acquireSignInAttempt(`sign-in-backoff:${hash}`);
      wait = attempt ? await attempt.getWait() : 1;
    } catch {
      await attempt?.release();
      this.logger.warn('Sign-in backoff counters are unavailable');
      if (isRemoteVia(details.via))
        throw new ServiceUnavailableException('This server is busy. Try again in a moment.');
      return;
    }
    if (wait > 0) {
      await attempt?.release();
      throw new HttpException(
        {
          message: RATE_LIMITED_MESSAGE,
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          code: 'rate_limited',
          retryAfter: wait,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return attempt;
  }

  async failed(attempt?: SignInAttempt, user?: AlertUser): Promise<void> {
    if (!attempt) return;
    await attempt.recordFailure().catch(() => this.logger.warn('Could not record sign-in backoff'));
    if (user) {
      // Finish before responding only for address-scoped backoff. Account-specific notices must not reveal
      // that the email exists through different response timing.
      void this.failedAccount(user).catch(() => this.logger.warn('Could not send repeated sign-in failure notice'));
    }
  }

  async succeeded(attempt?: SignInAttempt): Promise<void> {
    if (attempt) {
      await attempt.clearFailures().catch(() => this.logger.warn('Could not clear sign-in backoff'));
    }
  }

  async signedIn(user: AlertUser, details: LoginDetails): Promise<void> {
    try {
      const { environment, frameleafCloud } = this.configRepository.getEnv();
      if (environment === FrameleafEnvironment.Testing) return;
      const clientIp = details.securityClientIp ?? details.clientIp;
      const network = signInNetwork(clientIp);
      if (!network) return;
      const fingerprint = await this.key(
        'sign-in-device',
        JSON.stringify([
          details.deviceType.slice(0, 128),
          details.deviceOS.slice(0, 128),
          details.browserFamily ?? '',
          network,
        ]),
      );
      await this.sessionRepository.observeKnownDevice(user.id, Buffer.from(fingerprint, 'base64url'), async () => {
        const home = !isRemoteVia(details.via) && isHomeAddress(clientIp, frameleafCloud.trustedLanCidrs);
        // Browser and OS families come from the UA parser, not the arbitrary device request headers.
        const device = [details.browserFamily, details.deviceOSFamily].filter(Boolean).join(' on ') || 'Unknown device';
        const alert = await this.prepareAlert(user, {
          kind: 'new-device',
          device,
          place: home ? 'Home network' : 'Away',
          time: new Date().toISOString(),
        });
        return alert ? (db) => this.jobRepository.queueInTransaction(db, alert) : undefined;
      });
    } catch {
      this.logger.warn('Could not record or notify a new sign-in');
    }
  }

  private async failedAccount(user: AlertUser) {
    const hash = await this.key('sign-in-burst', user.id);
    if (!(await this.counters.recordSignInBurst(`sign-in-burst:${hash}`))) return;
    await Promise.all([
      this.publishBurstNotification(user, `sign-in-notice:in-app:${hash}`),
      this.publishBurstEmail(user, `sign-in-notice:email:${hash}`),
    ]);
  }

  private async publishBurstNotification(user: AlertUser, key: string) {
    const notice = await this.databaseRepository.publishSignInNotice(key, (db) =>
      this.notificationRepository.create(
        {
          userId: user.id,
          type: NotificationType.Custom,
          level: NotificationLevel.Warning,
          title: SIGN_IN_FAILURE_TITLE,
          description: SIGN_IN_FAILURE_DESCRIPTION,
          data: { link: SIGN_IN_SECURITY_URL },
        },
        db,
      ),
    );
    if (notice) this.websocketRepository.clientSend('on_notification', user.id, mapNotification(notice));
  }

  private async publishBurstEmail(user: AlertUser, key: string) {
    if (await this.databaseRepository.hasSignInNotice(key)) return;
    const alert = await this.prepareAlert(user, { kind: 'attempts' });
    await this.databaseRepository.publishSignInNotice(key, async (db) => {
      if (alert) await this.jobRepository.queueInTransaction(db, alert);
    });
  }

  private async prepareAlert(
    user: AlertUser,
    data: { kind: 'attempts' } | { kind: 'new-device'; device: string; place: string; time: string },
  ) {
    const preferences = getPreferences(user.metadata).emailNotifications;
    if (!preferences.enabled || (data.kind === 'new-device' && !preferences.newSignIn)) return;
    const { notifications, server, templates } = await this.getConfig({ withCache: false });
    if (!notifications.smtp.enabled) return;
    const baseUrl = await this.getPublicUrl(server);
    const { html, text } = await this.emailRepository.renderEmail({
      template: EmailTemplate.NEW_SIGN_IN,
      data: {
        ...data,
        baseUrl,
        showBranding: templates.email.showBranding,
      },
    });
    return {
      name: JobName.SendMail as const,
      data: {
        to: user.email,
        subject: data.kind === 'new-device' ? NEW_SIGN_IN_TITLE : SIGN_IN_FAILURE_TITLE,
        html,
        text,
      },
    };
  }

  private key(purpose: string, value: string) {
    return this.cryptoRepository.serverKeyedHash(identityDirectory(this.configRepository), purpose, value);
  }
}
