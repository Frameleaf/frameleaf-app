import { Kysely } from 'kysely';
import { NotificationLevel, NotificationType } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { NotificationRepository } from 'src/repositories/notification.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

/** FL-155: the administrator list and the notice dedupe lookup behind `notifyAdmins`. */
let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});

const setup = () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  return { ctx, users: ctx.get(UserRepository), notifications: ctx.get(NotificationRepository) };
};

it('lists every administrator that is not deleted, oldest first', async () => {
  const { ctx, users } = setup();
  const { user: first } = await ctx.newUser({ isAdmin: true });
  const { user: second } = await ctx.newUser({ isAdmin: true });
  const { user: member } = await ctx.newUser({ isAdmin: false });
  const { user: gone } = await ctx.newUser({ isAdmin: true, deletedAt: new Date() });

  const ids = (await users.getAdmins()).map(({ id }) => id);
  expect(ids).toEqual(expect.arrayContaining([first.id, second.id]));
  expect(ids).not.toContain(member.id);
  expect(ids).not.toContain(gone.id);
  expect(ids.indexOf(first.id)).toBeLessThan(ids.indexOf(second.id));
});

it('finds a recent notice by its dedupe key for that administrator only', async () => {
  const { ctx, notifications } = setup();
  const { user: admin } = await ctx.newUser({ isAdmin: true });
  const { user: other } = await ctx.newUser({ isAdmin: true });
  await notifications.create({
    userId: admin.id,
    type: NotificationType.SystemMessage,
    level: NotificationLevel.Warning,
    title: 'This server cannot reach Frameleaf Cloud',
    data: { dedupeKey: 'frameleaf-cloud:heartbeat-failing' },
  });

  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  await expect(
    notifications.findRecentByDedupeKey(admin.id, 'frameleaf-cloud:heartbeat-failing', dayAgo),
  ).resolves.toEqual({ id: expect.any(String) });
  await expect(
    notifications.findRecentByDedupeKey(other.id, 'frameleaf-cloud:heartbeat-failing', dayAgo),
  ).resolves.toBeNull();
  await expect(notifications.findRecentByDedupeKey(admin.id, 'frameleaf-cloud:revoked', dayAgo)).resolves.toBeNull();
  await expect(
    notifications.findRecentByDedupeKey(admin.id, 'frameleaf-cloud:heartbeat-failing', new Date(Date.now() + 60_000)),
  ).resolves.toBeNull();
});
