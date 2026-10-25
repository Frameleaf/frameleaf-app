import { constants } from 'node:fs';
import { lstat, open, opendir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { closeArtifactFile } from 'src/utils/render-artifact.js';

export type SourceCacheClosedIdentity = {
  id: string;
  writerId: string;
  writerOwnerId: string;
  bytes: number;
  sha256: Buffer;
  fileName: string | null;
};
type Probe = { expired: boolean; stopped: boolean };
const checkProbe = (owner?: Probe) => {
  if (owner?.expired) throw new Error('source_cache_probe_expired');
};
const closeProbeFile = async (file: { close: () => Promise<void> }, owner?: Probe) => {
  try {
    await closeArtifactFile(file);
  } catch (error) {
    if (owner) owner.stopped = false;
    throw error;
  }
};
const uuid = (value: string) => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value);
const folderFor = async (root: string, id: string, owner?: Probe) => {
  checkProbe(owner);
  if (!uuid(id) || !(await lstat(root)).isDirectory()) throw new Error('source_cache_ownership_unavailable');
  checkProbe(owner);
  const folder = join(root, id);
  if (!(await lstat(folder)).isDirectory()) throw new Error('source_cache_ownership_unavailable');
  checkProbe(owner);
  return folder;
};
const flush = async (folder: string) => {
  const directory = await open(folder, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await directory.sync();
  } finally {
    await closeArtifactFile(directory);
  }
};
const identity = async (folder: string, row: SourceCacheClosedIdentity, fileName: string, owner?: Probe) => {
  checkProbe(owner);
  if (!/^[a-f0-9-]{36}[.]artifact$/u.test(fileName) || (row.fileName && row.fileName !== fileName))
    throw new Error('source_cache_ownership_unavailable');
  const file = await lstat(join(folder, fileName), { bigint: true });
  checkProbe(owner);
  if (!file.isFile() || file.nlink !== 1n || file.size !== BigInt(row.bytes) || file.dev <= 0n || file.ino <= 0n)
    throw new Error('source_cache_ownership_unavailable');
  return JSON.stringify({
    format: 1,
    id: row.id,
    writerId: row.writerId,
    writerOwnerId: row.writerOwnerId,
    bytes: row.bytes,
    sha256: row.sha256.toString('hex'),
    fileName,
    dev: String(file.dev),
    ino: String(file.ino),
  });
};

/** The receiver has joined output and verification descriptor closure before publication. */
export async function writeSourceCacheClosed(root: string, row: SourceCacheClosedIdentity) {
  let temporary: string | undefined;
  let stopped = true;
  try {
    if (!row.fileName) return false;
    const folder = await folderFor(root, row.id);
    const bytes = await identity(folder, row, row.fileName);
    const path = join(folder, 'closed.json.partial');
    const file = await open(path, 'wx', 0o600);
    temporary = path;
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await closeArtifactFile(file);
    }
    await rename(path, join(folder, 'closed.json'));
    await flush(folder);
    return true;
  } catch (error) {
    if (error instanceof Error && error.message === 'artifact_close_unconfirmed') {
      stopped = false;
      throw error;
    }
    return false;
  } finally {
    if (stopped && temporary) await rm(temporary, { force: true }).catch(() => {});
  }
}

const readers = async (folder: string, fileName?: string, owner?: Probe) => {
  checkProbe(owner);
  let count = 0,
    total = 0;
  const directory = await opendir(folder, { bufferSize: 8 });
  try {
    for (;;) {
      checkProbe(owner);
      const entry = await directory.read();
      checkProbe(owner);
      if (!entry) break;
      if (++total > 132) throw new Error('source_cache_ownership_unavailable');
      if (/^reader-(?:lease-)?[a-f0-9-]{36}$/u.test(entry.name)) {
        count++;
        continue;
      }
      if (entry.name === 'closed.json' || entry.name === 'closed.json.partial') {
        const stat = await lstat(join(folder, entry.name));
        checkProbe(owner);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2048)
          throw new Error('source_cache_ownership_unavailable');
        continue;
      }
      const expected = fileName
        ? entry.name === fileName
        : /^[a-f0-9-]{36}[.]artifact(?:[.]partial)?$/u.test(entry.name);
      if (!expected || !entry.isFile()) throw new Error('source_cache_ownership_unavailable');
    }
  } finally {
    await closeProbeFile(directory, owner);
  }
  return count;
};

/** Persist before opening an FD; only its actual stopped owner may remove this unique marker. */
export async function beginSourceCacheReader(root: string, id: string, leaseId: string) {
  if (!uuid(leaseId)) throw new Error('source_cache_ownership_unavailable');
  const folder = await folderFor(root, id);
  if ((await readers(folder)) >= 64) throw new Error('source_cache_readers_unavailable');
  const marker = join(folder, `reader-lease-${leaseId}`);
  const file = await open(marker, 'wx', 0o600);
  try {
    await file.sync();
  } finally {
    await closeArtifactFile(file);
  }
  await flush(folder);
  let closed = false;
  return async () => {
    if (closed) return;
    await removeSourceCacheReaderMarker(root, id, leaseId);
    closed = true;
  };
}

/** Only the stopped owner or its durable positive stop journal may retire this exact lease marker. */
export async function removeSourceCacheReaderMarker(root: string, id: string, leaseId: string) {
  if (!uuid(id) || !uuid(leaseId) || !(await lstat(root)).isDirectory())
    throw new Error('source_cache_ownership_unavailable');
  const folder = join(root, id);
  const directory = await lstat(folder).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (!directory) {
    await flush(root);
    return;
  }
  if (!directory.isDirectory()) throw new Error('source_cache_ownership_unavailable');
  const marker = join(folder, `reader-lease-${leaseId}`);
  const entry = await lstat(marker).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (entry && (!entry.isFile() || entry.nlink !== 1 || entry.size > 0))
    throw new Error('source_cache_ownership_unavailable');
  await rm(marker, { force: true });
  await flush(folder);
}

const checks = new Map<string, { key: string; work: Promise<boolean>; owner: Probe }>();

/** Timeout refuses removal; the single readonly probe stays owned until it actually settles. */
export async function sourceCacheClosedMatches(root: string, row: SourceCacheClosedIdentity) {
  const key = JSON.stringify([
    row.id,
    row.writerId,
    row.writerOwnerId,
    row.bytes,
    row.sha256.toString('hex'),
    row.fileName,
  ]);
  let check = checks.get(root);
  if (check && (check.key !== key || check.owner.expired)) return false;
  if (!check) {
    const owner = { expired: false, stopped: true };
    const work = inspectClosed(root, row, owner)
      .then((matches) => matches && !owner.expired)
      .finally(() => {
        if (owner.stopped && checks.get(root)?.work === work) checks.delete(root);
      });
    check = { key, work, owner };
    checks.set(root, check);
  }
  const owner = check.owner;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      check.work,
      new Promise<false>((resolve) => {
        timer = setTimeout(() => {
          owner.expired = true;
          resolve(false);
        }, 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** A matching filesystem receipt survives database rewind; a missing receipt proves nothing. */
async function inspectClosed(root: string, row: SourceCacheClosedIdentity, owner: Probe) {
  try {
    const folder = await folderFor(root, row.id, owner);
    if (await readers(folder, undefined, owner)) return false;
    checkProbe(owner);
    const file = await open(join(folder, 'closed.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: string;
    try {
      checkProbe(owner);
      const stat = await file.stat();
      checkProbe(owner);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2048) return false;
      const buffer = Buffer.alloc(2049);
      const read = await file.read(buffer, 0, buffer.length, 0);
      checkProbe(owner);
      if (read.bytesRead !== stat.size || read.bytesRead > 2048) return false;
      bytes = buffer.subarray(0, read.bytesRead).toString('utf8');
    } finally {
      await closeProbeFile(file, owner);
    }
    checkProbe(owner);
    const { fileName } = JSON.parse(bytes) as { fileName: string };
    if (typeof fileName !== 'string') return false;
    return bytes === (await identity(folder, row, fileName, owner)) && (await readers(folder, fileName, owner)) === 0;
  } catch {
    return false;
  }
}
