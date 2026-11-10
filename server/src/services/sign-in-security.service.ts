import { HttpException, HttpStatus, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { UserAdmin } from 'src/database.js';
import type { LoginDetails } from 'src/services/auth.service.js';
import { mapNotification } from 'src/dtos/notification.dto.js';
import { FrameleafEnvironment, JobName, NotificationLevel, NotificationType } from 'src/enum.js';
import { RATE_LIMITED_MESSAGE, rateLimitAddress } from 'src/middleware/rate-limit.guard.js';
import { EmailTemplate } from 'src/repositories/email.repository.js';
import { RateLimitRepository } from 'src/repositories/rate-limit.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { identityDirectory } from 'src/utils/frameleaf-cloud-gateway.js';
import { isHomeAddress, isRemoteVia } from 'src/utils/frameleaf-sign-in.js';
import { getPreferences } from 'src/utils/preferences.js';
import { SIGN_IN_SECURITY_URL, signInNetwork } from 'src/utils/sign-in-security.js';

type BackoffKind = 'password' | 'two-factor' | 'shared-link';
type AlertUser = Pick<UserAdmin, 'id' | 'email' | 'metadata'>;
const SIGN_IN_FAILURE_TITLE = 'Someone tried to sign in to your account';
const SIGN_IN_FAILURE_DESCRIPTION =
  'There were repeated unsuccessful sign-in attempts. If they weren’t yours, review your signed-in devices and change your password.';
const NEW_SIGN_IN_TITLE = 'New sign-in to your Frameleaf Library';

@Injectable()
export class SignInSecurityService extends BaseService {
  @Inject(RateLimitRepository)
  private counters!: RateLimitRepository;

  async check(kind: BackoffKind, principal: string, details: LoginDetails): Promise<string | undefined> {
    if (this.configRepository.getEnv().environment === FrameleafEnvironment.Testing) return;

    let key: string;
    let wait: number;
    try {
      const hash = await this.key(
        'sign-in-backoff',
        JSON.stringify([kind, principal, rateLimitAddress(details.securityClientIp ?? details.clientIp)]),
      );
      key = `sign-in-backoff:${hash}`;
      wait = await this.counters.getSignInWait(key);
    } catch {
      this.logger.warn('Sign-in backoff counters are unavailable');
      if (isRemoteVia(details.via))
        throw new ServiceUnavailableException('This server is busy. Try again in a moment.');
      return;
    }
    if (wait > 0) {
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
    return key;
  }

  async failed(key?: string, user?: AlertUser): Promise<void> {
    if (!key) return;
    await this.counters.recordSignInFailure(key).catch(() => this.logger.warn('Could not record sign-in backoff'));
    if (user) {
      // Finish before responding only for address-scoped backoff. Account-specific notices must not reveal
      // that the email exists through different response timing.
      void this.failedAccount(user).catch(() => this.logger.warn('Could not send repeated sign-in failure notice'));
    }
  }

  async succeeded(key?: string): Promise<void> {
    if (key)
      await this.counters.clearSignInFailures(key).catch(() => this.logger.warn('Could not clear sign-in backoff'));
  }

  async signedIn(user: AlertUser, details: LoginDetails): Promise<void> {
    const { environment, frameleafCloud } = this.configRepository.getEnv();
    if (environment === FrameleafEnvironment.Testing) return;
    try {
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
      if (!(await this.sessionRepository.observeKnownDevice(user.id, Buffer.from(fingerprint, 'base64url')))) return;

      const home = !isRemoteVia(details.via) && isHomeAddress(clientIp, frameleafCloud.trustedLanCidrs);
      // Browser and OS families come from the UA parser, not the arbitrary device request headers.
      const device = [details.browserFamily, details.deviceOSFamily].filter(Boolean).join(' on ') || 'Unknown device';
      await this.sendAlert(user, {
        kind: 'new-device',
        device,
        place: home ? 'Home network' : 'Away',
        time: new Date().toISOString(),
      });
    } catch {
      this.logger.warn('Could not record or notify a new sign-in');
    }
  }

  private async failedAccount(user: AlertUser) {
    const hash = await this.key('sign-in-burst', user.id);
    if (!(await this.counters.recordSignInBurst(`sign-in-burst:${hash}`))) return;
    if ((await this.counters.hit(`sign-in-notice:${hash}`, 24 * 60 * 60)).count !== 1) return;
    const notice = await this.notificationRepository.create({
      userId: user.id,
      type: NotificationType.Custom,
      level: NotificationLevel.Warning,
      title: SIGN_IN_FAILURE_TITLE,
      description: SIGN_IN_FAILURE_DESCRIPTION,
      data: { link: SIGN_IN_SECURITY_URL },
    });
    this.websocketRepository.clientSend('on_notification', user.id, mapNotification(notice));
    await this.sendAlert(user, { kind: 'attempts' });
  }

  private async sendAlert(
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
    await this.jobRepository.queue({
      name: JobName.SendMail,
      data: {
        to: user.email,
        subject: data.kind === 'new-device' ? NEW_SIGN_IN_TITLE : SIGN_IN_FAILURE_TITLE,
        html,
        text,
      },
    });
  }

  private key(purpose: string, value: string) {
    return this.cryptoRepository.serverKeyedHash(identityDirectory(this.configRepository), purpose, value);
  }
}
