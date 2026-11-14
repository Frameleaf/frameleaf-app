import { Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { DB } from 'src/schema/index.js';

export type PaymentLinkRow = {
  id: string;
  ownerId: string;
  slug: string;
  title: string;
  description: string;
  amount: number;
  currency: string;
  reusable: boolean;
  active: boolean;
  createdAt: Date;
};
export type PaymentRow = {
  id: string;
  ownerId: string;
  linkId: string | null;
  amount: number;
  currency: string;
  payerEmail: string;
  checkoutId: string | null;
  providerRef: string | null;
  status: 'pending' | 'paid' | 'failed' | 'expired' | 'refunded';
  createdAt: Date;
  paidAt: Date | null;
};

/** FL-1041: payment links and the payments made through them. */
@Injectable()
export class PhotographyPaymentRepository {
  constructor(@InjectKysely() private readonly db: Kysely<DB>) {}

  async links(ownerId: string) {
    const { rows } = await sql<PaymentLinkRow & { payments: number; collected: string }>`
      SELECT l.*,
        (SELECT count(*)::int FROM photography_payment p WHERE p."linkId"=l.id AND p.status='paid') AS payments,
        (SELECT coalesce(sum(p.amount),0) FROM photography_payment p WHERE p."linkId"=l.id AND p.status='paid') AS collected
      FROM photography_payment_link l WHERE l."ownerId"=${ownerId}::uuid ORDER BY l."createdAt" DESC`.execute(this.db);
    return rows;
  }
  async link(id: string) {
    const { rows } = await sql<PaymentLinkRow>`SELECT * FROM photography_payment_link WHERE id=${id}::uuid`.execute(
      this.db,
    );
    return rows[0];
  }
  async linkBySlug(slug: string) {
    const { rows } = await sql<PaymentLinkRow>`SELECT * FROM photography_payment_link WHERE slug=${slug}`.execute(
      this.db,
    );
    return rows[0];
  }
  async createLink(link: Omit<PaymentLinkRow, 'id' | 'active' | 'createdAt'>) {
    const { rows } = await sql<PaymentLinkRow>`INSERT INTO photography_payment_link
      ("ownerId", slug, title, description, amount, currency, reusable)
      VALUES (${link.ownerId}::uuid, ${link.slug}, ${link.title}, ${link.description}, ${link.amount}, ${link.currency}, ${link.reusable})
      RETURNING *`.execute(this.db);
    return rows[0];
  }
  async updateLink(id: string, ownerId: string, change: { title?: string; description?: string; active?: boolean }) {
    const { rows } = await sql<PaymentLinkRow>`UPDATE photography_payment_link SET
      title=coalesce(${change.title ?? null}, title),
      description=coalesce(${change.description ?? null}, description),
      active=coalesce(${change.active ?? null}::boolean, active)
      WHERE id=${id}::uuid AND "ownerId"=${ownerId}::uuid RETURNING *`.execute(this.db);
    return rows[0];
  }
  async deleteLink(id: string, ownerId: string) {
    const { numAffectedRows } = await sql`DELETE FROM photography_payment_link
      WHERE id=${id}::uuid AND "ownerId"=${ownerId}::uuid`.execute(this.db);
    return Number(numAffectedRows ?? 0) > 0;
  }
  async paidCount(linkId: string) {
    const { rows } = await sql<{ n: number }>`SELECT count(*)::int AS n FROM photography_payment
      WHERE "linkId"=${linkId}::uuid AND status IN ('paid','refunded')`.execute(this.db);
    return rows[0].n;
  }
  async payments(ownerId: string) {
    const { rows } = await sql<PaymentRow & { title: string | null }>`SELECT p.*, l.title FROM photography_payment p
      LEFT JOIN photography_payment_link l ON l.id=p."linkId"
      WHERE p."ownerId"=${ownerId}::uuid AND p.status<>'pending' ORDER BY p."createdAt" DESC LIMIT 500`.execute(
      this.db,
    );
    return rows;
  }
  async payment(id: string) {
    const { rows } = await sql<PaymentRow>`SELECT * FROM photography_payment WHERE id=${id}::uuid`.execute(this.db);
    return rows[0];
  }
  /** The payer's own unfinished attempt on this link whose checkout outcome was never confirmed. */
  async pendingAttempt(linkId: string, payerEmail: string, minutes: number) {
    const { rows } = await sql<PaymentRow>`SELECT * FROM photography_payment WHERE "linkId"=${linkId}::uuid
      AND "payerEmail"=${payerEmail} AND status='pending' AND "checkoutId" IS NULL
      AND "createdAt" > now() - make_interval(mins => ${minutes}) ORDER BY "createdAt" DESC LIMIT 1`.execute(this.db);
    return rows[0];
  }
  /**
   * A new pending payment. For a single-use link the link row is locked and the payment is refused
   * (undefined) while another payer started within `holdMinutes` or the link is already paid, so two
   * checkouts can't both pass the check.
   */
  createPayment(link: PaymentLinkRow, payerEmail: string, holdMinutes = 30) {
    return this.db.transaction().execute(async (trx) => {
      if (!link.reusable) {
        // Lock first, then look: under READ COMMITTED the second statement sees whatever the lock holder committed.
        await sql`SELECT id FROM photography_payment_link WHERE id=${link.id}::uuid FOR UPDATE`.execute(trx);
        const { rows } = await sql<{ busy: boolean }>`SELECT EXISTS (
            SELECT 1 FROM photography_payment WHERE "linkId"=${link.id}::uuid AND (status IN ('paid','refunded')
              OR (status='pending' AND "createdAt" > now() - make_interval(mins => ${holdMinutes})))
          ) AS busy`.execute(trx);
        if (rows[0]?.busy) return;
      }
      const { rows } =
        await sql<PaymentRow>`INSERT INTO photography_payment ("ownerId", "linkId", amount, currency, "payerEmail")
        VALUES (${link.ownerId}::uuid, ${link.id}::uuid, ${link.amount}, ${link.currency}, ${payerEmail}) RETURNING *`.execute(
          trx,
        );
      return rows[0];
    });
  }
  async setCheckout(id: string, checkoutId: string) {
    await sql`UPDATE photography_payment SET "checkoutId"=${checkoutId} WHERE id=${id}::uuid`.execute(this.db);
  }
  /** Whether someone started paying this link in the last `minutes` and hasn't finished or given up. */
  async pendingSince(linkId: string, minutes: number) {
    const { rows } = await sql<{ n: number }>`SELECT count(*)::int AS n FROM photography_payment
      WHERE "linkId"=${linkId}::uuid AND status='pending' AND "createdAt" > now() - make_interval(mins => ${minutes})`.execute(
      this.db,
    );
    return rows[0].n > 0;
  }
  /**
   * Moves a payment from one of `from` to `to`; `moved` is false when it was already elsewhere, so a replayed
   * or out-of-order event changes nothing. The link row is locked first, so two payments on a single-use
   * link settle one after the other: the first closes the link, and `duplicate` reports any later one.
   */
  transition(id: string, from: PaymentRow['status'][], to: PaymentRow['status'], providerRef: string | null) {
    return this.db.transaction().execute(async (trx) => {
      const { rows: link } = await sql<{ id: string; reusable: boolean }>`SELECT l.id, l.reusable
        FROM photography_payment_link l JOIN photography_payment p ON p."linkId"=l.id
        WHERE p.id=${id}::uuid FOR UPDATE OF l`.execute(trx);
      const single = link[0] && !link[0].reusable;
      const { rows: before } = single
        ? await sql<{ n: number }>`SELECT count(*)::int AS n FROM photography_payment
            WHERE "linkId"=${link[0].id}::uuid AND status='paid' AND id<>${id}::uuid`.execute(trx)
        : { rows: [{ n: 0 }] };
      const { rows } = await sql<PaymentRow>`UPDATE photography_payment SET status=${to},
        "providerRef"=coalesce(${providerRef}, "providerRef"),
        "paidAt"=CASE WHEN ${to}='paid' THEN now() ELSE "paidAt" END
        WHERE id=${id}::uuid AND status = ANY(${from}::text[]) RETURNING *`.execute(trx);
      const moved = !!rows[0];
      if (moved && to === 'paid' && single) {
        await sql`UPDATE photography_payment_link SET active=false WHERE id=${link[0].id}::uuid`.execute(trx);
      }
      return { moved, duplicate: moved && to === 'paid' && before[0].n > 0 };
    });
  }
}
