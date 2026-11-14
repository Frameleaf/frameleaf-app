import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { render, toPlainText } from '@react-email/render';
import { setTimeout } from 'node:timers/promises';
import { createElement } from 'react';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { CampaignRow } from 'src/repositories/photography-campaign.repository.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import { PhotographyCampaignSaveDto, PhotographyCampaignScheduleDto } from 'src/dtos/photography-campaign.dto.js';
import { EmailLocaleContext, emailText } from 'src/emails/components/email-locale.js';
import MiniSessionEmail from 'src/emails/photography-mini-session.email.js';
import PrintSaleEmail from 'src/emails/photography-print-sale.email.js';
import ReviewRequestEmail from 'src/emails/photography-review-request.email.js';
import { FrameleafWorker, JobName, JobStatus, MailConnectionStatus, QueueName } from 'src/enum.js';
import { jobSignal } from 'src/queue/context.js';
import { MailApiError } from 'src/repositories/email.repository.js';
import { PhotographyCampaignRepository } from 'src/repositories/photography-campaign.repository.js';
import { PhotographyWorkflowRepository } from 'src/repositories/photography-workflow.repository.js';
import { PhotographyWorkspaceRepository } from 'src/repositories/photography-workspace.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { PhotographyWorkflowService } from 'src/services/photography-workflow.service.js';
import { connectedSender } from 'src/utils/frameleaf-mail.js';
import {
  MailNeedsSignInError,
  readMailConnection,
  sendConnectedEmail,
  signInProviderOf,
} from 'src/utils/mail-connection.js';
import { localeOf } from 'src/utils/preferences.js';

const authenticationReasons = new Set([
  'autherror',
  'insufficientpermissions',
  'access_token_scope_insufficient',
  'erroraccessdenied',
  'invalidauthenticationtoken',
  'insufficient_claims',
]);
const templates = {
  'print-sale': PrintSaleEmail,
  'review-request': ReviewRequestEmail,
  'mini-session': MiniSessionEmail,
};
const view = ({ ownerId: _, ...row }: CampaignRow) => ({
  ...row,
  scheduledFor: row.scheduledFor?.toISOString() ?? null,
});

@Injectable()
export class PhotographyCampaignService extends BaseService {
  @Inject(PhotographyCampaignRepository) private campaigns!: PhotographyCampaignRepository;
  @Inject(PhotographyWorkflowRepository) private studioRecords!: PhotographyWorkflowRepository;
  @Inject(PhotographyWorkspaceRepository) private workspace!: PhotographyWorkspaceRepository;
  @Inject(PhotographyWorkflowService) private workflow!: PhotographyWorkflowService;
  private sending = false;

  async list(auth: AuthDto) {
    const ownerId = this.workflow.studioOwner(auth);
    await this.campaigns.syncContacts(ownerId);
    const [items, clients, leads, delivery] = await Promise.all([
      this.campaigns.list(ownerId),
      this.campaigns.contacts(ownerId, { source: 'clients' }),
      this.campaigns.contacts(ownerId, { source: 'leads' }),
      this.delivery(),
    ]);
    return {
      items: items.map((row) => view(row)),
      clients: clients.length,
      leads: leads.length,
      mailReady: delivery.ready,
      sender: delivery.smtp.from,
    };
  }
  async save(auth: AuthDto, id: string, input: PhotographyCampaignSaveDto) {
    const ownerId = this.workflow.studioOwner(auth);
    const draft = PhotographyCampaignSaveDto.schema.parse(input);
    if (draft.audience.source === 'shoot' && !draft.audience.workflowId)
      throw new BadRequestException('Choose a shoot');
    return view(await this.campaigns.save(ownerId, id, draft));
  }
  async delivery() {
    const { notifications, server } = await this.getConfig({ withCache: false });
    const smtp = notifications.smtp;
    const baseUrl = await this.getPublicUrl(server);
    const provider = signInProviderOf(smtp.transport.type);
    const account = provider ? await readMailConnection(this.mailDeps) : null;
    const ready = !!(
      smtp.enabled &&
      smtp.from &&
      baseUrl &&
      (provider
        ? account?.provider === provider && account.status !== MailConnectionStatus.NeedsSignIn
        : smtp.transport.host)
    );
    return {
      smtp: { ...smtp, from: provider && account ? connectedSender(smtp.from, account.email) : smtp.from },
      baseUrl,
      provider,
      ready,
    };
  }
  private async message(row: CampaignRow, token: string) {
    const [workspace, owner] = await Promise.all([
      this.workspace.get(row.ownerId),
      this.studioRecords.studioOwner(row.ownerId),
    ]);
    const delivery = await this.delivery();
    const locale = localeOf(await this.userRepository.getMetadata(row.ownerId));
    const unsubscribeUrl = `${delivery.baseUrl}/api/photography/unsubscribe/${token}?locale=${encodeURIComponent(locale)}`;
    const brand = workspace?.value.brand;
    const studioName = brand?.name || owner?.name || 'Frameleaf';
    const color = /^#[a-f0-9]{6}$/i.test(brand?.color ?? '') ? brand!.color : '#333333';
    const html = await render(
      createElement(
        EmailLocaleContext.Provider,
        { value: locale },
        createElement(templates[row.templateKey], {
          studioName,
          subject: row.subject,
          body: row.body,
          unsubscribeUrl,
          color,
        }),
      ),
    );
    return { html, text: toPlainText(html), unsubscribeUrl, delivery, owner };
  }
  async results(auth: AuthDto, id: string) {
    await this.campaigns.get(this.workflow.studioOwner(auth), id);
    return this.campaigns.deliveries(id);
  }
  async preview(auth: AuthDto, id: string) {
    const ownerId = this.workflow.studioOwner(auth);
    const row = await this.campaigns.get(ownerId, id);
    await this.campaigns.syncContacts(ownerId);
    const [message, contacts] = await Promise.all([
      this.message(row, 'preview'),
      this.campaigns.contacts(ownerId, row.audience),
    ]);
    return { html: message.html, text: message.text, sender: message.delivery.smtp.from, recipients: contacts.length };
  }
  async test(auth: AuthDto, id: string) {
    const row = await this.campaigns.get(this.workflow.studioOwner(auth), id);
    const message = await this.message(row, 'preview');
    if (!message.owner?.email) throw new BadRequestException('Studio email is unavailable');
    if (!message.delivery.ready)
      throw new BadRequestException('Configure email delivery and your public address first');
    if (!(await this.campaigns.reserveTest(row.ownerId, id)))
      throw new BadRequestException('Wait a minute before another test');
    await this.send(message, message.owner.email, row.subject);
  }
  async schedule(auth: AuthDto, id: string, dto: PhotographyCampaignScheduleDto) {
    const ownerId = this.workflow.studioOwner(auth);
    const row = await this.campaigns.get(ownerId, id);
    const delivery = await this.delivery();
    if (!delivery.ready) throw new BadRequestException('Configure email delivery and your public address first');
    const when = dto.scheduledFor ? new Date(dto.scheduledFor) : new Date();
    if (dto.scheduledFor && when.getTime() < Date.now()) throw new BadRequestException('Choose a future date');
    await this.campaigns.syncContacts(ownerId);
    const contacts = await this.campaigns.contacts(ownerId, row.audience);
    if (contacts.length === 0) throw new BadRequestException('Choose at least one recipient');
    await this.campaigns.schedule(
      ownerId,
      id,
      when,
      contacts.map(({ id }) => id),
      dto.expectedRevision,
    );
    return view(await this.campaigns.get(ownerId, id));
  }
  async cancel(auth: AuthDto, id: string) {
    return view(await this.campaigns.cancel(this.workflow.studioOwner(auth), id));
  }
  @OnEvent({ name: 'AppBootstrap', workers: [FrameleafWorker.Microservices] })
  async startCampaigns() {
    this.cronRepository.create({
      name: 'PhotographyCampaigns',
      expression: '* * * * *',
      onTick: () => {
        void this.jobRepository
          .queue({ name: JobName.PhotographyCampaignSend })
          .catch(() => this.logger.warn('Campaign delivery paused'));
      },
    });
    await this.jobRepository.queue({ name: JobName.PhotographyCampaignSend });
  }
  @OnJob({ name: JobName.PhotographyCampaignSend, queue: QueueName.Notification })
  async handleCampaigns() {
    await this.dispatch();
    return JobStatus.Success;
  }
  async dispatch() {
    if (this.sending) return;
    this.sending = true;
    try {
      if (!(await this.delivery()).ready) return;
      let attempted = 0;
      for (const due of await this.campaigns.due()) {
        const row = await this.campaigns.get(due.ownerId, due.id);
        while (attempted < 50) {
          jobSignal()?.throwIfAborted();
          const contact = await this.campaigns.claim(row.id);
          if (!contact) break;
          let message: Awaited<ReturnType<PhotographyCampaignService['message']>>;
          try {
            message = await this.message(row, contact.unsubscribeToken);
          } catch (error) {
            await this.campaigns.finish(row.id, contact.id, 'pending');
            throw error;
          }
          // The durable claim precedes transport. An interrupted or ambiguous attempt stays visible for review.
          if (!message.delivery.ready) {
            await this.campaigns.finish(row.id, contact.id, 'pending');
            return;
          }
          try {
            const sent = await this.campaigns.sendIfEligible(row.id, contact.id, () => {
              jobSignal()?.throwIfAborted();
              return this.send(message, contact.email, row.subject);
            });
            await this.campaigns.finish(row.id, contact.id, sent ? 'sent' : 'unsubscribed');
          } catch (error) {
            if (jobSignal()?.aborted) throw error;
            const retryAfter = error instanceof MailApiError ? error.retryAfterSeconds : undefined;
            const delay = Number.isFinite(retryAfter) ? Math.ceil(retryAfter!) : 60;
            await this.campaigns.pause(row.id, Math.max(60, Math.min(2_147_483_647, delay)));
            const accountRefused =
              error instanceof MailNeedsSignInError ||
              (error instanceof MailApiError &&
                (error.status === 401 ||
                  (error.status === 403 && authenticationReasons.has(error.reasonCode?.toLowerCase() ?? ''))));
            if (accountRefused || (error instanceof MailApiError && error.status === 429)) {
              await this.campaigns.finish(row.id, contact.id, 'pending');
            } else if (
              error instanceof MailApiError &&
              error.status &&
              error.status >= 400 &&
              error.status < 500 &&
              error.status !== 408
            ) {
              await this.campaigns.finish(row.id, contact.id, 'failed');
            }
            this.logger.warn('A campaign delivery needs review');
            return;
          }
          attempted++;
          await setTimeout(2100, undefined, { signal: jobSignal() });
        }
        await this.campaigns.complete(row.id);
        if (attempted >= 50) break;
      }
    } finally {
      this.sending = false;
    }
  }
  private async send(message: Awaited<ReturnType<PhotographyCampaignService['message']>>, to: string, subject: string) {
    const { smtp, provider } = message.delivery;
    const payload = {
      from: smtp.from,
      replyTo: smtp.replyTo || smtp.from,
      to,
      subject,
      html: message.html,
      text: message.text,
      headers: {
        'List-Unsubscribe': `<${message.unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    };
    return provider
      ? sendConnectedEmail(this.mailDeps, provider, payload)
      : this.emailRepository.sendEmail({ ...payload, smtp: smtp.transport });
  }
  async unsubscribe(token: string, locale: string, confirm: boolean) {
    if (!/^[a-f0-9]{64}$/.test(token)) throw new NotFoundException();
    if (confirm && !(await this.campaigns.unsubscribe(token))) throw new NotFoundException();
    const label = emailText(locale, confirm ? 'campaign_unsubscribed' : 'campaign_unsubscribe');
    return `<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${label}</title><body><main><h1>${label}</h1>${confirm ? '' : `<form method="post"><button>${label}</button></form>`}</main></body></html>`;
  }
}
