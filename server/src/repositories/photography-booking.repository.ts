import { Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { DB } from 'src/schema/index.js';
import type { BookedAddOn, BookingAddOn } from 'src/schema/tables/photography-booking.table.js';

export type BookingTypeRow = {
  id: string;
  ownerId: string;
  name: string;
  description: string;
  durationMinutes: number;
  price: number;
  deposit: number;
  currency: string;
  active: boolean;
  addOns: BookingAddOn[];
  order: number;
  createdAt: Date;
};
export type BookingStatus = 'requested' | 'confirmed' | 'declined' | 'cancelled';
export type BookingRow = {
  id: string;
  ownerId: string;
  bookingTypeId: string | null;
  typeName: string;
  clientName: string;
  clientEmail: string;
  message: string;
  preferredDates: string[];
  addOns: BookedAddOn[];
  total: number;
  deposit: number;
  currency: string;
  depositPaymentId: string | null;
  status: BookingStatus;
  requestedAt: Date;
  /** The deposit payment's status, when there is one. */
  depositStatus?: string | null;
};
type BookingTypeInput = Omit<BookingTypeRow, 'id' | 'ownerId' | 'createdAt'>;

/** FL-1049: booking types and the bookings clients request through the studio website. */
@Injectable()
export class PhotographyBookingRepository {
  constructor(@InjectKysely() private readonly db: Kysely<DB>) {}

  async types(ownerId: string, activeOnly = false) {
    const { rows } = await sql<BookingTypeRow>`SELECT * FROM photography_booking_type WHERE "ownerId"=${ownerId}::uuid
      AND (${!activeOnly} OR active) ORDER BY "order", "createdAt"`.execute(this.db);
    return rows;
  }
  async type(id: string) {
    const { rows } = await sql<BookingTypeRow>`SELECT * FROM photography_booking_type WHERE id=${id}::uuid`.execute(
      this.db,
    );
    return rows[0];
  }
  async createType(ownerId: string, input: BookingTypeInput) {
    const { rows } = await sql<BookingTypeRow>`INSERT INTO photography_booking_type
      ("ownerId", name, description, "durationMinutes", price, deposit, currency, active, "addOns", "order")
      VALUES (${ownerId}::uuid, ${input.name}, ${input.description}, ${input.durationMinutes}, ${input.price}, ${input.deposit},
        ${input.currency}, ${input.active}, ${JSON.stringify(input.addOns)}::text::jsonb, ${input.order}) RETURNING *`.execute(
      this.db,
    );
    return rows[0];
  }
  async updateType(id: string, ownerId: string, input: BookingTypeInput) {
    const { rows } = await sql<BookingTypeRow>`UPDATE photography_booking_type SET name=${input.name},
      description=${input.description}, "durationMinutes"=${input.durationMinutes}, price=${input.price},
      deposit=${input.deposit}, currency=${input.currency}, active=${input.active},
      "addOns"=${JSON.stringify(input.addOns)}::text::jsonb, "order"=${input.order}
      WHERE id=${id}::uuid AND "ownerId"=${ownerId}::uuid RETURNING *`.execute(this.db);
    return rows[0];
  }
  async deleteType(id: string, ownerId: string) {
    const { numAffectedRows } = await sql`DELETE FROM photography_booking_type
      WHERE id=${id}::uuid AND "ownerId"=${ownerId}::uuid`.execute(this.db);
    return Number(numAffectedRows ?? 0) > 0;
  }
  async bookings(ownerId: string) {
    const { rows } = await sql<BookingRow>`SELECT b.*, p.status AS "depositStatus" FROM photography_booking b
      LEFT JOIN photography_payment p ON p.id=b."depositPaymentId"
      WHERE b."ownerId"=${ownerId}::uuid ORDER BY b."requestedAt" DESC LIMIT 500`.execute(this.db);
    return rows;
  }
  async createBooking(
    booking: Omit<BookingRow, 'id' | 'status' | 'requestedAt' | 'depositPaymentId' | 'depositStatus'>,
  ) {
    const { rows } = await sql<BookingRow>`INSERT INTO photography_booking ("ownerId", "bookingTypeId", "typeName",
        "clientName", "clientEmail", message, "preferredDates", "addOns", total, deposit, currency)
      VALUES (${booking.ownerId}::uuid, ${booking.bookingTypeId}::uuid, ${booking.typeName}, ${booking.clientName},
        ${booking.clientEmail}, ${booking.message}, ${JSON.stringify(booking.preferredDates)}::text::jsonb,
        ${JSON.stringify(booking.addOns)}::text::jsonb, ${booking.total}, ${booking.deposit}, ${booking.currency})
      RETURNING *`.execute(this.db);
    return rows[0];
  }
  /** The same client's request for the same session in the last `minutes`, still waiting: a retry of it, not a new one. */
  async recentRequest(ownerId: string, bookingTypeId: string, clientEmail: string, minutes: number) {
    const { rows } = await sql<BookingRow>`SELECT b.*, p.status AS "depositStatus" FROM photography_booking b
      LEFT JOIN photography_payment p ON p.id=b."depositPaymentId"
      WHERE b."ownerId"=${ownerId}::uuid AND b."bookingTypeId"=${bookingTypeId}::uuid AND b."clientEmail"=${clientEmail}
        AND b.status='requested' AND b."requestedAt" > now() - make_interval(mins => ${minutes})
      ORDER BY b."requestedAt" DESC LIMIT 1`.execute(this.db);
    return rows[0];
  }
  async setDepositPayment(id: string, paymentId: string) {
    await sql`UPDATE photography_booking SET "depositPaymentId"=${paymentId}::uuid WHERE id=${id}::uuid`.execute(
      this.db,
    );
  }
  async setStatus(id: string, ownerId: string, status: BookingStatus) {
    const { rows } = await sql<BookingRow>`WITH updated AS (UPDATE photography_booking SET status=${status}
        WHERE id=${id}::uuid AND "ownerId"=${ownerId}::uuid RETURNING *)
      SELECT updated.*, p.status AS "depositStatus" FROM updated
      LEFT JOIN photography_payment p ON p.id=updated."depositPaymentId"`.execute(this.db);
    return rows[0];
  }
}
