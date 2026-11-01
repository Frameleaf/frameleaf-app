import { createPostgres } from '@frameleaf/sql-tools';
import { Kysely, sql } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StorageCore } from 'src/cores/storage.core.js';
import { AssetFileType, AssetLockReason, AssetVisibility } from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { LockedEncryptionRepository } from 'src/repositories/locked-encryption.repository.js';
import { LOCKED_PATH_BUSY, LockedFileRepository } from 'src/repositories/locked-file.repository.js';
import { LockedKeyRepository } from 'src/repositories/locked-key.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

/** FL-721 Task 5: the Locked file registry and the database side of the seal and unseal jobs. */

let db: Kysely<DB>;
let media: string;

const setup = () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const sut = new LockedFileRepository(db, new LockedKeyRepository(), new LockedEncryptionRepository(db));
  return { ctx, sut, assets: ctx.get(AssetRepository) };
};

const turnOn = (userId: string, status: 'encrypting' | 'on' | 'decrypting' = 'on') =>
  db
    .insertInto('locked_encryption')
    .values({ userId, mode: 'pin', status, recoveryKeyCreatedAt: new Date() })
    .execute();

const lockRow = (assetId: string) =>
  db.selectFrom('asset_lock').select(['assetId', 'pendingUnlockAt']).where('assetId', '=', assetId).executeTakeFirst();

beforeAll(async () => {
  db = await getKyselyDB();
  media = await fs.mkdtemp(join(tmpdir(), 'locked-file-'));
  StorageCore.setMediaLocation(media);
});

afterAll(async () => {
  await fs.rm(media, { recursive: true, force: true });
  await db?.destroy();
});

describe(LockedFileRepository.name, () => {
  describe('filesOf', () => {
    it('lists the original, 3 asset_file rows, a develop revision and a video edit version: 6 paths', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const original = `/media/${randomUUID()}/IMG_0001.jpg`;
      const { asset } = await ctx.newAsset({ ownerId: user.id, originalPath: original });
      const thumbnail = `/media/${asset.id}_thumbnail.webp`;
      const preview = `/media/${asset.id}_preview.jpeg`;
      const sidecar = `${original}.xmp`;
      await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Thumbnail, path: thumbnail });
      await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Preview, path: preview });
      await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Sidecar, path: sidecar });
      const master = `/media/${asset.id}-develop-1.jpg`;
      await sql`INSERT INTO public.asset_develop_revision ("assetId", "ownerId", revision, recipe, "masterPath")
        VALUES (${asset.id}::uuid, ${user.id}::uuid, 1, ${{ version: 3 }}::jsonb, ${master})`.execute(db);
      const extra = `/media/${asset.id}-edit.mp4`;
      await sql`INSERT INTO public.video_edit_version ("assetId", "ownerId", purpose, recipe, "sourceChecksum", "sourcePath", files)
        VALUES (${asset.id}::uuid, ${user.id}::uuid, 'save', '[]'::jsonb, ${Buffer.alloc(32, 7)}, ${original},
          ${JSON.stringify([{ path: extra }])}::text::jsonb)`.execute(db);

      const files = await sut.filesOf(asset.id);

      expect(files.map(({ path }) => path).toSorted()).toEqual(
        [original, thumbnail, preview, sidecar, master, extra].toSorted(),
      );
      expect(files.find(({ path }) => path === original)).toMatchObject({ kind: 'original', table: 'asset' });
      expect(files.find(({ path }) => path === thumbnail)).toMatchObject({ kind: 'thumbnail', table: 'asset_file' });
      expect(files.find(({ path }) => path === sidecar)).toMatchObject({ kind: 'sidecar', table: 'asset_file' });
      expect(files.find(({ path }) => path === master)).toMatchObject({ table: 'asset_develop_revision' });
      expect(files.find(({ path }) => path === extra)).toMatchObject({ table: 'video_edit_version' });
    });

    it('is empty for an asset that does not exist', async () => {
      const { sut } = setup();
      await expect(sut.filesOf(randomUUID())).resolves.toEqual([]);
    });
  });

  describe('encryptedSetOwner', () => {
    it('is the owner only for their own Locked item while their encryption has a row', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset: locked } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Locked });
      const { asset: open } = await ctx.newAsset({ ownerId: user.id });

      await expect(sut.encryptedSetOwner(locked.id)).resolves.toBeNull();
      await turnOn(user.id);
      await expect(sut.encryptedSetOwner(locked.id)).resolves.toBe(user.id);
      await expect(sut.encryptedSetOwner(open.id)).resolves.toBeNull();
    });

    it('read-only source assets are never in the set (libraryId IS NOT NULL)', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      await turnOn(user.id);
      const libraryId = randomUUID();
      await sql`INSERT INTO public.library (id, name, "ownerId", "importPaths", "exclusionPatterns")
        VALUES (${libraryId}::uuid, 'Read-only', ${user.id}::uuid, '{}', '{}')`.execute(db);
      const { asset } = await ctx.newAsset({ ownerId: user.id, libraryId, visibility: AssetVisibility.Locked });

      await expect(sut.encryptedSetOwner(asset.id)).resolves.toBeNull();
      await expect(sut.isReadOnlySource(asset.id)).resolves.toBe(true);
      await expect(sut.getSealState(asset.id)).resolves.toMatchObject({ encryptable: false, locked: true });
    });
  });

  describe('unlock marks pendingUnlockAt (spec §7.3)', () => {
    it('keeps the lock row of an encrypted item until finishPendingUnlock, and deletes it otherwise', async () => {
      const { ctx, sut, assets } = setup();
      const { user } = await ctx.newUser();
      const { user: other } = await ctx.newUser();
      await turnOn(user.id);
      const { asset: encrypted } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Locked });
      const { asset: plain } = await ctx.newAsset({ ownerId: other.id, visibility: AssetVisibility.Locked });

      const unlocked = await assets.unlock([encrypted.id, plain.id]);

      expect(unlocked.map(({ assetId }) => assetId).toSorted()).toEqual([encrypted.id, plain.id].toSorted());
      expect(await lockRow(plain.id)).toBeUndefined();
      expect((await lockRow(encrypted.id))?.pendingUnlockAt).toBeInstanceOf(Date);
      await expect(sut.encryptedSetOwner(encrypted.id)).resolves.toBeNull();
      await expect(assets.getLockedEncryptionItems([encrypted.id])).resolves.toEqual([
        { id: encrypted.id, ownerId: user.id, pending: true, mode: 'pin' },
      ]);

      await expect(sut.finishPendingUnlock(encrypted.id)).resolves.toBe(true);
      expect(await lockRow(encrypted.id)).toBeUndefined();
      await expect(sut.finishPendingUnlock(encrypted.id)).resolves.toBe(false);
    });

    it('locking an item again while it is pending keeps it Locked and reports it as locked', async () => {
      const { ctx, sut, assets } = setup();
      const { user } = await ctx.newUser();
      await turnOn(user.id);
      const { asset } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Locked });
      await assets.unlock([asset.id]);

      await expect(assets.lock([asset.id], AssetLockReason.Marked, user.id)).resolves.toContain(asset.id);

      expect((await lockRow(asset.id))?.pendingUnlockAt).toBeNull();
      await expect(sut.finishPendingUnlock(asset.id)).resolves.toBe(false);
      expect(await lockRow(asset.id)).toBeDefined();
    });
  });

  describe('unshareOriginal (spec §6.1)', () => {
    const storedFile = async () => {
      const path = join(media, 'library', randomUUID(), 'shared.jpg');
      await fs.mkdir(join(path, '..'), { recursive: true });
      const bytes = randomBytes(5000);
      await fs.writeFile(path, bytes);
      return { path, bytes };
    };

    it('copies an original another user reads to the owner’s own path; the other file stays byte-identical', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { user: other } = await ctx.newUser();
      await turnOn(user.id);
      const { path, bytes } = await storedFile();
      const { asset } = await ctx.newAsset({
        ownerId: user.id,
        originalPath: path,
        visibility: AssetVisibility.Locked,
      });
      const { asset: theirs } = await ctx.newAsset({ ownerId: other.id, originalPath: path });

      await expect(sut.plainReaders(asset.id, path)).resolves.toEqual([theirs.id]);
      await expect(sut.unshareOriginal(asset.id)).resolves.toBe(true);

      const moved = await db
        .selectFrom('asset')
        .select(['originalPath', 'physicalOriginalFileId', 'libraryPath'])
        .where('id', '=', asset.id)
        .executeTakeFirstOrThrow();
      expect(moved.originalPath).not.toBe(path);
      expect(moved.originalPath.startsWith(join(media, 'upload', user.id))).toBe(true);
      expect(moved.libraryPath).toBe(path);
      expect((await fs.readFile(moved.originalPath)).equals(bytes)).toBe(true);
      const physical = await db
        .selectFrom('physical_file')
        .select(['path', 'canonicalAssetId'])
        .where('id', '=', moved.physicalOriginalFileId!)
        .executeTakeFirstOrThrow();
      expect(physical).toEqual({ path: moved.originalPath, canonicalAssetId: asset.id });
      // the other asset and its file are untouched
      const kept = await db
        .selectFrom('asset')
        .select('originalPath')
        .where('id', '=', theirs.id)
        .executeTakeFirstOrThrow();
      expect(kept.originalPath).toBe(path);
      expect((await fs.readFile(path)).equals(bytes)).toBe(true);
      // nothing is shared any more
      await expect(sut.unshareOriginal(asset.id)).resolves.toBe(false);
    });

    it('does not un-share for a partner copy, which follows the owner’s file', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { user: partner } = await ctx.newUser();
      await turnOn(user.id);
      const { path } = await storedFile();
      const { asset } = await ctx.newAsset({
        ownerId: user.id,
        originalPath: path,
        visibility: AssetVisibility.Locked,
      });
      const { asset: copy } = await ctx.newAsset({ ownerId: partner.id, originalPath: path });
      await sql`INSERT INTO public.asset_origin ("assetId", "ownerId", "partnerSharedById", "rootOwnerId", "sourceAssetId")
        VALUES (${copy.id}::uuid, ${partner.id}::uuid, ${user.id}::uuid, ${user.id}::uuid, ${asset.id}::uuid)`.execute(
        db,
      );

      await expect(sut.plainReaders(asset.id, path)).resolves.toEqual([]);
      await expect(sut.unshareOriginal(asset.id)).resolves.toBe(false);
      await expect(sut.encryptedSetOwner(copy.id)).resolves.toBeNull();
      await expect(sut.getSealState(copy.id)).resolves.toMatchObject({ partnerCopy: true });
    });

    it('does not un-share between two of the same person’s encrypted Locked items', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      await turnOn(user.id);
      const { path } = await storedFile();
      const { asset } = await ctx.newAsset({
        ownerId: user.id,
        originalPath: path,
        visibility: AssetVisibility.Locked,
      });
      const { asset: twin } = await ctx.newAsset({
        ownerId: user.id,
        originalPath: path,
        visibility: AssetVisibility.Locked,
      });

      await expect(sut.unshareOriginal(asset.id)).resolves.toBe(false);
      // an unlock of one of them must not decrypt what the other still reads encrypted
      await expect(sut.sealedReaders(asset.id, path)).resolves.toEqual([twin.id]);
    });
  });

  describe('partnerRecipients', () => {
    it('lists the partners the owner shares with that have a key file', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { user: partner } = await ctx.newUser();
      const { user: unkeyed } = await ctx.newUser();
      await ctx.newPartner({ sharedById: user.id, sharedWithId: partner.id });
      await ctx.newPartner({ sharedById: user.id, sharedWithId: unkeyed.id });
      const publicKey = randomBytes(32);
      await new LockedKeyRepository().write({
        format: 'frameleaf-locked-key/1',
        userId: partner.id,
        label: 'Partner',
        publicKey: publicKey.toString('base64'),
        mode: 'pin',
        encrypting: false,
        wraps: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      await expect(sut.partnerRecipients(user.id)).resolves.toEqual([{ userId: partner.id, publicKey }]);
    });
  });

  describe('getOwnersSharingWith (Task 8)', () => {
    it('lists the people with encryption on who share their library with the partner', async () => {
      const { ctx } = setup();
      const repository = new LockedEncryptionRepository(db);
      const { user: partner } = await ctx.newUser();
      const { user: encrypted } = await ctx.newUser();
      const { user: plain } = await ctx.newUser();
      const { user: sharedWith } = await ctx.newUser();
      await ctx.newPartner({ sharedById: encrypted.id, sharedWithId: partner.id });
      await ctx.newPartner({ sharedById: plain.id, sharedWithId: partner.id });
      // the other direction: the partner shares with someone who encrypts
      await ctx.newPartner({ sharedById: partner.id, sharedWithId: sharedWith.id });
      await turnOn(encrypted.id);
      await turnOn(sharedWith.id, 'decrypting');

      await expect(repository.getOwnersSharingWith(partner.id)).resolves.toEqual([encrypted.id]);
      await expect(repository.getOwnersSharingWith(sharedWith.id)).resolves.toEqual([]);
    });
  });

  describe('withFileLock (fix round 1, C1 and I3)', () => {
    it('lets one job at a time replace a path; the second is told it is busy', async () => {
      const { sut } = setup();
      const path = `/media/${randomUUID()}/shared.jpg`;
      const ownerId = randomUUID();
      let release!: () => void;
      const holding = new Promise<void>((resolve) => (release = resolve));
      let entered!: () => void;
      const inside = new Promise<void>((resolve) => (entered = resolve));

      const first = sut.withFileLock(path, ownerId, async () => {
        entered();
        await holding;
        return 'first';
      });
      await inside;
      await expect(sut.withFileLock(path, ownerId, () => Promise.resolve('second'))).resolves.toBe(LOCKED_PATH_BUSY);
      await expect(sut.withFileLock(`${path}.other`, ownerId, () => Promise.resolve('other'))).resolves.toBe('other');
      release();
      await expect(first).resolves.toBe('first');
      await expect(sut.withFileLock(path, ownerId, () => Promise.resolve('again'))).resolves.toBe('again');
    });

    it('a replacement uses exactly one connection: it completes on a pool of one (N1)', async () => {
      const { ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Locked });
      const url = new URL(process.env.IMMICH_TEST_POSTGRES_URL!);
      url.pathname = `/${(await sql<{ name: string }>`select current_database() as name`.execute(db)).rows[0].name}`;
      const single = new Kysely<DB>({
        dialect: new PostgresJSDialect({
          postgres: createPostgres({ connection: { connectionType: 'url', url: url.href }, maxConnections: 1 }),
        }),
      });
      try {
        const sut = new LockedFileRepository(single, new LockedKeyRepository(), new LockedEncryptionRepository(single));
        const run = sut.withFileLock(`/media/${randomUUID()}.jpg`, user.id, (commit) =>
          commit((trx) => sut.getSealState(asset.id, trx)),
        );
        const timeout = new Promise<'deadlock'>((resolve) => setTimeout(() => resolve('deadlock'), 10_000));
        await expect(Promise.race([run, timeout])).resolves.toMatchObject({ id: asset.id, locked: true });
      } finally {
        await single.destroy();
      }
    });

    it('a rename step waits while turning off or an unlock holds the per-user lock exclusively', async () => {
      const { ctx, sut } = setup();
      const database = ctx.get(DatabaseRepository);
      const ownerId = randomUUID();
      const order: string[] = [];
      let release!: () => void;
      const holding = new Promise<void>((resolve) => (release = resolve));
      let entered!: () => void;
      const inside = new Promise<void>((resolve) => (entered = resolve));

      const exclusive = database.withLockedKeyFileLock(ownerId, async () => {
        entered();
        await holding;
        order.push('finish');
      });
      await inside;
      const rename = sut.withFileLock(`/media/${randomUUID()}.jpg`, ownerId, (commit) =>
        commit(() => {
          order.push('rename');
          return Promise.resolve();
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(order).toEqual([]);
      release();
      await Promise.all([exclusive, rename]);
      expect(order).toEqual(['finish', 'rename']);
    });
  });
});
