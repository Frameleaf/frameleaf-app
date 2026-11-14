import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { PaymentLinkRow, PaymentRow } from 'src/repositories/photography-payment.repository.js';
import { MlAdmissionRefusal, SystemMetadataKey } from 'src/enum.js';
import { type ClientsPaymentEvent, ClientsPaymentsService } from 'src/services/clients-payments.service.js';
import { PhotographyPaymentService } from 'src/services/photography-payment.service.js';
import { FrameleafCloudError } from 'src/utils/frameleaf-cloud.js';

// The identity key itself is not what these tests are about.
vi.mock('src/utils/frameleaf-cloud-gateway.js', async (original) => ({
  ...(await original<typeof import('src/utils/frameleaf-cloud-gateway.js')>()),
  loadInstanceIdentity: vi.fn(() => Promise.resolve({})),
}));

const ownerId = randomUUID();
const auth = { user: { id: ownerId }, session: { id: 's' } } as unknown as AuthDto;

const setup = () => {
  const links: PaymentLinkRow[] = [];
  const payments: PaymentRow[] = [];
  const repository = {
    links: vi.fn(() => Promise.resolve(links.map((l) => ({ ...l, payments: 0, collected: 0 })))),
    linkBySlug: vi.fn((slug: string) => Promise.resolve(links.find((l) => l.slug === slug))),
    createLink: vi.fn((link: Omit<PaymentLinkRow, 'id' | 'active' | 'createdAt'>) => {
      const row = { ...link, id: randomUUID(), active: true, createdAt: new Date() };
      links.push(row);
      return Promise.resolve(row);
    }),
    paidCount: vi.fn((linkId: string) =>
      Promise.resolve(payments.filter((p) => p.linkId === linkId && ['paid', 'refunded'].includes(p.status)).length),
    ),
    payment: vi.fn((id: string) => Promise.resolve(payments.find((p) => p.id === id))),
    createPayment: vi.fn((link: PaymentLinkRow, payerEmail: string) => {
      if (!link.reusable && payments.some((p) => p.linkId === link.id && ['pending', 'paid'].includes(p.status))) {
        return Promise.resolve(undefined);
      }
      const row: PaymentRow = {
        id: randomUUID(),
        ownerId: link.ownerId,
        linkId: link.id,
        amount: link.amount,
        currency: link.currency,
        payerEmail,
        checkoutId: null,
        providerRef: null,
        status: 'pending',
        createdAt: new Date(),
        paidAt: null,
      };
      payments.push(row);
      return Promise.resolve(row);
    }),
    setCheckout: vi.fn((id: string, checkoutId: string) => {
      payments.find((p) => p.id === id)!.checkoutId = checkoutId;
      return Promise.resolve();
    }),
    pendingAttempt: vi.fn((linkId: string, email: string) =>
      Promise.resolve(
        payments.find((p) => p.linkId === linkId && p.payerEmail === email && p.status === 'pending' && !p.checkoutId),
      ),
    ),
    pendingSince: vi.fn((linkId: string) =>
      Promise.resolve(payments.some((p) => p.linkId === linkId && p.status === 'pending')),
    ),
    transition: vi.fn((id: string, from: PaymentRow['status'][], to: PaymentRow['status'], ref: string | null) => {
      const p = payments.find((p) => p.id === id)!;
      if (!from.includes(p.status)) return Promise.resolve({ moved: false, duplicate: false });
      const link = links.find((l) => l.id === p.linkId);
      const duplicate =
        to === 'paid' && !!link && !link.reusable && payments.some((o) => o.linkId === link.id && o.status === 'paid');
      p.status = to;
      p.providerRef = ref ?? p.providerRef;
      if (to === 'paid' && link && !link.reusable) link.active = false;
      return Promise.resolve({ moved: true, duplicate });
    }),
  };
  let n = 0;
  const clients = {
    onPayment: vi.fn(),
    ready: vi.fn(() => Promise.resolve(true)),
    checkout: vi.fn(() =>
      Promise.resolve({ id: `cs_${++n}`, url: `https://checkout.stripe.com/c/pay/cs_${n}`, expiresAt: '' }),
    ),
  };
  const workspace = {
    get: vi.fn(() =>
      Promise.resolve({
        value: { brand: { name: 'Cedar & Light', email: 'hi@cedar.test', color: '#123456', logoInitials: 'CL' } },
      }),
    ),
  };
  const service = new PhotographyPaymentService(
    repository as never,
    workspace as never,
    { ownerName: vi.fn() } as never,
    clients as never,
  );
  const event = (payment: PaymentRow, type: string, extra: Partial<ClientsPaymentEvent> = {}): ClientsPaymentEvent => ({
    id: `evt_${randomUUID()}`,
    type,
    owner: 'f'.repeat(64),
    ownerId,
    createdAt: new Date().toISOString(),
    reference: `link:${payment.id}`,
    sessionId: payment.checkoutId,
    paymentIntent: 'pi_1',
    amount: payment.amount,
    currency: payment.currency.toLowerCase(),
    payerEmail: payment.payerEmail,
    account: null,
    ...extra,
  });
  return { service, repository, clients, links, payments, event };
};

const draft = {
  title: 'Mini-session deposit',
  description: '',
  amount: 15_000,
  currency: 'CAD' as const,
  reusable: true,
};

describe(PhotographyPaymentService.name, () => {
  it('registers for link payments and blocks creating a link without a payment account', async () => {
    const s = setup();
    expect(s.clients.onPayment).toHaveBeenCalledWith('link', expect.any(Function));
    s.clients.ready.mockResolvedValueOnce(false);
    await expect(s.service.create(auth, draft)).rejects.toBeInstanceOf(ConflictException);
    await expect(s.service.links({ ...auth, sharedLink: {} } as never)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('charges the link’s own amount, accepts many payments on a reusable link, and ignores replays', async () => {
    const s = setup();
    const link = await s.service.create(auth, draft);
    expect(link.slug).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(await s.service.publicLink(link.slug)).toMatchObject({ amount: 15_000, brand: { name: 'Cedar & Light' } });
    for (const email of ['a@example.com', 'b@example.com']) {
      const { paymentId } = await s.service.checkout(link.slug, { email }, 'https://photos.example');
      const payment = s.payments.find((p) => p.id === paymentId)!;
      expect(s.clients.checkout).toHaveBeenLastCalledWith(
        ownerId,
        expect.objectContaining({ amount: 15_000, currency: 'cad', reference: `link:${paymentId}` }),
      );
      const paid = s.event(payment, 'payment.succeeded');
      await s.service.paymentEvent(paid);
      await s.service.paymentEvent(paid);
      expect(payment.status).toBe('paid');
    }
    expect(s.payments.filter((p) => p.status === 'paid')).toHaveLength(2);
    expect((await s.service.paymentStatus(link.slug, s.payments[0].id)).status).toBe('paid');
  });

  it('closes a single-use link after its first payment, and refuses a wrong amount or another studio', async () => {
    const s = setup();
    const link = await s.service.create(auth, { ...draft, reusable: false });
    const { paymentId } = await s.service.checkout(link.slug, { email: 'a@example.com' }, 'https://photos.example');
    const payment = s.payments.find((p) => p.id === paymentId)!;
    // While one payer is at checkout, a single-use link takes no second payer.
    await expect(s.service.checkout(link.slug, { email: 'c@example.com' }, 'https://x.example')).rejects.toBeInstanceOf(
      ConflictException,
    );
    await s.service.paymentEvent(s.event(payment, 'payment.succeeded', { amount: 1 }));
    await s.service.paymentEvent(s.event(payment, 'payment.succeeded', { ownerId: randomUUID() }));
    await s.service.paymentEvent(s.event(payment, 'payment.succeeded', { sessionId: 'cs_other' }));
    expect(payment.status).toBe('pending');
    await s.service.paymentEvent(s.event(payment, 'payment.succeeded'));
    expect(payment.status).toBe('paid');
    await expect(s.service.publicLink(link.slug)).rejects.toBeInstanceOf(NotFoundException);
    await expect(s.service.checkout(link.slug, { email: 'b@example.com' }, 'https://x.example')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    // An expiry after payment changes nothing; a refund of that payment is recorded.
    await s.service.paymentEvent(s.event(payment, 'payment.expired'));
    await s.service.paymentEvent(s.event(payment, 'payment.refunded', { sessionId: null, paymentIntent: 'pi_other' }));
    expect(payment.status).toBe('paid');
    await s.service.paymentEvent(s.event(payment, 'payment.refunded', { sessionId: null }));
    expect(payment.status).toBe('refunded');
  });

  it('records a refund that arrives before its payment; the late success changes nothing', async () => {
    const s = setup();
    const link = await s.service.create(auth, draft);
    const { paymentId } = await s.service.checkout(link.slug, { email: 'a@example.com' }, 'https://photos.example');
    const payment = s.payments.find((p) => p.id === paymentId)!;
    await s.service.paymentEvent(s.event(payment, 'payment.failed'));
    expect(payment).toMatchObject({ status: 'failed', providerRef: 'pi_1' });
    // A refund for a different payment intent is not this payment's.
    await s.service.paymentEvent(s.event(payment, 'payment.refunded', { sessionId: null, paymentIntent: 'pi_other' }));
    expect(payment.status).toBe('failed');
    await s.service.paymentEvent(s.event(payment, 'payment.refunded', { sessionId: null }));
    expect(payment.status).toBe('refunded');
    await s.service.paymentEvent(s.event(payment, 'payment.succeeded'));
    expect(payment.status).toBe('refunded');
  });

  it('releases a single-use link when Cloud refuses the checkout', async () => {
    const s = setup();
    const link = await s.service.create(auth, { ...draft, reusable: false });
    s.clients.checkout.mockRejectedValueOnce(
      new FrameleafCloudError(MlAdmissionRefusal.RequestInvalid, 422, 'refused'),
    );
    await expect(s.service.checkout(link.slug, { email: 'a@example.com' }, 'https://photos.example')).rejects.toThrow();
    expect(s.payments[0]).toMatchObject({ status: 'failed', checkoutId: null });
    const { paymentId } = await s.service.checkout(link.slug, { email: 'b@example.com' }, 'https://photos.example');
    expect(paymentId).not.toBe(s.payments[0].id);
  });

  it('retries an uncertain checkout with the same payment and idempotency key, so only one session can be paid', async () => {
    const s = setup();
    const link = await s.service.create(auth, { ...draft, reusable: false });
    s.clients.checkout.mockRejectedValueOnce(
      new FrameleafCloudError(MlAdmissionRefusal.CloudUnavailable, null, 'timeout'),
    );
    await expect(s.service.checkout(link.slug, { email: 'a@example.com' }, 'https://photos.example')).rejects.toThrow();
    expect(s.payments[0]).toMatchObject({ status: 'pending', checkoutId: null });
    const { paymentId } = await s.service.checkout(link.slug, { email: 'a@example.com' }, 'https://photos.example');
    expect(paymentId).toBe(s.payments[0].id);
    expect(s.payments).toHaveLength(1);
    const keys = s.clients.checkout.mock.calls.map(
      (call) => (call as unknown as [string, { idempotencyKey: string }])[1].idempotencyKey,
    );
    expect(new Set(keys).size).toBe(1);
    // Someone else is still held off while that attempt is open.
    await expect(s.service.checkout(link.slug, { email: 'b@example.com' }, 'https://x.example')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('shows a missing or turned-off link as unavailable, with nothing about the studio', async () => {
    const s = setup();
    await expect(s.service.publicLink('not-a-real-slug!')).rejects.toBeInstanceOf(NotFoundException);
    await expect(s.service.publicLink('A'.repeat(16))).rejects.toBeInstanceOf(NotFoundException);
    const link = await s.service.create(auth, draft);
    s.links[0].active = false;
    await expect(s.service.publicLink(link.slug)).rejects.toThrow('This payment link is unavailable');
    expect(s.repository.paidCount).not.toHaveBeenCalled();
  });

  it('stores a full batch of early refunds through the real handler before acknowledging, then takes the late success', async () => {
    const s = setup();
    const instanceId = randomUUID();
    const fingerprint = createHash('sha256').update(`${instanceId}${ownerId}`).digest('hex');
    const account = {
      fingerprint,
      status: 'active',
      chargesEnabled: true,
      requirementsDue: [],
      country: 'CA',
      defaultCurrency: 'cad',
      updatedAt: '',
    };
    let events: unknown[] = [];
    const acked: string[][] = [];
    let session = 0;
    const metadata = {
      get: vi.fn((key: SystemMetadataKey) =>
        Promise.resolve(
          key === SystemMetadataKey.FrameleafCloudLink
            ? { status: 'linked', instanceId, cloudUrl: 'https://cloud.example' }
            : key === SystemMetadataKey.ClientsPayments
              ? { accounts: { [ownerId]: account } }
              : null,
        ),
      ),
      setEntry: vi.fn(),
    };
    const cloud = {
      discovery: vi.fn(() => Promise.resolve({ api: 'https://api.cloud.example' })),
      accessToken: vi.fn(() => Promise.resolve({ accessToken: 't' })),
      requestJson: vi.fn(
        (schema: { parse: (v: unknown) => unknown }, request: { url: string; body?: { ids: string[] } }) => {
          const path = new URL(request.url).pathname;
          if (path.endsWith('/checkout')) {
            session++;
            return Promise.resolve(
              schema.parse({
                id: `cs_${session}`,
                url: `https://checkout.stripe.com/c/pay/cs_${session}`,
                expiresAt: '',
              }),
            );
          }
          if (path.endsWith('/events')) {
            // Cloud's contract: unacknowledged events come back, oldest first.
            const waiting = events.filter((e) => !acked.flat().includes((e as { id: string }).id));
            return Promise.resolve(schema.parse({ events: waiting.slice(0, 50) }));
          }
          acked.push(request.body!.ids);
          return Promise.resolve({});
        },
      ),
    };
    const clients = new ClientsPaymentsService(
      cloud as never,
      { getEnv: () => ({ frameleafCloud: { url: 'https://cloud.example' } }) } as never,
      { withLock: (_lock: unknown, fn: () => unknown) => fn() } as never,
      metadata as never,
      { loadOrCreate: vi.fn(), currentSigner: vi.fn() } as never,
      { setContext: vi.fn(), warn: vi.fn() } as never,
    );
    const service = new PhotographyPaymentService(
      s.repository as never,
      { get: vi.fn() } as never,
      { ownerName: vi.fn() } as never,
      clients,
    );
    const link = await service.create(auth, draft);
    for (let n = 0; n < 50; n++)
      await service.checkout(link.slug, { email: `p${n}@example.com` }, 'https://photos.example');
    const refund = (p: PaymentRow, n: number) => ({
      ...s.event(p, 'payment.refunded', { sessionId: null, paymentIntent: `pi_${n}` }),
      owner: fingerprint,
    });
    events = s.payments.map((p, n) => refund(p, n));
    events.push({ ...s.event(s.payments[7], 'payment.succeeded', { paymentIntent: 'pi_7' }), owner: fingerprint });

    await clients.collect();
    expect(acked[0]).toHaveLength(50);
    expect(s.payments.every((p) => p.status === 'refunded')).toBe(true);
    await clients.collect();
    expect(acked[1]).toEqual([(events[50] as { id: string }).id]);
    expect(s.payments[7].status).toBe('refunded');
  });
});
