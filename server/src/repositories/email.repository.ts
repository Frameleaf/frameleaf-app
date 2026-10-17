import { Injectable } from '@nestjs/common';
import { render, toPlainText } from '@react-email/render';
import { createTransport } from 'nodemailer';
import React, { createElement } from 'react';
import type { EmailImageAttachment } from 'src/types.js';
import { AlbumInviteEmail } from 'src/emails/album-invite.email.js';
import { AlbumUpdateEmail } from 'src/emails/album-update.email.js';
import { ItemShareEmail } from 'src/emails/item-share.email.js';
import { TestEmail } from 'src/emails/test.email.js';
import { WelcomeEmail } from 'src/emails/welcome.email.js';
import { MailSignInProvider } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';

export type SendEmailOptions = {
  from: string;
  to: string;
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  imageAttachments?: EmailImageAttachment[];
  smtp: SmtpOptions;
};

/** FL-379: a connected Gmail or Microsoft account and a current access token for it. */
export type MailAccount = { provider: MailSignInProvider; accessToken: string };

export type SendAccountEmailOptions = Omit<SendEmailOptions, 'smtp'> & { account: MailAccount };

/** Gmail API `users.messages.send`: `{ raw }` is the whole MIME message, base64url. */
export const GMAIL_SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
/** Microsoft Graph `/me/sendMail`: with `Content-Type: text/plain` the body is the MIME message, base64. */
export const GRAPH_SEND_URL = 'https://graph.microsoft.com/v1.0/me/sendMail';
/** Microsoft Graph: the signed-in account's own address (`User.Read`). */
export const GRAPH_ME_URL = 'https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName';
const MAIL_API_TIMEOUT_MS = 30_000;

/**
 * FL-379: Gmail or Microsoft refused or could not be reached. `status` is the HTTP status (null when
 * there was no answer); a 401 means the access token is no longer accepted. The message carries the
 * provider's own short reason and never a token or any part of the email.
 */
export class MailApiError extends Error {
  constructor(
    readonly provider: MailSignInProvider,
    readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'MailApiError';
  }
}

const providerName = (provider: MailSignInProvider) => (provider === MailSignInProvider.Gmail ? 'Gmail' : 'Microsoft');

export type SmtpOptions = {
  host: string;
  port?: number;
  secure?: boolean;
  username?: string;
  password?: string;
  ignoreCert?: boolean;
};

export enum EmailTemplate {
  TEST_EMAIL = 'test',

  // AUTH
  WELCOME = 'welcome',
  RESET_PASSWORD = 'reset-password',

  // ALBUM
  ALBUM_INVITE = 'album-invite',
  ALBUM_UPDATE = 'album-update',
  ITEM_SHARE = 'item-share',
}

interface BaseEmailProps {
  /**
   * FL-190: this server's public address. Absent when the server has none; the email then carries
   * no link and asks the recipient to open Frameleaf on their server.
   */
  baseUrl?: string;
  customTemplate?: string;
  /** FL-426: the Frameleaf name and logo at the top (`templates.email.showBranding`); on unless false. */
  showBranding?: boolean;
}

/** FL-426: an invitation's own first line (`templates.email.invitationFirstLine`); empty keeps "Hey {name}!". */
interface InvitationEmailProps {
  firstLine?: string;
}

export interface TestEmailProps extends BaseEmailProps {
  displayName: string;
}

export interface WelcomeEmailProps extends BaseEmailProps {
  displayName: string;
  username: string;
  password?: string;
}

export interface AlbumInviteEmailProps extends BaseEmailProps, InvitationEmailProps {
  albumName: string;
  albumId: string;
  senderName: string;
  recipientName: string;
  cid?: string;
}

/** FL-83 (AL-30b): items shared with a person; `link` opens Sharing › Shared with you. */
export interface ItemShareEmailProps extends BaseEmailProps, InvitationEmailProps {
  senderName: string;
  recipientName: string;
  count: number;
  link?: string;
}

export interface AlbumUpdateEmailProps extends BaseEmailProps {
  albumName: string;
  albumId: string;
  recipientName: string;
  cid?: string;
}

export type EmailRenderRequest =
  | {
      template: EmailTemplate.TEST_EMAIL;
      data: TestEmailProps;
      customTemplate: string;
    }
  | {
      template: EmailTemplate.WELCOME;
      data: WelcomeEmailProps;
      customTemplate: string;
    }
  | {
      template: EmailTemplate.ALBUM_INVITE;
      data: AlbumInviteEmailProps;
      customTemplate: string;
    }
  | {
      template: EmailTemplate.ALBUM_UPDATE;
      data: AlbumUpdateEmailProps;
      customTemplate: string;
    }
  | {
      template: EmailTemplate.ITEM_SHARE;
      data: ItemShareEmailProps;
      customTemplate: string;
    };

export type SendEmailResponse = {
  messageId: string;
  response: any;
};

@Injectable()
export class EmailRepository {
  constructor(private logger: LoggingRepository) {
    this.logger.setContext(EmailRepository.name);
  }

  async verifySmtp(options: SmtpOptions): Promise<true> {
    const transport = this.createTransport(options);
    try {
      return await transport.verify();
    } finally {
      transport.close();
    }
  }

  async renderEmail(request: EmailRenderRequest): Promise<{ html: string; text: string }> {
    const component = this.render(request);
    const html = await render(component, { pretty: false });
    const text = toPlainText(html);
    return { html, text };
  }

  async sendEmail({
    to,
    from,
    replyTo,
    subject,
    html,
    text,
    smtp,
    imageAttachments,
  }: SendEmailOptions): Promise<SendEmailResponse> {
    this.logger.debug(`Sending email to ${to} with subject: ${subject}`);
    const transport = this.createTransport(smtp);

    const attachments = imageAttachments?.map((attachment) => ({
      filename: attachment.filename,
      path: attachment.path,
      cid: attachment.cid,
    }));

    try {
      return await transport.sendMail({ to, from, replyTo, subject, html, text, attachments });
    } finally {
      transport.close();
    }
  }

  /**
   * FL-379: the finished MIME message nodemailer would hand to a mail server, built without sending
   * anything. Gmail and Microsoft both accept it whole, so only the last hop differs from SMTP.
   */
  async buildMessage({
    to,
    from,
    replyTo,
    subject,
    html,
    text,
    imageAttachments,
  }: Omit<SendEmailOptions, 'smtp'>): Promise<{ messageId: string; mime: Buffer }> {
    const attachments = imageAttachments?.map((attachment) => ({
      filename: attachment.filename,
      path: attachment.path,
      cid: attachment.cid,
    }));
    const transport = createTransport({ streamTransport: true, buffer: true, newline: 'windows' });
    const info = await transport.sendMail({ to, from, replyTo, subject, html, text, attachments });
    return { messageId: info.messageId, mime: info.message as Buffer };
  }

  /**
   * FL-379: send through the connected account's own service: the Gmail API (`users.messages.send`)
   * or Microsoft Graph (`/me/sendMail`). Neither the message nor the token is logged.
   */
  async sendEmailWithAccount({ account, ...message }: SendAccountEmailOptions): Promise<SendEmailResponse> {
    this.logger.debug(`Sending email to ${message.to} through ${providerName(account.provider)}`);
    const { messageId, mime } = await this.buildMessage(message);
    const gmail = account.provider === MailSignInProvider.Gmail;
    const response = await this.callMailApi(account, gmail ? GMAIL_SEND_URL : GRAPH_SEND_URL, {
      method: 'POST',
      headers: { 'Content-Type': gmail ? 'application/json' : 'text/plain' },
      body: gmail ? JSON.stringify({ raw: mime.toString('base64url') }) : mime.toString('base64'),
    });
    await response.body?.cancel();
    return { messageId, response: `${providerName(account.provider)} accepted the message (${response.status})` };
  }

  /** FL-379: the address of the Microsoft account an access token belongs to (`mail`, else the sign-in name). */
  async readMicrosoftAddress(accessToken: string): Promise<string> {
    const account = { provider: MailSignInProvider.Microsoft, accessToken };
    const response = await this.callMailApi(account, GRAPH_ME_URL, { method: 'GET' });
    const profile = (await response.json().catch(() => null)) as { mail?: unknown; userPrincipalName?: unknown } | null;
    const address = [profile?.mail, profile?.userPrincipalName].find(
      (value): value is string => typeof value === 'string' && value.includes('@'),
    );
    if (!address) {
      throw new MailApiError(account.provider, response.status, 'Microsoft did not say which address signed in');
    }
    return address;
  }

  private async callMailApi(account: MailAccount, url: string, init: RequestInit): Promise<Response> {
    const name = providerName(account.provider);
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${account.accessToken}` },
        redirect: 'error',
        signal: AbortSignal.timeout(MAIL_API_TIMEOUT_MS),
      });
    } catch (error) {
      throw new MailApiError(
        account.provider,
        null,
        `${name} did not answer: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!response.ok) {
      // both answer `{ error: { message } }`; only that short reason is kept
      const body = (await response.json().catch(() => null)) as { error?: { message?: unknown } } | null;
      const reason = typeof body?.error?.message === 'string' ? `: ${body.error.message.slice(0, 300)}` : '';
      throw new MailApiError(account.provider, response.status, `${name} refused (${response.status})${reason}`);
    }
    return response;
  }

  private render({ template, data, customTemplate }: EmailRenderRequest): React.FunctionComponentElement<any> {
    switch (template) {
      case EmailTemplate.TEST_EMAIL: {
        return createElement(TestEmail, { ...data, customTemplate });
      }

      case EmailTemplate.WELCOME: {
        return createElement(WelcomeEmail, { ...data, customTemplate });
      }

      case EmailTemplate.ALBUM_INVITE: {
        return createElement(AlbumInviteEmail, { ...data, customTemplate });
      }

      case EmailTemplate.ALBUM_UPDATE: {
        return createElement(AlbumUpdateEmail, { ...data, customTemplate });
      }

      case EmailTemplate.ITEM_SHARE: {
        return createElement(ItemShareEmail, { ...data, customTemplate });
      }
    }
  }

  private createTransport(options: SmtpOptions) {
    return createTransport({
      host: options.host,
      port: options.port,
      tls: { rejectUnauthorized: !options.ignoreCert },
      secure: options.secure,
      auth:
        options.username || options.password
          ? {
              user: options.username,
              pass: options.password,
            }
          : undefined,
      connectionTimeout: 5000,
    });
  }
}
