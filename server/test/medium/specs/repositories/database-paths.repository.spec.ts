import { AssetFileType } from 'src/enum.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

it.each([
  { source: '/old/media/', target: '/new/media/' },
  { source: "/old/猫🍁'[]%_", target: String.raw`/new/💾\1'folder` },
  { source: 'upload', target: '/new/media' },
  { source: '/', target: '/new/media' },
  { source: '/old/media', target: '/' },
  { source: 'C:\\old\\', target: 'D:\\new\\', separator: '\\' },
  { source: String.raw`\\fixture\share\old`, target: String.raw`\\fixture\share\new`, separator: '\\' },
])(
  'migrates literal paths from $source to $target without rewriting siblings or empty values',
  async ({ source, target, separator = '/' }) => {
    const database = await getKyselyDB();
    const { ctx } = newMediumService(BaseService, { database, real: [], mock: [LoggingRepository] });
    try {
      const prefix = source.endsWith(separator) ? source.slice(0, -1) : source;
      const destination = target.endsWith(separator) ? target.slice(0, -1) : target;
      const { user } = await ctx.newUser();
      const { user: emptyUser } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id, originalPath: prefix + separator + 'photo.jpg' });
      const { asset: sibling } = await ctx.newAsset({
        ownerId: user.id,
        originalPath: prefix + '-sibling' + separator + 'photo.jpg',
      });
      const before = await database
        .selectFrom('asset')
        .select(['originalPath', 'updateId'])
        .where('id', '=', sibling.id)
        .executeTakeFirstOrThrow();
      const file = await database
        .insertInto('asset_file')
        .values({ assetId: asset.id, type: AssetFileType.Thumbnail, path: prefix + separator + 'thumb.jpg' })
        .returningAll()
        .executeTakeFirstOrThrow();
      const { person } = await ctx.newPerson({ ownerId: user.id, thumbnailPath: prefix + separator + 'person.jpg' });
      const { person: emptyPerson } = await ctx.newPerson({ ownerId: emptyUser.id, thumbnailPath: '' });
      await database
        .updateTable('user')
        .set({ profileImagePath: prefix + separator + 'profile.jpg' })
        .where('id', '=', user.id)
        .execute();
      await database.updateTable('user').set({ profileImagePath: '' }).where('id', '=', emptyUser.id).execute();

      await ctx.get(DatabaseRepository).migrateFilePaths(source, target);

      await expect(
        database.selectFrom('asset').select('originalPath').where('id', '=', asset.id).executeTakeFirstOrThrow(),
      ).resolves.toEqual({ originalPath: destination + separator + 'photo.jpg' });
      await expect(
        database.selectFrom('asset_file').select('path').where('id', '=', file.id).executeTakeFirstOrThrow(),
      ).resolves.toEqual({ path: destination + separator + 'thumb.jpg' });
      await expect(
        database
          .selectFrom('person')
          .select('thumbnailPath')
          .where('ownerId', '=', user.id)
          .where('personGroupId', '=', person.personGroupId)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ thumbnailPath: destination + separator + 'person.jpg' });
      await expect(
        database.selectFrom('user').select('profileImagePath').where('id', '=', user.id).executeTakeFirstOrThrow(),
      ).resolves.toEqual({ profileImagePath: destination + separator + 'profile.jpg' });
      await expect(
        database
          .selectFrom('asset')
          .select(['originalPath', 'updateId'])
          .where('id', '=', sibling.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual(before);
      await expect(
        database.selectFrom('user').select('profileImagePath').where('id', '=', emptyUser.id).executeTakeFirstOrThrow(),
      ).resolves.toEqual({ profileImagePath: '' });
      await expect(
        database
          .selectFrom('person')
          .select('thumbnailPath')
          .where('ownerId', '=', emptyUser.id)
          .where('personGroupId', '=', emptyPerson.personGroupId)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ thumbnailPath: '' });
    } finally {
      await database.destroy();
    }
  },
);
