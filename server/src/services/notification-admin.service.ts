import { BadRequestException, Injectable } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { SystemConfigSmtpDto } from 'src/dtos/config.dto.js';
import { NotificationCreateDto, mapNotification } from 'src/dtos/notification.dto.js';
import { NotificationLevel, NotificationType } from 'src/enum.js';
import { EmailTemplate, MailApiError } from 'src/repositories/email.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { FrameleafCloudError } from 'src/utils/frameleaf-cloud.js';
import {
  MailAccountNotConnectedError,
  MailNeedsSignInError,
  MailSignInUnavailableError,
  sendConnectedEmail,
  signInProviderOf,
} from 'src/utils/mail-connection.js';

@Injectable()
export class NotificationAdminService extends BaseService {
  async create(auth: AuthDto, dto: NotificationCreateDto) {
    const item = await this.notificationRepository.create({
      userId: dto.userId,
      type: dto.type ?? NotificationType.Custom,
      level: dto.level ?? NotificationLevel.Info,
      title: dto.title,
      description: dto.description,
      data: dto.data,
    });

    return mapNotification(item);
  }

  async sendTestEmail(id: string, dto: SystemConfigSmtpDto, tempTemplate?: string) {
    const user = await this.userRepository.get(id, { withDeleted: false });
    if (!user) {
      throw new Error('User not found');
    }

    // FL-379: a connected Gmail or Microsoft account is tested by sending through it; there is no
    // mail server to verify, and a refused renewal answers with the "sign in again" reason
    const provider = signInProviderOf(dto.transport.type);
    const transport = provider ? dto.transport : await this.withStoredSmtpPassword(dto.transport);

    if (!provider) {
      try {
        await this.emailRepository.verifySmtp(transport);
      } catch (error) {
        throw new BadRequestException('Failed to verify SMTP configuration', { cause: error });
      }
    }

    const { server } = await this.getConfig({ withCache: false });
    const { html, text } = await this.emailRepository.renderEmail({
      template: EmailTemplate.TEST_EMAIL,
      data: {
        baseUrl: await this.getPublicUrl(server),
        displayName: user.name,
      },
      customTemplate: tempTemplate!,
    });
    const message = {
      to: user.email,
      subject: 'Test email from Frameleaf',
      html,
      text,
      from: dto.from,
      replyTo: dto.replyTo || dto.from,
    };
    if (!provider) {
      const { messageId } = await this.emailRepository.sendEmail({ ...message, smtp: transport });
      return { messageId };
    }

    try {
      const { messageId } = await sendConnectedEmail(this.mailDeps, provider, message);
      return { messageId };
    } catch (error) {
      if (
        error instanceof MailNeedsSignInError ||
        error instanceof MailAccountNotConnectedError ||
        error instanceof MailSignInUnavailableError ||
        error instanceof MailApiError ||
        error instanceof FrameleafCloudError
      ) {
        // each of these carries a reason an administrator can act on, and never a token
        throw new BadRequestException(error.message, { cause: error });
      }
      throw error;
    }
  }

  /**
   * FL-67: the SMTP password is write-only, so the settings page tests a draft with an empty
   * password. The stored password is used then, but only when every other transport setting is the
   * stored one, so a saved password is never sent to a different server, account or security mode.
   */
  private async withStoredSmtpPassword(transport: SystemConfigSmtpDto['transport']) {
    if (transport.password !== '') {
      return transport;
    }

    const { notifications } = await this.getConfig({ withCache: false });
    const stored = notifications.smtp.transport;
    const sameServer =
      stored.host === transport.host &&
      stored.port === transport.port &&
      stored.username === transport.username &&
      stored.secure === transport.secure &&
      stored.ignoreCert === transport.ignoreCert;

    return stored.password && sameServer ? { ...transport, password: stored.password } : transport;
  }

  async getTemplate(name: EmailTemplate, customTemplate: string) {
    const { server, templates } = await this.getConfig({ withCache: false });

    let templateResponse: string;

    switch (name) {
      case EmailTemplate.WELCOME: {
        const { html: _welcomeHtml } = await this.emailRepository.renderEmail({
          template: EmailTemplate.WELCOME,
          data: {
            baseUrl: await this.getPublicUrl(server),
            displayName: 'John Doe',
            username: 'john@doe.com',
            password: 'thisIsAPassword123',
          },
          customTemplate: customTemplate || templates.email.welcomeTemplate,
        });

        templateResponse = _welcomeHtml;
        break;
      }
      case EmailTemplate.ALBUM_UPDATE: {
        const { html: _updateAlbumHtml } = await this.emailRepository.renderEmail({
          template: EmailTemplate.ALBUM_UPDATE,
          data: {
            baseUrl: await this.getPublicUrl(server),
            albumId: '1',
            albumName: 'Favorite Photos',
            recipientName: 'Jane Doe',
            cid: undefined,
          },
          customTemplate: customTemplate || templates.email.albumUpdateTemplate,
        });
        templateResponse = _updateAlbumHtml;
        break;
      }

      case EmailTemplate.ALBUM_INVITE: {
        const { html } = await this.emailRepository.renderEmail({
          template: EmailTemplate.ALBUM_INVITE,
          data: {
            baseUrl: await this.getPublicUrl(server),
            albumId: '1',
            albumName: "John Doe's Favorites",
            senderName: 'John Doe',
            recipientName: 'Jane Doe',
            cid: undefined,
          },
          customTemplate: customTemplate || templates.email.albumInviteTemplate,
        });
        templateResponse = html;
        break;
      }
      default: {
        templateResponse = '';
        break;
      }
    }

    return { name, html: templateResponse };
  }
}
