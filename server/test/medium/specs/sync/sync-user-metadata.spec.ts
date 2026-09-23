import { Kysely } from 'kysely';
import { SyncEntityType, SyncRequestType, UserMetadataKey } from 'src/enum.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { SyncTestContext } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = async (db?: Kysely<DB>) => {
  const ctx = new SyncTestContext(db || defaultDatabase);
  const { auth, user, session } = await ctx.newSyncAuthUser();
  return { auth, user, session, ctx };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(SyncEntityType.UserMetadataV1, () => {
  it('should detect and sync new user metadata', async () => {
    const { auth, user, ctx } = await setup();

    const userRepo = ctx.get(UserRepository);
    await userRepo.upsertMetadata(user.id, { key: UserMetadataKey.Onboarding, value: { isOnboarded: true } });

    const response = await ctx.syncStream(auth, [SyncRequestType.UserMetadataV1]);
    expect(response).toEqual([
      {
        ack: expect.any(String),
        data: {
          key: UserMetadataKey.Onboarding,
          userId: user.id,
          value: { isOnboarded: true },
        },
        type: 'UserMetadataV1',
      },
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);

    await ctx.syncAckAll(auth, response);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.UserMetadataV1]);
  });

  it('should update user metadata', async () => {
    const { auth, user, ctx } = await setup();

    const userRepo = ctx.get(UserRepository);
    await userRepo.upsertMetadata(user.id, { key: UserMetadataKey.Onboarding, value: { isOnboarded: true } });

    const response = await ctx.syncStream(auth, [SyncRequestType.UserMetadataV1]);
    expect(response).toEqual([
      {
        ack: expect.any(String),
        data: {
          key: UserMetadataKey.Onboarding,
          userId: user.id,
          value: { isOnboarded: true },
        },
        type: 'UserMetadataV1',
      },
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);

    await ctx.syncAckAll(auth, response);

    await userRepo.upsertMetadata(user.id, { key: UserMetadataKey.Onboarding, value: { isOnboarded: false } });

    const updatedResponse = await ctx.syncStream(auth, [SyncRequestType.UserMetadataV1]);
    expect(updatedResponse).toEqual([
      {
        ack: expect.any(String),
        data: {
          key: UserMetadataKey.Onboarding,
          userId: user.id,
          value: { isOnboarded: false },
        },
        type: 'UserMetadataV1',
      },
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);

    await ctx.syncAckAll(auth, updatedResponse);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.UserMetadataV1]);
  });

  it('should leave Locked people, pets and tags out of preferences for a session that is not unlocked (FL-67)', async () => {
    const { auth, user, ctx } = await setup();
    const personId = 'c5f9f5a1-3b8d-4f6e-9a2b-0d1e2f3a4b5c';

    const userRepo = ctx.get(UserRepository);
    await userRepo.upsertMetadata(user.id, {
      key: UserMetadataKey.Preferences,
      value: { tags: { enabled: true }, privacy: { suppression: { personIds: [personId], scope: 'visible' } } },
    });

    const response = await ctx.syncStream(auth, [SyncRequestType.UserMetadataV1]);
    expect(response).toEqual([
      {
        ack: expect.any(String),
        data: {
          key: UserMetadataKey.Preferences,
          userId: user.id,
          value: { tags: { enabled: true }, privacy: { suppression: { scope: 'visible' } } },
        },
        type: 'UserMetadataV1',
      },
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);
    expect(JSON.stringify(response)).not.toContain(personId);
  });

  it('should still sync Locked people, pets and tags to an unlocked session (FL-67)', async () => {
    const { auth, user, ctx } = await setup();
    const unlocked = { ...auth, session: { ...auth.session!, hasElevatedPermission: true } };
    const personId = 'c5f9f5a1-3b8d-4f6e-9a2b-0d1e2f3a4b5c';

    const userRepo = ctx.get(UserRepository);
    await userRepo.upsertMetadata(user.id, {
      key: UserMetadataKey.Preferences,
      value: { privacy: { suppression: { personIds: [personId] } } },
    });

    const response = await ctx.syncStream(unlocked, [SyncRequestType.UserMetadataV1]);
    expect(response).toEqual([
      {
        ack: expect.any(String),
        data: {
          key: UserMetadataKey.Preferences,
          userId: user.id,
          value: { privacy: { suppression: { personIds: [personId] } } },
        },
        type: 'UserMetadataV1',
      },
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);
  });
});

describe(SyncEntityType.UserMetadataDeleteV1, () => {
  it('should delete and sync user metadata', async () => {
    const { auth, user, ctx } = await setup();

    const userRepo = ctx.get(UserRepository);
    await userRepo.upsertMetadata(user.id, { key: UserMetadataKey.Onboarding, value: { isOnboarded: true } });

    const response = await ctx.syncStream(auth, [SyncRequestType.UserMetadataV1]);
    expect(response).toEqual([
      {
        ack: expect.any(String),
        data: {
          key: UserMetadataKey.Onboarding,
          userId: user.id,
          value: { isOnboarded: true },
        },
        type: 'UserMetadataV1',
      },
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);

    await ctx.syncAckAll(auth, response);

    await userRepo.deleteMetadata(auth.user.id, UserMetadataKey.Onboarding);

    await expect(ctx.syncStream(auth, [SyncRequestType.UserMetadataV1])).resolves.toEqual([
      {
        ack: expect.any(String),
        data: {
          userId: user.id,
          key: UserMetadataKey.Onboarding,
        },
        type: 'UserMetadataDeleteV1',
      },
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);
  });
});
