import { LoginResponseDto } from '@frameleaf/sdk';
import { app, asBearerAuth, utils } from 'src/utils.js';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * FL-1606: a client books a session on the studio website, pays the deposit, and the studio confirms it. The
 * deposit goes through the fake Frameleaf Cloud's Clients payments relay (the FL-1037 contract): the fixture
 * opens the checkout and, standing in for Stripe test mode, reports it paid. No Stripe account is involved.
 */
const FIXTURE = 'http://127.0.0.1:3010';
const CLOUD_URL = 'http://frameleaf-cloud-fixture:3010';
const INSTANCE_ID = '0192f1a4-7c3e-7b21-9d4e-2a6f8c0b1e53';
const SLUG = 'cedar-and-light';
/** The server collects payment events every 30 seconds. */
const PULL_WAIT_MS = 45_000;

describe('Clients booking: book, pay the deposit, confirm (FL-1606)', () => {
  let studio: LoginResponseDto;
  let typeId: string;
  const auth = () => asBearerAuth(studio.accessToken);

  beforeAll(async () => {
    await fetch(`${FIXTURE}/__fixture/reset`, { method: 'POST' });
    await utils.resetDatabase();
    studio = await utils.adminSetup({ onboarding: false });

    const client = await utils.connectDatabase();
    await client.query(
      `INSERT INTO system_metadata (key, value) VALUES ('frameleaf-cloud-link', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [
        JSON.stringify({
          status: 'linked',
          cloudUrl: CLOUD_URL,
          instanceId: INSTANCE_ID,
          dataRegion: 'eu',
          heartbeat: { nextAt: '2099-01-01T00:00:00.000Z' },
        }),
      ],
    );

    // the studio's Stripe account, connected through Cloud
    const { body: account } = await request(app).get('/photography/payment-account').set(auth()).expect(200);
    expect(account).toMatchObject({ status: 'active', chargesEnabled: true });

    // its website, live at /studio/cedar-and-light
    const { body: current } = await request(app).get('/photography/site').set(auth()).expect(200);
    await request(app)
      .put('/photography/site')
      .set(auth())
      .send({ expectedRevision: current.revision, site: { ...current.site, enabled: true, slug: SLUG } })
      .expect(200);

    const { body: type } = await request(app)
      .post('/photography/booking-types')
      .set(auth())
      .send({
        name: 'Family session',
        durationMinutes: 60,
        price: 30_000,
        deposit: 5000,
        currency: 'CAD',
        addOns: [{ id: 'prints', name: 'Prints', price: 2500, maxQuantity: 3 }],
      })
      .expect(201);
    typeId = type.id;
  });

  it('takes the booking and its deposit, and lets the studio confirm it', async () => {
    // the public booking form lists the studio's active sessions
    const { body: offered } = await request(app).get(`/photography/studios/${SLUG}/booking-types`).expect(200);
    expect(offered.types).toEqual([expect.objectContaining({ id: typeId, deposit: 5000 })]);

    // the client books, choosing two prints; the server prices it and opens the deposit checkout
    const { body: requested } = await request(app)
      .post(`/photography/studios/${SLUG}/bookings`)
      .set('Origin', 'http://127.0.0.1:2285')
      .send({
        bookingTypeId: typeId,
        name: 'Morgan Ellis',
        email: 'morgan@example.test',
        preferredDates: ['2027-06-01'],
        addOns: [{ id: 'prints', quantity: 2 }],
        message: 'Two kids and a dog',
      })
      .expect(200);
    expect(requested).toMatchObject({ total: 35_000, deposit: 5000, currency: 'CAD' });
    expect(requested.checkoutUrl).toMatch(/^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_fixture_\d+$/);

    // the studio sees it waiting, deposit unpaid
    const list = async () => {
      const { body } = await request(app).get('/photography/bookings').set(auth()).expect(200);
      return body.bookings as Array<{ id: string; status: string; depositStatus: string; total: number }>;
    };
    const [booking] = await list();
    expect(booking).toMatchObject({ status: 'requested', total: 35_000 });
    expect(booking.depositStatus).not.toBe('paid');

    // the client pays the deposit
    const sessionId = requested.checkoutUrl.split('/').pop();
    await fetch(`${FIXTURE}/__fixture/clients/pay`, { method: 'POST', body: JSON.stringify({ sessionId }) }).then(
      (response) => expect(response.status).toBe(200),
    );
    await expect
      .poll(async () => (await list())[0].depositStatus, { timeout: PULL_WAIT_MS, interval: 1000 })
      .toBe('paid');

    // the studio confirms
    const { body: confirmed } = await request(app)
      .patch(`/photography/bookings/${booking.id}`)
      .set(auth())
      .send({ status: 'confirmed' })
      .expect(200);
    expect(confirmed).toMatchObject({ id: booking.id, status: 'confirmed', depositStatus: 'paid' });
    expect(await list()).toEqual([expect.objectContaining({ id: booking.id, status: 'confirmed' })]);
  });
});
