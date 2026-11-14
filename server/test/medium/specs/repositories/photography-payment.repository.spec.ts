import { Kysely, sql } from 'kysely';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
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

describe(PhotographyPaymentRepository.name, () => {
  it('totals past 2^31, settles a single-use link once and reports a late second payment (FL-1041)', async () => {
    const { ctx } = newMediumService(BaseService, { database, real: [], mock: [LoggingRepository] });
    const { user } = await ctx.newUser();
    const sut = new PhotographyPaymentRepository(database);
    const base = { ownerId: user.id, title: 'Deposit', description: '', currency: 'CAD' };

    const reusable = await sut.createLink({
      ...base,
      slug: `r${Date.now()}`.padEnd(16, 'x'),
      amount: 99_999_999,
      reusable: true,
    });
    for (let i = 0; i < 25; i++) {
      const payment = (await sut.createPayment(reusable, `p${i}@example.com`))!;
      expect((await sut.transition(payment.id, ['pending'], 'paid', `pi_${i}`)).moved).toBe(true);
    }
    const listed = (await sut.links(user.id)).find((link) => link.id === reusable.id)!;
    expect(Number(listed.collected)).toBe(25 * 99_999_999);
    expect(listed.payments).toBe(25);

    const single = await sut.createLink({
      ...base,
      slug: `s${Date.now()}`.padEnd(16, 'x'),
      amount: 5000,
      reusable: false,
    });
    // Two payers starting at once: the locked check lets exactly one through.
    const started = await Promise.all([
      sut.createPayment(single, 'a@example.com'),
      sut.createPayment(single, 'b@example.com'),
    ]);
    expect(started.filter(Boolean)).toHaveLength(1);
    const first = started.find(Boolean)!;
    expect(await sut.pendingSince(single.id, 30)).toBe(true);
    // With no hold (as after 30 minutes), a second payer can still start.
    const second = (await sut.createPayment(single, 'b@example.com', 0))!;
    expect(second).toBeDefined();
    const settled = await Promise.all([
      sut.transition(first.id, ['pending'], 'paid', 'pi_a'),
      sut.transition(second.id, ['pending'], 'paid', 'pi_b'),
    ]);
    expect(settled.map((s) => s.moved)).toEqual([true, true]);
    expect(settled.filter((s) => s.duplicate)).toHaveLength(1);
    expect((await sut.link(single.id))!.active).toBe(false);
    expect(await sut.pendingSince(single.id, 30)).toBe(false);
    // A replay changes nothing.
    expect(await sut.transition(first.id, ['pending'], 'paid', 'pi_a')).toEqual({ moved: false, duplicate: false });
  });

  it('a payer who waits on the lock sees the payment the lock holder committed (FL-1041)', async () => {
    const { ctx } = newMediumService(BaseService, { database, real: [], mock: [LoggingRepository] });
    const { user } = await ctx.newUser();
    const sut = new PhotographyPaymentRepository(database);
    const link = await sut.createLink({
      ownerId: user.id,
      slug: `w${Date.now()}`.padEnd(16, 'x'),
      title: 'Deposit',
      description: '',
      amount: 5000,
      currency: 'CAD',
      reusable: false,
    });
    let second: Promise<unknown> | undefined;
    await database.transaction().execute(async (trx) => {
      // The first payer holds the lock and has inserted, but not committed, when the second one starts.
      await sql`SELECT id FROM photography_payment_link WHERE id=${link.id}::uuid FOR UPDATE`.execute(trx);
      await sql`INSERT INTO photography_payment ("ownerId", "linkId", amount, currency, "payerEmail")
        VALUES (${user.id}::uuid, ${link.id}::uuid, 5000, 'CAD', 'a@example.com')`.execute(trx);
      second = sut.createPayment(link, 'b@example.com');
      // Commit only once PostgreSQL reports the second payer waiting on the link lock.
      let blocked = false;
      for (let tries = 0; tries < 100 && !blocked; tries++) {
        const { rows } = await sql<{ n: number }>`SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND query LIKE '%photography_payment_link%FOR UPDATE%'`.execute(database);
        blocked = rows[0].n > 0;
        if (blocked) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(blocked).toBe(true);
    });
    expect(await second).toBeUndefined();
  });
});
