import { Kysely } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { AssetEditAction } from 'src/dtos/editing.dto.js';
import { AlbumUserRole, AssetVisibility, JobName } from 'src/enum.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetEditRepository } from 'src/repositories/asset-edit.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { CloudBackupIndexRepository } from 'src/repositories/cloud-backup-index.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { StackRepository } from 'src/repositories/stack.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { TagRepository } from 'src/repositories/tag.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { CloudBackupDetailsService } from 'src/services/cloud-backup-details.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

/**
 * FL-164 (cloud-backup.md, Restore): what a restore does to the library once the files are back. A
 * deleted item is made again with its details, a deleted album and person with the same ids, and an
 * item still in the library gets its details back as the person chose ("Keep", "Fill in missing" or
 * "Replace current details"). Read back through the same query the backup writes its manifest from.
 */

let defaultDatabase: Kysely<DB>;

const setup = () => {
  const { ctx, sut } = newMediumService(CloudBackupDetailsService, {
    database: defaultDatabase,
    real: [
      AlbumRepository,
      AssetEditRepository,
      AssetRepository,
      ConfigRepository,
      PersonRepository,
      PhysicalFileRepository,
      StackRepository,
      SystemMetadataRepository,
      TagRepository,
      UserRepository,
    ],
    mock: [JobRepository, LoggingRepository],
  });
  ctx.getMock(JobRepository).queue.mockResolvedValue();
  return { ctx, sut, index: new CloudBackupIndexRepository(defaultDatabase) };
};

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(CloudBackupDetailsService.name, () => {
  it('owner mode refuses a foreign asset atomically rather than applying backed-up details', async () => {
    const { ctx, sut, index } = setup();
    const { user } = await ctx.newUser();
    const { user: foreign } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: foreign.id });
    const current = (await index.getAssetDetails([asset.id])).get(asset.id)!;
    await expect(
      defaultDatabase.transaction().execute((db) =>
        sut.putBack(
          {
            assetId: asset.id,
            ownerId: foreign.id,
            type: current.record.type,
            current: current.details,
            backup: { ...current.details, isFavorite: true },
            mode: 'replace',
            people: {},
          },
          { db, ownerId: user.id, jobs: [] },
        ),
      ),
    ).rejects.toThrow('Owner restore details unavailable');
    expect((await index.getAssetDetails([asset.id])).get(asset.id)!.details.isFavorite).toBe(false);
  });

  it('owner mode refuses a current foreign album without leaking a membership on rollback', async () => {
    const { ctx, sut, index } = setup();
    const { user } = await ctx.newUser();
    const { user: foreign } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    const { album } = await ctx.newAlbum({ ownerId: foreign.id }, []);
    const current = (await index.getAssetDetails([asset.id])).get(asset.id)!;
    await expect(
      defaultDatabase.transaction().execute((db) =>
        sut.putBack(
          {
            assetId: asset.id,
            ownerId: user.id,
            type: current.record.type,
            current: current.details,
            backup: {
              ...current.details,
              albums: [{ id: album.id, name: 'Foreign private album' }],
              isFavorite: true,
            },
            mode: 'replace',
            people: {},
          },
          { db, ownerId: user.id, jobs: [] },
        ),
      ),
    ).rejects.toThrow('Owner restore album unavailable');
    expect((await index.getAssetDetails([asset.id])).get(asset.id)!.details).toEqual(current.details);
    expect(
      await defaultDatabase.selectFrom('album_asset').select('assetId').where('albumId', '=', album.id).execute(),
    ).toEqual([]);
  });

  it('owner mode recreates a missing historical own album without restoring obsolete shared viewers', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { user: foreign } = await ctx.newUser();
    const albumId = randomUUID();
    await defaultDatabase.transaction().execute((db) =>
      sut.restoreAlbum(
        {
          albumId,
          memberIds: [],
          album: {
            name: 'Older own backup',
            description: '',
            ownerId: user.id,
            coverAssetId: null,
            order: 'asc',
            sharedUsers: [{ userId: foreign.id, role: 'viewer' }],
          },
        },
        { db, ownerId: user.id, jobs: [] },
      ),
    );
    expect(
      await defaultDatabase
        .selectFrom('album_user')
        .select(['userId', 'role'])
        .where('albumId', '=', albumId)
        .execute(),
    ).toEqual([{ userId: user.id, role: AlbumUserRole.Owner }]);
  });

  it('owner mode refuses an unknown historical person instead of silently dropping the face association', async () => {
    const { ctx, sut, index } = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    const current = (await index.getAssetDetails([asset.id])).get(asset.id)!;
    await expect(
      defaultDatabase.transaction().execute((db) =>
        sut.putBack(
          {
            assetId: asset.id,
            ownerId: user.id,
            type: current.record.type,
            current: current.details,
            backup: {
              ...current.details,
              isFavorite: true,
              faces: [
                { personId: randomUUID(), box: [1, 2, 30, 40], imageWidth: 100, imageHeight: 80, isHidden: false },
              ],
            },
            mode: 'replace',
            people: {},
          },
          { db, ownerId: user.id, jobs: [] },
        ),
      ),
    ).rejects.toThrow('Owner restore person unavailable');
    const unchanged = (await index.getAssetDetails([asset.id])).get(asset.id)!;
    expect(unchanged.details.isFavorite).toBe(false);
    expect(unchanged.details.faces).toEqual([]);
  });

  it('joins owner recreation and rolls back the asset and physical original together (universal storage)', async () => {
    const { ctx, sut, index } = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    const saved = (await index.getAssetDetails([asset.id])).get(asset.id)!;
    await defaultDatabase.deleteFrom('asset').where('id', '=', asset.id).execute();
    const input = {
      assetId: asset.id,
      ownerId: user.id,
      record: saved.record,
      details: saved.details,
      sha256: createHash('sha256').update('owned original').digest('hex'),
      size: 14,
      originalPath: `/data/library/${user.id}/own.jpg`,
      sidecarPath: null,
      people: {},
    };
    await expect(
      defaultDatabase.transaction().execute(async (db) => {
        expect(await sut.recreate(input, { db, ownerId: user.id, jobs: [] })).toEqual({
          status: 'created',
          assetId: asset.id,
        });
        expect(
          await db
            .selectFrom('physical_file')
            .select('canonicalAssetId')
            .where('path', '=', input.originalPath)
            .executeTakeFirst(),
        ).toEqual({ canonicalAssetId: asset.id });
        throw new Error('rollback fixture');
      }),
    ).rejects.toThrow('rollback fixture');
    expect(
      await defaultDatabase.selectFrom('asset').select('id').where('id', '=', asset.id).executeTakeFirst(),
    ).toBeUndefined();
    expect(
      await defaultDatabase
        .selectFrom('physical_file')
        .select('id')
        .where('path', '=', input.originalPath)
        .executeTakeFirst(),
    ).toBeUndefined();
    expect(ctx.getMock(JobRepository).queue).not.toHaveBeenCalled();
  });

  it('recreates own details, album membership, faces, tags and photo edits inside the owner transaction', async () => {
    const { ctx, sut, index } = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id, isFavorite: true });
    await ctx.newExif({ assetId: asset.id, description: 'Own older backup', rating: 3 });
    const { tag } = await ctx.newTag({ userId: user.id, value: 'Own history' });
    await ctx.newTagAsset({ tagIds: [tag.id], assetIds: [asset.id] });
    const { album } = await ctx.newAlbum({ ownerId: user.id, albumName: 'Own album' }, [asset.id]);
    const { person } = await ctx.newPerson({ ownerId: user.id, name: 'Own person' });
    await ctx.newAssetFace({
      assetId: asset.id,
      personGroupId: person.personGroupId,
      boundingBoxX1: 1,
      boundingBoxY1: 2,
      boundingBoxX2: 30,
      boundingBoxY2: 40,
      imageWidth: 100,
      imageHeight: 80,
    });
    await ctx.newEdits(asset.id, {
      edits: [{ action: AssetEditAction.Crop, parameters: { x: 0, y: 0, width: 50, height: 40 } }],
    } as never);
    const saved = (await index.getAssetDetails([asset.id])).get(asset.id)!;
    const people = Object.fromEntries(
      await index.getPersonRecords([{ ownerId: user.id, personId: person.personGroupId }]),
    );
    await defaultDatabase.deleteFrom('asset').where('id', '=', asset.id).execute();
    await defaultDatabase.transaction().execute(async (db) => {
      const jobs: Parameters<CloudBackupDetailsService['recreate']>[1] = { db, ownerId: user.id, jobs: [] };
      expect(
        await sut.recreate(
          {
            assetId: asset.id,
            ownerId: user.id,
            record: saved.record,
            details: saved.details,
            sha256: sha('own original'),
            size: 12,
            originalPath: asset.originalPath,
            sidecarPath: null,
            people,
          },
          jobs,
        ),
      ).toEqual({ status: 'created', assetId: asset.id });
      expect(jobs.jobs.length).toBeGreaterThan(0);
      expect(ctx.getMock(JobRepository).queue).not.toHaveBeenCalled();
    });
    const restored = (await index.getAssetDetails([asset.id])).get(asset.id)!;
    expect(restored.details.isFavorite).toBe(true);
    expect(restored.details.description).toBe('Own older backup');
    expect(restored.details.albums.map(({ id }) => id)).toContain(album.id);
    expect(restored.details.faces.map(({ personId }) => personId)).toContain(person.personGroupId);
    expect(restored.details.tags).toEqual(saved.details.tags);
    expect(restored.details.edits).toEqual(saved.details.edits);
  });

  it('makes a deleted item, its album and its person again, with the details it had', async () => {
    const { ctx, sut, index } = setup();
    const { user } = await ctx.newUser();
    const { user: friend } = await ctx.newUser();
    const { asset } = await ctx.newAsset({
      ownerId: user.id,
      isFavorite: true,
      visibility: AssetVisibility.Archive,
      originalFileName: 'IMG_1.jpg',
    });
    await ctx.newExif({ assetId: asset.id, description: 'Lake morning', rating: 4, latitude: 46.5, longitude: 7.9 });
    const { tag } = await ctx.newTag({ userId: user.id, value: 'Trips' });
    await ctx.newTagAsset({ tagIds: [tag.id], assetIds: [asset.id] });
    const { album } = await ctx.newAlbum({ ownerId: user.id, albumName: 'Lake house' }, [asset.id]);
    await ctx.newAlbumUser({ albumId: album.id, userId: friend.id, role: AlbumUserRole.Viewer });
    const { person } = await ctx.newPerson({ ownerId: user.id, name: 'Jamie' });
    await ctx.newAssetFace({
      assetId: asset.id,
      personGroupId: person.personGroupId,
      boundingBoxX1: 1,
      boundingBoxY1: 2,
      boundingBoxX2: 30,
      boundingBoxY2: 40,
      imageWidth: 100,
      imageHeight: 80,
    });
    await ctx.newEdits(asset.id, {
      edits: [{ action: AssetEditAction.Crop, parameters: { x: 0, y: 0, width: 50, height: 40 } }],
    } as never);

    const backedUp = (await index.getAssetDetails([asset.id])).get(asset.id)!;
    const albums = await index.getAlbumRecords([album.id]);
    const people = Object.fromEntries(
      await index.getPersonRecords([{ ownerId: user.id, personId: person.personGroupId! }]),
    );

    // deleted for good: the item, its album and its person
    await defaultDatabase.deleteFrom('asset').where('id', '=', asset.id).execute();
    await ctx.get(AlbumRepository).delete(album.id);
    await ctx.get(PersonRepository).delete([person.personGroupId!], user.id);
    await ctx.get(PersonRepository).deleteGroups([person.personGroupId!]);

    const outcome = await sut.recreate({
      assetId: asset.id,
      ownerId: user.id,
      record: backedUp.record,
      details: backedUp.details,
      sha256: sha('restored'),
      size: 100,
      originalPath: '/data/library/IMG_1.jpg',
      sidecarPath: '/data/library/IMG_1.jpg.xmp',
      people,
    });
    await expect(
      sut.restoreAlbum({ albumId: album.id, album: albums.get(album.id), memberIds: [asset.id] }),
    ).resolves.toBe('created');

    expect(outcome).toEqual({ status: 'created', assetId: asset.id });
    const restored = (await index.getAssetDetails([asset.id])).get(asset.id)!;
    expect(restored).toEqual(backedUp);
    await expect(index.getAlbumRecords([album.id])).resolves.toEqual(albums);
    await expect(
      ctx.get(PersonRepository).getByGroupId({ ownerId: user.id, personGroupId: person.personGroupId! }),
    ).resolves.toMatchObject({ name: 'Jamie' });
    expect(ctx.getMock(JobRepository).queue).toHaveBeenCalledWith({
      name: JobName.AssetExtractMetadata,
      data: { id: asset.id },
    });
  });

  it('gives a deleted item back as the item its owner already has with the same file', async () => {
    const { ctx, sut, index } = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id, checksum: Buffer.from(sha('same'), 'hex') });
    const record = (await index.getAssetDetails([asset.id])).get(asset.id)!.record;

    await expect(
      sut.recreate({
        assetId: randomUUID(),
        ownerId: user.id,
        record,
        details: undefined,
        sha256: sha('same'),
        size: 1,
        originalPath: '/data/library/copy.jpg',
        sidecarPath: null,
        people: {},
      }),
    ).resolves.toEqual({ status: 'duplicate', assetId: asset.id });
  });

  it('never gives an item to an account that is gone', async () => {
    const { ctx, sut, index } = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    const record = (await index.getAssetDetails([asset.id])).get(asset.id)!.record;

    await expect(
      sut.recreate({
        assetId: randomUUID(),
        ownerId: randomUUID(),
        record,
        details: undefined,
        sha256: sha('orphan'),
        size: 1,
        originalPath: '/data/library/orphan.jpg',
        sidecarPath: null,
        people: {},
      }),
    ).resolves.toEqual({ status: 'no-owner' });
  });

  it('fills in only empty details, or replaces the ones that differ', async () => {
    const { ctx, sut, index } = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    await ctx.newExif({ assetId: asset.id, description: 'Edited later', rating: null });
    const { album } = await ctx.newAlbum({ ownerId: user.id, albumName: 'Summer' }, []);
    const current = (await index.getAssetDetails([asset.id])).get(asset.id)!;
    const backup = {
      ...current.details,
      isFavorite: true,
      visibility: 'archive' as const,
      rating: 5,
      description: 'Lake morning',
      tags: ['Trips/Lake'],
      albums: [{ id: album.id, name: 'Summer' }],
    };

    await expect(
      sut.putBack({
        assetId: asset.id,
        ownerId: user.id,
        type: current.record.type,
        current: current.details,
        backup,
        mode: 'fill',
        people: {},
      }),
    ).resolves.toBe(true);
    const filled = (await index.getAssetDetails([asset.id])).get(asset.id)!.details;
    expect(filled).toMatchObject({
      isFavorite: true,
      visibility: 'timeline',
      rating: 5,
      description: 'Edited later',
      tags: ['Trips/Lake'],
      albums: [{ id: album.id, name: 'Summer' }],
    });

    await sut.putBack({
      assetId: asset.id,
      ownerId: user.id,
      type: current.record.type,
      current: filled,
      backup,
      mode: 'replace',
      people: {},
    });
    const replaced = (await index.getAssetDetails([asset.id])).get(asset.id)!.details;
    expect(replaced).toMatchObject({ visibility: 'archive', description: 'Lake morning', rating: 5 });

    await expect(
      sut.putBack({
        assetId: asset.id,
        ownerId: user.id,
        type: current.record.type,
        current: replaced,
        backup,
        mode: 'keep',
        people: {},
      }),
    ).resolves.toBe(false);
  });

  it('adds the members an album lost back to it', async () => {
    const { ctx, sut, index } = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    const { album } = await ctx.newAlbum({ ownerId: user.id, albumName: 'Kept' }, []);

    await expect(sut.restoreAlbum({ albumId: album.id, album: undefined, memberIds: [asset.id] })).resolves.toBe(
      'updated',
    );
    expect((await index.getAssetDetails([asset.id])).get(asset.id)!.details.albums).toEqual([
      { id: album.id, name: 'Kept' },
    ]);
    // a deleted album the backup does not describe cannot be made again
    await expect(sut.restoreAlbum({ albumId: randomUUID(), album: undefined, memberIds: [] })).resolves.toBeNull();
  });
});
