import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PhotographyInvoiceService } from 'src/services/photography-invoice.service.js';
import { factory } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const token = 'a'.repeat(64);
const invoice = {
  id: 'invoice',
  ownerId: 'owner',
  number: 42,
  clientName: 'Morgan',
  clientEmail: 'morgan@example.test',
  lines: [{ description: 'Portrait session', quantity: 1, unitPrice: 30_000 }],
  taxBasisPoints: 500,
  currency: 'CAD',
  subtotal: 30_000,
  tax: 1500,
  total: 31_500,
  schedule: [
    { dueOn: '2027-05-22', amount: 10_000 },
    { dueOn: '2027-06-22', amount: 21_500 },
  ],
  reminders: true,
  status: 'sent',
  tokenHashes: [],
  sentAt: new Date(),
  lastReminderOn: null,
  createdAt: new Date(),
  paid: 0,
};

describe(PhotographyInvoiceService.name, () => {
  let sut: PhotographyInvoiceService;
  let mocks: ServiceMocks;
  const invoices = {
    create: vi.fn(),
    get: vi.fn(),
    byToken: vi.fn(),
    attempt: vi.fn(),
    setCheckout: vi.fn(),
    payment: vi.fn(),
    transition: vi.fn(),
    recordManual: vi.fn(),
    remindable: vi.fn(),
    claimReminder: vi.fn(),
    send: vi.fn(),
  };
  const payments = { ready: vi.fn(), checkout: vi.fn(), onPayment: vi.fn() };
  const delivery = vi.fn();
  const auth = factory.auth({ session: {} });

  beforeEach(() => {
    vi.resetAllMocks();
    ({ sut, mocks } = newTestService(PhotographyInvoiceService));
    Object.assign(sut, {
      invoices,
      payments,
      campaigns: { delivery },
      workspace: { get: vi.fn().mockResolvedValue({ value: { brand: { name: 'Cedar & Light', color: '#577059' } } }) },
      studioRecords: { studioOwner: vi.fn().mockResolvedValue({ name: 'Owner', email: 'studio@example.test' }) },
      workflow: {
        studioOwner: (candidate: typeof auth) => {
          if (!candidate.session || candidate.apiKey || candidate.sharedLink) throw new ForbiddenException();
          return candidate.user.id;
        },
      },
    });
    mocks.user.getMetadata.mockResolvedValue([]);
    delivery.mockResolvedValue({
      ready: true,
      baseUrl: 'https://studio.test',
      smtp: { from: 's@x.test', transport: {} },
    });
    mocks.email.sendEmail.mockResolvedValue({ messageId: 'sent', response: 'ok' });
    payments.ready.mockResolvedValue(true);
  });

  it('computes totals, tax and the schedule on the server', async () => {
    invoices.create.mockResolvedValue('invoice');
    invoices.get.mockResolvedValue(invoice);
    await sut.create(auth, {
      clientName: 'Morgan',
      clientEmail: 'Morgan@Example.test',
      lines: [{ description: 'Portrait session', quantity: 2, unitPrice: 15_000 }],
      taxBasisPoints: 500,
      currency: 'CAD',
      deposit: 10_000,
      depositDue: '2027-05-22',
      balanceDue: '2027-06-22',
      reminders: true,
    });
    expect(invoices.create).toHaveBeenCalledWith(
      auth.user.id,
      expect.objectContaining({
        clientEmail: 'morgan@example.test',
        subtotal: 30_000,
        tax: 1500,
        total: 31_500,
        schedule: invoice.schedule,
      }),
    );
    await expect(
      sut.create(auth, {
        clientName: 'M',
        clientEmail: 'm@example.test',
        lines: [{ description: 'x', quantity: 1, unitPrice: 100 }],
        taxBasisPoints: 0,
        currency: 'CAD',
        deposit: 100,
        depositDue: '2027-05-22',
        balanceDue: '2027-06-22',
        reminders: false,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('checks out exactly the amount due now, never an amount from the client', async () => {
    invoices.byToken.mockResolvedValue({ ...invoice, paid: 4000 });
    invoices.attempt.mockResolvedValue({ payment: { id: '00000000-0000-4000-8000-000000000001', amount: 6000 } });
    payments.checkout.mockResolvedValue({ id: 'cs_1', url: 'https://checkout.stripe.com/c/cs_1' });
    await sut.checkout(token, 'https://studio.test');
    expect(invoices.byToken).toHaveBeenCalledWith(sha256(token));
    expect(payments.checkout).toHaveBeenCalledWith(
      'owner',
      expect.objectContaining({
        reference: 'invoice:00000000-0000-4000-8000-000000000001',
        amount: 6000,
        currency: 'cad',
      }),
    );
    invoices.attempt.mockResolvedValue(null);
    await expect(sut.checkout(token, 'https://studio.test')).rejects.toBeInstanceOf(ConflictException);
    await expect(sut.publicView('nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('settles a matching payment event and ignores one for another session or amount', async () => {
    const payment = {
      id: '00000000-0000-4000-8000-000000000001',
      ownerId: 'owner',
      invoiceId: 'invoice',
      amount: 10_000,
      currency: 'CAD',
      checkoutId: 'cs_1',
      providerRef: null,
    };
    invoices.payment.mockResolvedValue(payment);
    invoices.transition.mockResolvedValue({ moved: true, overpaid: false });
    const event = {
      id: 'evt_1',
      ownerId: 'owner',
      type: 'payment.succeeded',
      reference: `invoice:${payment.id}`,
      sessionId: 'cs_1',
      paymentIntent: 'pi_1',
      amount: 10_000,
      currency: 'cad',
    };
    await sut.paymentEvent(event as never);
    expect(invoices.transition).toHaveBeenCalledWith(payment.id, ['pending', 'failed', 'expired'], 'paid', 'pi_1');
    invoices.transition.mockClear();
    await sut.paymentEvent({ ...event, amount: 9999 } as never);
    await sut.paymentEvent({ ...event, sessionId: 'cs_other' } as never);
    await sut.paymentEvent({ ...event, ownerId: 'someone-else' } as never);
    expect(invoices.transition).not.toHaveBeenCalled();
  });

  it('refuses a manual payment above the balance', async () => {
    invoices.recordManual.mockResolvedValue(false);
    await expect(sut.markPaid(auth, 'invoice', 99_999)).rejects.toBeInstanceOf(ConflictException);
  });

  it('sends a reminder only when one is due, once a day', async () => {
    invoices.remindable.mockResolvedValue([
      { ...invoice, id: 'due', schedule: [{ dueOn: new Date().toISOString().slice(0, 10), amount: 31_500 }] },
      { ...invoice, id: 'later', schedule: [{ dueOn: '2999-01-01', amount: 31_500 }] },
    ]);
    invoices.claimReminder.mockResolvedValue(true);
    invoices.send.mockResolvedValue(true);
    await sut.remind();
    expect(invoices.claimReminder).toHaveBeenCalledExactlyOnceWith('due', expect.any(String));
    expect(mocks.email.sendEmail).toHaveBeenCalledOnce();
    expect(mocks.email.sendEmail.mock.calls[0][0].html).toMatch(/photography\/invoice\/[a-f\d]{64}/);
  });

  it('renders the invoice PDF', async () => {
    invoices.get.mockResolvedValue({ ...invoice, paid: 10_000 });
    const { name, buffer } = await sut.pdf(auth, 'invoice');
    expect(name).toBe('CL-0042.pdf');
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
