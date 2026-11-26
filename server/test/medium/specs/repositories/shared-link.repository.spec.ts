import { UnauthorizedException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { randomBytes } from 'node:crypto';
import { SharedLinkType } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SharedLinkRepository } from 'src/repositories/shared-link.repository.js';
import { DB } from 'src/schema/index.js';
import { AuthService } from 'src/services/auth.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let database: Kysely<DB>;
beforeAll(async () => {
  database = await getKyselyDB();
});
afterAll(async () => {
  await database?.destroy();
});

describe('shared-link owner authentication', () => {
  it.each(['key', 'slug'] as const)(
    'refuses a soft-deleted owner through %s and permits their restored account',
    async (kind) => {
      const { ctx, sut } = newMediumService(AuthService, {
        database,
        real: [SharedLinkRepository],
        mock: [LoggingRepository],
      });
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const key = randomBytes(50);
      const slug = `fixture-${user.id}`;
      await ctx.get(SharedLinkRepository).create({
        userId: user.id,
        allowUpload: false,
        key,
        slug,
        type: SharedLinkType.Individual,
        assetIds: [asset.id],
      });
      const authenticate = () =>
        kind === 'key' ? sut.validateSharedLinkKey(key.toString('base64url')) : sut.validateSharedLinkSlug(slug);
      await expect(authenticate()).resolves.toMatchObject({ user: { id: user.id } });
      await database.updateTable('user').set({ deletedAt: new Date() }).where('id', '=', user.id).execute();
      await expect(authenticate()).rejects.toBeInstanceOf(UnauthorizedException);
      await database.updateTable('user').set({ deletedAt: null }).where('id', '=', user.id).execute();
      await expect(authenticate()).resolves.toMatchObject({ user: { id: user.id } });
    },
  );
});

/** FL-1795: the list a page at a time. */
describe('shared-link list paging', () => {
  it('walks every listed link once, newest first, and counts them by type without reading them', async () => {
    const { ctx } = newMediumService(AuthService, {
      database,
      real: [SharedLinkRepository],
      mock: [LoggingRepository],
    });
    const sut = ctx.get(SharedLinkRepository);
    const { user } = await ctx.newUser();
    const { user: other } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    const { album } = await ctx.newAlbum({ ownerId: user.id }, [asset.id]);
    const { album: gone } = await ctx.newAlbum({ ownerId: user.id });
    const link = (userId: string, target: { albumId?: string; assetIds?: string[] }) =>
      sut.create({
        userId,
        allowUpload: false,
        key: randomBytes(50),
        type: target.albumId ? SharedLinkType.Album : SharedLinkType.Individual,
        ...target,
      });
    for (let index = 0; index < 3; index++) {
      await link(user.id, { assetIds: [asset.id] });
    }
    await link(user.id, { albumId: album.id });
    await link(user.id, { albumId: album.id });
    await link(user.id, { albumId: gone.id });
    await link(other.id, { assetIds: [] });
    await database.updateTable('album').set({ deletedAt: new Date() }).where('id', '=', gone.id).execute();
    // links made in one statement share a creation time to the microsecond: the id still orders them
    await database.updateTable('shared_link').set({ createdAt: new Date() }).where('userId', '=', user.id).execute();

    const all = await sut.getAll({ userId: user.id });
    expect(all).toHaveLength(5);
    await expect(sut.getCounts(user.id)).resolves.toEqual({ album: 2, individual: 3 });

    const paged: string[] = [];
    let after: { at: string; id: string } | undefined;
    for (let page = 0; page < 4; page++) {
      const rows = await sut.getAll({ userId: user.id, take: 2, after });
      paged.push(...rows.map(({ id }) => id));
      if (rows.length < 2) {
        break;
      }
      after = { at: rows.at(-1)!.cursorAt!, id: rows.at(-1)!.id };
    }
    expect(paged).toEqual(all.map(({ id }) => id));
    const albumLink = all.find(({ type }) => type === SharedLinkType.Album)!;
    expect(albumLink).toMatchObject({ assetCount: 1, coverAssets: [{ id: asset.id }] });
  });
});
