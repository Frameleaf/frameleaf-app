import { Kysely } from 'kysely';
import { StorageCore } from 'src/cores/storage.core.js';
import { SystemMetadataKey } from 'src/enum.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { SystemMetadataService } from 'src/services/system-metadata.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  return newMediumService(SystemMetadataService, {
    database: db || defaultDatabase,
    real: [SystemMetadataRepository, UserRepository, PersonRepository, AlbumRepository],
    mock: [StorageRepository, LoggingRepository],
  });
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
  StorageCore.setMediaLocation('/data');
});

describe(`${SystemMetadataService.name} (FL-176 Frameleaf setup)`, () => {
  it('saves progress, resumes it and finishes once an admin exists', async () => {
    const { sut, ctx } = setup();
    const storage = ctx.getMock(StorageRepository);
    storage.checkFileExists.mockResolvedValue(true);
    storage.checkDiskUsage.mockResolvedValue({ available: 4e11, free: 4e11, total: 1e12 });

    const progress = { version: 1, step: 'library', reached: 3, choices: { signIn: 'local' as const } };
    await sut.updateFrameleafSetup({ flow: 'new', progress });
    await expect(sut.getFrameleafSetup()).resolves.toEqual({
      completed: false,
      completedAt: null,
      flow: 'new',
      progress,
    });

    const { user } = await ctx.newUser({ isAdmin: true });
    await ctx.newAlbum({ ownerId: user.id, albumName: 'Summer' });
    await ctx.newPerson({ ownerId: user.id });
    const library = await sut.getFrameleafSetupLibrary();
    expect(library.albums).toBeGreaterThanOrEqual(1);
    expect(library.users).toBeGreaterThanOrEqual(1);

    await expect(sut.finishFrameleafSetup()).resolves.toMatchObject({ completed: true, flow: 'new' });
    await expect(sut.getAdminOnboarding()).resolves.toEqual({ isOnboarded: true });

    const stored = await ctx.get(SystemMetadataRepository).get(SystemMetadataKey.FrameleafSetup);
    expect(JSON.stringify(stored)).not.toContain('password');
  });
});
