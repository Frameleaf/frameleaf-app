import { Kysely } from 'kysely';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { BuddyManifest } from 'src/services/buddy-backup-capture.service.js';
import { serverVersion } from 'src/constants.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { AssetEditAction } from 'src/dtos/editing.dto.js';
import {
  AlbumKind,
  AlbumUserRole,
  ChecksumAlgorithm,
  MediaOperationDestination,
  MediaOperationKind,
  MediaOperationStatus,
  StorageFolder,
} from 'src/enum.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetEditRepository } from 'src/repositories/asset-edit.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { BuddyBackupMetadataRepository } from 'src/repositories/buddy-backup-metadata.repository.js';
import { CloudBackupIndexRepository } from 'src/repositories/cloud-backup-index.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { StackRepository } from 'src/repositories/stack.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { TagRepository } from 'src/repositories/tag.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { BuddyBackupRestoreService } from 'src/services/buddy-backup-restore.service.js';
import { CloudBackupDetailsService } from 'src/services/cloud-backup-details.service.js';
import { buddyLibraryForOwner, readBuddyMetadata, selectBuddyAlbumIds } from 'src/utils/buddy-backup-metadata.js';
import { ownerRestoreHash } from 'src/utils/cloud-backup-owner-restore.js';
import { type MediumTestContext, newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

// Metadata-only API coverage still runs the real filesystem preflight. CI's temporary disk can be below its 1 GiB reserve.
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...fs,
    statfs: async (path: Parameters<typeof fs.statfs>[0]) => {
      const stats = await fs.statfs(path);
      return { ...stats, bavail: Math.max(stats.bavail, Math.ceil((2 * 1024 ** 3) / stats.bsize)) };
    },
  };
});

let database: Kysely<DB>;
const temporaryRoots: string[] = [];
beforeAll(async () => {
  database = await getKyselyDB();
});
afterAll(async () => {
  await database?.destroy();
});
afterEach(async () => {
  StorageCore.reset();
  await database.deleteFrom('media_operation').execute();
  const roots = [...temporaryRoots];
  temporaryRoots.length = 0;
  for (const path of roots) {
    await rm(path, { recursive: true, force: true });
  }
});

const setup = () => {
  const { ctx, sut: details } = newMediumService(CloudBackupDetailsService, {
    database,
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
  return {
    ctx,
    details,
    metadata: new BuddyBackupMetadataRepository(database),
    index: new CloudBackupIndexRepository(database),
  };
};

const claim = async (ctx: MediumTestContext, ownerId: string) => {
  const { session } = await ctx.newSession({ userId: ownerId, pinExpiresAt: new Date(Date.now() + 60_000) });
  const operations = new MediaOperationRepository(database);
  const operation = await operations.create({
    ownerId,
    kind: MediaOperationKind.BuddyRestore,
    destination: MediaOperationDestination.Local,
    label: 'Buddy metadata-only recovery',
    snapshot: {},
    settings: {},
  });
  const claimed = (await operations.claimNext({
    kinds: [MediaOperationKind.BuddyRestore],
    workerId: 'buddy-metadata-test',
    leaseMs: 60_000,
  }))!;
  expect(claimed.operation.id).toBe(operation.id);
  await operations.reportProgress(operation.id, claimed.claimToken, {
    status: MediaOperationStatus.Rendering,
    processedUnits: 0,
    totalUnits: null,
    progress: 0,
  });
  return {
    owner: { ownerId, sessionId: session.id },
    lease: { operationId: operation.id, claimToken: claimed.claimToken },
    session,
    operation,
  };
};

describe('Buddy owner-specific people and metadata-only albums (FL-310)', () => {
  it('lists and prepares an own empty album with no asset anchor while hiding other owners', async () => {
    const { ctx, metadata, index, details } = setup();
    const root = await realpath(await mkdtemp(join(tmpdir(), 'buddy-empty-album-medium-')));
    temporaryRoots.push(root);
    const { user: owner } = await ctx.newUser();
    const { user: other } = await ctx.newUser();
    const { session } = await ctx.newSession({ userId: owner.id, pinExpiresAt: new Date(Date.now() + 60_000) });
    const { album } = await ctx.newAlbum({ ownerId: owner.id, albumName: 'Own empty album' });
    await ctx.newAlbum({ ownerId: other.id, albumName: 'Other private album' });
    const snapshotId = randomUUID();
    const ring = { version: 1, vaultId: randomUUID(), current: 1, keys: { 1: randomBytes(32).toString('base64url') } };
    const manifest = {
      version: 1,
      snapshotId,
      vaultId: ring.vaultId,
      sequence: 1,
      previous: null,
      frameleafVersion: serverVersion.toString(),
      metadata: await metadata.capture([]),
      library: {
        version: 2,
        format: 'frameleaf-cloud-backup',
        instanceId: randomUUID(),
        createdAt: new Date().toISOString(),
        database: null,
        assets: {},
        profiles: {},
        albums: {},
        people: {},
      },
      configurationFiles: [],
      dependencies: [],
      assetLinks: {},
      assetFiles: {},
      contents: {},
    };
    const operations = new MediaOperationRepository(database);
    const logger = LoggingRepository.create();
    const service = Object.assign(Object.create(BuddyBackupRestoreService.prototype), {
      repository: { db: database, root: () => join(root, 'buddy-state') },
      index,
      operations,
      details,
      storage: new StorageRepository(logger),
      crypto: new CryptoRepository(),
      logger,
      jobs: { queueAll: () => Promise.resolve() },
      // Only the encrypted source transport is substituted; current owner/PIN queries and operation creation remain real.
      backup: {
        client: () =>
          Promise.resolve({
            request: () =>
              Promise.resolve([{ id: snapshotId, createdAt: new Date().toISOString(), sequence: 1, keyVersion: 1 }]),
          }),
        keyring: () => Promise.resolve(ring),
      },
      open: () => Promise.resolve({ manifest, reader: { ring } }),
      tick: () => {},
    }) as BuddyBackupRestoreService;
    StorageCore.setMediaLocation(root);
    const auth = { user: owner, session: { id: session.id, hasElevatedPermission: true } } as AuthDto;
    expect((await service.snapshots(auth, false)).snapshots.map(({ id }) => id)).toEqual([snapshotId]);
    expect((await service.browse(auth, snapshotId, false)).albums).toEqual([
      { id: album.id, name: 'Own empty album', items: 0 },
    ]);
    await new AlbumRepository(database).delete(album.id);
    const request = { snapshotId, scope: 'album' as const, albumId: album.id, mode: 'keep' as const, confirm: false };
    expect(await service.prepare(auth, request, false)).toMatchObject({
      items: 0,
      metadataItems: 1,
      bytes: 0,
      state: 'preview',
    });
    const queued = await service.prepare(auth, { ...request, confirm: true }, false);
    const operation = (await operations.getOfKind(queued.operationId!, MediaOperationKind.BuddyRestore))!;
    expect(
      Object.keys((operation.snapshot as unknown as { albums: { albums: Record<string, unknown> } }).albums.albums),
    ).toEqual([album.id]);
    const claimed = (await operations.claimNext({
      kinds: [MediaOperationKind.BuddyRestore],
      workerId: 'buddy-empty-album-test',
      leaseMs: 60_000,
    }))!;
    expect(claimed.operation.id).toBe(operation.id);
    const worker = service as unknown as { run: (operation: typeof claimed.operation, token: string) => Promise<void> };
    await worker.run(claimed.operation, claimed.claimToken);
    expect((await operations.getOfKind(operation.id, MediaOperationKind.BuddyRestore))!.status).toBe(
      MediaOperationStatus.Completed,
    );
    expect((await new AlbumRepository(database).getById(album.id, { withAssets: false }))!).toMatchObject({
      albumName: 'Own empty album',
      parentId: null,
      kind: 'album',
    });
    expect(
      await database.selectFrom('album_asset').select('assetId').where('albumId', '=', album.id).execute(),
    ).toEqual([]);
  });
  it('keeps current false favorite, empty edits and removed album membership through the actual Buddy worker', async () => {
    const { ctx, metadata, index, details } = setup();
    const root = await realpath(await mkdtemp(join(tmpdir(), 'buddy-keep-medium-')));
    try {
      StorageCore.setMediaLocation(root);
      const { user: owner } = await ctx.newUser();
      const { session } = await ctx.newSession({ userId: owner.id, pinExpiresAt: new Date(Date.now() + 60_000) });
      const { album } = await ctx.newAlbum({
        ownerId: owner.id,
        albumName: 'Current album',
        albumThumbnailAssetId: null,
      });
      const folder = StorageCore.getFolderLocation(StorageFolder.Upload, owner.id);
      await mkdir(folder, { recursive: true });
      const path = join(folder, 'original.jpg');
      const bytes = Buffer.from('real owner-managed original');
      await writeFile(path, bytes);
      const checksum = createHash('sha256').update(bytes).digest();
      const { asset } = await ctx.newAsset({
        ownerId: owner.id,
        originalPath: path,
        originalFileName: 'original.jpg',
        checksum,
        checksumAlgorithm: ChecksumAlgorithm.sha256File,
        isFavorite: false,
      });
      const current = (await index.getAssetDetails([asset.id])).get(asset.id)!;
      const snapshotId = randomUUID();
      const ring = {
        version: 1 as const,
        vaultId: randomUUID(),
        current: 1,
        keys: { 1: randomBytes(32).toString('base64url') },
      };
      const saved = await metadata.capture([]);
      saved.albums[album.id].name = 'Historical name';
      saved.albums[album.id].coverAssetId = asset.id;
      const manifest: BuddyManifest = {
        version: 1,
        snapshotId,
        vaultId: ring.vaultId,
        sequence: 1,
        previous: null,
        frameleafVersion: serverVersion.toString(),
        metadata: saved,
        library: {
          version: 2,
          format: 'frameleaf-backup-manifest',
          instanceId: randomUUID(),
          createdAt: new Date().toISOString(),
          database: null,
          assets: {
            [asset.id]: {
              ...current.record,
              owner: owner.id,
              files: [{ role: 'original', path, sha256: checksum.toString('hex'), size: bytes.length, mtime: null }],
              details: {
                ...current.details,
                isFavorite: true,
                albums: [{ id: album.id, name: 'Historical name' }],
                edits: [{ action: AssetEditAction.Crop, parameters: { x: 0, y: 0, width: 10, height: 10 } }],
              },
            },
          },
          profiles: {},
          albums: {},
          people: {},
        },
        configurationFiles: [],
        dependencies: [],
        assetLinks: { [asset.id]: { livePhotoVideoId: null, isExternal: false, libraryId: null } },
        assetFiles: {},
        contents: {},
        environment: {},
        storageRoot: root,
        storageRoots: [root],
        settings: { system: {}, users: [] },
      };
      const operations = new MediaOperationRepository(database);
      const logger = LoggingRepository.create();
      const service = Object.assign(Object.create(BuddyBackupRestoreService.prototype), {
        repository: { db: database, root: () => join(root, 'buddy-state') },
        index,
        operations,
        details,
        storage: new StorageRepository(logger),
        crypto: new CryptoRepository(),
        logger,
        jobs: { queueAll: () => Promise.resolve() },
        // Only source transport is substituted. Files, owner/PIN/claim checks and metadata publication remain real.
        backup: { keyring: () => Promise.resolve(ring) },
        open: () =>
          Promise.resolve({
            manifest,
            reader: {
              ring,
              download: async (_manifest: unknown, _hash: string, target: string) => {
                await writeFile(target, bytes);
                return { sha256: checksum.toString('hex'), size: bytes.length };
              },
            },
          }),
        tick: () => {},
      }) as BuddyBackupRestoreService;
      const auth = { user: owner, session: { id: session.id, hasElevatedPermission: true } } as AuthDto;
      const queued = await service.prepare(
        auth,
        { snapshotId, scope: 'asset', assetIds: [asset.id], mode: 'keep', confirm: true },
        false,
      );
      const claimed = (await operations.claimNext({
        kinds: [MediaOperationKind.BuddyRestore],
        workerId: 'buddy-keep-test',
        leaseMs: 60_000,
      }))!;
      expect(claimed.operation.id).toBe(queued.operationId);
      const worker = service as unknown as {
        run: (operation: typeof claimed.operation, token: string) => Promise<void>;
      };
      await worker.run(claimed.operation, claimed.claimToken);
      expect((await operations.getOfKind(queued.operationId!, MediaOperationKind.BuddyRestore))!.status).toBe(
        MediaOperationStatus.Completed,
      );
      const restored = (await index.getAssetDetails([asset.id])).get(asset.id)!.details;
      expect(restored.isFavorite).toBe(false);
      expect(restored.edits).toEqual([]);
      expect(restored.albums).toEqual([]);
      expect((await new AlbumRepository(database).getById(album.id, { withAssets: false }))!).toMatchObject({
        albumName: 'Current album',
        albumThumbnailAssetId: null,
      });
      expect(
        await database.selectFrom('album_asset').select('assetId').where('albumId', '=', album.id).execute(),
      ).toEqual([]);
    } finally {
      StorageCore.reset();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('captures both owners of one person group and uses the correct record in restore hashes', async () => {
    const { ctx, metadata } = setup();
    const { user: first } = await ctx.newUser();
    const { user: second } = await ctx.newUser({ clusterGroupId: first.clusterGroupId });
    const { person } = await ctx.newPerson({
      ownerId: first.id,
      name: 'First name',
      isHidden: false,
      isFavorite: true,
    });
    await ctx.newPerson({
      ownerId: second.id,
      personGroupId: person.personGroupId,
      name: 'Second name',
      isHidden: true,
      isFavorite: false,
    });
    const captured = await metadata.capture([
      { ownerId: first.id, personId: person.personGroupId },
      { ownerId: second.id, personId: person.personGroupId },
    ]);
    expect(captured.peopleByOwner[first.id][person.personGroupId]).toEqual({
      ownerId: first.id,
      name: 'First name',
      birthDate: null,
      isHidden: false,
      isFavorite: true,
    });
    expect(captured.peopleByOwner[second.id][person.personGroupId]).toEqual({
      ownerId: second.id,
      name: 'Second name',
      birthDate: null,
      isHidden: true,
      isFavorite: false,
    });
    const library = {
      assets: {},
      albums: {},
      people: { [person.personGroupId]: captured.peopleByOwner[first.id][person.personGroupId] },
    };
    const manifest = { metadata: captured, library } as Parameters<typeof buddyLibraryForOwner>[0];
    const own = buddyLibraryForOwner(manifest, second.id);
    expect(own.people[person.personGroupId].name).toBe('Second name');
    const asset = {
      owner: second.id,
      files: [],
      details: { albums: [], faces: [{ personId: person.personGroupId }] },
    } as never;
    const firstHash = ownerRestoreHash(asset, own);
    captured.peopleByOwner[first.id][person.personGroupId].name = 'Another owner changed';
    expect(ownerRestoreHash(asset, buddyLibraryForOwner(manifest, second.id))).toBe(firstHash);
    captured.peopleByOwner[second.id][person.personGroupId].name = 'Own record changed';
    expect(ownerRestoreHash(asset, buddyLibraryForOwner(manifest, second.id))).not.toBe(firstHash);
  });

  it.each([false, true])('restores an own face in a shared current group (own row missing: %s)', async (missing) => {
    const { ctx, metadata, index, details } = setup();
    const { user: owner } = await ctx.newUser();
    const { user: other } = await ctx.newUser({ clusterGroupId: owner.clusterGroupId });
    const { person } = await ctx.newPerson({ ownerId: owner.id, name: 'Own person', isFavorite: true });
    await ctx.newPerson({
      ownerId: other.id,
      personGroupId: person.personGroupId,
      name: 'Other person',
      isHidden: true,
    });
    const { asset } = await ctx.newAsset({ ownerId: owner.id });
    const saved = await metadata.capture([{ ownerId: owner.id, personId: person.personGroupId }]);
    if (missing) {
      await database
        .deleteFrom('person')
        .where('ownerId', '=', owner.id)
        .where('personGroupId', '=', person.personGroupId)
        .execute();
    }
    const current = (await index.getAssetDetails([asset.id])).get(asset.id)!;
    await database.transaction().execute((db) =>
      details.putBack(
        {
          assetId: asset.id,
          ownerId: owner.id,
          type: current.record.type,
          current: current.details,
          backup: {
            ...current.details,
            faces: [
              {
                personId: person.personGroupId,
                box: [1, 2, 30, 40],
                imageWidth: 100,
                imageHeight: 80,
                isHidden: false,
              },
            ],
          },
          mode: 'replace',
          people: saved.peopleByOwner[owner.id],
        },
        { db, ownerId: owner.id, jobs: [], buddyPeople: true },
      ),
    );
    expect(
      (await index.getAssetDetails([asset.id])).get(asset.id)!.details.faces.map(({ personId }) => personId),
    ).toEqual([person.personGroupId]);
    expect(
      await database
        .selectFrom('person')
        .select(['ownerId', 'name', 'isHidden', 'isFavorite'])
        .where('personGroupId', '=', person.personGroupId)
        .orderBy('name')
        .execute(),
    ).toEqual([
      { ownerId: other.id, name: 'Other person', isHidden: true, isFavorite: false },
      { ownerId: owner.id, name: 'Own person', isHidden: false, isFavorite: true },
    ]);
    expect(
      await database
        .selectFrom('person_group')
        .select('clusterGroupId')
        .where('id', '=', person.personGroupId)
        .executeTakeFirst(),
    ).toEqual({ clusterGroupId: owner.clusterGroupId });
  });

  it.each(['keep', 'replace'] as const)(
    'applies %s only to the caller person attributes in the current shared group',
    async (mode) => {
      const { ctx, metadata, index, details } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: other } = await ctx.newUser({ clusterGroupId: owner.clusterGroupId });
      const { person } = await ctx.newPerson({ ownerId: owner.id, name: 'Own backup name', isFavorite: true });
      await ctx.newPerson({
        ownerId: other.id,
        personGroupId: person.personGroupId,
        name: 'Foreign current name',
        isHidden: true,
      });
      const { asset } = await ctx.newAsset({ ownerId: owner.id });
      const saved = await metadata.capture([{ ownerId: owner.id, personId: person.personGroupId }]);
      await new PersonRepository(database).update({
        ownerId: owner.id,
        personGroupId: person.personGroupId,
        name: 'Own current name',
        isFavorite: false,
      });
      const current = (await index.getAssetDetails([asset.id])).get(asset.id)!;
      await database.transaction().execute((db) =>
        details.putBack(
          {
            assetId: asset.id,
            ownerId: owner.id,
            type: current.record.type,
            current: current.details,
            backup: {
              ...current.details,
              faces: [
                {
                  personId: person.personGroupId,
                  box: [1, 2, 30, 40],
                  imageWidth: 100,
                  imageHeight: 80,
                  isHidden: false,
                },
              ],
            },
            mode: 'replace',
            people: saved.peopleByOwner[owner.id],
          },
          { db, ownerId: owner.id, jobs: [], buddyPeople: true, buddyPeopleMode: mode },
        ),
      );
      expect(
        await database
          .selectFrom('person')
          .select(['name', 'isFavorite'])
          .where('ownerId', '=', owner.id)
          .where('personGroupId', '=', person.personGroupId)
          .executeTakeFirst(),
      ).toEqual({
        name: mode === 'replace' ? 'Own backup name' : 'Own current name',
        isFavorite: mode === 'replace',
      });
      expect(
        await database
          .selectFrom('person')
          .select(['name', 'isHidden'])
          .where('ownerId', '=', other.id)
          .where('personGroupId', '=', person.personGroupId)
          .executeTakeFirst(),
      ).toEqual({ name: 'Foreign current name', isHidden: true });
    },
  );

  it('refuses the historical group after a real cluster departure without undoing the split', async () => {
    const { ctx, metadata, index, details } = setup();
    const { user: owner } = await ctx.newUser();
    const { user: other } = await ctx.newUser({ clusterGroupId: owner.clusterGroupId });
    const { user: destination } = await ctx.newUser();
    const { person } = await ctx.newPerson({ ownerId: owner.id, name: 'Old own name' });
    await ctx.newPerson({ ownerId: other.id, personGroupId: person.personGroupId, name: 'Surviving foreign name' });
    const { asset } = await ctx.newAsset({ ownerId: owner.id });
    const saved = await metadata.capture([{ ownerId: owner.id, personId: person.personGroupId }]);
    await new PersonRepository(database).reassignCluster({
      userId: owner.id,
      newClusterId: destination.clusterGroupId,
    });
    await database
      .updateTable('user')
      .set({ clusterGroupId: destination.clusterGroupId })
      .where('id', '=', owner.id)
      .execute();
    const current = (await index.getAssetDetails([asset.id])).get(asset.id)!;
    await expect(
      database.transaction().execute((db) =>
        details.putBack(
          {
            assetId: asset.id,
            ownerId: owner.id,
            type: current.record.type,
            current: current.details,
            backup: {
              ...current.details,
              isFavorite: true,
              faces: [
                {
                  personId: person.personGroupId,
                  box: [1, 2, 30, 40],
                  imageWidth: 100,
                  imageHeight: 80,
                  isHidden: false,
                },
              ],
            },
            mode: 'replace',
            people: saved.peopleByOwner[owner.id],
          },
          { db, ownerId: owner.id, jobs: [], buddyPeople: true },
        ),
      ),
    ).rejects.toThrow('Buddy restore person unavailable');
    expect((await index.getAssetDetails([asset.id])).get(asset.id)!.details.isFavorite).toBe(false);
    expect(
      await database.selectFrom('person').select('ownerId').where('personGroupId', '=', person.personGroupId).execute(),
    ).toEqual([{ ownerId: other.id }]);
    expect(
      await database
        .selectFrom('person_group')
        .select('clusterGroupId')
        .where('id', '=', person.personGroupId)
        .executeTakeFirst(),
    ).toEqual({ clusterGroupId: other.clusterGroupId });
  });

  it('preserves the ordinary Cloud owner-mode refusal for a foreign row in the group', async () => {
    const { ctx, metadata, index, details } = setup();
    const { user: owner } = await ctx.newUser();
    const { user: other } = await ctx.newUser({ clusterGroupId: owner.clusterGroupId });
    const { person } = await ctx.newPerson({ ownerId: owner.id });
    await ctx.newPerson({ ownerId: other.id, personGroupId: person.personGroupId });
    const { asset } = await ctx.newAsset({ ownerId: owner.id });
    const current = (await index.getAssetDetails([asset.id])).get(asset.id)!;
    const saved = await metadata.capture([{ ownerId: owner.id, personId: person.personGroupId }]);
    await expect(
      database.transaction().execute((db) =>
        details.putBack(
          {
            assetId: asset.id,
            ownerId: owner.id,
            type: current.record.type,
            current: current.details,
            backup: {
              ...current.details,
              faces: [
                {
                  personId: person.personGroupId,
                  box: [1, 2, 30, 40],
                  imageWidth: 100,
                  imageHeight: 80,
                  isHidden: false,
                },
              ],
            },
            mode: 'replace',
            people: saved.peopleByOwner[owner.id],
          },
          { db, ownerId: owner.id, jobs: [] },
        ),
      ),
    ).rejects.toThrow('Owner restore person unavailable');
  });

  it('recreates a missing own person group with the original UUID', async () => {
    const { ctx, metadata, index, details } = setup();
    const { user: owner } = await ctx.newUser();
    const { person } = await ctx.newPerson({ ownerId: owner.id, name: 'Missing own person' });
    const { asset } = await ctx.newAsset({ ownerId: owner.id });
    const saved = await metadata.capture([{ ownerId: owner.id, personId: person.personGroupId }]);
    await database.deleteFrom('person_group').where('id', '=', person.personGroupId).execute();
    const current = (await index.getAssetDetails([asset.id])).get(asset.id)!;
    await database.transaction().execute((db) =>
      details.putBack(
        {
          assetId: asset.id,
          ownerId: owner.id,
          type: current.record.type,
          current: current.details,
          backup: {
            ...current.details,
            faces: [
              {
                personId: person.personGroupId,
                box: [1, 2, 30, 40],
                imageWidth: 100,
                imageHeight: 80,
                isHidden: false,
              },
            ],
          },
          mode: 'replace',
          people: saved.peopleByOwner[owner.id],
        },
        { db, ownerId: owner.id, jobs: [], buddyPeople: true },
      ),
    );
    expect(
      await database
        .selectFrom('person_group')
        .select(['id', 'clusterGroupId'])
        .where('id', '=', person.personGroupId)
        .executeTakeFirst(),
    ).toEqual({ id: person.personGroupId, clusterGroupId: owner.clusterGroupId });
  });

  it('captures and restores empty collection, child album and shared space with exact structure and owner-only membership', async () => {
    const { ctx, metadata } = setup();
    const { user: owner } = await ctx.newUser();
    const { user: obsoleteViewer } = await ctx.newUser();
    const { album: collection } = await ctx.newAlbum({
      ownerId: owner.id,
      albumName: 'Empty collection',
      kind: AlbumKind.Collection,
      icon: 'folder',
      sortOrder: 2,
    });
    const { album: child } = await ctx.newAlbum({
      ownerId: owner.id,
      albumName: 'Empty child',
      parentId: collection.id,
      icon: 'camera',
      sortOrder: 3,
    });
    const { album: space } = await ctx.newAlbum({
      ownerId: owner.id,
      albumName: 'Empty space',
      kind: AlbumKind.Space,
      sortOrder: 4,
    });
    await ctx.newAlbumUser({ albumId: space.id, userId: obsoleteViewer.id, role: AlbumUserRole.Viewer });
    const captured = await metadata.capture([]);
    expect(captured.albums[child.id]).toMatchObject({
      ownerId: owner.id,
      name: 'Empty child',
      parentId: collection.id,
      kind: 'album',
      icon: 'camera',
      sortOrder: 3,
    });
    expect(selectBuddyAlbumIds(captured, { scope: 'album', albumId: collection.id }, {}, owner.id, false)).toEqual(
      expect.arrayContaining([collection.id, child.id]),
    );
    await new AlbumRepository(database).deleteCollection(collection.id);
    await new AlbumRepository(database).delete(child.id);
    await new AlbumRepository(database).delete(space.id);
    const plan = await metadata.plan(captured, [collection.id, child.id, space.id], 'keep');
    const authority = await claim(ctx, owner.id);
    const publish = () =>
      metadata.withRestore(
        authority.owner,
        authority.lease,
        false,
        () => Promise.resolve(),
        (db) => new BuddyBackupMetadataRepository(db).publish(plan, authority.owner.ownerId, false),
      );
    await publish();
    await publish(); // A resumed metadata phase is idempotent, including closure and mirror writes.
    const albums = await new AlbumRepository(database).getAll(owner.id, { isOwned: true });
    expect(albums.find(({ id }) => id === child.id)).toMatchObject({
      albumName: 'Empty child',
      parentId: collection.id,
      kind: 'album',
      icon: 'camera',
      sortOrder: 3,
    });
    expect(albums.find(({ id }) => id === space.id)).toMatchObject({ kind: 'space', sortOrder: 4 });
    expect(
      await database
        .selectFrom('album_closure')
        .select(['id_ancestor', 'id_descendant'])
        .where('id_descendant', '=', child.id)
        .orderBy('id_ancestor')
        .execute(),
    ).toEqual(
      expect.arrayContaining([
        { id_ancestor: child.id, id_descendant: child.id },
        { id_ancestor: collection.id, id_descendant: child.id },
      ]),
    );
    expect(
      await database.selectFrom('album_user').select(['userId', 'role']).where('albumId', '=', space.id).execute(),
    ).toEqual([{ userId: owner.id, role: AlbumUserRole.Owner }]);
    expect(
      await database
        .selectFrom('album_asset')
        .select('assetId')
        .where('albumId', 'in', [collection.id, child.id, space.id])
        .execute(),
    ).toEqual([]);
  });

  it('binds every owned album dependency of selected members before restoring structure', async () => {
    const { ctx, metadata, index } = setup();
    const { user: owner } = await ctx.newUser();
    const { user: foreign } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: owner.id });
    const { album: selected } = await ctx.newAlbum({ ownerId: owner.id }, [asset.id]);
    const { album: parent } = await ctx.newAlbum({ ownerId: owner.id, kind: AlbumKind.Collection });
    const { album: related } = await ctx.newAlbum(
      { ownerId: owner.id, parentId: parent.id, icon: 'camera', sortOrder: 7 },
      [asset.id],
    );
    const { album: shared } = await ctx.newAlbum({ ownerId: foreign.id }, [asset.id]);
    const current = (await index.getAssetDetails([asset.id])).get(asset.id)!;
    const saved = await metadata.capture([]);
    const assets = { [asset.id]: { ...current.record, owner: owner.id, files: [], details: current.details } };
    const ids = selectBuddyAlbumIds(
      saved,
      { scope: 'album', albumId: selected.id, assetIds: [asset.id] },
      assets,
      owner.id,
      false,
    );
    expect(ids).toHaveLength(3);
    expect(ids).toEqual(expect.arrayContaining([selected.id, related.id, parent.id]));
    expect(ids).not.toContain(shared.id);
    expect(
      selectBuddyAlbumIds(saved, { scope: 'album', albumId: selected.id, assetIds: [] }, assets, owner.id, false),
    ).toEqual([selected.id]);
    await new AlbumRepository(database).deleteCollection(parent.id);
    await new AlbumRepository(database).delete(related.id);
    const plan = await metadata.plan(saved, ids, 'replace');
    const authority = await claim(ctx, owner.id);
    await metadata.withRestore(
      authority.owner,
      authority.lease,
      false,
      () => Promise.resolve(),
      (db) => new BuddyBackupMetadataRepository(db).publish(plan, owner.id, false),
    );
    expect((await new AlbumRepository(database).getById(related.id, { withAssets: false }))!).toMatchObject({
      parentId: parent.id,
      kind: 'album',
      icon: 'camera',
      sortOrder: 7,
    });
    expect(
      await database.selectFrom('album_user').select(['userId', 'role']).where('albumId', '=', related.id).execute(),
    ).toEqual([{ userId: owner.id, role: AlbumUserRole.Owner }]);
  });

  it('preserves current album changes with keep and restores bound own fields with replace', async () => {
    const { ctx, metadata } = setup();
    const { user: owner } = await ctx.newUser();
    const { album } = await ctx.newAlbum({ ownerId: owner.id, albumName: 'Backup name', icon: 'camera', sortOrder: 2 });
    const captured = await metadata.capture([]);
    await new AlbumRepository(database).update(
      album.id,
      { albumName: 'Current name', icon: 'folder', sortOrder: 8 },
      owner.id,
    );
    const authority = await claim(ctx, owner.id);
    const run = async (mode: 'keep' | 'replace') => {
      const plan = await metadata.plan(captured, [album.id], mode);
      await metadata.withRestore(
        authority.owner,
        authority.lease,
        false,
        () => Promise.resolve(),
        (db) => new BuddyBackupMetadataRepository(db).publish(plan, authority.owner.ownerId, false),
      );
    };
    await run('keep');
    expect((await new AlbumRepository(database).getById(album.id, { withAssets: false }))!).toMatchObject({
      albumName: 'Current name',
      icon: 'folder',
      sortOrder: 8,
    });
    await run('replace');
    expect((await new AlbumRepository(database).getById(album.id, { withAssets: false }))!).toMatchObject({
      albumName: 'Backup name',
      icon: 'camera',
      sortOrder: 2,
    });
  });

  it.each(['parent', 'kind', 'name'] as const)(
    'refuses a concurrent canonical album %s change atomically without replacing current structure',
    async (conflict) => {
      const { ctx, metadata } = setup();
      const { user: owner } = await ctx.newUser();
      const { album: parent } = await ctx.newAlbum({ ownerId: owner.id, kind: AlbumKind.Collection });
      const { album } = await ctx.newAlbum({ ownerId: owner.id, albumName: 'Backup name', parentId: parent.id });
      const captured = await metadata.capture([]);
      const plan = await metadata.plan(captured, [album.id], 'keep');
      await database
        .updateTable('album')
        .set(
          conflict === 'parent'
            ? { parentId: null }
            : conflict === 'kind'
              ? { kind: AlbumKind.Space, parentId: null }
              : { albumName: 'Current name' },
        )
        .where('id', '=', album.id)
        .execute();
      const current = await database
        .selectFrom('album')
        .selectAll()
        .where('id', '=', album.id)
        .executeTakeFirstOrThrow();
      const closure = await database
        .selectFrom('album_closure')
        .selectAll()
        .where('id_descendant', '=', album.id)
        .orderBy('id_ancestor')
        .execute();
      const authority = await claim(ctx, owner.id);
      await expect(
        metadata.withRestore(
          authority.owner,
          authority.lease,
          false,
          () => Promise.resolve(),
          (db) => new BuddyBackupMetadataRepository(db).publish(plan, owner.id, false),
        ),
      ).rejects.toThrow(conflict === 'kind' ? 'Buddy restore album unavailable' : 'Buddy restore album changed');
      expect(
        await database.selectFrom('album').selectAll().where('id', '=', album.id).executeTakeFirstOrThrow(),
      ).toEqual(current);
      expect(
        await database
          .selectFrom('album_closure')
          .selectAll()
          .where('id_descendant', '=', album.id)
          .orderBy('id_ancestor')
          .execute(),
      ).toEqual(closure);
    },
  );

  it('refuses a revoked foreign parent grant and rolls back newly created own albums', async () => {
    const { ctx, metadata } = setup();
    const { user: owner } = await ctx.newUser();
    const { user: foreign } = await ctx.newUser();
    const { album: parent } = await ctx.newAlbum({ ownerId: foreign.id, kind: AlbumKind.Collection });
    await ctx.newAlbumUser({ albumId: parent.id, userId: owner.id, role: AlbumUserRole.Editor });
    const { album: child } = await ctx.newAlbum({ ownerId: owner.id, parentId: parent.id });
    const captured = await metadata.capture([]);
    await new AlbumRepository(database).delete(child.id);
    const allowed = await metadata.plan(captured, [child.id], 'keep');
    const authority = await claim(ctx, owner.id);
    await metadata.withRestore(
      authority.owner,
      authority.lease,
      false,
      () => Promise.resolve(),
      (db) => new BuddyBackupMetadataRepository(db).publish(allowed, authority.owner.ownerId, false),
    );
    expect((await new AlbumRepository(database).getById(child.id, { withAssets: false }))!.parentId).toBe(parent.id);
    const grants = await database
      .selectFrom('album_user')
      .select(['userId', 'role'])
      .where('albumId', '=', parent.id)
      .execute();
    expect(grants).toHaveLength(2);
    expect(grants).toEqual(
      expect.arrayContaining([
        { userId: foreign.id, role: AlbumUserRole.Owner },
        { userId: owner.id, role: AlbumUserRole.Editor },
      ]),
    );
    await new AlbumRepository(database).delete(child.id);
    const plan = await metadata.plan(captured, [child.id], 'keep');
    await database.deleteFrom('album_user').where('albumId', '=', parent.id).where('userId', '=', owner.id).execute();
    await expect(
      metadata.withRestore(
        authority.owner,
        authority.lease,
        false,
        () => Promise.resolve(),
        (db) => new BuddyBackupMetadataRepository(db).publish(plan, authority.owner.ownerId, false),
      ),
    ).rejects.toThrow('Buddy restore parent unavailable');
    expect(await database.selectFrom('album').select('id').where('id', '=', child.id).execute()).toEqual([]);
    expect(await database.selectFrom('album_user').select('userId').where('albumId', '=', child.id).execute()).toEqual(
      [],
    );
  });

  it('refuses a foreign current album UUID and a concurrent directory metadata decision', async () => {
    const { ctx, metadata } = setup();
    const { user: owner } = await ctx.newUser();
    const { user: foreign } = await ctx.newUser();
    const { album } = await ctx.newAlbum({ ownerId: owner.id });
    const captured = await metadata.capture([]);
    const plan = await metadata.plan(captured, [album.id], 'replace');
    await new AlbumRepository(database).update(album.id, { albumName: 'Later decision' }, owner.id);
    const authority = await claim(ctx, owner.id);
    await expect(
      metadata.withRestore(
        authority.owner,
        authority.lease,
        false,
        () => Promise.resolve(),
        (db) => new BuddyBackupMetadataRepository(db).publish(plan, authority.owner.ownerId, false),
      ),
    ).rejects.toThrow('Buddy restore album changed');
    await database
      .updateTable('album_user')
      .set({ userId: foreign.id })
      .where('albumId', '=', album.id)
      .where('role', '=', AlbumUserRole.Owner)
      .execute();
    await expect(metadata.plan(captured, [album.id], 'replace')).rejects.toThrow('Buddy restore album unavailable');
  });

  it.each(['soft-deleted', 'kind'] as const)('refuses a current %s album identity', async (conflict) => {
    const { ctx, metadata } = setup();
    const { user: owner } = await ctx.newUser();
    const { album } = await ctx.newAlbum({ ownerId: owner.id });
    const saved = await metadata.capture([]);
    if (conflict === 'soft-deleted') {
      await database.updateTable('album').set({ deletedAt: new Date() }).where('id', '=', album.id).execute();
    } else {
      await database.updateTable('album').set({ kind: AlbumKind.Space }).where('id', '=', album.id).execute();
    }
    await expect(metadata.plan(saved, [album.id], 'replace')).rejects.toThrow('Buddy restore album unavailable');
  });

  it('refuses an ordinary owner publishing foreign album metadata ', async () => {
    const { ctx, metadata } = setup();
    const { user: owner } = await ctx.newUser();
    const { user: foreign } = await ctx.newUser();
    const { album } = await ctx.newAlbum({ ownerId: foreign.id });
    const captured = await metadata.capture([]);
    const plan = await metadata.plan(captured, [album.id], 'keep');
    const authority = await claim(ctx, owner.id);
    await expect(
      metadata.withRestore(
        authority.owner,
        authority.lease,
        false,
        () => Promise.resolve(),
        (db) => new BuddyBackupMetadataRepository(db).publish(plan, owner.id, false),
      ),
    ).rejects.toThrow('Buddy restore album unavailable');
  });

  it.each([
    'pin',
    'session',
    'session-expiry',
    'owner',
    'operation-owner',
    'kind',
    'token',
    'expiry',
    'cancel',
    'pause',
    'binding',
  ] as const)('rejects %s changes before metadata-only publication', async (failure) => {
    const { ctx, metadata } = setup();
    const { user: owner } = await ctx.newUser();
    const id = randomUUID();
    const capture = {
      version: 1 as const,
      peopleByOwner: {},
      albums: {
        [id]: {
          ownerId: owner.id,
          name: 'Missing own album',
          description: '',
          coverAssetId: null,
          order: 'asc' as const,
          sharedUsers: [],
          parentId: null,
          kind: 'album' as const,
          icon: null,
          sortOrder: null,
        },
      },
    };
    const plan = await metadata.plan(capture, [id], 'keep');
    const authority = await claim(ctx, owner.id);
    switch (failure) {
      case 'pin': {
        await database
          .updateTable('session')
          .set({ pinExpiresAt: new Date(0) })
          .where('id', '=', authority.session.id)
          .execute();
        break;
      }
      case 'session': {
        await database.deleteFrom('session').where('id', '=', authority.session.id).execute();
        break;
      }
      case 'session-expiry': {
        await database
          .updateTable('session')
          .set({ expiresAt: new Date(0) })
          .where('id', '=', authority.session.id)
          .execute();
        break;
      }
      case 'operation-owner': {
        await database
          .updateTable('media_operation')
          .set({ ownerId: (await ctx.newUser()).user.id })
          .where('id', '=', authority.operation.id)
          .execute();
        break;
      }
      case 'owner': {
        await database.updateTable('user').set({ deletedAt: new Date() }).where('id', '=', owner.id).execute();
        break;
      }
      case 'kind': {
        await database
          .updateTable('media_operation')
          .set({ kind: MediaOperationKind.CloudRestore })
          .where('id', '=', authority.operation.id)
          .execute();
        break;
      }
      case 'token': {
        authority.lease.claimToken = randomUUID();
        break;
      }
      case 'expiry': {
        await database
          .updateTable('media_operation')
          .set({ claimExpiresAt: new Date(0) })
          .where('id', '=', authority.operation.id)
          .execute();
        break;
      }
      case 'cancel': {
        await database
          .updateTable('media_operation')
          .set({ cancelRequestedAt: new Date() })
          .where('id', '=', authority.operation.id)
          .execute();
        break;
      }
      case 'pause': {
        await database
          .updateTable('media_operation')
          .set({ pauseRequestedAt: new Date() })
          .where('id', '=', authority.operation.id)
          .execute();
        break;
      }
      case 'binding': {
        break;
      }
    }
    await expect(
      metadata.withRestore(
        authority.owner,
        authority.lease,
        false,
        () => (failure === 'binding' ? Promise.reject(new Error('keyring changed')) : Promise.resolve()),
        (db) => new BuddyBackupMetadataRepository(db).publish(plan, authority.owner.ownerId, false),
      ),
    ).rejects.toThrow();
    expect(await database.selectFrom('album').select('id').where('id', '=', id).execute()).toEqual([]);
  });

  it('rolls back album, owner, closure and fork mirror on a metadata publication failure', async () => {
    const { ctx, metadata } = setup();
    const { user: owner } = await ctx.newUser();
    const id = randomUUID();
    const capture = {
      version: 1 as const,
      peopleByOwner: {},
      albums: {
        [id]: {
          ownerId: owner.id,
          name: 'Missing own album',
          description: '',
          coverAssetId: null,
          order: 'asc' as const,
          sharedUsers: [],
          parentId: null,
          kind: 'album' as const,
          icon: null,
          sortOrder: null,
        },
      },
    };
    const plan = await metadata.plan(capture, [id], 'keep');
    const authority = await claim(ctx, owner.id);
    await expect(
      metadata.withRestore(
        authority.owner,
        authority.lease,
        false,
        () => Promise.resolve(),
        async (db) => {
          await new BuddyBackupMetadataRepository(db).publish(plan, authority.owner.ownerId, false);
          throw new Error('publication interrupted');
        },
      ),
    ).rejects.toThrow('publication interrupted');
    expect(await database.selectFrom('album').select('id').where('id', '=', id).execute()).toEqual([]);
    expect(
      await database.selectFrom('album_closure').select('id_descendant').where('id_descendant', '=', id).execute(),
    ).toEqual([]);
  });

  it('fails malformed new metadata instead of falling back to another owner record', () => {
    const ownerId = randomUUID();
    const otherId = randomUUID();
    const groupId = randomUUID();
    expect(() =>
      readBuddyMetadata({
        version: 1,
        albums: {},
        peopleByOwner: {
          [ownerId]: {
            [groupId]: { ownerId: otherId, name: 'Foreign', birthDate: null, isHidden: false, isFavorite: false },
          },
        },
      }),
    ).toThrow();
    expect(readBuddyMetadata(undefined)).toBeUndefined();
  });
});
