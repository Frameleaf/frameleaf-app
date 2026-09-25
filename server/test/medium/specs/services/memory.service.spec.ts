import { Kysely } from 'kysely';
import { DateTime } from 'luxon';
import { BulkIdErrorReason } from 'src/dtos/asset-ids.response.dto.js';
import { AssetFileType, AssetLockReason, MemoryShowLessKind, MemoryType, PetObservationState } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MemoryRepository } from 'src/repositories/memory.repository.js';
import { PartnerRepository } from 'src/repositories/partner.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { MemoryService } from 'src/services/memory.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  return newMediumService(MemoryService, {
    database: db || defaultDatabase,
    real: [
      AccessRepository,
      AssetRepository,
      DatabaseRepository,
      MemoryRepository,
      UserRepository,
      SystemMetadataRepository,
      UserRepository,
      PartnerRepository,
    ],
    mock: [LoggingRepository],
  });
};

const create = async (ctx: ReturnType<typeof setup>['ctx']) => {
  const { user } = await ctx.newUser();
  const { memory } = await ctx.newMemory({ ownerId: user.id });
  const { asset } = await ctx.newAsset({ ownerId: user.id });

  return { memory, asset, user };
};

describe(MemoryService.name, () => {
  describe('get', () => {
    it('should return the memory', async () => {
      const { sut, ctx } = setup();
      const { memory, user } = await create(ctx);
      const auth = factory.auth({ user });

      await expect(sut.get(auth, memory.id)).resolves.toEqual(expect.objectContaining({ id: memory.id }));
    });

    it('should not return a memory of another user', async () => {
      const { sut, ctx } = setup();
      const { memory } = await create(ctx);
      const { user: otherUser } = await ctx.newUser();
      const otherAuth = factory.auth({ user: otherUser });

      await expect(sut.get(otherAuth, memory.id)).rejects.toThrow('Not found or no memory.read access');
    });
  });

  describe('cleanup', () => {
    it('keeps a locked asset in its memory, hidden while locked and back once unlocked (FL-34)', async () => {
      const { sut, ctx } = setup();
      const { memory, asset, user } = await create(ctx);
      const auth = factory.auth({ user });
      await ctx.newMemoryAsset({ memoryId: memory.id, assetId: asset.id });
      const assetRepository = ctx.get(AssetRepository);
      await assetRepository.lock([asset.id], AssetLockReason.Marked, user.id);

      await ctx.get(MemoryRepository).cleanup();

      await expect(sut.get(auth, memory.id)).resolves.toEqual(expect.objectContaining({ assets: [] }));

      await assetRepository.unlock([asset.id]);

      await expect(sut.get(auth, memory.id)).resolves.toEqual(
        expect.objectContaining({ assets: [expect.objectContaining({ id: asset.id })] }),
      );
    });
  });

  describe('update', () => {
    it('should update the memory', async () => {
      const { sut, ctx } = setup();
      const { memory, user } = await create(ctx);
      const auth = factory.auth({ user });

      await expect(sut.get(auth, memory.id)).resolves.toEqual(expect.objectContaining({ isSaved: false }));
      await expect(sut.update(auth, memory.id, { isSaved: true })).resolves.toEqual(
        expect.objectContaining({ id: memory.id, isSaved: true }),
      );
    });

    it('should not update a memory of another user', async () => {
      const { sut, ctx } = setup();
      const { memory } = await create(ctx);
      const { user: otherUser } = await ctx.newUser();
      const otherAuth = factory.auth({ user: otherUser });

      await expect(sut.update(otherAuth, memory.id, { isSaved: true })).rejects.toThrow(
        'Not found or no memory.update access',
      );
    });
  });

  describe('remove', () => {
    it('should remove the memory', async () => {
      const { sut, ctx } = setup();
      const { memory, user } = await create(ctx);
      const auth = factory.auth({ user });

      await expect(sut.remove(auth, memory.id)).resolves.toBeUndefined();
      await expect(sut.get(auth, memory.id)).rejects.toThrow('Not found or no memory.read access');
    });

    it('should not remove a memory of another user', async () => {
      const { sut, ctx } = setup();
      const { memory, user } = await create(ctx);
      const auth = factory.auth({ user });
      const { user: otherUser } = await ctx.newUser();
      const otherAuth = factory.auth({ user: otherUser });

      await expect(sut.remove(otherAuth, memory.id)).rejects.toThrow('Not found or no memory.delete access');
      await expect(sut.get(auth, memory.id)).resolves.toEqual(expect.objectContaining({ id: memory.id }));
    });
  });

  describe('addAssets', () => {
    it('should add assets to the memory', async () => {
      const { sut, ctx } = setup();
      const { memory, asset, user } = await create(ctx);
      const auth = factory.auth({ user });

      await expect(sut.addAssets(auth, memory.id, { ids: [asset.id] })).resolves.toEqual([
        { id: asset.id, success: true },
      ]);
    });

    it('should require access to the asset', async () => {
      const { sut, ctx } = setup();
      const { memory, user } = await create(ctx);
      const auth = factory.auth({ user });
      const { user: other } = await ctx.newUser();
      const { asset: otherAsset } = await ctx.newAsset({ ownerId: other.id });

      await expect(sut.addAssets(auth, memory.id, { ids: [otherAsset.id] })).resolves.toEqual([
        { id: otherAsset.id, success: false, error: BulkIdErrorReason.NO_PERMISSION },
      ]);
    });

    it('should not add assets to a memory of another user', async () => {
      const { sut, ctx } = setup();
      const { memory, asset } = await create(ctx);
      const { user: otherUser } = await ctx.newUser();
      const otherAuth = factory.auth({ user: otherUser });

      await expect(sut.addAssets(otherAuth, memory.id, { ids: [asset.id] })).rejects.toThrow(
        'Not found or no memory.read access',
      );
    });
  });

  describe('removeAssets', () => {
    it('should remove assets from the memory', async () => {
      const { sut, ctx } = setup();
      const { memory, asset, user } = await create(ctx);
      const auth = factory.auth({ user });
      await ctx.newMemoryAsset({ memoryId: memory.id, assetId: asset.id });

      await expect(sut.removeAssets(auth, memory.id, { ids: [asset.id] })).resolves.toEqual([
        { id: asset.id, success: true },
      ]);
    });

    it('should only remove assets that are in the memory', async () => {
      const { sut, ctx } = setup();
      const { memory, asset, user } = await create(ctx);
      const auth = factory.auth({ user });

      await expect(sut.removeAssets(auth, memory.id, { ids: [asset.id] })).resolves.toEqual([
        { id: asset.id, success: false, error: BulkIdErrorReason.NOT_FOUND },
      ]);
    });

    it('should not remove assets from a memory of another user', async () => {
      const { sut, ctx } = setup();
      const { memory, asset } = await create(ctx);
      const { user: otherUser } = await ctx.newUser();
      const otherAuth = factory.auth({ user: otherUser });
      await ctx.newMemoryAsset({ memoryId: memory.id, assetId: asset.id });

      await expect(sut.removeAssets(otherAuth, memory.id, { ids: [asset.id] })).rejects.toThrow(
        'Not found or no memory.update access',
      );
    });
  });

  beforeEach(async () => {
    defaultDatabase = await getKyselyDB();
  });

  describe('create', () => {
    it('should create a new memory', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const dto = {
        type: MemoryType.OnThisDay,
        data: { year: 2021 },
        memoryAt: new Date(2021),
      };

      await expect(sut.create(auth, dto)).resolves.toEqual({
        id: expect.any(String),
        type: dto.type,
        data: dto.data,
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
        isSaved: false,
        isHidden: false,
        title: null,
        memoryAt: dto.memoryAt,
        ownerId: user.id,
        assets: [],
      });
    });

    it('should create a new memory (with assets)', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset: asset1 } = await ctx.newAsset({ ownerId: user.id });
      const { asset: asset2 } = await ctx.newAsset({ ownerId: user.id });
      const auth = factory.auth({ user });
      const dto = {
        type: MemoryType.OnThisDay,
        data: { year: 2021 },
        memoryAt: new Date(2021),
        assetIds: [asset1.id, asset2.id],
      };

      await expect(sut.create(auth, dto)).resolves.toEqual(
        expect.objectContaining({
          id: expect.any(String),
          assets: [expect.objectContaining({ id: asset1.id }), expect.objectContaining({ id: asset2.id })],
        }),
      );
    });

    it('should create a new memory and ignore assets the user does not have access to', async () => {
      const { sut, ctx } = setup();
      const { user: user1 } = await ctx.newUser();
      const { user: user2 } = await ctx.newUser();
      const { asset: asset1 } = await ctx.newAsset({ ownerId: user1.id });
      const { asset: asset2 } = await ctx.newAsset({ ownerId: user2.id });
      const auth = factory.auth({ user: user1 });
      const dto = {
        type: MemoryType.OnThisDay,
        data: { year: 2021 },
        memoryAt: new Date(2021),
        assetIds: [asset1.id, asset2.id],
      };

      await expect(sut.create(auth, dto)).resolves.toEqual(
        expect.objectContaining({
          id: expect.any(String),
          assets: [expect.objectContaining({ id: asset1.id })],
        }),
      );
    });

    it('should not link a partner asset', async () => {
      const { sut, ctx } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: partner } = await ctx.newUser();
      await ctx.newPartner({ sharedById: partner.id, sharedWithId: owner.id, inTimeline: true });
      const { asset } = await ctx.newAsset({ ownerId: partner.id });
      const auth = factory.auth({ user: owner });
      const dto = {
        type: MemoryType.OnThisDay,
        data: { year: 2021 },
        memoryAt: new Date(2021),
        assetIds: [asset.id],
      };

      await expect(sut.create(auth, dto)).resolves.toEqual(expect.objectContaining({ assets: [] }));
    });
  });

  describe('addAssets', () => {
    it('should not link a partner asset', async () => {
      const { sut, ctx } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: partner } = await ctx.newUser();
      await ctx.newPartner({ sharedById: partner.id, sharedWithId: owner.id, inTimeline: true });
      const { asset } = await ctx.newAsset({ ownerId: partner.id });
      const auth = factory.auth({ user: owner });
      const memory = await sut.create(auth, {
        type: MemoryType.OnThisDay,
        data: { year: 2021 },
        memoryAt: new Date(2021),
      });

      await expect(sut.addAssets(auth, memory.id, { ids: [asset.id] })).resolves.toEqual([
        { id: asset.id, success: false, error: BulkIdErrorReason.NO_PERMISSION },
      ]);
    });
  });

  describe('onMemoryCreate', () => {
    it('should work on an empty database', async () => {
      const { sut } = setup();
      await expect(sut.onMemoriesCreate()).resolves.not.toThrow();
    });

    it('should create a memory from an asset', async () => {
      const { sut, ctx } = setup();
      const assetRepo = ctx.get(AssetRepository);
      const memoryRepo = ctx.get(MemoryRepository);
      const now = DateTime.fromObject({ year: 2025, month: 2, day: 25 }, { zone: 'utc' }) as DateTime<true>;
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id, localDateTime: now.minus({ years: 1 }).toISO() });
      await Promise.all([
        ctx.newExif({ assetId: asset.id, make: 'Canon' }),
        ctx.newJobStatus({ assetId: asset.id }),
        assetRepo.upsertFiles([
          { assetId: asset.id, type: AssetFileType.Preview, path: '/path/to/preview.jpg' },
          { assetId: asset.id, type: AssetFileType.Thumbnail, path: '/path/to/thumbnail.jpg' },
        ]),
      ]);

      vi.setSystemTime(now.toJSDate());
      await sut.onMemoriesCreate();

      const memories = await memoryRepo.search(user.id, {});
      expect(memories.length).toBe(1);
      expect(memories[0]).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          createdAt: expect.any(Date),
          memoryAt: expect.any(Date),
          updatedAt: expect.any(Date),
          deletedAt: null,
          ownerId: user.id,
          assets: expect.arrayContaining([expect.objectContaining({ id: asset.id })]),
          isSaved: false,
          showAt: now.startOf('day').toJSDate(),
          hideAt: now.endOf('day').toJSDate(),
          seenAt: null,
          type: 'on_this_day',
          data: { year: 2024 },
        }),
      );
    });

    it('should create a memory from an asset - in advance', async () => {
      const { sut, ctx } = setup();
      const assetRepo = ctx.get(AssetRepository);
      const memoryRepo = ctx.get(MemoryRepository);
      const now = DateTime.fromObject({ year: 2035, month: 2, day: 26 }, { zone: 'utc' }) as DateTime<true>;
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id, localDateTime: now.minus({ years: 1 }).toISO() });
      await Promise.all([
        ctx.newExif({ assetId: asset.id, make: 'Canon' }),
        ctx.newJobStatus({ assetId: asset.id }),
        assetRepo.upsertFiles([
          { assetId: asset.id, type: AssetFileType.Preview, path: '/path/to/preview.jpg' },
          { assetId: asset.id, type: AssetFileType.Thumbnail, path: '/path/to/thumbnail.jpg' },
        ]),
      ]);

      vi.setSystemTime(now.toJSDate());
      await sut.onMemoriesCreate();

      const memories = await memoryRepo.search(user.id, {});
      expect(memories.length).toBe(1);
      expect(memories[0]).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          createdAt: expect.any(Date),
          memoryAt: expect.any(Date),
          updatedAt: expect.any(Date),
          deletedAt: null,
          ownerId: user.id,
          assets: expect.arrayContaining([expect.objectContaining({ id: asset.id })]),
          isSaved: false,
          showAt: now.startOf('day').toJSDate(),
          hideAt: now.endOf('day').toJSDate(),
          seenAt: null,
          type: 'on_this_day',
          data: { year: 2034 },
        }),
      );
    });

    it('should not generate a memory twice for the same day', async () => {
      const { sut, ctx } = setup();
      const assetRepo = ctx.get(AssetRepository);
      const memoryRepo = ctx.get(MemoryRepository);
      const now = DateTime.fromObject({ year: 2025, month: 2, day: 20 }, { zone: 'utc' }) as DateTime<true>;
      const { user } = await ctx.newUser();
      for (const dto of [
        {
          ownerId: user.id,
          localDateTime: now.minus({ year: 1 }).plus({ days: 3 }).toISO(),
        },
        {
          ownerId: user.id,
          localDateTime: now.minus({ year: 1 }).plus({ days: 4 }).toISO(),
        },
        {
          ownerId: user.id,
          localDateTime: now.minus({ year: 1 }).plus({ days: 5 }).toISO(),
        },
      ]) {
        const { asset } = await ctx.newAsset(dto);
        await Promise.all([
          ctx.newExif({ assetId: asset.id, make: 'Canon' }),
          ctx.newJobStatus({ assetId: asset.id }),
          assetRepo.upsertFiles([
            { assetId: asset.id, type: AssetFileType.Preview, path: '/path/to/preview.jpg' },
            { assetId: asset.id, type: AssetFileType.Thumbnail, path: '/path/to/thumbnail.jpg' },
          ]),
        ]);
      }

      vi.setSystemTime(now.toJSDate());
      await sut.onMemoriesCreate();

      const memories = await memoryRepo.search(user.id, {});
      expect(memories.length).toBe(1);

      await sut.onMemoriesCreate();

      const memoriesAfter = await memoryRepo.search(user.id, {});
      expect(memoriesAfter.length).toBe(1);
    });
  });

  describe('search', () => {
    const memoryWithTwoPhotos = async (ctx: ReturnType<typeof setup>['ctx']) => {
      const { user } = await ctx.newUser();
      const { memory } = await ctx.newMemory({ ownerId: user.id });
      const { asset: petPhoto } = await ctx.newAsset({ ownerId: user.id });
      const { asset: otherPhoto } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newMemoryAsset({ memoryId: memory.id, assetId: petPhoto.id });
      await ctx.newMemoryAsset({ memoryId: memory.id, assetId: otherPhoto.id });
      const pet = await ctx.database
        .insertInto('pet')
        .values({ ownerId: user.id, name: 'Biscuit', isHidden: true })
        .returning('id')
        .executeTakeFirstOrThrow();
      return { user, petPhoto, otherPhoto, pet };
    };

    it('should leave out a photo of a pet the owner hid, as it does a hidden person', async () => {
      const { sut, ctx } = setup();
      const { user, petPhoto, otherPhoto, pet } = await memoryWithTwoPhotos(ctx);
      await ctx.database.insertInto('pet_observation').values({ petId: pet.id, assetId: petPhoto.id }).execute();

      const memories = await sut.search(factory.auth({ user }), {});

      expect(memories).toHaveLength(1);
      expect(memories[0].assets.map(({ id }) => id)).toEqual([otherPhoto.id]);
    });

    it('should keep a photo in which the owner rejected the hidden pet', async () => {
      const { sut, ctx } = setup();
      const { user, petPhoto, pet } = await memoryWithTwoPhotos(ctx);
      await ctx.database
        .insertInto('pet_observation')
        .values({ petId: pet.id, assetId: petPhoto.id, state: PetObservationState.Rejected })
        .execute();

      const memories = await sut.search(factory.auth({ user }), {});

      expect(memories[0].assets.map(({ id }) => id)).toContain(petPhoto.id);
    });
  });

  // FL-62 review: hiding, restoring or reading one memory never brings back an item the search leaves out.
  describe('single-memory reads', () => {
    const memoryWithTwoPhotos = async (ctx: ReturnType<typeof setup>['ctx'], isHidden: boolean) => {
      const { user } = await ctx.newUser();
      const { memory } = await ctx.newMemory({ ownerId: user.id });
      const { asset: petPhoto } = await ctx.newAsset({ ownerId: user.id });
      const { asset: otherPhoto } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newMemoryAsset({ memoryId: memory.id, assetId: petPhoto.id });
      await ctx.newMemoryAsset({ memoryId: memory.id, assetId: otherPhoto.id });
      const pet = await ctx.database
        .insertInto('pet')
        .values({ ownerId: user.id, name: 'Biscuit', isHidden })
        .returning('id')
        .executeTakeFirstOrThrow();
      await ctx.database.insertInto('pet_observation').values({ petId: pet.id, assetId: petPhoto.id }).execute();
      return { user, memory, petPhoto, otherPhoto, pet };
    };

    it('hides and restores a memory without the photo of a pet the owner hid', async () => {
      const { sut, ctx } = setup();
      const { user, memory, otherPhoto } = await memoryWithTwoPhotos(ctx, true);
      const auth = factory.auth({ user });

      const hidden = await sut.update(auth, memory.id, { isHidden: true });
      const restored = await sut.update(auth, memory.id, { isHidden: false });
      const read = await sut.get(auth, memory.id);

      for (const result of [hidden, restored, read]) {
        expect(result.assets.map(({ id }) => id)).toEqual([otherPhoto.id]);
      }
    });

    it('leaves out the photos of a pet the owner asked to see less of', async () => {
      const { sut, ctx } = setup();
      const { user, memory, otherPhoto, pet } = await memoryWithTwoPhotos(ctx, false);
      const auth = factory.auth({ user });
      await sut.addShowLess(auth, { kind: MemoryShowLessKind.Pet, value: pet.id });

      const restored = await sut.update(auth, memory.id, { isHidden: false, title: 'Our walk' });
      const read = await sut.get(auth, memory.id);
      const [byId] = await sut.search(auth, { id: memory.id });

      for (const result of [restored, read, byId]) {
        expect(result.assets.map(({ id }) => id)).toEqual([otherPhoto.id]);
      }
    });
  });

  describe('onMemoriesCleanup', () => {
    it('should run without error', async () => {
      const { sut } = setup();
      await expect(sut.onMemoriesCleanup()).resolves.not.toThrow();
    });
  });

  describe('pet stories (FL-58)', () => {
    it('reads only the owner’s confirmed photos of named, visible pets on the timeline', async () => {
      const { ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: other } = await ctx.newUser();
      const when = new Date('2026-08-10T12:00:00.000Z');
      const { asset: timeline } = await ctx.newAsset({ ownerId: user.id, localDateTime: when });
      const { asset: rejected } = await ctx.newAsset({ ownerId: user.id, localDateTime: when });
      const { asset: strangers } = await ctx.newAsset({ ownerId: other.id, localDateTime: when });
      const named = await ctx.database
        .insertInto('pet')
        .values({ ownerId: user.id, name: 'Biscuit' })
        .returningAll()
        .executeTakeFirstOrThrow();
      const nameless = await ctx.database
        .insertInto('pet')
        .values({ ownerId: user.id, name: '' })
        .returningAll()
        .executeTakeFirstOrThrow();
      await ctx.database
        .insertInto('pet_observation')
        .values([
          { petId: named.id, assetId: timeline.id },
          { petId: named.id, assetId: rejected.id, state: PetObservationState.Rejected },
          { petId: named.id, assetId: strangers.id },
          { petId: nameless.id, assetId: timeline.id },
        ])
        .execute();

      const rows = await ctx
        .get(MemoryRepository)
        .getPetStoryCandidates(user.id, new Date('2026-08-01T00:00:00.000Z'), new Date('2026-08-31T23:59:59.000Z'));

      expect(rows).toEqual([expect.objectContaining({ petId: named.id, name: 'Biscuit', assetId: timeline.id })]);
    });

    it('remembers every pet story it made in the window, deleted ones too', async () => {
      const { ctx } = setup();
      const { user } = await ctx.newUser();
      const repository = ctx.get(MemoryRepository);
      const memory = await repository.create(
        {
          ownerId: user.id,
          type: MemoryType.PetStory,
          data: { kind: 'pet_story', year: 2026, month: '2026-08', petId: 'pet-1', name: 'Biscuit' } as never,
          memoryAt: '2026-08-01T00:00:00.000Z',
          showAt: '2026-09-01T00:00:00.000Z',
        },
        new Set(),
      );
      await ctx.database.updateTable('memory').set({ deletedAt: new Date() }).where('id', '=', memory.id).execute();

      await expect(
        repository.getPetStoryKeys(user.id, new Date('2026-07-01T00:00:00.000Z'), new Date('2026-09-30T00:00:00.000Z')),
      ).resolves.toEqual(new Set(['pet-1:2026-08']));
    });
  });
});
