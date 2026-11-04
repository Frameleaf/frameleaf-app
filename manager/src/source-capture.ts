import { type BigIntStats } from 'node:fs';
import { lstat, realpath, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { Refusal, type SourceFence } from './contracts.js';
import { Fencing } from './fencing.js';
import { fileHash } from './files.js';
import { captureSqliteSnapshot } from './import-sqlite.js';

const canonicalPath = z.string().min(2).refine((value) => value.startsWith('/') && value === resolve(value) && !/[\x00-\x1f]/u.test(value));
const inputSchema = z.strictObject({
  databasePath: canonicalPath,
  stagingRoot: canonicalPath,
  expectedSchemaSha256: z.string().regex(/^[a-f0-9]{64}$/u),
});
const within = (path: string, root: string) => path === root || path.startsWith(root + '/');
const identity = (info: BigIntStats) => [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs, info.nlink].join(':');
async function databaseState(path: string) {
  const main = await lstat(path, { bigint: true });
  if (!main.isFile() || main.nlink !== 1n) throw new Refusal('source_snapshot_file_invalid');
  let wal: BigIntStats | undefined;
  try { wal = await lstat(path + '-wal', { bigint: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (wal && (!wal.isFile() || wal.nlink !== 1n)) throw new Refusal('source_snapshot_file_invalid');
  // SQLite may create an empty WAL for a read-only connection; it contains no source records.
  return { main: identity(main), wal: wal && wal.size > 0n ? identity(wal) : null };
}

/** Capture evidence only: the adapter still qualifies application identity, ownership and privacy. */
export async function captureFencedSqliteSource(fencing: Fencing, sourceInput: SourceFence, input: unknown) {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new Refusal('source_snapshot_input_invalid');
  const { databasePath, stagingRoot, expectedSchemaSha256 } = parsed.data;
  const source = structuredClone(sourceInput);
  const roots = source.mounts.filter((mount) => mount.type === 'bind' && canonicalPath.safeParse(mount.source).success).map((mount) => mount.source);
  if (!roots.some((root) => within(databasePath, root))) throw new Refusal('source_snapshot_export_required');
  if (roots.some((root) => within(stagingRoot, root))) throw new Refusal('source_snapshot_staging_in_source');
  let snapshot: Awaited<ReturnType<typeof captureSqliteSnapshot>> | undefined;
  try {
    if (await realpath(databasePath) !== databasePath || await realpath(stagingRoot) !== stagingRoot)
      throw new Refusal('source_snapshot_path_changed');
    const stage = await lstat(stagingRoot, { bigint: true });
    if (!stage.isDirectory() || stage.uid !== BigInt(process.geteuid?.() ?? -1) || (stage.mode & 0o077n) !== 0n)
      throw new Refusal('source_snapshot_private_staging_required');
    const metadata = await lstat(databasePath, { bigint: true });
    // A directory mapping is required so the DB and its WAL come from the same reviewed namespace.
    let approved = false;
    for (const root of roots.filter((root) => databasePath.startsWith(root + '/'))) {
      const directory = await lstat(root, { bigint: true });
      if (directory.isDirectory() && directory.dev === metadata.dev && await realpath(root) === root) approved = true;
    }
    if (!approved) throw new Refusal('source_snapshot_export_required');
    await databaseState(databasePath);
    await fencing.stop(source);
    const before = await databaseState(databasePath);
    snapshot = await captureSqliteSnapshot(databasePath, stagingRoot);
    if (snapshot.schemaSha256 !== expectedSchemaSha256) throw new Refusal('source_snapshot_schema_unqualified');
    const sha256 = await fileHash(snapshot.path);
    await fencing.verify(source);
    if (await realpath(databasePath) !== databasePath || JSON.stringify(await databaseState(databasePath)) !== JSON.stringify(before))
      throw new Refusal('source_snapshot_changed');
    return { ...snapshot, sha256, sourceId: source.id, sourceFingerprint: source.fingerprint };
  } catch (error) {
    if (snapshot) {
      try { await rm(dirname(snapshot.path), { recursive: true }); }
      catch { throw new Refusal('source_snapshot_cleanup_failed'); }
    }
    if (error instanceof Refusal) throw error;
    throw new Refusal('source_snapshot_failed');
  }
}
