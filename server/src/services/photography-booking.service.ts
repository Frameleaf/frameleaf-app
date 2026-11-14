import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { BookedAddOn } from 'src/schema/tables/photography-booking.table.js';
import {
  PhotographyBookingRequestDto,
  PhotographyBookingStatusDto,
  PhotographyBookingTypeSaveDto,
} from 'src/dtos/photography-booking.dto.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import {
  type BookingRow,
  type BookingTypeRow,
  PhotographyBookingRepository,
} from 'src/repositories/photography-booking.repository.js';
import { PhotographyPaymentRepository } from 'src/repositories/photography-payment.repository.js';
import { ClientsPaymentsService } from 'src/services/clients-payments.service.js';
import { PhotographySiteService } from 'src/services/photography-site.service.js';

const typeView = (t: BookingTypeRow) => ({
  id: t.id,
  name: t.name,
  description: t.description,
  durationMinutes: t.durationMinutes,
  price: t.price,
  deposit: t.deposit,
  currency: t.currency,
  active: t.active,
  addOns: t.addOns,
  order: t.order,
  createdAt: new Date(t.createdAt).toISOString(),
});

const bookingView = (b: BookingRow) => ({
  id: b.id,
  bookingTypeId: b.bookingTypeId,
  typeName: b.typeName,
  clientName: b.clientName,
  clientEmail: b.clientEmail,
  message: b.message,
  preferredDates: b.preferredDates,
  addOns: b.addOns,
  total: b.total,
  deposit: b.deposit,
  currency: b.currency,
  depositStatus: (b.deposit === 0 ? 'none' : (b.depositStatus ?? 'unpaid')) as
    'none' | 'unpaid' | 'pending' | 'paid' | 'failed' | 'expired' | 'refunded',
  status: b.status,
  requestedAt: new Date(b.requestedAt).toISOString(),
});

const money = (cents: number, currency: string) => `${(cents / 100).toFixed(2)} ${currency}`;

/**
 * FL-1049: booking types with paid add-ons. Clients choose a type, add-ons and preferred dates on the studio website;
 * the server prices the request from the type (never from the form), saves it as a booking and as a lead on the
 * studio's inquiry list, and when the type asks for a deposit, opens a checkout on the studio's own connected account
 * (FL-1037). Deposit payments are ordinary payments (FL-1041) referenced as `booking:<payment id>`.
 */
@Injectable()
export class PhotographyBookingService {
  constructor(
    private repository: PhotographyBookingRepository,
    private payments: PhotographyPaymentRepository,
    private site: PhotographySiteService,
    private clients: ClientsPaymentsService,
    private logger?: LoggingRepository,
  ) {}

  private studio(auth: AuthDto) {
    if (!auth.session || auth.apiKey || auth.sharedLink) throw new ForbiddenException('Studio session required');
    return auth.user.id;
  }

  async types(auth: AuthDto) {
    return { types: (await this.repository.types(this.studio(auth))).map((t) => typeView(t)) };
  }

  async createType(auth: AuthDto, dto: PhotographyBookingTypeSaveDto) {
    return typeView(await this.repository.createType(this.studio(auth), dto));
  }

  async updateType(auth: AuthDto, id: string, dto: PhotographyBookingTypeSaveDto) {
    const updated = await this.repository.updateType(id, this.studio(auth), dto);
    if (!updated) throw new NotFoundException();
    return typeView(updated);
  }

  async deleteType(auth: AuthDto, id: string) {
    if (!(await this.repository.deleteType(id, this.studio(auth)))) throw new NotFoundException();
  }

  async bookings(auth: AuthDto) {
    return { bookings: (await this.repository.bookings(this.studio(auth))).map((b) => bookingView(b)) };
  }

  async setStatus(auth: AuthDto, id: string, dto: PhotographyBookingStatusDto) {
    const updated = await this.repository.setStatus(id, this.studio(auth), dto.status);
    if (!updated) throw new NotFoundException();
    return bookingView(updated);
  }

  /** `GET /photography/studios/:site/booking-types`: the active types, for the website's booking form. */
  async publicTypes(idOrSlug: string) {
    const { ownerId } = await this.site.liveStudio(idOrSlug);
    const types = await this.repository.types(ownerId, true);
    return {
      types: types.map(({ id, name, description, durationMinutes, price, deposit, currency, addOns }) => ({
        id,
        name,
        description,
        durationMinutes,
        price,
        deposit,
        currency,
        addOns,
      })),
    };
  }

  /**
   * `POST /photography/studios/:site/bookings`. The total is the type's price plus each chosen add-on's price times its
   * quantity, all read from the stored type; an unknown add-on or a quantity over its limit is refused.
   */
  async request(idOrSlug: string, input: PhotographyBookingRequestDto, origin: string | null) {
    const dto = PhotographyBookingRequestDto.schema.parse(input);
    const { ownerId, site } = await this.site.liveStudio(idOrSlug);
    const type = await this.repository.type(dto.bookingTypeId);
    if (!type || type.ownerId !== ownerId || !type.active) throw new NotFoundException('This session can’t be booked');
    // Bots that fill every field are told it worked, and nothing is kept (as for website inquiries).
    if (dto.website) return { total: 0, deposit: 0, currency: type.currency, checkoutUrl: null };

    const chosen: BookedAddOn[] = [];
    for (const pick of dto.addOns) {
      const addOn = type.addOns.find((a) => a.id === pick.id);
      if (!addOn || pick.quantity > addOn.maxQuantity || chosen.some((c) => c.id === pick.id))
        throw new BadRequestException('Choose from this session’s add-ons');
      chosen.push({ id: addOn.id, name: addOn.name, price: addOn.price, quantity: pick.quantity });
    }
    const total = type.price + chosen.reduce((sum, a) => sum + a.price * a.quantity, 0);
    // An identical resend (same client, session, dates, add-ons and message, still waiting) resumes its booking: no second
    // booking or lead, and its deposit keeps its payment and idempotency key. A changed request is a new booking.
    const { booking, created } = await this.repository.findOrCreateRequest(
      {
        ownerId,
        bookingTypeId: type.id,
        typeName: type.name,
        clientName: dto.name,
        clientEmail: dto.email,
        message: dto.message,
        preferredDates: dto.preferredDates,
        addOns: chosen,
        total,
        deposit: type.deposit,
        currency: type.currency,
      },
      30,
    );

    if (created) {
      const lines = [
        `Booking request: ${type.name} (${money(total, type.currency)})`,
        ...chosen.map((a) => `+ ${a.name} × ${a.quantity}`),
        dto.preferredDates.length > 0 ? `Preferred dates: ${dto.preferredDates.join(', ')}` : '',
        dto.message,
      ].filter(Boolean);
      // The booking is the record; the lead on the inquiry list is a convenience, so a failure there is logged and
      // never turned into an error that would make the client send the booking again.
      try {
        await this.site.addInquiry(ownerId, site, {
          kind: 'inquiry',
          name: dto.name,
          email: dto.email,
          date: dto.preferredDates[0] ?? '',
          type: type.name.slice(0, 60),
          message: lines.join('\n').slice(0, 5000),
        });
      } catch (error) {
        this.logger?.warn(`Booking ${booking.id} saved without its inquiry lead: ${(error as Error).message}`);
      }
    }

    let checkoutUrl: string | null = null;
    const owed = booking.deposit > 0 && !['paid', 'refunded'].includes(booking.depositStatus ?? '');
    if (owed && (await this.clients.ready(ownerId))) {
      const back = origin ?? (await this.clients.publicUrl());
      try {
        if (back) checkoutUrl = await this.depositCheckout(booking, `${back}/studio/${idOrSlug}`);
      } catch (error) {
        // The booking is taken either way; sending the form again resumes this same deposit.
        this.logger?.warn(`Deposit checkout for booking ${booking.id} didn't start: ${(error as Error).message}`);
      }
    }
    return { total: booking.total, deposit: booking.deposit, currency: booking.currency, checkoutUrl };
  }

  /** The deposit as a payment on the studio's own account; its events reach PhotographyPaymentService (`booking:`). */
  private async depositCheckout(booking: BookingRow, back: string) {
    // Every value comes from the booking as saved, so a resend sends Stripe the same parameters with the same key.
    const paymentId = await this.repository.claimDepositPayment(booking.id);
    const session = await this.clients.checkout(booking.ownerId, {
      reference: `booking:${paymentId}`,
      idempotencyKey: `payment-${paymentId}`,
      name: `${booking.typeName} deposit`,
      amount: booking.deposit,
      currency: booking.currency.toLowerCase(),
      customerEmail: booking.clientEmail,
      successUrl: `${back}?booking=sent`,
      cancelUrl: back,
    });
    if (!session.url.startsWith('https://checkout.stripe.com/'))
      throw new ConflictException('Invalid hosted checkout response');
    await this.payments.setCheckout(paymentId, session.id);
    return session.url;
  }
}
