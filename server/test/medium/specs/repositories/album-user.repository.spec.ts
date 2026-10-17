import { Kysely } from 'kysely';
import { AlbumUserRepository } from 'src/repositories/album-user.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
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

describe(AlbumUserRepository.name, () => {
  it('keeps each member visit monotonic when an older request arrives later', async () => {
    const { ctx } = newMediumService(BaseService, { database, real: [], mock: [LoggingRepository] });
    const { user } = await ctx.newUser();
    const { user: other } = await ctx.newUser();
    const { album } = await ctx.newAlbum({ ownerId: user.id });
    const repository = ctx.get(AlbumUserRepository);
    const member = { albumId: album.id, userId: user.id };
    const foreign = { albumId: album.id, userId: other.id };
    const earlier = new Date('2026-01-01T00:00:00Z');
    const current = new Date('2026-02-01T00:00:00Z');
    const later = new Date('2026-03-01T00:00:00Z');
    await repository.setSpaceVisit(member, current);
    await repository.setSpaceVisit(foreign, earlier);
    await repository.setSpaceVisit(member, earlier);
    await expect(repository.getSpaceVisit(member)).resolves.toMatchObject({ lastSeenAt: current });
    await repository.setSpaceVisit(member, later);
    await repository.setSpaceVisit(member, later);
    await expect(repository.getSpaceVisit(member)).resolves.toMatchObject({ lastSeenAt: later });
    await expect(repository.getSpaceVisit(foreign)).resolves.toMatchObject({ lastSeenAt: earlier });
  });
});
