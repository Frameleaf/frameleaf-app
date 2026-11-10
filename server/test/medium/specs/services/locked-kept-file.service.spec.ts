import { type LockedKeyFile, decryptFile, encryptFile, generateKeyPair, isLockedFile } from '@frameleaf/locked-crypto';
import { Kysely, sql } from 'kysely';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { StorageCore } from 'src/cores/storage.core.js';
import { AssetVisibility, JobName, JobStatus } from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { LockedEncryptionRepository } from 'src/repositories/locked-encryption.repository.js';
import {
  LIBRARY_CARE_SETTLE_MS,
  LockedFileRepository,
  libraryCareFolderOf,
} from 'src/repositories/locked-file.repository.js';
import { LockedKeyRepository } from 'src/repositories/locked-key.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { LockedSealService } from 'src/services/locked-seal.service.js';
import { lockedKeys } from 'src/utils/locked-key-holder.js';
import { LIBRARY_CARE_FOLDER } from 'src/utils/media-health-roots.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

/**
 * FL-1364: the damaged file Library care keeps beside a repaired photo (`asset_health.evidence.retainedPath`,
 * and the kept files Undo payloads name) is one of the photo's files, so FL-721's seal, unseal and sweep cover
 * it exactly as they cover the original: on a real filesystem, with the real registry and path locks.
 */

let db: Kysely<DB>;
let media: string;

const turnOn = (userId: string, status: 'encrypting' | 'on' = 'on') =>
  db
    .insertInto('locked_encryption')
    .values({ userId, mode: 'pin', status, recoveryKeyCreatedAt: new Date() })
    .execute();

const header = async (path: string) => (await fs.readFile(path)).subarray(0, 4).toString('latin1');

beforeAll(async () => {
  db = await getKyselyDB();
  media = await fs.mkdtemp(join(tmpdir(), 'locked-kept-'));
  StorageCore.setMediaLocation(media);
});

afterAll(async () => {
  await fs.rm(media, { recursive: true, force: true });
  await db?.destroy();
});

afterEach(() => {
  lockedKeys.clear();
});

const setup = async (options: { status?: 'encrypting' | 'on' } = {}) => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const lockedEncryption = new LockedEncryptionRepository(db);
  const lockedFile = new LockedFileRepository(db, new LockedKeyRepository(), lockedEncryption);
  const keys = generateKeyPair();
  const { user } = await ctx.newUser();
  const keyFile = {
    format: 'frameleaf-locked-key/1',
    userId: user.id,
    label: 'Taylor',
    publicKey: keys.publicKey.toString('base64'),
    mode: 'pin',
    encrypting: true,
    wraps: [],
    createdAt: '2026-11-10T00:00:00.000Z',
    updatedAt: '2026-11-10T00:00:00.000Z',
  } as unknown as LockedKeyFile;
  const lockedKey = {
    read: vi.fn((userId: string) => Promise.resolve(userId === user.id ? structuredClone(keyFile) : null)),
    list: vi.fn().mockResolvedValue([]),
    exists: vi.fn().mockResolvedValue(true),
  };
  const job = { queue: vi.fn().mockResolvedValue(undefined), queueAll: vi.fn().mockResolvedValue(undefined) };
  const sut = new LockedSealService(
    ctx.getMock(LoggingRepository) as never,
    lockedFile,
    lockedKey as never,
    lockedEncryption,
    job as never,
    ctx.get(DatabaseRepository),
    { serverSend: vi.fn() } as never,
    { create: vi.fn() } as never,
  );

  const id = randomUUID();
  // the photo's own Library care folder, where its recovered copy (its original now) and kept files are
  const care = libraryCareFolderOf(user.id, id);
  await fs.mkdir(care, { recursive: true });
  const original = join(care, `${id}-${randomUUID()}-0123abcd.jpg`);
  const originalBytes = randomBytes(90_000);
  await fs.writeFile(original, originalBytes);
  const { asset } = await ctx.newAsset({
    id,
    ownerId: user.id,
    originalPath: original,
    originalFileName: 'IMG_0001.jpg',
    visibility: AssetVisibility.Locked,
  });
  await turnOn(user.id, options.status);

  /** A file in the photo's Library care folder that no record names, written long enough ago to have settled. */
  const unrecorded = async (name: string, settled = true) => {
    const path = join(care, name);
    const bytes = randomBytes(20_000);
    await fs.writeFile(path, bytes);
    if (settled) {
      const then = new Date(Date.now() - LIBRARY_CARE_SETTLE_MS - 60_000);
      await fs.utimes(path, then, then);
    }
    return { path, bytes };
  };

  /** A repair's damaged file, kept beside the recovered copy and recorded as Library care records it. */
  const keep = async (
    options: { resolved?: boolean; write?: boolean; name?: string; undo?: Record<string, unknown> } = {},
  ) => {
    const kept = join(care, options.name ?? `${asset.id}-${randomUUID()}.damaged.jpg`);
    const bytes = randomBytes(50_000);
    if (options.write ?? true) {
      await fs.writeFile(kept, bytes);
    }
    const { rows } = await sql<{ id: string }>`
      INSERT INTO public.asset_health ("assetId", category, status, severity, "originalPath", "originalFileName",
        evidence, resolution, "checkedAt", "resolvedAt")
      VALUES (${asset.id}::uuid, 'corrupt', ${options.resolved === false ? 'corrupt_confirmed' : 'resolved'},
        'info', ${original}, 'IMG_0001.jpg', ${JSON.stringify({ fixState: 'repaired', retainedPath: kept })}::text::jsonb,
        '{}'::jsonb, now(), ${options.resolved === false ? null : new Date()})
      RETURNING id`.execute(db);
    const healthId = rows[0].id;
    await sql`INSERT INTO public.asset_health_step ("healthId", "assetId", step, outcome, undo)
      VALUES (${healthId}::uuid, ${asset.id}::uuid, 'kept-damaged', 'info',
        ${JSON.stringify(options.undo ?? { kind: 'repair', previousPath: kept, originalPath: original })}::text::jsonb)`.execute(
      db,
    );
    return { kept, bytes, healthId };
  };

  const decrypted = async (path: string) => {
    const out = join(media, `${randomUUID()}.out`);
    await decryptFile(path, out, keys.privateKey);
    const bytes = await fs.readFile(out);
    await fs.rm(out);
    return bytes;
  };
  const loadKey = () => lockedKeys.load(user.id, keys.publicKey, Buffer.from(keys.privateKey), null);
  const temporaries = async () => (await fs.readdir(care)).filter((name) => name.endsWith('.fllk.tmp'));

  return {
    ctx,
    sut,
    job,
    user,
    asset,
    keys,
    care,
    original,
    originalBytes,
    keep,
    unrecorded,
    decrypted,
    loadKey,
    temporaries,
    lockedFile,
  };
};

const lockOf = (assetId: string) =>
  db.selectFrom('asset_lock').select('assetId').where('assetId', '=', assetId).executeTakeFirst();

describe('FL-1364: Library care kept files under Locked encryption', () => {
  it('a seal encrypts the kept damaged file with the original, under the same key', async () => {
    const { sut, asset, original, originalBytes, keep, decrypted, temporaries, lockedFile } = await setup();
    const { kept, bytes } = await keep();
    // one entry, though both the finding and its Undo step name it
    expect((await lockedFile.filesOf(asset.id)).filter(({ path }) => path === kept)).toEqual([
      { path: kept, kind: 'other', table: 'asset_health', optional: true },
    ]);

    await expect(sut.handleSeal({ id: asset.id })).resolves.toBe(JobStatus.Success);

    expect(await header(original)).toBe('FLLK');
    expect(await header(kept)).toBe('FLLK');
    expect((await decrypted(original)).equals(originalBytes)).toBe(true);
    expect((await decrypted(kept)).equals(bytes)).toBe(true);
    expect(await temporaries()).toEqual([]);
  });

  it('covers the kept file of an open finding and the kept file an Undo payload names', async () => {
    const { sut, asset, care, original, keep } = await setup();
    // a restore moved a changed file aside; its finding is open again
    const aside = join(care, `${asset.id}-${randomUUID()}.changed.jpg`);
    await fs.writeFile(aside, randomBytes(10_000));
    const open = await keep({
      resolved: false,
      undo: { kind: 'restore', previousPath: original, originalPath: original, retainedPath: aside },
    });

    await expect(sut.handleSeal({ id: asset.id })).resolves.toBe(JobStatus.Success);

    expect(await header(open.kept)).toBe('FLLK');
    expect(await header(aside)).toBe('FLLK');
  });

  it('a kept file that is gone does not stop the seal or block turning on', async () => {
    const { sut, job, user, asset, original, keep } = await setup({ status: 'encrypting' });
    await keep({ write: false });

    await expect(sut.handleSeal({ id: asset.id })).resolves.toBe(JobStatus.Success);
    expect(await header(original)).toBe('FLLK');

    // the finish check: nothing plain is left, so encryption is on
    await expect(sut.handleSweep({ userId: user.id })).resolves.toBe(JobStatus.Success);
    expect(job.queueAll).not.toHaveBeenCalled();
    await expect(
      db.selectFrom('locked_encryption').select('status').where('userId', '=', user.id).executeTakeFirst(),
    ).resolves.toEqual({ status: 'on' });
  });

  it('the sweep finds an already-sealed photo whose kept file is still plain, and the seal it queues fixes it', async () => {
    const { sut, job, user, asset, keys, original, originalBytes, keep, decrypted } = await setup({
      status: 'encrypting',
    });
    // sealed before FL-1364: the original only
    const sealed = `${original}.sealed`;
    await encryptFile(original, sealed, [{ publicKey: keys.publicKey }], {
      assetId: asset.id,
      kind: 'original',
      originalFileName: 'IMG_0001.jpg',
      mime: 'image/jpeg',
    });
    await fs.rename(sealed, original);
    const { kept, bytes } = await keep();

    await expect(sut.handleSweep({ userId: user.id })).resolves.toBe(JobStatus.Success);
    expect(job.queueAll).toHaveBeenCalledWith([{ name: JobName.LockedSeal, data: { id: asset.id } }]);
    // still turning on: the plain kept file holds it
    await expect(
      db.selectFrom('locked_encryption').select('status').where('userId', '=', user.id).executeTakeFirst(),
    ).resolves.toEqual({ status: 'encrypting' });

    await expect(sut.handleSeal({ id: asset.id })).resolves.toBe(JobStatus.Success);
    expect(await header(kept)).toBe('FLLK');
    expect((await decrypted(kept)).equals(bytes)).toBe(true);
    expect((await decrypted(original)).equals(originalBytes)).toBe(true);
  });

  it('leaving Locked opens the kept file again, at the path its records name, before the lock goes', async () => {
    const { ctx, sut, asset, original, originalBytes, keep, loadKey, healthPaths } = {
      ...(await setup()),
      healthPaths: async (healthId: string) =>
        (
          await sql<{ retained: string; previous: string }>`
            SELECT h.evidence->>'retainedPath' AS retained, s.undo->>'previousPath' AS previous
            FROM public.asset_health h JOIN public.asset_health_step s ON s."healthId" = h.id
            WHERE h.id = ${healthId}::uuid`.execute(db)
        ).rows[0],
    };
    const { kept, bytes, healthId } = await keep();
    await expect(sut.handleSeal({ id: asset.id })).resolves.toBe(JobStatus.Success);
    expect(await header(kept)).toBe('FLLK');

    await ctx.get(AssetRepository).unlock([asset.id]);
    // without the key the kept file stays sealed and the lock stays
    await expect(sut.handleUnseal({ id: asset.id })).resolves.toBe(JobStatus.Skipped);
    expect(await header(kept)).toBe('FLLK');
    expect(
      await db.selectFrom('asset_lock').select('assetId').where('assetId', '=', asset.id).executeTakeFirst(),
    ).toBeDefined();

    loadKey();
    await expect(sut.handleUnseal({ id: asset.id })).resolves.toBe(JobStatus.Success);

    expect((await fs.readFile(kept)).equals(bytes)).toBe(true);
    expect((await fs.readFile(original)).equals(originalBytes)).toBe(true);
    expect(
      await db.selectFrom('asset_lock').select('assetId').where('assetId', '=', asset.id).executeTakeFirst(),
    ).toBeUndefined();
    // sealed and opened in place: the finding and its Undo step still name the kept file
    await expect(healthPaths(healthId)).resolves.toEqual({ retained: kept, previous: kept });
  });

  it('never seals a kept path that another photo reads as its own file', async () => {
    const { ctx, sut, user, asset, care, keep } = await setup();
    const { kept, bytes } = await keep();
    await ctx.newAsset({ ownerId: user.id, originalPath: kept });

    await expect(sut.handleSeal({ id: asset.id })).resolves.toBe(JobStatus.Success);

    expect(await isLockedFile(kept)).toBe(false);
    expect((await fs.readFile(kept)).equals(bytes)).toBe(true);
    expect((await fs.readdir(care)).filter((name) => name.endsWith('.fllk.tmp'))).toEqual([]);
  });

  it('seals the copies no record names: a restored file an Undo moved aside, a repaired copy left unreferenced', async () => {
    const { sut, asset, care, unrecorded, decrypted, temporaries } = await setup();
    const restored = await unrecorded(`${asset.id}-${randomUUID()}.restored.jpg`);
    const repaired = await unrecorded(`${asset.id}-${randomUUID()}-89abcdef.jpg`);
    const partial = await unrecorded(`${asset.id}-${randomUUID()}-89abcdef.jpg.${randomUUID()}.partial`);
    // still being written by a fix, perhaps: a later sweep
    const fresh = await unrecorded(`${asset.id}-${randomUUID()}-fedcba98.jpg`, false);
    // another photo's, in the same folder
    const theirs = await unrecorded(`${randomUUID()}-${randomUUID()}.restored.jpg`);
    // a link, even one named after the photo, is never followed
    const outside = join(media, `${randomUUID()}.jpg`);
    await fs.writeFile(outside, 'not a kept file');
    const link = join(care, `${asset.id}-${randomUUID()}.link.jpg`);
    await fs.symlink(outside, link);

    await expect(sut.handleSeal({ id: asset.id })).resolves.toBe(JobStatus.Success);

    for (const { path, bytes } of [restored, repaired, partial]) {
      expect(await header(path)).toBe('FLLK');
      expect((await decrypted(path)).equals(bytes)).toBe(true);
    }
    for (const { path, bytes } of [fresh, theirs]) {
      expect((await fs.readFile(path)).equals(bytes)).toBe(true);
    }
    await expect(fs.readFile(outside, 'utf8')).resolves.toBe('not a kept file');
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await temporaries()).toEqual([]);
    expect((await fs.readdir(care)).length).toBe(7);
  });

  it('an unreadable kept file never stops the photo’s other files, and is tried again', async () => {
    const { sut, job, user, asset, original, keep, unrecorded, decrypted } = await setup({ status: 'encrypting' });
    const { kept } = await keep();
    const later = await unrecorded(`${asset.id}-${randomUUID()}.restored.jpg`);
    await fs.chmod(kept, 0o000);
    try {
      await expect(sut.handleSeal({ id: asset.id })).resolves.toBe(JobStatus.Success);
      expect(await header(original)).toBe('FLLK');
      expect((await decrypted(later.path)).equals(later.bytes)).toBe(true);

      // the sweep reads it as unreadable, never throws, and queues the seal again
      await expect(sut.handleSweep({ userId: user.id })).resolves.toBe(JobStatus.Success);
      expect(job.queueAll).toHaveBeenCalledWith([{ name: JobName.LockedSeal, data: { id: asset.id } }]);
    } finally {
      await fs.chmod(kept, 0o600);
    }
    await expect(sut.handleSeal({ id: asset.id })).resolves.toBe(JobStatus.Success);
    expect(await header(kept)).toBe('FLLK');
  });

  it('never touches a recorded kept path that is not the photo’s own file', async () => {
    const { ctx, sut, user, asset, care, keep, lockedFile } = await setup();
    // the file trash keeps a file at this path (the finding's own kept file)
    const trashed = await keep();
    await sql`INSERT INTO public.physical_file_trash (checksum, "originalFileName", path, "sizeInBytes")
      VALUES (${Buffer.alloc(32, 1)}, 'IMG_0001.jpg', ${trashed.kept}, 50000)`.execute(db);
    const undoing = (previousPath: string) =>
      sql`INSERT INTO public.asset_health_step ("healthId", "assetId", step, outcome, undo)
        VALUES (${trashed.healthId}::uuid, ${asset.id}::uuid, 'put-back', 'ok',
          ${JSON.stringify({ kind: 'relink', previousPath, originalPath: '/elsewhere.jpg' })}::text::jsonb)`.execute(
        db,
      );
    // outside the owner's own folders
    const { user: other } = await ctx.newUser();
    await fs.mkdir(join(media, 'upload', other.id), { recursive: true });
    const elsewhere = join(media, 'upload', other.id, `${randomUUID()}.jpg`);
    await fs.writeFile(elsewhere, 'someone else’s photo');
    await undoing(elsewhere);
    // a link inside the owner's folder to a file outside it
    const target = join(media, `${randomUUID()}.jpg`);
    await fs.writeFile(target, 'outside the library');
    const link = join(media, 'upload', user.id, `${randomUUID()}.jpg`);
    await fs.symlink(target, link);
    await undoing(link);
    // written in a form other than its own
    const name = `${randomUUID()}.jpg`;
    await fs.writeFile(join(care, name), 'a file');
    const crooked = `${care}/../${LIBRARY_CARE_FOLDER}/${name}`;
    await undoing(crooked);
    // another photo's kept file
    const { asset: theirs } = await ctx.newAsset({ ownerId: user.id });
    const shared = join(media, 'upload', user.id, `${randomUUID()}.damaged.jpg`);
    await fs.writeFile(shared, 'their damaged file');
    await sql`INSERT INTO public.asset_health ("assetId", category, status, severity, "originalPath", "originalFileName",
        evidence, resolution, "checkedAt")
      VALUES (${theirs.id}::uuid, 'corrupt', 'resolved', 'info', ${theirs.originalPath}, 'x.jpg',
        ${JSON.stringify({ retainedPath: shared })}::text::jsonb, '{}'::jsonb, now())`.execute(db);
    await undoing(shared);
    // and one that is the photo's own, beside them
    const mine = join(media, 'upload', user.id, `${randomUUID()}.jpg`);
    await fs.writeFile(mine, 'the photo’s old original');
    await undoing(mine);

    const listed = new Set((await lockedFile.filesOf(asset.id)).map(({ path }) => path));
    expect([trashed.kept, elsewhere, link, crooked, shared, mine].map((path) => listed.has(path))).toEqual([
      false,
      false,
      false,
      false,
      false,
      true,
    ]);

    await expect(sut.handleSeal({ id: asset.id })).resolves.toBe(JobStatus.Success);
    expect((await fs.readFile(trashed.kept)).equals(trashed.bytes)).toBe(true);
    await expect(fs.readFile(elsewhere, 'utf8')).resolves.toBe('someone else’s photo');
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('outside the library');
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    await expect(fs.readFile(join(care, name), 'utf8')).resolves.toBe('a file');
    await expect(fs.readFile(shared, 'utf8')).resolves.toBe('their damaged file');
    expect(await header(mine)).toBe('FLLK');
  });

  it('a kept file still sealed after its photo left Locked is opened by the sweep once the key is loaded', async () => {
    const { sut, job, user, asset, care, keep, unrecorded, loadKey } = await setup();
    const { kept, bytes } = await keep();
    const restored = await unrecorded(`${asset.id}-${randomUUID()}.restored.jpg`);
    await expect(sut.handleSeal({ id: asset.id })).resolves.toBe(JobStatus.Success);
    expect(await header(kept)).toBe('FLLK');
    // the unlock finished while the kept files' drive was away
    await db.deleteFrom('asset_lock').where('assetId', '=', asset.id).execute();
    expect(await lockOf(asset.id)).toBeUndefined();
    const stale = join(care, `${basename(restored.path)}.${randomUUID()}.fllk.tmp`);
    await fs.writeFile(stale, 'left by a crash');

    // without the key there is nothing to do
    await expect(sut.handleSweep({ userId: user.id })).resolves.toBe(JobStatus.Success);
    expect(job.queueAll).not.toHaveBeenCalled();

    loadKey();
    await expect(sut.handleSweep({ userId: user.id })).resolves.toBe(JobStatus.Success);
    expect(job.queueAll).toHaveBeenCalledWith([{ name: JobName.LockedUnseal, data: { id: asset.id } }]);
    await expect(sut.handleUnseal({ id: asset.id })).resolves.toBe(JobStatus.Success);
    expect((await fs.readFile(kept)).equals(bytes)).toBe(true);
    expect((await fs.readFile(restored.path)).equals(restored.bytes)).toBe(true);

    // start-up clears a temporary file a crash left beside a kept file of an item out of Locked
    await sut.removeStaleTemp();
    await expect(fs.stat(stale)).rejects.toThrow();
    // start-up reads every person's items, so it takes a while on a database the other specs filled
  }, 60_000);
});
