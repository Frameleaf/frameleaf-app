import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { BookingRow, BookingTypeRow } from 'src/repositories/photography-booking.repository.js';
import { PhotographyBookingService } from 'src/services/photography-booking.service.js';

const ownerId = randomUUID();
const auth = { user: { id: ownerId }, session: { id: 's' } } as unknown as AuthDto;

const setup = (ready = true) => {
  const types: BookingTypeRow[] = [];
  const bookings: BookingRow[] = [];
  const repository = {
    types: vi.fn((owner: string, activeOnly = false) =>
      Promise.resolve(types.filter((t) => t.ownerId === owner && (!activeOnly || t.active))),
    ),
    type: vi.fn((id: string) => Promise.resolve(types.find((t) => t.id === id))),
    createType: vi.fn((owner: string, input: Omit<BookingTypeRow, 'id' | 'ownerId' | 'createdAt'>) => {
      const row = { ...input, id: randomUUID(), ownerId: owner, createdAt: new Date() };
      types.push(row);
      return Promise.resolve(row);
    }),
    createBooking: vi.fn((b: Omit<BookingRow, 'id' | 'status' | 'requestedAt' | 'depositPaymentId'>) => {
      const row = {
        ...b,
        id: randomUUID(),
        status: 'requested' as const,
        requestedAt: new Date(),
        depositPaymentId: null,
      };
      bookings.push(row);
      return Promise.resolve(row);
    }),
    recentRequest: vi.fn((owner: string, typeId: string, email: string) =>
      Promise.resolve(
        bookings.findLast((b) => b.ownerId === owner && b.bookingTypeId === typeId && b.clientEmail === email),
      ),
    ),
    setDepositPayment: vi.fn((id: string, paymentId: string) => {
      bookings.find((b) => b.id === id)!.depositPaymentId = paymentId;
      return Promise.resolve();
    }),
  };
  const payments = {
    createStandalonePayment: vi.fn(() => Promise.resolve({ id: randomUUID() })),
    setCheckout: vi.fn(() => Promise.resolve()),
  };
  const site = {
    liveStudio: vi.fn(() => Promise.resolve({ ownerId, site: { title: 'Cedar & Light' } })),
    addInquiry: vi.fn(() => Promise.resolve()),
  };
  const clients = {
    ready: vi.fn(() => Promise.resolve(ready)),
    publicUrl: vi.fn(() => Promise.resolve('https://photos.example')),
    checkout: vi.fn(() =>
      Promise.resolve({ id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1', expiresAt: '' }),
    ),
  };
  const service = new PhotographyBookingService(
    repository as never,
    payments as never,
    site as never,
    clients as never,
  );
  return { service, repository, payments, site, clients, types, bookings };
};

const mini = {
  name: 'Mini session',
  description: '',
  durationMinutes: 30,
  price: 20_000,
  deposit: 5000,
  currency: 'CAD' as const,
  active: true,
  addOns: [
    { id: 'prints', name: 'Print set', price: 4000, maxQuantity: 3 },
    { id: 'pet', name: 'Bring a pet', price: 2500, maxQuantity: 1 },
  ],
  order: 0,
};
const request = (bookingTypeId: string, extra: object = {}) => ({
  bookingTypeId,
  name: 'Sam',
  email: 'sam@example.com',
  preferredDates: ['2027-04-01'],
  addOns: [{ id: 'prints', quantity: 2 }],
  message: 'Golden hour please',
  ...extra,
});

describe(PhotographyBookingService.name, () => {
  it('prices the request on the server from the stored type and opens the deposit checkout', async () => {
    const s = setup();
    const type = await s.service.createType(auth, mini);
    const answer = await s.service.request('cedar', request(type.id), 'https://photos.example');
    expect(answer).toMatchObject({
      total: 28_000,
      deposit: 5000,
      currency: 'CAD',
      checkoutUrl: expect.stringContaining('checkout.stripe.com'),
    });
    expect(s.bookings[0]).toMatchObject({
      total: 28_000,
      addOns: [{ id: 'prints', name: 'Print set', price: 4000, quantity: 2 }],
    });
    expect(s.clients.checkout).toHaveBeenCalledWith(
      ownerId,
      expect.objectContaining({
        amount: 5000,
        reference: expect.stringMatching(/^booking:/),
        successUrl: 'https://photos.example/studio/cedar?booking=sent',
      }),
    );
    expect(s.bookings[0].depositPaymentId).not.toBeNull();
    expect(s.site.addInquiry).toHaveBeenCalledWith(
      ownerId,
      expect.anything(),
      expect.objectContaining({ name: 'Sam', type: 'Mini session' }),
    );
  });

  it('refuses unknown add-ons, quantities over the limit and inactive or foreign types', async () => {
    const s = setup();
    const type = await s.service.createType(auth, mini);
    await expect(
      s.service.request('cedar', request(type.id, { addOns: [{ id: 'drone', quantity: 1 }] }), null),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      s.service.request('cedar', request(type.id, { addOns: [{ id: 'pet', quantity: 2 }] }), null),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      s.service.request(
        'cedar',
        request(type.id, {
          addOns: [
            { id: 'pet', quantity: 1 },
            { id: 'pet', quantity: 1 },
          ],
        }),
        null,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    // A price sent by the client isn't even accepted by the form.
    await expect(s.service.request('cedar', request(type.id, { total: 1 }) as never, null)).rejects.toThrow();
    s.types[0].active = false;
    await expect(s.service.request('cedar', request(type.id), null)).rejects.toBeInstanceOf(NotFoundException);
    s.types[0].active = true;
    s.types[0].ownerId = randomUUID();
    await expect(s.service.request('cedar', request(type.id), null)).rejects.toBeInstanceOf(NotFoundException);
    expect(s.bookings).toHaveLength(0);
  });

  it('keeps nothing from bots, and books without a checkout when no payment account is ready', async () => {
    const s = setup(false);
    const type = await s.service.createType(auth, mini);
    expect(await s.service.request('cedar', request(type.id, { website: 'https://spam.example' }), null)).toMatchObject(
      { checkoutUrl: null },
    );
    expect(s.bookings).toHaveLength(0);
    expect(s.site.addInquiry).not.toHaveBeenCalled();
    expect(await s.service.request('cedar', request(type.id), null)).toMatchObject({
      total: 28_000,
      checkoutUrl: null,
    });
    expect(s.bookings[0].depositPaymentId).toBeNull();
    expect(s.clients.checkout).not.toHaveBeenCalled();
  });

  it('lists only active types publicly, and only to studio sessions privately', async () => {
    const s = setup();
    await s.service.createType(auth, mini);
    await s.service.createType(auth, { ...mini, name: 'Retired', active: false });
    expect((await s.service.publicTypes('cedar')).types.map((t) => t.name)).toEqual(['Mini session']);
    expect((await s.service.types(auth)).types).toHaveLength(2);
    await expect(s.service.types({ ...auth, sharedLink: {} } as never)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('takes the booking even when checkout or the lead fails, and a resend resumes the same booking and deposit', async () => {
    const s = setup();
    const type = await s.service.createType(auth, mini);
    s.site.addInquiry.mockRejectedValueOnce(new Error('Studio settings storage limit reached'));
    s.clients.checkout.mockRejectedValueOnce(new Error('Frameleaf Cloud unreachable'));
    expect(await s.service.request('cedar', request(type.id), 'https://photos.example')).toMatchObject({
      total: 28_000,
      checkoutUrl: null,
    });
    expect(s.bookings).toHaveLength(1);
    const paymentId = s.bookings[0].depositPaymentId;
    expect(paymentId).not.toBeNull();
    // The client sends the form again: same booking, no second lead, same deposit payment and idempotency key.
    const again = await s.service.request('cedar', request(type.id), 'https://photos.example');
    expect(again.checkoutUrl).toContain('checkout.stripe.com');
    expect(s.bookings).toHaveLength(1);
    expect(s.site.addInquiry).toHaveBeenCalledTimes(1);
    expect(s.payments.createStandalonePayment).toHaveBeenCalledTimes(1);
    const keys = s.clients.checkout.mock.calls.map(
      (call) => (call as unknown as [string, { idempotencyKey: string }])[1].idempotencyKey,
    );
    expect(keys).toEqual([`payment-${paymentId}`, `payment-${paymentId}`]);
  });
});
