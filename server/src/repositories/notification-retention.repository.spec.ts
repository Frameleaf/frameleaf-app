import { DateTime } from 'luxon';
import { NotificationRepository } from 'src/repositories/notification.repository.js';
import { scriptedKysely } from 'test/scripted-kysely.js';

// FL-1603: read ones two days after reading (once 15 days old), unread ones after 30 days
it('deletes by the notification retention predicates and cutoffs', async () => {
  const now = DateTime.utc(2026, 10, 15);
  if (!now.isValid) throw new Error('Invalid fixture clock');
  const clock = vi.spyOn(DateTime, 'now').mockReturnValue(now);
  const { db, queries } = scriptedKysely();
  try {
    await new NotificationRepository(db).cleanup();
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toBe(
      'delete from "notification" where (("deletedAt" is not null and "deletedAt" < $1) or ("readAt" < $2 and "createdAt" < $3) or ("readAt" is null and "createdAt" < $4))',
    );
    expect(queries[0].parameters).toEqual([
      now.minus({ days: 3 }).toJSDate(),
      now.minus({ days: 2 }).toJSDate(),
      now.minus({ days: 15 }).toJSDate(),
      now.minus({ days: 30 }).toJSDate(),
    ]);
  } finally {
    clock.mockRestore();
    await db.destroy();
  }
});
