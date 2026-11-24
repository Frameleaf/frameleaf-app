import { Kysely } from 'kysely';
import { createHash } from 'node:crypto';
import type { DB } from 'src/schema/index.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PhotographyInvoiceRepository } from 'src/repositories/photography-invoice.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { invoiceSchedule, invoiceTotals } from 'src/utils/photography-invoice.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const lines = [{ description: 'Portrait session', quantity: 1, unitPrice: 30_000 }];
const values = () => {
  const totals = invoiceTotals(lines, 0);
  return {
    clientName: 'Morgan',
    clientEmail: 'morgan@example.test',
    lines,
    taxBasisPoints: 0,
    currency: 'CAD',
    ...totals,
    schedule: invoiceSchedule(totals.total, 10_000, '2027-05-22', '2027-06-22'),
  };
};

it('numbers invoices sequentially per owner, even when created at once', async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const { user: other } = await ctx.newUser();
  const repository = new PhotographyInvoiceRepository(db);
  await Promise.all(Array.from({ length: 5 }, () => repository.create(user.id, values())));
  await repository.create(other.id, values());
  expect((await repository.list(user.id)).map(({ number }) => number)).toEqual([5, 4, 3, 2, 1]);
  expect((await repository.list(other.id)).map(({ number }) => number)).toEqual([1]);
});

it('refuses edits while a payer holds a checkout, and never counts money in an old currency (FL-1769)', async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const repository = new PhotographyInvoiceRepository(db);
  const id = await repository.create(user.id, values());
  await repository.send(user.id, id, sha256('held'));
  const attempt = await repository.attempt(id);
  expect(await repository.update(user.id, id, { ...values(), currency: 'USD' })).toBe(true); // no checkout page yet
  await repository.update(user.id, id, values());
  const held = await repository.attempt(id);
  await repository.setCheckout(held!.payment.id, 'cs_held');
  expect(await repository.update(user.id, id, { ...values(), currency: 'USD' })).toBe(false);

  // an attempt made before a currency change is paid late: recorded, owed back, and not counted
  await db.updateTable('photography_payment').set({ currency: 'EUR' }).where('id', '=', attempt!.payment.id).execute();
  expect(await repository.transition(attempt!.payment.id, ['pending'], 'paid', 'pi_old')).toEqual({
    moved: true,
    overpaid: true,
  });
  expect(await repository.get(user.id, id)).toMatchObject({ status: 'sent', paid: 0 });
});

it('moves to part-paid then paid, refuses an overpayment, and stops reminders once paid or voided', async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const repository = new PhotographyInvoiceRepository(db);
  const id = await repository.create(user.id, values());
  expect(await repository.recordManual(user.id, id, 100)).toBe(false); // a draft takes no payment
  await repository.send(user.id, id, sha256('first'));
  await repository.send(user.id, id, sha256('second'));
  expect((await repository.byToken(sha256('first')))?.id).toBe(id);
  expect((await repository.byToken(sha256('second')))?.id).toBe(id);

  const attempt = await repository.attempt(id);
  expect(attempt?.payment.amount).toBe(10_000);
  expect((await repository.attempt(id))?.reused).toBe(true);
  expect(await repository.transition(attempt!.payment.id, ['pending'], 'paid', 'pi_1')).toEqual({
    moved: true,
    overpaid: false,
  });
  expect(await repository.transition(attempt!.payment.id, ['pending'], 'paid', 'pi_1')).toEqual({
    moved: false,
    overpaid: false,
  });
  expect(await repository.get(user.id, id)).toMatchObject({ status: 'part', paid: 10_000 });

  expect(await repository.recordManual(user.id, id, 20_001)).toBe(false);
  expect(await repository.claimReminder(id, '2027-06-19')).toBe(true);
  expect(await repository.claimReminder(id, '2027-06-19')).toBe(false);
  expect(await repository.update(user.id, id, values())).toBe(false); // money recorded: no edits
  expect(await repository.recordManual(user.id, id, 20_000)).toBe(true);
  expect(await repository.get(user.id, id)).toMatchObject({ status: 'paid', paid: 30_000 });
  expect(await repository.remindable('2027-06-22')).toEqual([]);

  const voided = await repository.create(user.id, values());
  await repository.send(user.id, voided, sha256('voided'));
  expect((await repository.remindable('2027-06-22')).map((row) => row.id)).toEqual([voided]);
  await repository.void(user.id, voided);
  expect(await repository.byToken(sha256('voided'))).toBeUndefined();
  expect(await repository.remindable('2027-06-22')).toEqual([]);
});
