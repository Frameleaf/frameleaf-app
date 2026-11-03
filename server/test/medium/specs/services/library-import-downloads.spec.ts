import { BadRequestException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { AssetVisibility, PhysicalFileType } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { DownloadRepository } from 'src/repositories/download.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { DownloadService } from 'src/services/download.service.js';
import { readZipDirectory, readZipEntry } from 'src/utils/studio-bundle.js';
import { lockedFixture } from 'test/fixtures/locked.stub.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => db?.destroy());
afterEach(() => vi.restoreAllMocks());

const setup = () =>
  newMediumService(DownloadService, {
    database: db,
    real: [AccessRepository, AssetRepository, DownloadRepository, StorageRepository, UserRepository],
    mock: [LoggingRepository],
  });

it.each([false, true])(
  'downloads every original with verified bytes and safe collision names (encrypted=%s)',
  async (encrypted) => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();
    const { user: other } = await ctx.newUser();
    const locked = encrypted ? await lockedFixture(user.id) : undefined;
    const directory = locked?.dir ?? (await mkdtemp(join(tmpdir(), 'frameleaf-original-download-')));
    try {
      locked?.loadKey();
      const contents = [
        Buffer.from('synthetic JPEG'),
        Buffer.from('synthetic RAW one'),
        Buffer.from('synthetic RAW two'),
      ];
      const paths: string[] = [];
      for (const [index, bytes] of contents.entries()) {
        const name = `${index}.original`;
        const path = locked ? await locked.seal(name, bytes) : join(directory, name);
        if (!locked) await writeFile(path, bytes);
        paths.push(path);
      }
      const { asset } = await ctx.newAsset({
        ownerId: user.id,
        originalPath: paths[0],
        originalFileName: 'camera.jpg',
        ...(encrypted && { visibility: AssetVisibility.Locked }),
      });
      await ctx.newExif({ assetId: asset.id, fileSizeInByte: contents[0].length });
      for (const index of [1, 2]) {
        const physical = await ctx.get(PhysicalFileRepository).upsertPhysicalFile({
          canonicalAssetId: asset.id,
          checksum: createHash('sha256').update(contents[index]).digest(),
          sizeInBytes: contents[index].length,
          path: paths[index],
          type: PhysicalFileType.Original,
        });
        await db
          .insertInto('asset_original')
          .values({ assetId: asset.id, physicalFileId: physical.id, originalFileName: 'camera.nef' })
          .execute();
      }
      const auth = factory.auth({ user: { id: user.id }, session: { hasElevatedPermission: encrypted } });
      const planned = await sut.getDownloadInfo(auth, { assetIds: [asset.id] });
      expect.soft(planned.totalSize).toBe(contents.reduce((total, bytes) => total + bytes.length, 0));
      expect(planned.archives.flatMap(({ assetIds }) => assetIds)).toEqual([asset.id]);
      const archive = vi.spyOn(ctx.get(StorageRepository), 'createZipStream');
      await expect(
        sut.downloadArchive(factory.auth({ user: { id: other.id } }), { assetIds: [asset.id], includeSidecar: false }),
      ).rejects.toThrow();
      expect(archive).not.toHaveBeenCalled();
      const response = await sut.downloadArchive(auth, { assetIds: [asset.id], includeSidecar: false });
      const bytes = await buffer(response.stream);
      const source = {
        size: bytes.length,
        read: (position: number, length: number) => Promise.resolve(bytes.subarray(position, position + length)),
      };
      const zip = await readZipDirectory(source);
      expect(zip.entries.map(({ name }) => name).sort()).toEqual(['camera+1.nef', 'camera.jpg', 'camera.nef']);
      const extracted = await Promise.all(zip.entries.map((entry) => readZipEntry(source, entry)));
      expect(extracted.map((value) => createHash('sha256').update(value).digest('hex')).sort()).toEqual(
        contents.map((value) => createHash('sha256').update(value).digest('hex')).sort(),
      );
      const shown = await sut.downloadArchive(auth, { assetIds: [asset.id], edited: true, includeSidecar: false });
      const shownBytes = await buffer(shown.stream);
      const shownSource = {
        size: shownBytes.length,
        read: (position: number, length: number) => Promise.resolve(shownBytes.subarray(position, position + length)),
      };
      expect((await readZipDirectory(shownSource)).entries.map(({ name }) => name)).toEqual(['camera.jpg']);
      if (locked) expect(await locked.copiesLeft()).toBe(0);
    } finally {
      if (locked) await locked.cleanup();
      else await rm(directory, { recursive: true, force: true });
    }
  },
);

it('refuses a legacy portable inventory before creating an archive that would omit original relationships', async () => {
  const { sut, ctx } = setup();
  const { user } = await ctx.newUser();
  const { asset } = await ctx.newAsset({ ownerId: user.id });
  const physical = await ctx.get(PhysicalFileRepository).upsertPhysicalFile({
    canonicalAssetId: asset.id,
    checksum: Buffer.alloc(20, 1),
    sizeInBytes: 42,
    path: `/fixture/${asset.id}/extra.raw`,
    type: PhysicalFileType.Original,
  });
  await db
    .insertInto('asset_original')
    .values({ assetId: asset.id, physicalFileId: physical.id, originalFileName: 'extra.raw' })
    .execute();
  const archive = vi.spyOn(ctx.get(StorageRepository), 'createZipStream').mockReturnValue({
    stream: Readable.from([]),
    addFile: vi.fn(),
    finalize: vi.fn().mockResolvedValue(undefined),
  });
  await expect(
    sut.downloadArchive(factory.auth({ user: { id: user.id } }), {
      assetIds: [asset.id],
      includeSidecar: false,
      includeLibraryMetadata: true,
    }),
  ).rejects.toBeInstanceOf(BadRequestException);
  expect(archive).not.toHaveBeenCalled();
});

it.each([false, true])(
  'closes an active file when a later original has no usable key (encrypted=%s)',
  async (encrypted) => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();
    const first = await lockedFixture(user.id);
    const second = await lockedFixture('unavailable-recipient');
    let active: Readable | undefined;
    try {
      const contents = Buffer.alloc(8 * 1024 * 1024, 7);
      const primary = encrypted ? await first.seal('primary.raw', contents) : join(first.dir, 'primary.raw');
      if (!encrypted) await writeFile(primary, contents);
      const companion = await second.seal('companion.raw', 'a different recipient');
      first.loadKey();
      const { asset } = await ctx.newAsset({ ownerId: user.id, originalPath: primary });
      const physical = await ctx.get(PhysicalFileRepository).upsertPhysicalFile({
        canonicalAssetId: asset.id,
        checksum: Buffer.alloc(20, 2),
        sizeInBytes: 21,
        path: companion,
        type: PhysicalFileType.Original,
      });
      await db
        .insertInto('asset_original')
        .values({ assetId: asset.id, physicalFileId: physical.id, originalFileName: 'companion.raw' })
        .execute();
      const storage = ctx.get(StorageRepository);
      const plain = storage.createPlainReadStream.bind(storage);
      vi.spyOn(storage, 'createPlainReadStream').mockImplementation((path) => {
        const input = plain(path);
        active ??= input;
        return input;
      });
      const create = storage.createZipStream.bind(storage);
      vi.spyOn(storage, 'createZipStream').mockImplementation(() => {
        const zip = create();
        const append = zip.addFile;
        zip.addFile = (input, name) => {
          if (input instanceof Readable) active ??= input;
          append(input, name);
        };
        return zip;
      });
      const downloads = ctx.get(DownloadRepository);
      const originals = downloads.getAdditionalOriginals.bind(downloads);
      vi.spyOn(downloads, 'getAdditionalOriginals').mockImplementation(async function* (ids) {
        await vi.waitFor(() => expect(active?.readableDidRead).toBe(true));
        yield* originals(ids);
      });
      await expect(
        sut.downloadArchive(factory.auth({ user: { id: user.id } }), { assetIds: [asset.id], includeSidecar: false }),
      ).rejects.toThrow();
      await vi.waitFor(() => expect(active?.closed).toBe(true));
    } finally {
      active?.destroy();
      await second.cleanup();
      await first.cleanup();
    }
  },
);
