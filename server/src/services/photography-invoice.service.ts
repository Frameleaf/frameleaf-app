import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { render, toPlainText } from '@react-email/render';
import { createHash, randomBytes } from 'node:crypto';
import { createElement } from 'react';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { OnEvent } from 'src/decorators.js';
import { PhotographyInvoiceSaveDto } from 'src/dtos/photography-invoice.dto.js';
import { EmailLocaleContext, emailText } from 'src/emails/components/email-locale.js';
import PhotographyContractEmail from 'src/emails/photography-contract.email.js';
import { FrameleafWorker } from 'src/enum.js';
import { InvoiceRow, PhotographyInvoiceRepository } from 'src/repositories/photography-invoice.repository.js';
import { PhotographyWorkflowRepository } from 'src/repositories/photography-workflow.repository.js';
import { PhotographyWorkspaceRepository } from 'src/repositories/photography-workspace.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { type ClientsPaymentEvent, ClientsPaymentsService } from 'src/services/clients-payments.service.js';
import { PhotographyCampaignService } from 'src/services/photography-campaign.service.js';
import { PhotographyWorkflowService } from 'src/services/photography-workflow.service.js';
import { refundsWholePayment } from 'src/utils/clients-payments.js';
import { sendConnectedEmail } from 'src/utils/mail-connection.js';
import { renderInvoicePdf } from 'src/utils/photography-invoice-pdf.js';
import {
  invoiceLabel,
  invoiceNext,
  invoiceReminderDue,
  invoiceSchedule,
  invoiceTotals,
} from 'src/utils/photography-invoice.js';
import { localeOf } from 'src/utils/preferences.js';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const today = () => new Date().toISOString().slice(0, 10);
const iso = (value: Date | string | null) => (value ? new Date(value).toISOString() : null);
const unavailable = () => new NotFoundException('This invoice link is unavailable');
type Status = 'draft' | 'sent' | 'part' | 'paid' | 'void';
type Delivery = Awaited<ReturnType<PhotographyCampaignService['delivery']>>;

export const invoiceView = (row: InvoiceRow) => {
  const next = ['sent', 'part'].includes(row.status) ? invoiceNext(row.schedule, row.paid) : null;
  return {
    id: row.id,
    number: row.number,
    label: invoiceLabel(row.number),
    clientName: row.clientName,
    clientEmail: row.clientEmail,
    lines: row.lines,
    taxBasisPoints: row.taxBasisPoints,
    currency: row.currency,
    subtotal: row.subtotal,
    tax: row.tax,
    total: row.total,
    schedule: row.schedule,
    reminders: row.reminders,
    status: row.status as Status,
    paid: row.paid,
    overdue: !!next && next.dueOn < today(),
    sentAt: iso(row.sentAt),
    createdAt: iso(row.createdAt)!,
  };
};

/**
 * FL-1081: invoices with a deposit and a balance. Totals and tax are computed here in integer minor units; clients
 * pay the amount due now through the studio's connected Stripe account (FL-1037) as `invoice:<payment id>`, and
 * reminders go out 3 days before each due date, on it, then weekly while overdue.
 */
@Injectable()
export class PhotographyInvoiceService extends BaseService implements OnModuleInit {
  @Inject(PhotographyInvoiceRepository) private invoices!: PhotographyInvoiceRepository;
  @Inject(PhotographyWorkflowRepository) private studioRecords!: PhotographyWorkflowRepository;
  @Inject(PhotographyWorkspaceRepository) private workspace!: PhotographyWorkspaceRepository;
  @Inject(PhotographyWorkflowService) private workflow!: PhotographyWorkflowService;
  @Inject(PhotographyCampaignService) private campaigns!: PhotographyCampaignService;
  @Inject(ClientsPaymentsService) private payments!: ClientsPaymentsService;

  onModuleInit() {
    this.payments.onPayment('invoice', (event) => this.paymentEvent(event));
  }

  async list(auth: AuthDto) {
    const ownerId = this.workflow.studioOwner(auth);
    const [rows, delivery, paymentsReady] = await Promise.all([
      this.invoices.list(ownerId),
      this.campaigns.delivery(),
      this.payments.ready(ownerId),
    ]);
    return { items: rows.map((row) => invoiceView(row)), mailReady: delivery.ready, paymentsReady };
  }
  async get(auth: AuthDto, id: string) {
    return invoiceView(await this.invoices.get(this.workflow.studioOwner(auth), id));
  }
  private values(dto: PhotographyInvoiceSaveDto) {
    const totals = invoiceTotals(dto.lines, dto.taxBasisPoints);
    let schedule;
    try {
      schedule = invoiceSchedule(totals.total, dto.deposit, dto.depositDue, dto.balanceDue);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
    return {
      clientName: dto.clientName,
      clientEmail: dto.clientEmail.toLowerCase(),
      lines: dto.lines,
      taxBasisPoints: dto.taxBasisPoints,
      currency: dto.currency,
      ...totals,
      schedule,
      reminders: dto.reminders,
    };
  }
  async create(auth: AuthDto, dto: PhotographyInvoiceSaveDto) {
    const ownerId = this.workflow.studioOwner(auth);
    const id = await this.invoices.create(ownerId, this.values(dto));
    return invoiceView(await this.invoices.get(ownerId, id));
  }
  async update(auth: AuthDto, id: string, dto: PhotographyInvoiceSaveDto) {
    const ownerId = this.workflow.studioOwner(auth);
    if (!(await this.invoices.update(ownerId, id, this.values(dto)))) {
      await this.invoices.get(ownerId, id);
      throw new ConflictException('An invoice with a payment, or a paid or voided one, can’t be changed');
    }
    return invoiceView(await this.invoices.get(ownerId, id));
  }
  async delete(auth: AuthDto, id: string) {
    const ownerId = this.workflow.studioOwner(auth);
    if (!(await this.invoices.delete(ownerId, id))) {
      await this.invoices.get(ownerId, id);
      throw new ConflictException('Only a draft can be deleted; void a sent invoice instead');
    }
  }
  /** Emails the invoice link. Links emailed earlier keep working until the invoice is voided. */
  async send(auth: AuthDto, id: string) {
    const ownerId = this.workflow.studioOwner(auth);
    const delivery = await this.campaigns.delivery();
    if (!delivery.ready) throw new BadRequestException('Configure email delivery and your public address first');
    const token = randomBytes(32).toString('hex');
    if (!(await this.invoices.send(ownerId, id, sha256(token)))) {
      await this.invoices.get(ownerId, id);
      throw new ConflictException('A paid or voided invoice can’t be sent');
    }
    const row = await this.invoices.get(ownerId, id);
    const studio = await this.studio(ownerId);
    const next = invoiceNext(row.schedule, row.paid);
    await this.mail(delivery, row.clientEmail, studio, {
      subject: emailText(studio.locale, 'invoice_email_subject', {
        studio: studio.name,
        number: invoiceLabel(row.number),
      }),
      body: next
        ? emailText(studio.locale, 'invoice_email_body', {
            amount: this.money(next.amount, row.currency, studio.locale),
            date: this.date(next.dueOn, studio.locale),
          })
        : '',
      heading: invoiceLabel(row.number),
      url: `${delivery.baseUrl}/photography/invoice/${token}`,
    });
    return invoiceView(row);
  }
  async void(auth: AuthDto, id: string) {
    const ownerId = this.workflow.studioOwner(auth);
    if (!(await this.invoices.void(ownerId, id))) {
      await this.invoices.get(ownerId, id);
      throw new ConflictException('A paid or voided invoice can’t be voided');
    }
    return invoiceView(await this.invoices.get(ownerId, id));
  }
  /** Records money received outside Frameleaf (cash, transfer). More than the balance is refused. */
  async markPaid(auth: AuthDto, id: string, amount: number) {
    const ownerId = this.workflow.studioOwner(auth);
    if (!(await this.invoices.recordManual(ownerId, id, amount))) {
      throw new ConflictException('That is more than the balance, or the invoice isn’t open');
    }
    return invoiceView(await this.invoices.get(ownerId, id));
  }
  async pdf(auth: AuthDto, id: string) {
    const row = await this.invoices.get(this.workflow.studioOwner(auth), id);
    return { name: `${invoiceLabel(row.number)}.pdf`, buffer: await this.renderPdf(row) };
  }

  private async byToken(token: string) {
    if (!/^[a-f\d]{64}$/.test(token)) throw unavailable();
    const row = await this.invoices.byToken(sha256(token));
    if (!row) throw unavailable();
    return row;
  }
  async publicView(token: string) {
    const row = await this.byToken(token);
    const studio = await this.studio(row.ownerId);
    const next = row.status === 'paid' ? null : invoiceNext(row.schedule, row.paid);
    return {
      studio: { name: studio.name, email: studio.email, color: studio.color },
      label: invoiceLabel(row.number),
      clientName: row.clientName,
      lines: row.lines,
      taxBasisPoints: row.taxBasisPoints,
      currency: row.currency,
      subtotal: row.subtotal,
      tax: row.tax,
      total: row.total,
      schedule: row.schedule,
      paid: row.paid,
      status: row.status as Status,
      next,
      payOnline: !!next && (await this.payments.ready(row.ownerId)),
    };
  }
  async publicPdf(token: string) {
    const row = await this.byToken(token);
    return { name: `${invoiceLabel(row.number)}.pdf`, buffer: await this.renderPdf(row) };
  }
  /** Checkout for the amount due now. The amount comes from the invoice, never the payer. */
  async checkout(token: string, origin: string) {
    const row = await this.byToken(token);
    if (!(await this.payments.ready(row.ownerId)))
      throw new ConflictException('This studio doesn’t take online payments');
    const held = await this.invoices.attempt(row.id);
    if (!held) throw new ConflictException('Nothing is due on this invoice');
    const { payment } = held;
    const back = `${origin}/photography/invoice/${token}`;
    const session = await this.payments.checkout(row.ownerId, {
      reference: `invoice:${payment.id}`,
      idempotencyKey: `payment-${payment.id}`,
      name: invoiceLabel(row.number),
      amount: payment.amount,
      currency: row.currency.toLowerCase(),
      customerEmail: row.clientEmail,
      successUrl: `${back}?payment=${payment.id}`,
      cancelUrl: back,
    });
    if (!session.url.startsWith('https://checkout.stripe.com/'))
      throw new ConflictException('Invalid hosted checkout response');
    await this.invoices.setCheckout(payment.id, session.id);
    return { url: session.url, paymentId: payment.id };
  }
  async paymentStatus(token: string, paymentId: string) {
    const row = await this.byToken(token);
    const payment = await this.invoices.payment(paymentId);
    if (payment?.invoiceId !== row.id) throw unavailable();
    return { status: payment.status as 'pending' | 'paid' | 'failed' | 'expired' | 'refunded' };
  }

  /** A relayed Stripe event for `invoice:<payment id>`. Replays and out-of-order events change nothing. */
  async paymentEvent(event: ClientsPaymentEvent) {
    const id = event.reference?.slice('invoice:'.length) ?? '';
    if (!/^[a-f\d-]{36}$/.test(id)) return;
    const payment = await this.invoices.payment(id);
    if (!payment?.invoiceId || payment.ownerId !== event.ownerId) return;
    const transitions: Record<string, [string[], string]> = {
      'payment.succeeded': [['pending', 'failed', 'expired'], 'paid'],
      'payment.failed': [['pending'], 'failed'],
      'payment.expired': [['pending'], 'expired'],
      'payment.refunded': [['pending', 'failed', 'expired', 'paid'], 'refunded'],
    };
    const move = transitions[event.type];
    if (!move) return;
    if (event.type === 'payment.refunded') {
      if (!event.paymentIntent || (payment.providerRef && payment.providerRef !== event.paymentIntent)) return;
      // Marking it refunded would put the whole amount back on the invoice and ask the client to pay it again.
      if (!refundsWholePayment(event.amount, payment.amount)) {
        this.logger.warn(`Payment ${payment.id} on invoice ${payment.invoiceId} was partly refunded in Stripe`);
        return;
      }
    } else if (
      (payment.checkoutId !== null && event.sessionId !== payment.checkoutId) ||
      (event.type === 'payment.succeeded' &&
        (event.amount !== payment.amount || event.currency?.toUpperCase() !== payment.currency))
    ) {
      return;
    }
    const { overpaid } = await this.invoices.transition(payment.id, move[0], move[1], event.paymentIntent ?? null);
    if (overpaid)
      this.logger.warn(`Payment ${payment.id} paid more than invoice ${payment.invoiceId} owed; refund it in Stripe`);
  }

  @OnEvent({ name: 'AppBootstrap', workers: [FrameleafWorker.Microservices] })
  startReminders() {
    this.cronRepository.create({
      name: 'PhotographyInvoiceReminders',
      expression: '0 * * * *',
      onTick: () => {
        void this.remind().catch(() => this.logger.warn('Invoice reminders paused'));
      },
    });
  }
  /** Runs hourly; each invoice gets at most one reminder a day, claimed before it is sent. */
  async remind() {
    const delivery = await this.campaigns.delivery();
    if (!delivery.ready) return;
    const day = today();
    for (const row of await this.invoices.remindable(day)) {
      const next = invoiceNext(row.schedule, row.paid);
      if (!next || !invoiceReminderDue(next.dueOn, day)) continue;
      if (!(await this.invoices.claimReminder(row.id, day))) continue;
      // Only link hashes are stored, so a reminder carries a new link; the ones sent before still work.
      const token = randomBytes(32).toString('hex');
      if (!(await this.invoices.send(row.ownerId, row.id, sha256(token)))) continue;
      const studio = await this.studio(row.ownerId);
      const values = {
        amount: this.money(next.amount, row.currency, studio.locale),
        date: this.date(next.dueOn, studio.locale),
        number: invoiceLabel(row.number),
        studio: studio.name,
      };
      await this.mail(delivery, row.clientEmail, studio, {
        subject: emailText(studio.locale, 'invoice_reminder_subject', values),
        body: emailText(studio.locale, next.dueOn < day ? 'invoice_reminder_overdue' : 'invoice_reminder_body', values),
        heading: values.number,
        url: `${delivery.baseUrl}/photography/invoice/${token}`,
      }).catch(() => this.logger.warn('An invoice reminder could not be sent'));
    }
  }

  /** Whether this server can email clients now (FL-1606 shows the booking email choice only then). */
  async mailReady() {
    return (await this.campaigns.delivery()).ready;
  }

  /**
   * FL-1606: a short message to a client in the studio's name, language and colour, without a button. False when
   * email isn't set up; a send failure is thrown for the caller to log.
   */
  async emailClient(
    ownerId: string,
    to: string,
    compose: (studio: { locale: string; name: string }) => { subject: string; heading: string; body: string },
  ) {
    const delivery = await this.campaigns.delivery();
    if (!delivery.ready) return false;
    const studio = await this.studio(ownerId);
    await this.mail(delivery, to, studio, compose(studio));
    return true;
  }

  private money(amount: number, currency: string, locale: string) {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amount / 100);
  }
  private date(value: string, locale: string) {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(value));
  }
  private async renderPdf(row: InvoiceRow) {
    const studio = await this.studio(row.ownerId);
    return renderInvoicePdf({
      row,
      label: invoiceLabel(row.number),
      studio,
      locale: studio.locale,
      money: (amount) => this.money(amount, row.currency, studio.locale),
      date: (value) => this.date(value, studio.locale),
    });
  }
  private async studio(ownerId: string) {
    const [workspace, owner, metadata] = await Promise.all([
      this.workspace.get(ownerId),
      this.studioRecords.studioOwner(ownerId),
      this.userRepository.getMetadata(ownerId),
    ]);
    const brand = workspace?.value.brand;
    return {
      name: brand?.name || owner?.name || 'Frameleaf',
      email: brand?.email || owner?.email || '',
      color: /^#[a-f\d]{6}$/i.test(brand?.color ?? '') ? brand!.color : '#577059',
      locale: localeOf(metadata),
    };
  }
  private async mail(
    delivery: Delivery,
    to: string,
    studio: { name: string; color: string; email: string; locale: string },
    message: { subject: string; heading: string; body: string; url?: string },
  ) {
    const html = await render(
      createElement(
        EmailLocaleContext.Provider,
        { value: studio.locale },
        createElement(PhotographyContractEmail, {
          studioName: studio.name,
          color: studio.color,
          heading: message.heading,
          body: message.body,
          button: message.url ? emailText(studio.locale, 'invoice_email_button') : undefined,
          url: message.url,
        }),
      ),
    );
    const { smtp, provider } = delivery;
    const payload = {
      from: smtp.from,
      replyTo: studio.email || smtp.replyTo || smtp.from,
      to,
      subject: message.subject,
      html,
      text: toPlainText(html),
    };
    await (provider
      ? sendConnectedEmail(this.mailDeps, provider, payload)
      : this.emailRepository.sendEmail({ ...payload, smtp: smtp.transport }));
  }
}
