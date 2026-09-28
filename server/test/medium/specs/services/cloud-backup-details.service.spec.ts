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
