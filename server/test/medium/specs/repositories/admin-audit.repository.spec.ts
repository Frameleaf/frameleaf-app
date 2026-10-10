import { Kysely } from 'kysely';
import { AdminAuditAction } from 'src/enum.js';
import { AdminAuditRepository } from 'src/repositories/admin-audit.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

/**
 * The administrator audit trail behind the account detail's Activity tab (FL-76): newest first,
 * paged on (createdAt, id), one account at a time, and kept when the acting administrator is gone.
 */

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const { ctx } = newMediumService(BaseService, {
    database: db || defaultDatabase,
    real: [],
    mock: [LoggingRepository],
  });
  return { ctx, sut: ctx.get(AdminAuditRepository) };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(AdminAuditRepository.name, () => {
  it('pages one account, newest first, without repeating or skipping an event', async () => {
    const { ctx, sut } = setup();
    const { user: admin } = await ctx.newUser({ isAdmin: true });
    const { user } = await ctx.newUser();
    const { user: other } = await ctx.newUser();
    const at = (day: number) => new Date(`2026-09-0${day}T12:00:00.000Z`);

    await sut.create([
      { userId: user.id, actorId: admin.id, action: AdminAuditAction.AccountCreated, subject: 'A', createdAt: at(1) },
      { userId: user.id, actorId: admin.id, action: AdminAuditAction.PinReset, subject: 'A', createdAt: at(2) },
      // two events in the same instant keep a stable order across pages
      { userId: user.id, actorId: admin.id, action: AdminAuditAction.AdminGranted, subject: 'A', createdAt: at(3) },
      { userId: user.id, actorId: admin.id, action: AdminAuditAction.QuotaChanged, subject: 'A', createdAt: at(3) },
      { userId: other.id, actorId: admin.id, action: AdminAuditAction.AccountCreated, subject: 'B', createdAt: at(4) },
    ]);

    const first = await sut.getByUserId(user.id, { take: 2 });
    const second = await sut.getByUserId(user.id, { before: first.at(-1)!.id, take: 2 });
    const third = await sut.getByUserId(user.id, { before: second.at(-1)!.id, take: 2 });

    const pages = [...first, ...second, ...third];
    expect(pages).toHaveLength(4);
    expect(new Set(pages.map(({ id }) => id)).size).toBe(4);
    expect(pages.map(({ createdAt }) => createdAt.toISOString())).toEqual([
      at(3).toISOString(),
      at(3).toISOString(),
      at(2).toISOString(),
      at(1).toISOString(),
    ]);
    expect(pages.every(({ userId, actorName }) => userId === user.id && actorName === admin.name)).toBe(true);
    expect(third).toHaveLength(0);
  });

  it("yields an empty page for a cursor from another account's history", async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { user: other } = await ctx.newUser();

    await sut.create([
      { userId: user.id, action: AdminAuditAction.AccountCreated, subject: 'A' },
      { userId: other.id, action: AdminAuditAction.AccountCreated, subject: 'B' },
    ]);
    const [foreign] = await sut.getByUserId(other.id, { take: 1 });

    await expect(sut.getByUserId(user.id, { before: foreign.id, take: 10 })).resolves.toEqual([]);
  });

  it('keeps an event, without a name, once the acting administrator is gone', async () => {
    const { ctx, sut } = setup();
    const { user: admin } = await ctx.newUser({ isAdmin: true });
    const { user } = await ctx.newUser();

    await sut.create([{ userId: user.id, actorId: admin.id, action: AdminAuditAction.PinReset, subject: 'A' }]);
    await ctx.database.deleteFrom('user').where('id', '=', admin.id).execute();

    await expect(sut.getByUserId(user.id, { take: 10 })).resolves.toEqual([
      expect.objectContaining({ action: AdminAuditAction.PinReset, actorId: null, actorName: null }),
    ]);
  });
});
