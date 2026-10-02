import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { AssetLockReason, AssetVisibility, MemoryType, PushEventType, PushPlatform } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MemoryRepository } from 'src/repositories/memory.repository.js';
import { PushDeviceRepository } from 'src/repositories/push-device.repository.js';
import { SessionRepository } from 'src/repositories/session.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;

const key = (fill: number) => Buffer.alloc(32, fill).toString('base64url');

const setup = () => {
  const { ctx } = newMediumService(BaseService, {
    database: db,
    real: [SessionRepository, UserRepository],
    mock: [LoggingRepository],
  });
  return { ctx, sut: new PushDeviceRepository(db) };
};

const registration = (userId: string, sessionId: string, overrides: Record<string, unknown> = {}) => ({
  userId,
  sessionId,
  platform: PushPlatform.Ios,
  pushToken: `apns-${randomUUID()}`,
  pushToStartToken: null,
  apnsEnvironment: null,
  publicKey: key(1),
  backupDeviceKey: null,
  disabledEvents: [],
  ...overrides,
});

beforeAll(async () => {
  db = await getKyselyDB();
});

afterAll(async () => {
  await db?.destroy();
});

describe('push device registry (FL-228)', () => {
  it('registers one device per session and rotates its tokens in place', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { session } = await ctx.newSession({ userId: user.id });

    const first = await sut.upsert(registration(user.id, session.id, { pushToken: 'apns-1' }));
    const rotated = await sut.upsert(
      registration(user.id, session.id, { pushToken: 'apns-2', pushToStartToken: 'start-1', publicKey: key(2) }),
    );

    expect(rotated.id).toBe(first.id);
    expect(rotated).toMatchObject({ pushToken: 'apns-2', pushToStartToken: 'start-1', publicKey: key(2) });
    expect(await sut.getByUser(user.id)).toHaveLength(1);
  });

  it('keeps the APNs environment of a development build, and changes it in place (FL-302)', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { session } = await ctx.newSession({ userId: user.id });

    await sut.upsert(registration(user.id, session.id, { apnsEnvironment: 'sandbox' }));
    expect(await sut.getBySession(session.id)).toMatchObject({ apnsEnvironment: 'sandbox' });
    const [target] = await sut.getDeliveryTargets([user.id]);
    expect(target).toMatchObject({ apnsEnvironment: 'sandbox' });

    await sut.update(session.id, { apnsEnvironment: null });
    expect(await sut.getBySession(session.id)).toMatchObject({ apnsEnvironment: null });
  });

  it('moves a push token that reappears under a new session instead of keeping two registrations', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { session: old } = await ctx.newSession({ userId: user.id });
    const { session: next } = await ctx.newSession({ userId: user.id });

    await sut.upsert(registration(user.id, old.id, { pushToken: 'same-token' }));
    await sut.upsert(registration(user.id, next.id, { pushToken: 'same-token' }));

    const devices = await sut.getByUser(user.id);
    expect(devices.map(({ sessionId }) => sessionId)).toEqual([next.id]);
  });

  it('removes the registration and its Live Activity tokens when the session is deleted (logout, revoke)', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { session } = await ctx.newSession({ userId: user.id });
    const device = await sut.upsert(registration(user.id, session.id));
    await sut.setActivity(device.id, { activityId: 'activity-1', kind: 'cloud-backup-activation', token: 'update-1' });

    await ctx.get(SessionRepository).delete(session.id);

    expect(await sut.getByUser(user.id)).toEqual([]);
    const activities = await db.selectFrom('push_device_activity').where('deviceId', '=', device.id).execute();
    expect(activities).toEqual([]);
  });

  it('removes every registration of an account that is removed', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { session } = await ctx.newSession({ userId: user.id });
    const { session: other } = await ctx.newSession({ userId: user.id });
    await sut.upsert(registration(user.id, session.id));
    await sut.upsert(registration(user.id, other.id));

    expect(await sut.deleteAllForUser(user.id)).toBe(2);
    expect(await sut.getByUser(user.id)).toEqual([]);

    const { session: again } = await ctx.newSession({ userId: user.id });
    await sut.upsert(registration(user.id, again.id));
    await sql`DELETE FROM "user" WHERE id = ${user.id}`.execute(db);
    expect(await db.selectFrom('push_device').where('userId', '=', user.id).execute()).toEqual([]);
  });

  it('keeps one update token per Live Activity and replaces it when ActivityKit rotates it', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { session } = await ctx.newSession({ userId: user.id });
    const device = await sut.upsert(registration(user.id, session.id));

    await sut.setActivity(device.id, { activityId: 'a', kind: 'cloud-backup-activation', token: 'update-1' });
    await sut.setActivity(device.id, { activityId: 'a', kind: 'cloud-backup-activation', token: 'update-2' });

    const [target] = await sut.getDeliveryTargets([user.id]);
    expect(target.activities).toEqual([
      expect.objectContaining({ activityId: 'a', kind: 'cloud-backup-activation', token: 'update-2' }),
    ]);

    expect(await sut.deleteActivity(device.id, 'a')).toBe(true);
    expect((await sut.getDeliveryTargets([user.id]))[0].activities).toEqual([]);
  });

  it('finds delivery targets of the given users only, with their preferences', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { user: other } = await ctx.newUser();
    const { session } = await ctx.newSession({ userId: user.id });
    const { session: otherSession } = await ctx.newSession({ userId: other.id });
    await sut.upsert(registration(user.id, session.id, { disabledEvents: [PushEventType.Memories] }));
    await sut.upsert(registration(other.id, otherSession.id));

    const targets = await sut.getDeliveryTargets([user.id]);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ userId: user.id, disabledEvents: [PushEventType.Memories] });
  });

  it('only offers items for a preview that are neither Locked, hidden, sensitive nor trashed', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { asset: ordinary } = await ctx.newAsset({ ownerId: user.id });
    const { asset: locked } = await ctx.newAsset({ ownerId: user.id });
    const { asset: legacyLocked } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Locked });
    const { asset: hidden } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Hidden });
    const { asset: sensitive } = await ctx.newAsset({ ownerId: user.id });
    const { asset: trashed } = await ctx.newAsset({ ownerId: user.id, deletedAt: new Date() });
    await db
      .insertInto('asset_lock')
      .values({ assetId: locked.id, reason: AssetLockReason.Marked, lockedBy: user.id })
      .execute();
    await db.updateTable('asset').set({ is_nsfw: true }).where('id', '=', sensitive.id).execute();

    const safe = await sut.getPreviewSafeAssetIds([
      ordinary.id,
      locked.id,
      legacyLocked.id,
      hidden.id,
      sensitive.id,
      trashed.id,
      randomUUID(),
    ]);

    expect([...safe]).toEqual([ordinary.id]);
    expect(await sut.getPreviewSafeAssetIds([])).toEqual(new Set());
  });

  it("keeps items a recipient hides by person or tag out of that recipient's preview only (FL-293)", async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { user: other } = await ctx.newUser();
    const { asset: ordinary } = await ctx.newAsset({ ownerId: user.id });
    const { asset: withPerson } = await ctx.newAsset({ ownerId: user.id });
    const { asset: withTag } = await ctx.newAsset({ ownerId: user.id });
    const { asset: othersWithPerson } = await ctx.newAsset({ ownerId: other.id });
    const { person } = await ctx.newPerson({ ownerId: user.id, name: 'Hidden' });
    await ctx.newAssetFace({ assetId: withPerson.id, personGroupId: person.personGroupId });
    await ctx.newAssetFace({ assetId: othersWithPerson.id, personGroupId: person.personGroupId });
    const { tag: parent } = await ctx.newTag({ userId: user.id, value: 'private' });
    const { tag: child } = await ctx.newTag({ userId: user.id, value: 'private/letters', parentId: parent.id });
    await ctx.newTagAsset({ tagIds: [child.id], assetIds: [withTag.id] });
    const ids = [ordinary.id, withPerson.id, withTag.id, othersWithPerson.id];
    const rules = {
      userId: user.id,
      includeNsfw: false,
      personIds: [person.personGroupId],
      tagIds: [parent.id],
      petIds: [],
    };

    // somebody without such rules sees all four
    expect(await sut.getPreviewSafeAssetIds(ids)).toEqual(new Set(ids));
    // the rules of this recipient, applying to their own items: the person, and the tag through its parent
    expect(await sut.getPreviewSafeAssetIds(ids, { ...rules, scope: 'owned' })).toEqual(
      new Set([ordinary.id, othersWithPerson.id]),
    );
    // applying to everything they can see
    expect(await sut.getPreviewSafeAssetIds(ids, { ...rules, scope: 'visible' })).toEqual(new Set([ordinary.id]));
  });

  it('finds devices whose phone backup went stale, at most once per wake window', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { session } = await ctx.newSession({ userId: user.id });
    const { session: freshSession } = await ctx.newSession({ userId: user.id });
    const staleKey = randomUUID();
    const freshKey = randomUUID();
    const now = Date.now();
    await db
      .insertInto('backup_device')
      .values([
        {
          ownerId: user.id,
          deviceKey: staleKey,
          displayName: 'Phone',
          model: 'Phone',
          platform: 'ios',
          appVersion: '1',
          pendingCount: 3,
          lastSuccessfulBackupAt: new Date(now - 5 * 86_400_000),
        },
        {
          ownerId: user.id,
          deviceKey: freshKey,
          displayName: 'Tablet',
          model: 'Tablet',
          platform: 'ios',
          appVersion: '1',
          pendingCount: 0,
          lastSuccessfulBackupAt: new Date(now - 3_600_000),
        },
      ])
      .execute();
    const stale = await sut.upsert(registration(user.id, session.id, { backupDeviceKey: staleKey }));
    await sut.upsert(registration(user.id, freshSession.id, { backupDeviceKey: freshKey }));

    const cutoff = new Date(now - 2 * 86_400_000);
    const wakeCutoff = new Date(now - 20 * 3_600_000);
    const targets = await sut.getStaleBackupWakeTargets(cutoff, wakeCutoff);
    expect(targets).toEqual([
      expect.objectContaining({ deviceId: stale.id, userId: user.id, backupDeviceKey: staleKey, pendingCount: 3 }),
    ]);

    await sut.markStaleWake([stale.id]);
    expect(await sut.getStaleBackupWakeTargets(cutoff, wakeCutoff)).toEqual([]);
  });

  it('summarises the memories that became visible for each owner, for the memories notice', async () => {
    const { ctx } = setup();
    const memories = new MemoryRepository(db);
    const { user } = await ctx.newUser();
    const { user: other } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    const now = new Date();
    const since = new Date(now.getTime() - 86_400_000);
    const memory = (ownerId: string, overrides: Record<string, unknown> = {}) => ({
      ownerId,
      type: MemoryType.OnThisDay,
      data: { year: 2020 },
      memoryAt: now,
      showAt: new Date(now.getTime() - 3_600_000),
      hideAt: new Date(now.getTime() + 86_400_000),
      ...overrides,
    });
    await memories.create(memory(user.id), new Set([asset.id]));
    await memories.create(memory(user.id), new Set());
    // not yet shown, already seen, deleted: none of them is news
    await memories.create(memory(user.id, { showAt: new Date(now.getTime() + 86_400_000) }), new Set());
    await memories.create(memory(user.id, { seenAt: now }), new Set());
    await db
      .insertInto('memory')
      .values(memory(other.id, { deletedAt: now }))
      .execute();

    const summaries = await memories.getNewlyVisibleSummaries(since, now);

    expect(summaries).toEqual([{ ownerId: user.id, count: 2, assetIds: [asset.id] }]);
  });
});
