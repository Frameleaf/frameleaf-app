import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import {
  PhotographyPayCheckoutDto,
  PhotographyPaymentLinkCreateDto,
  PhotographyPaymentLinkUpdateDto,
} from 'src/dtos/photography-payment.dto.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import {
  type PaymentLinkRow,
  type PaymentRow,
  PhotographyPaymentRepository,
} from 'src/repositories/photography-payment.repository.js';
import { PhotographyWorkflowRepository } from 'src/repositories/photography-workflow.repository.js';
import { PhotographyWorkspaceRepository } from 'src/repositories/photography-workspace.repository.js';
import { type ClientsPaymentEvent, ClientsPaymentsService } from 'src/services/clients-payments.service.js';

const SLUG = /^[A-Za-z0-9_-]{16}$/;
const unavailable = () => new NotFoundException('This payment link is unavailable');

const linkView = (link: PaymentLinkRow & { payments?: number; collected?: number | string }) => ({
  id: link.id,
  slug: link.slug,
  title: link.title,
  description: link.description,
  amount: link.amount,
  currency: link.currency,
  reusable: link.reusable,
  active: link.active,
  payments: link.payments ?? 0,
  // A sum is bigint in PostgreSQL; well inside a JS number for any studio's totals.
  collected: Number(link.collected ?? 0),
  createdAt: new Date(link.createdAt).toISOString(),
});

/**
 * FL-1041: payment links. A studio sets a title and an amount; anyone with the link pays exactly
 * that through the studio's own connected Stripe account (FL-1037). A single-use link closes after
 * its first successful payment. Payment events arrive through ClientsPaymentsService as `link:<id>`.
 */
@Injectable()
export class PhotographyPaymentService {
  constructor(
    private repository: PhotographyPaymentRepository,
    private workspace: PhotographyWorkspaceRepository,
    private workflow: PhotographyWorkflowRepository,
    private payments: ClientsPaymentsService,
    private logger?: LoggingRepository,
  ) {
    this.payments.onPayment('link', (event) => this.paymentEvent(event));
  }

  private studio(auth: AuthDto) {
    if (!auth.session || auth.apiKey || auth.sharedLink) throw new ForbiddenException('Studio session required');
    return auth.user.id;
  }

  async links(auth: AuthDto) {
    const ownerId = this.studio(auth);
    const [links, ready] = await Promise.all([this.repository.links(ownerId), this.payments.ready(ownerId)]);
    return { links: links.map((link) => linkView(link)), ready };
  }

  async create(auth: AuthDto, dto: PhotographyPaymentLinkCreateDto) {
    const ownerId = this.studio(auth);
    if (!(await this.payments.ready(ownerId)))
      throw new ConflictException({ code: 'payments-not-connected', message: 'Connect a payment account first' });
    const link = await this.repository.createLink({
      ownerId,
      slug: randomBytes(12).toString('base64url'),
      title: dto.title,
      description: dto.description,
      amount: dto.amount,
      currency: dto.currency,
      reusable: dto.reusable,
    });
    return linkView(link);
  }

  async update(auth: AuthDto, id: string, dto: PhotographyPaymentLinkUpdateDto) {
    const link = await this.repository.updateLink(id, this.studio(auth), dto);
    if (!link) throw new NotFoundException();
    return linkView(link);
  }

  async remove(auth: AuthDto, id: string) {
    if (!(await this.repository.deleteLink(id, this.studio(auth)))) throw new NotFoundException();
  }

  async paymentList(auth: AuthDto) {
    const rows = await this.repository.payments(this.studio(auth));
    return {
      payments: rows.map((p) => ({
        id: p.id,
        linkId: p.linkId,
        title: p.title,
        amount: p.amount,
        currency: p.currency,
        payerEmail: p.payerEmail,
        status: p.status as 'paid' | 'failed' | 'expired' | 'refunded',
        createdAt: new Date(p.createdAt).toISOString(),
      })),
    };
  }

  /** An open link, or a 404 that says nothing about the studio. */
  private async open(slug: string) {
    if (!SLUG.test(slug)) throw unavailable();
    const link = await this.repository.linkBySlug(slug);
    if (!link?.active) throw unavailable();
    if (!link.reusable && (await this.repository.paidCount(link.id)) > 0) throw unavailable();
    return link;
  }

  /** `GET /photography/pay/:slug`. */
  async publicLink(slug: string) {
    const link = await this.open(slug);
    const brand = (await this.workspace.get(link.ownerId))?.value.brand;
    return {
      title: link.title,
      description: link.description,
      amount: link.amount,
      currency: link.currency,
      brand: {
        name: brand?.name ?? (await this.workflow.ownerName(link.ownerId)) ?? '',
        email: brand?.email ?? '',
        color: brand?.color ?? '#577059',
        logoInitials: brand?.logoInitials ?? '',
      },
    };
  }

  /** `POST /photography/pay/:slug/checkout`: the amount always comes from the link, never the payer. */
  async checkout(slug: string, dto: PhotographyPayCheckoutDto, origin: string) {
    const link = await this.open(slug);
    if (!(await this.payments.ready(link.ownerId))) throw unavailable();
    // ponytail: a single-use link is held for 30 minutes while someone is paying it (checked and taken in one
    // locked step); a payment that still lands after that is recorded as paid and logged for a refund in Stripe.
    const payment = await this.repository.createPayment(link, dto.email);
    if (!payment)
      throw new ConflictException({ code: 'payment-in-progress', message: 'Someone is paying this link now' });
    const back = `${origin}/photography/pay/${link.slug}`;
    try {
      return await this.startCheckout(link, payment, dto.email, back);
    } catch (error) {
      // Stripe's page never reached the payer: release the hold so they can try again. If a session was made after all,
      // its payment still lands (a failed payment can become paid), matched by its reference.
      await this.repository.transition(payment.id, ['pending'], 'failed', null);
      throw error;
    }
  }

  private async startCheckout(link: PaymentLinkRow, payment: PaymentRow, email: string, back: string) {
    const session = await this.payments.checkout(link.ownerId, {
      reference: `link:${payment.id}`,
      idempotencyKey: `payment-${payment.id}`,
      name: link.title,
      amount: link.amount,
      currency: link.currency.toLowerCase(),
      customerEmail: email,
      successUrl: `${back}?payment=${payment.id}`,
      cancelUrl: back,
    });
    if (!session.url.startsWith('https://checkout.stripe.com/'))
      throw new ConflictException('Invalid hosted checkout response');
    await this.repository.setCheckout(payment.id, session.id);
    return { url: session.url, paymentId: payment.id };
  }

  /** `GET /photography/pay/:slug/payments/:id`: the thank-you page's check. The id is unguessable. */
  async paymentStatus(slug: string, id: string) {
    const link = await this.repository.linkBySlug(slug);
    const payment = link ? await this.repository.payment(id) : undefined;
    if (!link || payment?.linkId !== link.id) throw unavailable();
    return { status: payment.status, amount: payment.amount, currency: payment.currency };
  }

  /** A relayed Stripe event for `link:<payment id>`. Replays and out-of-order events change nothing. */
  async paymentEvent(event: ClientsPaymentEvent) {
    const id = event.reference?.slice('link:'.length) ?? '';
    if (!/^[a-f0-9-]{36}$/.test(id)) return;
    const payment = await this.repository.payment(id);
    if (!payment || payment.ownerId !== event.ownerId) return;
    const transitions: Record<string, [PaymentRow['status'][], PaymentRow['status']]> = {
      'payment.succeeded': [['pending', 'failed', 'expired'], 'paid'],
      'payment.failed': [['pending'], 'failed'],
      'payment.expired': [['pending'], 'expired'],
      // Stripe refunds only money it took, so a refund settles the payment even when its success comes later.
      'payment.refunded': [['pending', 'failed', 'expired', 'paid'], 'refunded'],
    };
    const move = transitions[event.type];
    if (!move) return;
    if (event.type === 'payment.refunded') {
      // Cloud took the reference from this payment's own PaymentIntent; a different intent already on file is not it.
      if (!event.paymentIntent || (payment.providerRef && payment.providerRef !== event.paymentIntent)) return;
    } else if (
      // No session on file means checkout creation failed before its id came back; the reference, which Cloud read
      // from that session's own metadata, still ties the event to this payment.
      (payment.checkoutId !== null && event.sessionId !== payment.checkoutId) ||
      (event.type === 'payment.succeeded' &&
        (event.amount !== payment.amount || event.currency?.toUpperCase() !== payment.currency))
    ) {
      return;
    }
    const { duplicate } = await this.repository.transition(payment.id, move[0], move[1], event.paymentIntent);
    if (duplicate)
      this.logger?.warn(`Payment ${payment.id} paid a single-use link that was already paid; refund it in Stripe`);
  }
}
