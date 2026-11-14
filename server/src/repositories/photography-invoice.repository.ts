import { Injectable, NotFoundException } from '@nestjs/common';
import { Insertable, Kysely, Selectable, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { DB } from 'src/schema/index.js';
import type { PhotographyInvoiceTable } from 'src/schema/tables/photography-invoice.table.js';
import { UserStatus } from 'src/enum.js';
import { invoiceNext, invoiceStatus } from 'src/utils/photography-invoice.js';

export type InvoiceRow = Selectable<PhotographyInvoiceTable> & { paid: number };
type InvoiceValues = Omit<Insertable<PhotographyInvoiceTable>, 'ownerId' | 'number'>;
const paidSum = sql<number>`(SELECT coalesce(sum(p.amount),0)::int FROM photography_payment p
  WHERE p."invoiceId"=photography_invoice.id AND p.status='paid')`.as('paid');

/** FL-1081: invoices and the payments recorded against them. */
@Injectable()
export class PhotographyInvoiceRepository {
  constructor(@InjectKysely() private readonly db: Kysely<DB>) {}

  private select(db: Kysely<DB> = this.db) {
    return db.selectFrom('photography_invoice').selectAll().select(paidSum);
  }
  list(ownerId: string) {
    return this.select().where('ownerId', '=', ownerId).orderBy('number', 'desc').execute() as Promise<InvoiceRow[]>;
  }
  async get(ownerId: string, id: string) {
    const row = await this.select().where('ownerId', '=', ownerId).where('id', '=', id).executeTakeFirst();
    if (!row) throw new NotFoundException('Invoice is unavailable');
    return row as InvoiceRow;
  }
  /** A sent, unvoided invoice of an active studio. */
  byToken(tokenHash: string) {
    return this.select()
      .where(sql<boolean>`${tokenHash} = ANY("tokenHashes")`)
      .where('status', 'in', ['sent', 'part', 'paid'])
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('user')
            .select('user.id')
            .whereRef('user.id', '=', 'photography_invoice.ownerId')
            .where('user.deletedAt', 'is', null)
            .where('user.status', '=', UserStatus.Active),
        ),
      )
      .executeTakeFirst() as Promise<InvoiceRow | undefined>;
  }
  /** The next number is taken under a per-owner advisory lock, so numbers are sequential with no gaps from races. */
  create(ownerId: string, values: InvoiceValues) {
    return this.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`photography_invoice:${ownerId}`}, 0))`.execute(trx);
      const { max } = await trx
        .selectFrom('photography_invoice')
        .select((eb) => eb.fn.max('number').as('max'))
        .where('ownerId', '=', ownerId)
        .executeTakeFirstOrThrow();
      const { id } = await trx
        .insertInto('photography_invoice')
        .values({ ...values, ownerId, number: (max ?? 0) + 1 })
        .returning('id')
        .executeTakeFirstOrThrow();
      return id;
    });
  }
  /** Edits are allowed until money is recorded; returns false otherwise. */
  async update(ownerId: string, id: string, values: InvoiceValues) {
    const { numUpdatedRows } = await this.db
      .updateTable('photography_invoice')
      .set(values)
      .where('ownerId', '=', ownerId)
      .where('id', '=', id)
      .where('status', 'in', ['draft', 'sent'])
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('photography_payment as p')
              .select('p.id')
              .whereRef('p.invoiceId', '=', 'photography_invoice.id')
              .where('p.status', 'in', ['paid', 'refunded']),
          ),
        ),
      )
      .executeTakeFirst();
    return numUpdatedRows > 0n;
  }
  /** Adds an emailed link; links sent earlier keep working. */
  async send(ownerId: string, id: string, tokenHash: string) {
    const { numUpdatedRows } = await this.db
      .updateTable('photography_invoice')
      .set({
        tokenHashes: sql`array_append("tokenHashes", ${tokenHash})`,
        sentAt: new Date(),
        status: sql`CASE WHEN status='draft' THEN 'sent' ELSE status END`,
      })
      .where('ownerId', '=', ownerId)
      .where('id', '=', id)
      .where('status', 'in', ['draft', 'sent', 'part'])
      .executeTakeFirst();
    return numUpdatedRows > 0n;
  }
  async void(ownerId: string, id: string) {
    const { numUpdatedRows } = await this.db
      .updateTable('photography_invoice')
      .set({ status: 'void', tokenHashes: sql`'{}'` })
      .where('ownerId', '=', ownerId)
      .where('id', '=', id)
      .where('status', 'in', ['draft', 'sent', 'part'])
      .executeTakeFirst();
    return numUpdatedRows > 0n;
  }
  async delete(ownerId: string, id: string) {
    const { numDeletedRows } = await this.db
      .deleteFrom('photography_invoice')
      .where('ownerId', '=', ownerId)
      .where('id', '=', id)
      .where('status', '=', 'draft')
      .executeTakeFirst();
    return numDeletedRows > 0n;
  }

  /** Locks the invoice and returns it with what is paid, for a change that depends on the balance. */
  private async locked(trx: Kysely<DB>, id: string) {
    await trx.selectFrom('photography_invoice').select('id').where('id', '=', id).forUpdate().execute();
    return (await this.select(trx).where('id', '=', id).executeTakeFirst()) as InvoiceRow | undefined;
  }
  private async settle(trx: Kysely<DB>, invoice: InvoiceRow, paid: number) {
    await trx
      .updateTable('photography_invoice')
      .set({ status: invoiceStatus(invoice.total, paid) })
      .where('id', '=', invoice.id)
      .where('status', 'in', ['sent', 'part', 'paid'])
      .execute();
  }
  /** A payment received outside Frameleaf. Refused (false) when it would pay more than is owed. */
  recordManual(ownerId: string, id: string, amount: number) {
    return this.db.transaction().execute(async (trx) => {
      const invoice = await this.locked(trx, id);
      if (!invoice || invoice.ownerId !== ownerId) throw new NotFoundException('Invoice is unavailable');
      if (!['sent', 'part'].includes(invoice.status) || invoice.paid + amount > invoice.total) return false;
      await trx
        .insertInto('photography_payment')
        .values({
          ownerId,
          invoiceId: id,
          amount,
          currency: invoice.currency,
          payerEmail: invoice.clientEmail,
          providerRef: 'manual',
          status: 'paid',
          paidAt: new Date(),
        })
        .execute();
      await this.settle(trx, invoice, invoice.paid + amount);
      return true;
    });
  }
  /**
   * The checkout attempt for the amount due now. One attempt is held per invoice for `holdMinutes`, so two
   * payers can't pay the same instalment; a retry within the hold gets the same attempt (and Stripe session).
   */
  attempt(id: string, holdMinutes = 30) {
    return this.db.transaction().execute(async (trx) => {
      const invoice = await this.locked(trx, id);
      const next =
        invoice && ['sent', 'part'].includes(invoice.status) ? invoiceNext(invoice.schedule, invoice.paid) : null;
      if (!invoice || !next) return null;
      const held = await trx
        .selectFrom('photography_payment')
        .selectAll()
        .where('invoiceId', '=', id)
        .where('status', '=', 'pending')
        .where('createdAt', '>', sql<Date>`now() - make_interval(mins => ${holdMinutes})`)
        .orderBy('createdAt', 'desc')
        .executeTakeFirst();
      if (held) return { invoice, payment: held, reused: true };
      const payment = await trx
        .insertInto('photography_payment')
        .values({
          ownerId: invoice.ownerId,
          invoiceId: id,
          amount: next.amount,
          currency: invoice.currency,
          payerEmail: invoice.clientEmail,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return { invoice, payment, reused: false };
    });
  }
  async setCheckout(paymentId: string, checkoutId: string) {
    await this.db.updateTable('photography_payment').set({ checkoutId }).where('id', '=', paymentId).execute();
  }
  payment(id: string) {
    return this.db.selectFrom('photography_payment').selectAll().where('id', '=', id).executeTakeFirst();
  }
  /**
   * Moves an online payment's status and re-derives the invoice's. `overpaid` reports a success that took the
   * invoice past its total (two payments for one instalment); it is recorded and left for a refund in Stripe.
   */
  transition(paymentId: string, from: string[], to: string, providerRef: string | null) {
    return this.db.transaction().execute(async (trx) => {
      const payment = await trx
        .selectFrom('photography_payment')
        .select(['invoiceId', 'amount', 'status'])
        .where('id', '=', paymentId)
        .executeTakeFirst();
      const invoice = payment?.invoiceId ? await this.locked(trx, payment.invoiceId) : undefined;
      if (!payment || !invoice) return { moved: false, overpaid: false };
      const moved = await trx
        .updateTable('photography_payment')
        .set({
          status: to,
          providerRef: sql`coalesce(${providerRef}, "providerRef")`,
          paidAt: to === 'paid' ? new Date() : sql`"paidAt"`,
        })
        .where('id', '=', paymentId)
        .where('status', 'in', from)
        .executeTakeFirst();
      if (moved.numUpdatedRows === 0n) return { moved: false, overpaid: false };
      const delta =
        to === 'paid' ? payment.amount : to === 'refunded' && payment.status === 'paid' ? -payment.amount : 0;
      const paid = invoice.paid + delta;
      await this.settle(trx, invoice, paid);
      return { moved: true, overpaid: to === 'paid' && paid > invoice.total };
    });
  }
  /** Sent or part-paid invoices with reminders on, not yet reminded today. */
  remindable(today: string) {
    return this.select()
      .where('status', 'in', ['sent', 'part'])
      .where('reminders', '=', true)
      .where(sql<boolean>`cardinality("tokenHashes") > 0`)
      .where((eb) => eb.or([eb('lastReminderOn', 'is', null), eb('lastReminderOn', '<', today)]))
      .execute() as Promise<InvoiceRow[]>;
  }
  /** Claims today's reminder; false when another run already did, so a reminder goes out once. */
  async claimReminder(id: string, today: string) {
    const { numUpdatedRows } = await this.db
      .updateTable('photography_invoice')
      .set({ lastReminderOn: today })
      .where('id', '=', id)
      .where('status', 'in', ['sent', 'part'])
      .where((eb) => eb.or([eb('lastReminderOn', 'is', null), eb('lastReminderOn', '<', today)]))
      .executeTakeFirst();
    return numUpdatedRows > 0n;
  }
}
