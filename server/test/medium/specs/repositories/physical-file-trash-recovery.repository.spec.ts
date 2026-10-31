import { Kysely, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { StorageCore } from 'src/cores/storage.core.js';
import { PhysicalFileType } from 'src/enum.js';
import {
  PhysicalFileTrashInput,
  PhysicalFileTrashRepository,
} from 'src/repositories/physical-file-trash.repository.js';
import { PhysicalFileRepository, recoverFileTrashMoves } from 'src/repositories/physical-file.repository.js';
import { DB } from 'src/schema/index.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
let root: string;
let files: PhysicalFileRepository;
let trash: PhysicalFileTrashRepository;
let bytes: Buffer;
const move = async (from: string, to: string) => {
  await mkdir(dirname(to), { recursive: true });
  await rename(from, to);
};
const intents = (path: string) =>
  sql<{ id: string; newPath: string }>`SELECT id, "newPath"
  FROM public.move_history WHERE "pathType" = 'file_trash' AND "oldPath" = ${path}`.execute(db);

const original = async (registered = true): Promise<PhysicalFileTrashInput> => {
  const path = join(root, 'upload', randomUUID(), 'original.jpg');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  const checksum = createHash('sha256').update(bytes).digest();
  const physical = registered
    ? await files.upsertPhysicalFile({
        canonicalAssetId: null,
        checksum,
        path,
        sizeInBytes: bytes.length,
        type: PhysicalFileType.Original,
      })
    : undefined;
  return {
    physicalFileId: physical?.id ?? null,
    path,
    checksum,
    sizeInBytes: bytes.length,
    lastOwnerId: randomUUID(),
    lastAssetId: randomUUID(),
    originalFileName: 'original.jpg',
  };
};
const journal = async (input: PhysicalFileTrashInput) => {
  const id = randomUUID();
  const target = StorageCore.getFileTrashPath(id, input.originalFileName);
  await sql`INSERT INTO public.move_history (id, "entityId", "pathType", "oldPath", "newPath")
    VALUES (${id}::uuid, ${id}::uuid, 'file_trash', ${input.path}, ${target})`.execute(db);
  await move(input.path, target);
  return { id, target };
};
const expectCompensated = async (input: PhysicalFileTrashInput) => {
  expect(await readFile(input.path)).toEqual(bytes);
  expect((await intents(input.path)).rows).toEqual([]);
  expect(
    (await sql`SELECT id FROM public.physical_file_trash WHERE checksum = ${input.checksum}`.execute(db)).rows,
  ).toEqual([]);
  if (input.physicalFileId)
    expect(await files.getPhysicalFile(input.physicalFileId)).toMatchObject({ path: input.path });
};

beforeAll(async () => {
  db = await getKyselyDB();
  files = new PhysicalFileRepository(db);
  trash = new PhysicalFileTrashRepository(db);
});
beforeEach(async () => {
  bytes = Buffer.from(`the original bytes must survive every transaction failure ${randomUUID()}`);
  root = await mkdtemp(join(tmpdir(), 'frameleaf-file-trash-'));
  StorageCore.setMediaLocation(root);
});
afterEach(async () => {
  // Each assertion runs before fixture cleanup; cleanup never decides which production copy to delete.
  await rm(root, { recursive: true, force: true });
  StorageCore.setMediaLocation('/data');
});

describe('recoverable original trash moves (FL-337)', () => {
  it.each([true, false])(
    'compensates an immediate INSERT failure (registered=%s), then retries once',
    async (registered) => {
      const input = await original(registered);
      const moved = vi.fn(move);
      await expect(trash.trash({ ...input, lastOwnerId: 'invalid-uuid' }, moved)).rejects.toThrow();
      await expectCompensated(input);
      expect(moved).toHaveBeenCalledTimes(2);
      const result = await trash.trash(input, moved);
      expect(result.status).toBe('trashed');
      if (result.status !== 'trashed') throw new Error('not trashed');
      expect(await readFile(result.entry.path)).toEqual(bytes);
      expect(result.entry.lastOwnerId).toBe(input.lastOwnerId);
      expect((await intents(input.path)).rows).toEqual([]);
      await expect(trash.trash(input, moved)).resolves.toEqual({ status: 'missing' });
      expect(
        (await sql`SELECT id FROM public.physical_file_trash WHERE checksum = ${input.checksum}`.execute(db)).rows,
      ).toHaveLength(1);
    },
  );

  it.each([false, true])(
    'compensates failure after INSERT including deferred commit failure (deferred=%s)',
    async (deferred) => {
      const input = await original();
      const name = `fail_trash_${randomUUID().replaceAll('-', '')}`;
      const functionName = sql.ref(`public.${name}`);
      const triggerName = sql.ref(name);
      await sql`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS
      $$BEGIN RAISE EXCEPTION 'injected trash transaction failure'; END$$`.execute(db);
      try {
        await sql`CREATE ${deferred ? sql`CONSTRAINT` : sql``} TRIGGER ${triggerName}
        ${deferred ? sql`AFTER` : sql`BEFORE`} DELETE ON public.physical_file
        ${deferred ? sql`DEFERRABLE INITIALLY DEFERRED` : sql``}
        FOR EACH ROW WHEN (OLD.id = ${sql.lit(input.physicalFileId!)}::uuid)
        EXECUTE FUNCTION ${functionName}()`.execute(db);
        const unlink = vi.fn();
        await expect(
          files.deleteUnreferencedPath(input.path, unlink, {
            trash: {
              move,
              original: {
                checksum: input.checksum,
                sizeInBytes: bytes.length,
                ownerId: input.lastOwnerId,
                assetId: input.lastAssetId,
                originalFileName: input.originalFileName,
              },
            },
          }),
        ).rejects.toThrow('injected trash transaction failure');
        expect(unlink).not.toHaveBeenCalled();
        await expectCompensated(input);
      } finally {
        await sql`DROP TRIGGER IF EXISTS ${triggerName} ON public.physical_file`.execute(db);
        await sql`DROP FUNCTION ${functionName}()`.execute(db);
      }
    },
  );

  it('preserves the source when ENOENT names a missing destination rather than the original', async () => {
    const input = await original();
    const unlink = vi.fn(() => rm(input.path));
    const missingDestination = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('destination disappeared'), { code: 'ENOENT' }));
    await expect(
      files.deleteUnreferencedPath(input.path, unlink, { trash: { move: missingDestination } }),
    ).rejects.toThrow('destination disappeared');
    expect(unlink).not.toHaveBeenCalled();
    await expectCompensated(input);
  });

  it('reconciles a restart intent and a concurrent retry exactly once, including an unregistered original', async () => {
    const input = await original(false);
    await journal(input);
    await Promise.all([trash.recoverMoves(move), recoverFileTrashMoves(db, move, input.path)]);
    await expectCompensated(input);
    await expect(trash.trash(input, move)).resolves.toMatchObject({ status: 'trashed' });
  });

  it('retains both copies and prevents another move when the old path was recreated', async () => {
    const input = await original(false);
    const { target } = await journal(input);
    const otherOwnerBytes = Buffer.from('another owner recreated this path');
    await writeFile(input.path, otherOwnerBytes);
    const moved = vi.fn(move);
    expect(await recoverFileTrashMoves(db, moved, input.path)).toBe(1);
    await expect(trash.trash(input, moved)).rejects.toThrow('needs recovery');
    expect(moved).not.toHaveBeenCalled();
    expect(await readFile(input.path)).toEqual(otherOwnerBytes);
    expect(await readFile(target)).toEqual(bytes);
    expect((await intents(input.path)).rows).toHaveLength(1);
    const unlink = vi.fn();
    await expect(files.deleteUnreferencedPath(target, unlink)).resolves.toMatchObject({ deleted: false });
    expect(unlink).not.toHaveBeenCalled();
  });

  it('does not move a target that another retained owner references', async () => {
    const input = await original(false);
    const { target } = await journal(input);
    const packageId = randomUUID();
    // An independent trash entry is a retained owner even when its bytes happen to match.
    await sql`INSERT INTO public.physical_file_trash
      (id, "physicalFileId", path, checksum, "sizeInBytes", "lastOwnerId", "lastAssetId", "originalFileName")
      VALUES (${packageId}::uuid, NULL, ${target}, ${input.checksum}, ${bytes.length}::bigint,
        ${randomUUID()}::uuid, NULL, 'another-owner.jpg')`.execute(db);
    const moved = vi.fn(move);
    expect(await recoverFileTrashMoves(db, moved, input.path)).toBe(1);
    expect(moved).not.toHaveBeenCalled();
    expect(await readFile(target)).toEqual(bytes);
    expect((await intents(input.path)).rows).toHaveLength(1);
  });

  it('retains both copies after cross-filesystem source cleanup fails', async () => {
    const input = await original(false);
    const interrupted = vi.fn(async (from: string, to: string) => {
      await mkdir(dirname(to), { recursive: true });
      await copyFile(from, to);
      throw Object.assign(new Error('source unlink failed'), { code: 'EIO' });
    });
    await expect(trash.trash(input, interrupted)).rejects.toThrow('source unlink failed');
    const pending = (await intents(input.path)).rows;
    expect(pending).toHaveLength(1);
    expect(await readFile(input.path)).toEqual(bytes);
    expect(await readFile(pending[0].newPath)).toEqual(bytes);
    await expect(trash.trash(input, move)).rejects.toThrow('needs recovery');
  });
});
