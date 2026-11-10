import { Kysely } from 'kysely';
import { AccountEventAction, AdminAuditAction } from 'src/enum.js';
import { AccountEventRepository } from 'src/repositories/account-event.repository.js';
import { AdminAuditRepository } from 'src/repositories/admin-audit.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { AccountEventService } from 'src/services/account-event.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

/** FL-808 (E16-02): the account activity log against a real database: paging, the admin merge and retention. */

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const { ctx, sut } = newMediumService(AccountEventService, {
    database: db || defaultDatabase,
    real: [AccountEventRepository, AdminAuditRepository],
    mock: [LoggingRepository],
  });
  return { ctx, sut, events: ctx.get(AccountEventRepository), audit: ctx.get(AdminAuditRepository) };
};

const at = (day: number) => new Date(`2026-09-${String(day).padStart(2, '0')}T12:00:00.000Z`);

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(AccountEventService.name, () => {
  it('pages one account, newest first, without repeating, skipping or showing another account', async () => {
    const { ctx, sut, events } = setup();
    const { user } = await ctx.newUser();
    const { user: other } = await ctx.newUser();

    const write = (userId: string, action: AccountEventAction, createdAt: Date) =>
      ctx.database.insertInto('account_event').values({ userId, action, subject: 'S', createdAt }).execute();
    await write(user.id, AccountEventAction.SignedIn, at(1));
    await write(user.id, AccountEventAction.PasswordChanged, at(2));
    // two events in the same instant keep a stable order across pages
    await write(user.id, AccountEventAction.ApiKeyCreated, at(3));
    await write(user.id, AccountEventAction.SignedOut, at(3));
    await write(other.id, AccountEventAction.SignedIn, at(4));

    const auth = factory.auth({ user: { id: user.id } });
    const first = await sut.getMine(auth, { take: 2 });
    const second = await sut.getMine(auth, { take: 2, before: first.events.at(-1)!.id });
    const third = await sut.getMine(auth, { take: 2, before: second.events.at(-1)!.id });

    expect(first.hasMore).toBe(true);
    expect(second.hasMore).toBe(false);
    expect(third.events).toEqual([]);
    const all = [...first.events, ...second.events];
    expect(new Set(all.map(({ id }) => id)).size).toBe(4);
    expect(all.every(({ userId, source }) => userId === user.id && source === 'account')).toBe(true);
    expect(all.map(({ createdAt }) => createdAt)).toEqual([at(3), at(3), at(2), at(1)].map((d) => d.toISOString()));

    // a cursor from another account's log yields nothing
    const [foreign] = await events.getByUserId(other.id, { take: 1 });
    await expect(sut.getMine(auth, { before: foreign.id })).resolves.toEqual({ events: [], hasMore: false });
  });

  it('merges administrator events for administrators, tagged and paged across both tables', async () => {
    const { ctx, sut, events, audit } = setup();
    const { user: admin } = await ctx.newUser({ isAdmin: true });
    const { user } = await ctx.newUser();

    await events.create({
      userId: user.id,
      action: AccountEventAction.SignedIn,
      subject: user.name,
      deviceType: 'Safari',
    });
    await audit.create([
      { userId: user.id, actorId: admin.id, action: AdminAuditAction.QuotaChanged, subject: user.name },
    ]);
    await events.create({ userId: user.id, action: AccountEventAction.SignedOut, subject: user.name });

    const auth = factory.auth({ user: { id: admin.id, isAdmin: true } });
    const page = await sut.getAll(auth, { userId: user.id });
    expect(page.events.map(({ source, action }) => [source, action])).toEqual([
      ['account', 'signed-out'],
      ['admin', 'quota-changed'],
      ['account', 'signed-in'],
    ]);
    expect(page.events[1]).toMatchObject({ actorId: admin.id, actorName: admin.name, deviceType: null, via: null });
    expect(page.events[2]).toMatchObject({ deviceType: 'Safari', actorId: null, actorName: null });

    const first = await sut.getAll(auth, { userId: user.id, take: 2 });
    const rest = await sut.getAll(auth, { userId: user.id, take: 2, before: first.events.at(-1)!.id });
    expect(first.hasMore).toBe(true);
    expect([...first.events, ...rest.events].map(({ id }) => id)).toEqual(page.events.map(({ id }) => id));

    const filtered = await sut.getAll(auth, { userId: user.id, action: 'quota-changed' });
    expect(filtered.events).toHaveLength(1);
  });

  it('keeps 400 days: the nightly cleanup removes only older events', async () => {
    const { ctx, sut, events } = setup();
    const { user } = await ctx.newUser();
    const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    await ctx.database
      .insertInto('account_event')
      .values([
        { userId: user.id, action: AccountEventAction.SignedIn, subject: 'old', createdAt: daysAgo(401) },
        { userId: user.id, action: AccountEventAction.SignedIn, subject: 'kept', createdAt: daysAgo(399) },
      ])
      .execute();

    await sut.onNightlyDatabaseCleanup();

    const left = await events.getByUserId(user.id, { take: 10 });
    expect(left.map(({ subject }) => subject)).toEqual(['kept']);
  });

  it('removes an account’s log with the account', async () => {
    const { ctx, events } = setup();
    const { user } = await ctx.newUser();
    await events.create({ userId: user.id, action: AccountEventAction.SignedIn, subject: user.name });

    await ctx.database.deleteFrom('user').where('id', '=', user.id).execute();

    await expect(events.getByUserId(user.id, { take: 10 })).resolves.toEqual([]);
  });
});
