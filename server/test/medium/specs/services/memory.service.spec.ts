import { Kysely } from 'kysely';
import { DateTime } from 'luxon';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buffer, text } from 'node:stream/consumers';
import { StorageCore } from 'src/cores/storage.core.js';
import { BulkIdErrorReason } from 'src/dtos/asset-ids.response.dto.js';
import {
  AssetFileType,
  AssetLockReason,
  JobStatus,
  MediaOperationDestination,
  MediaOperationKind,
  MemoryExportFormat,
  MemoryExportStatus,
  MemoryShowLessKind,
  MemoryType,
  PetObservationState,
  StorageFolder,
  StudioExportScope,
  StudioExportVersionState,
  SystemMetadataKey,
} from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { DerivativePrivacyRepository } from 'src/repositories/derivative-privacy.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { MemoryRepository } from 'src/repositories/memory.repository.js';
import { PartnerRepository } from 'src/repositories/partner.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { StudioExportRepository } from 'src/repositories/studio-export.repository.js';
import { StudioProjectRepository } from 'src/repositories/studio-project.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { MemoryHighlightService } from 'src/services/memory-highlight.service.js';
import { MemoryService } from 'src/services/memory.service.js';
import { StudioExportService } from 'src/services/studio-export.service.js';
import { emptyHiddenContentFilter } from 'src/utils/hidden-content.js';
import { studioExportProjectPath } from 'src/utils/studio-export.js';
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
      StorageRepository,
      PersonRepository,
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
    it('keeps a locked asset in its memory, hidden while locked and back once unlocked (FL-34, FL-195)', async () => {
      const { sut, ctx } = setup();
      const { memory, asset, user } = await create(ctx);
      const auth = factory.auth({ user });
      const elevated = { ...auth, session: { id: 'session', hasElevatedPermission: true } } as typeof auth;
      await ctx.newMemoryAsset({ memoryId: memory.id, assetId: asset.id });
      const assetRepository = ctx.get(AssetRepository);
      await assetRepository.lock([asset.id], AssetLockReason.Marked, user.id);

      await ctx.get(MemoryRepository).cleanup();

      // FL-195: a memory holding a locked item shows nowhere while the session is locked, not even as
      // an empty memory, and is out of reach like one that does not exist; the owner's unlocked session
      // sees it with its item, like any other memory
      await expect(sut.get(auth, memory.id)).rejects.toThrow('Not found or no memory.read access');
      await expect(sut.search(auth, {})).resolves.not.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: memory.id })]),
      );
      await expect(sut.get(elevated, memory.id)).resolves.toEqual(
        expect.objectContaining({ assets: [expect.objectContaining({ id: asset.id })] }),
      );

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

  describe('memories holding hidden items (FL-195 follow-up)', () => {
    it('counts only memories containing an item search can return', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { memory } = await ctx.newMemory({ ownerId: user.id });
      const { asset } = await ctx.newAsset({ ownerId: user.id, deletedAt: new Date() });
      await ctx.newMemoryAsset({ memoryId: memory.id, assetId: asset.id });
      await expect(sut.search(auth, {})).resolves.toEqual([]);
      await expect(sut.statistics(auth, {})).resolves.toEqual({ total: 0 });
    });

    const withPreview = async (ctx: ReturnType<typeof setup>['ctx'], assetId: string) => {
      await Promise.all([
        ctx.newExif({ assetId, make: 'Canon' }),
        ctx.newJobStatus({ assetId }),
        ctx.get(AssetRepository).upsertFiles([
          { assetId, type: AssetFileType.Preview, path: `/path/to/${assetId}-preview.jpg` },
          { assetId, type: AssetFileType.Thumbnail, path: `/path/to/${assetId}-thumbnail.jpg` },
        ]),
      ]);
    };

    it('hides a memory with even one locked item entirely while locked, and shows all of it unlocked', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const ordinary = factory.auth({ user });
      const elevated = { ...ordinary, session: { id: 'session', hasElevatedPermission: true } } as typeof ordinary;
      const { memory: mixed } = await ctx.newMemory({ ownerId: user.id });
      const { memory: open } = await ctx.newMemory({ ownerId: user.id });
      const { asset: plain } = await ctx.newAsset({ ownerId: user.id });
      const { asset: moved } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newMemoryAsset({ memoryId: mixed.id, assetId: plain.id });
      await ctx.newMemoryAsset({ memoryId: mixed.id, assetId: moved.id });
      await ctx.newMemoryAsset({ memoryId: open.id, assetId: plain.id });
      // an item moved from the old Locked folder, revealed like any other lock once unlocked
      await ctx.database
        .insertInto('asset_lock')
        .values({ assetId: moved.id, reason: AssetLockReason.ImmichLockedFolder })
        .execute();

      const ids = (memories: { id: string }[]) => memories.map(({ id }) => id).toSorted();
      await expect(sut.search(ordinary, {}).then(ids)).resolves.toEqual([open.id]);
      await expect(sut.statistics(ordinary, {})).resolves.toEqual({ total: 1 });
      await expect(sut.get(ordinary, mixed.id)).rejects.toThrow();
      await expect(sut.update(ordinary, mixed.id, { isSaved: true })).rejects.toThrow();

      await expect(sut.search(elevated, {}).then(ids)).resolves.toEqual([mixed.id, open.id].toSorted());
      await expect(sut.statistics(elevated, {})).resolves.toEqual({ total: 2 });
      const shown = await sut.get(elevated, mixed.id);
      expect(shown.assets.map(({ id }) => id).toSorted()).toEqual([plain.id, moved.id].toSorted());

      // another account's unlocked session never reaches it
      const { user: other } = await ctx.newUser();
      const otherElevated = { ...factory.auth({ user: other }), session: { id: 's2', hasElevatedPermission: true } };
      await expect(sut.get(otherElevated as never, mixed.id)).rejects.toThrow();
    });

    it("hides a memory holding an item the owner's Locked rules match while locked", async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { memory } = await ctx.newMemory({ ownerId: user.id });
      const { asset: plain } = await ctx.newAsset({ ownerId: user.id });
      const { asset: matched } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newMemoryAsset({ memoryId: memory.id, assetId: plain.id });
      await ctx.newMemoryAsset({ memoryId: memory.id, assetId: matched.id });
      const { tag } = await ctx.newTag({ userId: user.id, value: 'Private' });
      await ctx.newTagAsset({ tagIds: [tag.id], assetIds: [matched.id] });
      const locked = factory.auth({ user });
      locked.hiddenContent = {
        userId: user.id,
        includeNsfw: false,
        tagIds: [tag.id],
        personIds: [],
        petIds: [],
        scope: 'owned',
      };

      await expect(sut.search(locked, {})).resolves.toEqual([]);
      await expect(sut.get(locked, memory.id)).rejects.toThrow();
      const unlocked = { ...factory.auth({ user }), session: { id: 'session', hasElevatedPermission: true } };
      await expect(sut.get(unlocked as never, memory.id)).resolves.toEqual(
        expect.objectContaining({ assets: expect.arrayContaining([expect.objectContaining({ id: matched.id })]) }),
      );
    });

    it('generates memories from locked items too, shown only to the unlocked session', async () => {
      const { sut, ctx } = setup();
      const now = DateTime.fromObject({ year: 2025, month: 3, day: 12 }, { zone: 'utc' }) as DateTime<true>;
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id, localDateTime: now.minus({ years: 1 }).toISO() });
      await withPreview(ctx, asset.id);
      await ctx.get(AssetRepository).lock([asset.id], AssetLockReason.Marked, user.id);

      vi.setSystemTime(now.toJSDate());
      await sut.onMemoriesCreate();

      const ordinary = factory.auth({ user });
      const elevated = { ...ordinary, session: { id: 'session', hasElevatedPermission: true } } as typeof ordinary;
      await expect(sut.search(ordinary, {})).resolves.toEqual([]);
      const memories = await sut.search(elevated, {});
      expect(memories).toHaveLength(1);
      expect(memories[0].assets.map(({ id }) => id)).toEqual([asset.id]);
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

  // FL-57: a birthday or recap names a person and shows their photos; a face or person change must
  // never leave it naming someone else or showing a photo that no longer shows them.
  describe('birthdays and recaps after face changes (FL-57)', () => {
    const personMemory = async (ctx: ReturnType<typeof setup>['ctx'], type = MemoryType.Birthday) => {
      const { user } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user.id, name: 'Ann' });
      const { person: other } = await ctx.newPerson({ ownerId: user.id, name: 'Bea' });
      const { asset: moved } = await ctx.newAsset({ ownerId: user.id });
      const { asset: kept } = await ctx.newAsset({ ownerId: user.id });
      const { assetFace: movedFace } = await ctx.newAssetFace({
        assetId: moved.id,
        personGroupId: person.personGroupId,
      });
      await ctx.newAssetFace({ assetId: kept.id, personGroupId: person.personGroupId });
      const { memory } = await ctx.newMemory({
        ownerId: user.id,
        type,
        data: {
          kind: type === MemoryType.Birthday ? 'birthday' : 'person_recap',
          year: 2026,
          subject: 'person',
          subjectId: person.personGroupId,
          name: 'Ann',
        } as never,
      });
      await ctx.newMemoryAsset({ memoryId: memory.id, assetId: moved.id });
      await ctx.newMemoryAsset({ memoryId: memory.id, assetId: kept.id });
      return { user, person, other, moved, kept, movedFace, memory };
    };

    it('names the person as they are called now', async () => {
      const { sut, ctx } = setup();
      const { user, person, memory } = await personMemory(ctx);
      const auth = factory.auth({ user });
      await ctx.database
        .updateTable('person')
        .set({ name: 'Anna' })
        .where('personGroupId', '=', person.personGroupId)
        .execute();

      const [found] = await sut.search(auth, {});
      const read = await sut.get(auth, memory.id);

      for (const result of [found, read]) {
        expect(result.data).toEqual(expect.objectContaining({ name: 'Anna' }));
      }
    });

    it('leaves out a photo whose face was moved to someone else, and brings it back on undo', async () => {
      const { sut, ctx } = setup();
      const { user, person, other, moved, kept, movedFace, memory } = await personMemory(ctx, MemoryType.PersonRecap);
      const auth = factory.auth({ user });
      const { memory: onThisDay } = await ctx.newMemory({ ownerId: user.id, data: { year: 2020 } });
      await ctx.newMemoryAsset({ memoryId: onThisDay.id, assetId: moved.id });
      const moveTo = (personGroupId: string) =>
        ctx.database.updateTable('asset_face').set({ personGroupId }).where('id', '=', movedFace.id).execute();

      await moveTo(other.personGroupId);
      const recap = (await sut.search(auth, {})).find(({ id }) => id === memory.id);
      expect(recap?.assets.map(({ id }) => id)).toEqual([kept.id]);
      expect((await sut.get(auth, memory.id)).assets.map(({ id }) => id)).toEqual([kept.id]);
      // a memory that does not name a person keeps its photo
      expect((await sut.get(auth, onThisDay.id)).assets.map(({ id }) => id)).toEqual([moved.id]);

      await moveTo(person.personGroupId);
      expect((await sut.get(auth, memory.id)).assets.map(({ id }) => id).toSorted()).toEqual(
        [moved.id, kept.id].toSorted(),
      );
    });

    it('is left out once the person is merged away, hidden or suppressed while locked', async () => {
      const { sut, ctx } = setup();
      const { user, person, memory } = await personMemory(ctx);
      const auth = factory.auth({ user });
      const locked = {
        ...factory.auth({ user }),
        hiddenContent: { ...emptyHiddenContentFilter(user.id), personIds: [person.personGroupId] },
      };

      await expect(sut.search(locked, {})).resolves.toEqual([]);
      await expect(sut.get(locked, memory.id)).rejects.toThrow(/not found/i);

      await ctx.database
        .updateTable('person')
        .set({ isHidden: true })
        .where('personGroupId', '=', person.personGroupId)
        .execute();
      await expect(sut.search(auth, {})).resolves.toEqual([]);
      await expect(sut.statistics(auth, {})).resolves.toEqual({ total: 0 });

      await ctx.database.deleteFrom('person').where('personGroupId', '=', person.personGroupId).execute();
      await expect(sut.search(auth, {})).resolves.toEqual([]);
      await expect(sut.statistics(auth, { type: MemoryType.Birthday })).resolves.toEqual({ total: 0 });
      await expect(sut.get(auth, memory.id)).rejects.toThrow(/not found/i);
    });
  });

  describe('onMemoriesCleanup', () => {
    it('should run without error', async () => {
      const { sut } = setup();
      const mediaLocation = mkdtempSync(join(tmpdir(), 'memory-cleanup-'));
      StorageCore.setMediaLocation(mediaLocation);
      try {
        await expect(sut.onMemoriesCleanup()).resolves.not.toThrow();
      } finally {
        StorageCore.reset();
        rmSync(mediaLocation, { recursive: true, force: true });
      }
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

  // FL-62 validation: memory generation across a time-zone boundary, with duplicate suppression.
  describe('birthdays across time zones (FL-62)', () => {
    it("keeps a 29 February pet's birthday on 28 February, shown for that day in every zone, once", async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const pet = await ctx.database
        .insertInto('pet')
        .values({ ownerId: user.id, name: 'Biscuit', birthDate: '2024-02-29' })
        .returning('id')
        .executeTakeFirstOrThrow();
      for (const localDateTime of ['2024-06-01T10:00:00Z', '2025-03-02T10:00:00Z', '2026-08-15T10:00:00Z']) {
        const { asset } = await ctx.newAsset({ ownerId: user.id, localDateTime });
        await ctx
          .get(AssetRepository)
          .upsertFiles([{ assetId: asset.id, type: AssetFileType.Preview, path: '/path/to/preview.jpg' }]);
        await ctx.database.insertInto('pet_observation').values({ petId: pet.id, assetId: asset.id }).execute();
      }

      vi.setSystemTime(new Date('2027-02-28T12:00:00Z'));
      await sut.onMemoriesCreate();
      // a second pass that has forgotten where it got to must not make the birthday twice
      await ctx.database.deleteFrom('system_metadata').where('key', '=', SystemMetadataKey.MemoriesState).execute();
      await sut.onMemoriesCreate();

      const birthdays = await ctx.get(MemoryRepository).search(user.id, { type: MemoryType.Birthday });
      expect(birthdays).toHaveLength(1);
      expect(birthdays[0]).toEqual(
        expect.objectContaining({
          data: expect.objectContaining({ kind: 'birthday', date: '2027-02-28', subjectId: pet.id, age: 3 }),
          // the calendar day from its first start (UTC+14) to its last end (UTC-12)
          showAt: new Date('2027-02-27T10:00:00.000Z'),
          hideAt: new Date('2027-03-01T11:59:59.999Z'),
        }),
      );
      expect(birthdays[0].assets).toHaveLength(3);
      vi.useRealTimers();
    });
  });

  // FL-62 validation: the private highlight export against a real database and real files.
  describe('private highlight export (FL-62)', () => {
    let mediaLocation: string;

    beforeEach(() => {
      mediaLocation = mkdtempSync(join(tmpdir(), 'memory-export-'));
      // the storage core is a singleton; an earlier service in this file made it without storage
      StorageCore.reset();
      StorageCore.setMediaLocation(mediaLocation);
    });

    afterEach(() => {
      StorageCore.reset();
      rmSync(mediaLocation, { recursive: true, force: true });
    });

    const setupExport = () => {
      const services = newMediumService(MemoryService, {
        database: defaultDatabase,
        real: [
          AccessRepository,
          AssetRepository,
          DatabaseRepository,
          MemoryRepository,
          UserRepository,
          SystemMetadataRepository,
          PartnerRepository,
          StorageRepository,
        ],
        mock: [JobRepository, LoggingRepository],
      });
      services.ctx.getMock(JobRepository).queue.mockResolvedValue();
      return services;
    };

    const memoryWithFiles = async (ctx: ReturnType<typeof setupExport>['ctx']) => {
      const { user } = await ctx.newUser();
      const { memory } = await ctx.newMemory({ ownerId: user.id });
      const assets = [];
      for (const name of ['beach.jpg', 'sunset.jpg']) {
        const folder = join(mediaLocation, 'upload', user.id);
        mkdirSync(folder, { recursive: true });
        const originalPath = join(folder, name);
        writeFileSync(originalPath, `original bytes of ${name}`);
        const { asset } = await ctx.newAsset({ ownerId: user.id, originalPath, originalFileName: name });
        await ctx.newMemoryAsset({ memoryId: memory.id, assetId: asset.id });
        assets.push(asset);
      }
      return { user, memory, assets, auth: factory.auth({ user }) };
    };

    const archivePath = (ownerId: string, id: string) =>
      StorageCore.getNestedPath(StorageFolder.Exports, ownerId, `${id}.zip`);

    it('writes the snapshot taken at request time, and only the owner can read or download it', async () => {
      const { sut, ctx } = setupExport();
      const { user, memory, assets, auth } = await memoryWithFiles(ctx);
      const { user: stranger } = await ctx.newUser();

      const requested = await sut.createExport(auth, memory.id, {});
      // a membership edit after the request cannot change the export under way
      await sut.removeAssets(auth, memory.id, { ids: [assets[1].id] });

      await expect(sut.handleMemoryExport({ id: requested.id })).resolves.toBe(JobStatus.Success);

      const ready = await sut.getExport(auth, requested.id);
      expect(ready).toEqual(
        expect.objectContaining({ status: MemoryExportStatus.Ready, assetCount: 2, processedAssets: 2 }),
      );
      expect(existsSync(archivePath(user.id, requested.id))).toBe(true);
      const download = await sut.downloadExport(auth, requested.id);
      // Read the stream to the end: an unread stream opens its file lazily, after this test's
      // cleanup has removed the media folder, and that open error escapes as an uncaught exception.
      const archive = await buffer(download.stream);
      expect(download.length).toBe(ready.sizeInBytes);
      expect(archive.length).toBe(ready.sizeInBytes);

      const strangerAuth = factory.auth({ user: stranger });
      await expect(sut.getExport(strangerAuth, requested.id)).rejects.toThrow();
      await expect(sut.downloadExport(strangerAuth, requested.id)).rejects.toThrow();
      await expect(sut.getExports(strangerAuth)).resolves.toEqual([]);
    });

    it('returns the run in flight for a second request, and a failed run can be retried', async () => {
      const { sut, ctx } = setupExport();
      const { memory, auth } = await memoryWithFiles(ctx);

      const first = await sut.createExport(auth, memory.id, {});
      await expect(sut.createExport(auth, memory.id, {})).resolves.toEqual(expect.objectContaining({ id: first.id }));

      await ctx.get(MemoryRepository).updateExport(first.id, { status: MemoryExportStatus.Failed });
      const retried = await sut.createExport(auth, memory.id, {});
      expect(retried.id).not.toBe(first.id);
      expect(retried.status).toBe(MemoryExportStatus.Pending);
    });

    it('cancels a run before it starts, and the worker then writes nothing', async () => {
      const { sut, ctx } = setupExport();
      const { user, memory, auth } = await memoryWithFiles(ctx);

      const run = await sut.createExport(auth, memory.id, {});
      await expect(sut.cancelExport(auth, run.id)).resolves.toEqual(
        expect.objectContaining({ status: MemoryExportStatus.Cancelled }),
      );

      await expect(sut.handleMemoryExport({ id: run.id })).resolves.toBe(JobStatus.Skipped);
      expect(existsSync(archivePath(user.id, run.id))).toBe(false);
      await expect(sut.downloadExport(auth, run.id)).rejects.toThrow('Export is not ready');
    });

    it('removes the archive with its memory, and revokes the download', async () => {
      const { sut, ctx } = setupExport();
      const { user, memory, auth } = await memoryWithFiles(ctx);
      const run = await sut.createExport(auth, memory.id, {});
      await sut.handleMemoryExport({ id: run.id });
      expect(existsSync(archivePath(user.id, run.id))).toBe(true);

      await sut.remove(auth, memory.id);

      expect(existsSync(archivePath(user.id, run.id))).toBe(false);
      await expect(sut.downloadExport(auth, run.id)).rejects.toThrow();
    });

    it('removes an archive whose memory went by cascade at the next cleanup', async () => {
      const { sut, ctx } = setupExport();
      const { user, memory, auth } = await memoryWithFiles(ctx);
      const run = await sut.createExport(auth, memory.id, {});
      await sut.handleMemoryExport({ id: run.id });

      // the 30-day cleanup of unsaved memories deletes them in SQL, which cannot reach the disk
      await ctx.database.deleteFrom('memory').where('id', '=', memory.id).execute();
      expect(existsSync(archivePath(user.id, run.id))).toBe(true);

      await sut.onMemoriesCleanup();

      expect(existsSync(archivePath(user.id, run.id))).toBe(false);
    });

    it('fails a run abandoned by a lost worker on restart, removes its partial file and never resumes it', async () => {
      const { sut, ctx } = setupExport();
      const { user, memory, auth } = await memoryWithFiles(ctx);
      const run = await sut.createExport(auth, memory.id, {});
      const repository = ctx.get(MemoryRepository);
      await repository.claimExport(run.id);
      const partial = `${archivePath(user.id, run.id)}.partial`;
      mkdirSync(join(partial, '..'), { recursive: true });
      writeFileSync(partial, 'half an archive');
      await ctx.database
        .updateTable('memory_export')
        .set({ updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
        .where('id', '=', run.id)
        .execute();

      await sut.onMemoriesCleanup();

      await expect(sut.getExport(auth, run.id)).resolves.toEqual(
        expect.objectContaining({
          status: MemoryExportStatus.Failed,
          error: 'Export was interrupted and did not resume',
        }),
      );
      expect(existsSync(partial)).toBe(false);
      // a redelivered job cannot claim the failed run again
      await expect(sut.handleMemoryExport({ id: run.id })).resolves.toBe(JobStatus.Skipped);
    });
  });
  describe('highlight video (FL-194)', () => {
    let mediaLocation: string;

    beforeEach(() => {
      mediaLocation = mkdtempSync(join(tmpdir(), 'memory-highlight-'));
      StorageCore.reset();
      StorageCore.setMediaLocation(mediaLocation);
    });

    afterEach(() => {
      StorageCore.reset();
      rmSync(mediaLocation, { recursive: true, force: true });
    });

    /**
     * The memory service with its highlight service over the real database. Studio's own export
     * service is real for everything a highlight does after it starts (cancel, download, save);
     * only the start, which needs a qualified render worker and Studio's resolver, is stood in for
     * by writing the same project, render job and version rows the real start writes.
     */
    const setupHighlight = () => {
      const services = newMediumService(MemoryService, {
        database: defaultDatabase,
        real: [
          AccessRepository,
          AssetRepository,
          CryptoRepository,
          DatabaseRepository,
          MemoryRepository,
          UserRepository,
          SystemMetadataRepository,
          PartnerRepository,
          StorageRepository,
        ],
        mock: [JobRepository, LoggingRepository],
      });
      const { sut, ctx } = services;
      ctx.getMock(JobRepository).queue.mockResolvedValue();
      const logger = ctx.getMock(LoggingRepository);
      const projects = new StudioProjectRepository(defaultDatabase);
      const operations = new MediaOperationRepository(defaultDatabase);
      const versions = new StudioExportRepository(defaultDatabase, new DerivativePrivacyRepository(defaultDatabase));
      const studioExports = new StudioExportService(
        logger as never,
        versions,
        operations,
        projects,
        {} as never,
        {} as never,
        ctx.get(UserRepository),
        ctx.get(AccessRepository),
        ctx.get(StorageRepository),
        ctx.get(CryptoRepository),
        ctx.getMock(JobRepository) as never,
        { getEnv: () => ({}) } as never,
        ctx.get(SystemMetadataRepository),
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        { emit: vi.fn() } as never,
      );
      vi.spyOn(studioExports, 'create').mockImplementation(async (auth, projectId, dto, options) => {
        const settings = { format: dto.format, color: dto.color, resolution: dto.resolution };
        const created = await versions.createWithRender(
          {
            ownerId: auth.user.id,
            kind: MediaOperationKind.StudioExport,
            destination: dto.destination,
            destinationDetail: null,
            label: 'highlight',
            assetId: null,
            resultAssetId: null,
            retryOfId: null,
            projectId,
            revisionId: 'digest-1',
            snapshot: { kind: 'studio-export', retain: options?.retainInProject ? 'project' : undefined },
            settings,
            estimate: null,
            totalUnits: null,
            maxAttempts: 3,
          },
          {
            ownerId: auth.user.id,
            projectId,
            revision: 1,
            revisionDigest: 'digest-1',
            destination: dto.destination,
            settings,
          },
        );
        return { version: created.version, operation: created.operation } as never;
      });
      const studioProjects = {
        create: (auth: { user: { id: string } }, dto: { name: string }) =>
          projects.create({ ownerId: auth.user.id, name: dto.name, spaceId: null }),
        update: () => Promise.resolve(),
        forgetResolutions: () => {},
      };
      const highlights = new MemoryHighlightService(
        logger as never,
        ctx.get(MemoryRepository),
        studioProjects as never,
        studioExports,
        projects,
        versions,
        operations,
        ctx.get(AssetRepository),
        ctx.get(AccessRepository),
        ctx.get(StorageRepository),
      );
      (sut as unknown as { highlights: MemoryHighlightService }).highlights = highlights;
      return { sut, ctx, projects, versions, operations };
    };

    const memoryWithItems = async (ctx: ReturnType<typeof setupHighlight>['ctx']) => {
      const { user } = await ctx.newUser();
      const { memory } = await ctx.newMemory({ ownerId: user.id });
      for (let index = 0; index < 3; index++) {
        const { asset } = await ctx.newAsset({ ownerId: user.id });
        await ctx.newMemoryAsset({ memoryId: memory.id, assetId: asset.id });
      }
      return { user, memory, auth: factory.auth({ user }) };
    };

    /** What a render worker and publication leave: a published result kept with its project. */
    const publishKept = async (context: ReturnType<typeof setupHighlight>, ownerId: string, versionId: string) => {
      const path = studioExportProjectPath(ownerId, versionId, '.mp4');
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, 'a highlight video');
      await defaultDatabase
        .updateTable('studio_export_version')
        .set({
          state: StudioExportVersionState.Published,
          scope: StudioExportScope.Project,
          version: 1,
          outputPath: path,
          outputChecksum: Buffer.alloc(32, 1),
          outputSizeInBytes: '17',
          outputContentType: 'video/mp4',
          privacy: { lockReason: null, scope: StudioExportScope.Project },
          publishedAt: new Date(),
        })
        .where('id', '=', versionId)
        .execute();
      return path;
    };

    it('renders only when asked, follows the render, and only the owner can read or download it', async () => {
      const context = setupHighlight();
      const { sut, ctx } = context;
      const { user, memory, auth } = await memoryWithItems(ctx);
      const { user: stranger } = await ctx.newUser();
      const strangerAuth = factory.auth({ user: stranger });

      // nothing exists until the owner asks
      await expect(sut.getExports(auth, memory.id)).resolves.toEqual([]);
      expect(await defaultDatabase.selectFrom('studio_project').where('ownerId', '=', user.id).execute()).toEqual([]);

      const started = await sut.createExport(auth, memory.id, {
        format: MemoryExportFormat.Highlight,
        highlight: { lengthSeconds: 30, resolution: '1080p' },
      });
      expect(started).toEqual(
        expect.objectContaining({
          status: MemoryExportStatus.Running,
          format: MemoryExportFormat.Highlight,
          highlight: expect.objectContaining({ lengthSeconds: 30, resolution: '1080p', progress: 0 }),
        }),
      );
      const run = await ctx.get(MemoryRepository).getExport(started.id, user.id);
      const version = await context.versions.getById(run!.studioExportVersionId!);
      expect(version).toEqual(expect.objectContaining({ projectId: run!.studioProjectId }));

      await defaultDatabase
        .updateTable('media_operation')
        .set({ progress: 40 })
        .where('id', '=', version!.renderOperationId!)
        .execute();
      await expect(sut.getExport(auth, started.id)).resolves.toEqual(
        expect.objectContaining({ highlight: expect.objectContaining({ progress: 40 }) }),
      );

      await publishKept(context, user.id, version!.id);
      const ready = await sut.getExport(auth, started.id);
      expect(ready).toEqual(expect.objectContaining({ status: MemoryExportStatus.Ready, isDownloadable: true }));
      const download = await sut.downloadExport(auth, started.id);
      await expect(text(download.stream)).resolves.toBe('a highlight video');
      expect(download.disposition).toContain('.mp4');

      await expect(sut.getExport(strangerAuth, started.id)).rejects.toThrow();
      await expect(sut.downloadExport(strangerAuth, started.id)).rejects.toThrow();
      await expect(sut.saveExportToLibrary(strangerAuth, started.id)).rejects.toThrow();
    });

    it('cancels, lets the project go, and can be retried', async () => {
      const context = setupHighlight();
      const { sut, ctx } = context;
      const { user, memory, auth } = await memoryWithItems(ctx);

      const first = await sut.createExport(auth, memory.id, { format: MemoryExportFormat.Highlight });
      const projectId = (await ctx.get(MemoryRepository).getExport(first.id, user.id))!.studioProjectId!;
      await expect(sut.cancelExport(auth, first.id)).resolves.toEqual(
        expect.objectContaining({ status: MemoryExportStatus.Cancelled }),
      );
      expect(await context.projects.getById(projectId)).toBeUndefined();

      const retried = await sut.createExport(auth, memory.id, { format: MemoryExportFormat.Highlight });
      expect(retried.id).not.toBe(first.id);
      expect(retried.status).toBe(MemoryExportStatus.Running);
    });

    it('saves to the library only when asked, and the saved copy stays when the memory goes', async () => {
      const context = setupHighlight();
      const { sut, ctx } = context;
      const { user, memory, auth } = await memoryWithItems(ctx);
      const started = await sut.createExport(auth, memory.id, { format: MemoryExportFormat.Highlight });
      const run = await ctx.get(MemoryRepository).getExport(started.id, user.id);
      const kept = await publishKept(context, user.id, run!.studioExportVersionId!);
      await sut.getExport(auth, started.id);

      const saved = await sut.saveExportToLibrary(auth, started.id);
      const assetId = saved.highlight!.savedAssetId!;
      expect(assetId).toBeTruthy();
      expect(existsSync(kept)).toBe(false);
      const asset = await defaultDatabase
        .selectFrom('asset')
        .select(['ownerId', 'originalPath', 'deletedAt'])
        .where('id', '=', assetId)
        .executeTakeFirstOrThrow();
      expect(asset).toEqual(expect.objectContaining({ ownerId: user.id, deletedAt: null }));
      expect(existsSync(asset.originalPath)).toBe(true);

      await sut.remove(auth, memory.id);
      expect(existsSync(asset.originalPath)).toBe(true);
    });

    it('removes the render and its private result with the memory, and revokes the download', async () => {
      const context = setupHighlight();
      const { sut, ctx } = context;
      const { user, memory, auth } = await memoryWithItems(ctx);
      const started = await sut.createExport(auth, memory.id, { format: MemoryExportFormat.Highlight });
      const run = await ctx.get(MemoryRepository).getExport(started.id, user.id);
      const kept = await publishKept(context, user.id, run!.studioExportVersionId!);
      await sut.getExport(auth, started.id);

      await sut.remove(auth, memory.id);

      expect(existsSync(kept)).toBe(false);
      expect(await context.projects.getById(run!.studioProjectId!)).toBeUndefined();
      await expect(sut.downloadExport(auth, started.id)).rejects.toThrow();
    });

    it('deletes the projects of memories the 30-day cleanup removes, and never fails a long render as abandoned', async () => {
      const context = setupHighlight();
      const { sut, ctx } = context;
      const { user, memory, auth } = await memoryWithItems(ctx);
      const kept = await memoryWithItems(ctx);
      const expiring = await sut.createExport(auth, memory.id, { format: MemoryExportFormat.Highlight });
      const long = await sut.createExport(kept.auth, kept.memory.id, { format: MemoryExportFormat.Highlight });
      const expiringProject = (await ctx.get(MemoryRepository).getExport(expiring.id, user.id))!.studioProjectId!;

      await defaultDatabase
        .updateTable('memory')
        .set({ createdAt: DateTime.now().minus({ days: 31 }).toJSDate(), isSaved: false })
        .where('id', '=', memory.id)
        .execute();
      await defaultDatabase.updateTable('memory').set({ isSaved: true }).where('id', '=', kept.memory.id).execute();
      await defaultDatabase
        .updateTable('memory_export')
        .set({ updatedAt: new Date(Date.now() - 3 * 60 * 60 * 1000) })
        .where('id', '=', long.id)
        .execute();

      await sut.onMemoriesCleanup();

      expect(await context.projects.getById(expiringProject)).toBeUndefined();
      await expect(sut.getExport(auth, expiring.id)).rejects.toThrow();
      await expect(sut.getExport(kept.auth, long.id)).resolves.toEqual(
        expect.objectContaining({ status: MemoryExportStatus.Running }),
      );
    });

    it('renders at home only', async () => {
      const { sut, ctx } = setupHighlight();
      const { memory, auth } = await memoryWithItems(ctx);
      const started = await sut.createExport(auth, memory.id, {
        format: MemoryExportFormat.Highlight,
        highlight: { destination: MediaOperationDestination.Lan },
      });
      expect(started.highlight?.destination).toBe(MediaOperationDestination.Lan);
    });
  });
});
