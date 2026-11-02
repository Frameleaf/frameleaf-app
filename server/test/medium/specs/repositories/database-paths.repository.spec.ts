import { sql } from 'kysely';
import { AssetFileType } from 'src/enum.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

const cases = [
  { source: '/old/media/', target: '/new/media/' },
  { source: "/old/猫🍁'[]%_", target: String.raw`/new/💾\1'folder` },
  { source: 'upload', target: '/new/media' },
  { source: '/', target: '/new/media' },
  { source: '/old/media', target: '/' },
  { source: 'C:\\old\\', target: 'D:\\new\\', separator: '\\' },
  { source: String.raw`\\fixture\share\old`, target: String.raw`\\fixture\share\new`, separator: '\\' },
];

it.each(cases)(
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

it.each(cases)(
  'rebases fork path columns, path arrays and JSON paths from $source to $target',
  async ({ source, target, separator = '/' }) => {
    const database = await getKyselyDB();
    const { ctx } = newMediumService(BaseService, { database, real: [], mock: [LoggingRepository] });
    try {
      const prefix = source.endsWith(separator) ? source.slice(0, -1) : source;
      const destination = target.endsWith(separator) ? target.slice(0, -1) : target;
      const at = (folder: string, name: string) => folder + separator + name;
      const sibling = at(prefix + '-sibling', 'keep.jpg');
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id, originalPath: at(prefix, 'photo.jpg') });
      const checksum = Buffer.alloc(20, 7);
      await sql`INSERT INTO public.physical_file (type, checksum, "sizeInBytes", path)
        VALUES ('original', ${checksum}, 1, ${at(prefix, 'photo.jpg')}), ('original', ${Buffer.alloc(20, 8)}, 1, ${sibling})`.execute(
        database,
      );
      await sql`INSERT INTO public.physical_file_trash (checksum, "originalFileName", path, "sizeInBytes")
        VALUES (${checksum}, 'photo.jpg', ${at(prefix, 'file-trash/photo.jpg')}, 1)`.execute(database);
      await sql`INSERT INTO public.asset_develop_artifact ("assetId", "ownerId", id, kind, path, bytes, width, height)
        VALUES (${asset.id}::uuid, ${user.id}::uuid, ${'a'.repeat(64)}, 'mask', ${at(prefix, 'mask.png')}, 1, 1, 1)`.execute(
        database,
      );
      await sql`INSERT INTO public.asset_checksum ("assetId", sha1, sha256, "sizeInBytes", "linkCount", "verifiedPaths")
        VALUES (${asset.id}::uuid, ${checksum}, ${Buffer.alloc(32, 7)}, 1, 1,
          ${[at(prefix, 'photo.jpg'), sibling, at(prefix, 'copy.jpg')]}::text[])`.execute(database);
      await sql`INSERT INTO public.video_edit_version ("assetId", "ownerId", purpose, recipe, "sourceChecksum", "sourcePath", files)
        VALUES (${asset.id}::uuid, ${user.id}::uuid, 'save', '[]'::jsonb, ${checksum}, ${at(prefix, 'photo.jpg')},
          ${JSON.stringify([{ path: at(prefix, 'sidecar.json') }, { path: sibling }])}::text::jsonb)`.execute(database);

      await ctx.get(DatabaseRepository).migrateFilePaths(source, target);

      const paths = await sql<{ path: string }>`SELECT path FROM public.physical_file ORDER BY path`.execute(database);
      expect(paths.rows.map(({ path }) => path).toSorted()).toEqual([at(destination, 'photo.jpg'), sibling].toSorted());
      const trash = await sql<{ path: string }>`SELECT path FROM public.physical_file_trash`.execute(database);
      expect(trash.rows).toEqual([{ path: at(destination, 'file-trash/photo.jpg') }]);
      const artifact = await sql<{ path: string }>`SELECT path FROM public.asset_develop_artifact`.execute(database);
      expect(artifact.rows).toEqual([{ path: at(destination, 'mask.png') }]);
      const verified = await sql<{
        verifiedPaths: string[];
      }>`SELECT "verifiedPaths" FROM public.asset_checksum`.execute(database);
      expect(verified.rows).toEqual([
        { verifiedPaths: [at(destination, 'photo.jpg'), sibling, at(destination, 'copy.jpg')] },
      ]);
      const version = await sql<{ sourcePath: string; files: unknown }>`SELECT "sourcePath", files
        FROM public.video_edit_version`.execute(database);
      expect(version.rows).toEqual([
        {
          sourcePath: at(destination, 'photo.jpg'),
          files: [{ path: at(destination, 'sidecar.json') }, { path: sibling }],
        },
      ]);
    } finally {
      await database.destroy();
    }
  },
);
