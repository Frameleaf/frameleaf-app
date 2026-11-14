import { Kysely } from 'kysely';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PhotographyBookingRepository } from 'src/repositories/photography-booking.repository.js';
import { PhotographyPaymentRepository } from 'src/repositories/photography-payment.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let database: Kysely<DB>;
beforeAll(async () => {
  database = await getKyselyDB();
});
afterAll(async () => {
  await database?.destroy();
});

describe(PhotographyBookingRepository.name, () => {
  it('stores booking types with add-ons, lists active ones, and reports a deposit by its payment (FL-1049)', async () => {
    const { ctx } = newMediumService(BaseService, { database, real: [], mock: [LoggingRepository] });
    const { user } = await ctx.newUser();
    const sut = new PhotographyBookingRepository(database);
    const payments = new PhotographyPaymentRepository(database);
    const addOns = [{ id: 'prints', name: 'Print set', price: 4000, maxQuantity: 3 }];
    const base = {
      description: '',
      durationMinutes: 30,
      price: 20_000,
      deposit: 5000,
      currency: 'CAD',
      addOns,
      order: 0,
    };
    const mini = await sut.createType(user.id, { ...base, name: 'Mini', active: true });
    await sut.createType(user.id, { ...base, name: 'Retired', active: false, order: 1 });
    expect(mini.addOns).toEqual(addOns);
    expect((await sut.types(user.id, true)).map((t) => t.name)).toEqual(['Mini']);
    expect(await sut.types(user.id)).toHaveLength(2);

    const request = {
      ownerId: user.id,
      bookingTypeId: mini.id,
      typeName: 'Mini',
      clientName: 'Sam',
      clientEmail: 'sam@example.com',
      message: '',
      preferredDates: ['2027-04-01'],
      addOns: [{ id: 'prints', name: 'Print set', price: 4000, quantity: 2 }],
      total: 28_000,
      deposit: 5000,
      currency: 'CAD',
    };
    // Overlapping resends of one request make one booking and one deposit payment.
    const sent = await Promise.all([sut.findOrCreateRequest(request, 30), sut.findOrCreateRequest(request, 30)]);
    expect(new Set(sent.map((r) => r.booking.id)).size).toBe(1);
    expect(sent.filter((r) => r.created)).toHaveLength(1);
    const booking = sent[0].booking;
    const claimed = await Promise.all([sut.claimDepositPayment(booking.id), sut.claimDepositPayment(booking.id)]);
    expect(claimed[0]).toBe(claimed[1]);
    // A changed request (another date) is a new booking.
    const other = await sut.findOrCreateRequest({ ...request, preferredDates: ['2027-05-01'] }, 30);
    expect(other.created).toBe(true);
    await payments.transition(claimed[0], ['pending'], 'paid', 'pi_1');
    const listed = (await sut.bookings(user.id)).find((b) => b.id === booking.id)!;
    expect(listed).toMatchObject({
      total: 28_000,
      depositStatus: 'paid',
      status: 'requested',
      preferredDates: ['2027-04-01'],
    });
    expect(await sut.setStatus(booking.id, user.id, 'confirmed')).toMatchObject({
      status: 'confirmed',
      depositStatus: 'paid',
    });
    // Deleting a type keeps its bookings.
    expect(await sut.deleteType(mini.id, user.id)).toBe(true);
    expect((await sut.bookings(user.id)).every((b) => b.bookingTypeId === null && b.typeName === 'Mini')).toBe(true);
  });
});
