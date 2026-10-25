import fs from 'node:fs/promises';
import { join } from 'node:path';

const orMissing = <T>(operation: Promise<T>) =>
  operation.catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  });

type Reservation = { id: string; bytes: number };
type Probe = { expired: boolean; stopped: boolean };
const scans = new Map<string, { key: string; work: Promise<boolean>; owner: Probe }>();

/** A stalled read refuses admission; it never proves the underlying filesystem operation stopped. */
export async function sourceCacheDiskIsAccounted(root: string, entries: readonly Reservation[]) {
  const key = entries
    .map(({ id, bytes }) => `${id}:${bytes}`)
    .toSorted((left, right) => left.localeCompare(right))
    .join(',');
  let scan = scans.get(root);
  if (scan && (scan.key !== key || scan.owner.expired)) return false;
  if (!scan) {
    const owner = { expired: false, stopped: true };
    const work = inspectDisk(root, entries, owner)
      .then((accounted) => accounted && !owner.expired)
      .finally(() => {
        if (owner.stopped && scans.get(root)?.work === work) scans.delete(root);
      });
    scan = { key, work, owner };
    scans.set(root, scan);
  }
  const owner = scan.owner;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      scan.work,
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

/** Inspect only private cache metadata; unknown objects are never adopted, followed or deleted. */
async function inspectDisk(root: string, entries: readonly Reservation[], owner: Probe) {
  const check = () => {
    if (owner.expired) throw new Error('source_cache_probe_expired');
  };
  const close = async (directory: Awaited<ReturnType<typeof fs.opendir>>) => {
    try {
      await directory.close();
    } catch (error) {
      owner.stopped = false;
      throw error;
    }
  };
  try {
    const known = new Map(entries.map((entry) => [entry.id, BigInt(entry.bytes)]));
    check();
    const stat = await orMissing(fs.lstat(root));
    check();
    if (!stat) return true;
    if (!stat.isDirectory()) return false;
    const directory = await orMissing(fs.opendir(root, { bufferSize: 64 }));
    if (!directory) return true;
    let objects = 0;
    try {
      for (;;) {
        check();
        const entry = await directory.read();
        check();
        if (!entry) break;
        if (++objects > entries.length) return false;
        const budget = known.get(entry.name);
        if (budget === undefined) return false;
        const folder = join(root, entry.name);
        const identity = await orMissing(fs.lstat(folder));
        check();
        if (!identity) continue;
        if (!identity.isDirectory()) return false;
        const files = await orMissing(fs.opendir(folder, { bufferSize: 4 }));
        if (!files) continue;
        const measured = new Map<string, bigint>();
        let count = 0,
          receipts = 0,
          readers = 0;
        try {
          for (;;) {
            check();
            const file = await files.read();
            check();
            if (!file) break;
            const receipt = file.name === 'closed.json' || file.name === 'closed.json.partial';
            const reader = /^reader-(?:lease-)?[a-f0-9-]{36}$/u.test(file.name);
            // Two payload/receipt names can overlap; concurrent reader admission is bounded separately.
            if (receipt) {
              if (++receipts > 2) return false;
            } else if (reader) {
              if (++readers > 128) return false;
            } else if (++count > 2 || !/^[a-f0-9-]{36}[.]artifact(?:[.]partial)?$/u.test(file.name)) return false;
            const stat = await orMissing(fs.lstat(join(folder, file.name), { bigint: true }));
            check();
            if (!stat) continue;
            if (!stat.isFile() || stat.nlink !== 1n) return false;
            if (receipt || reader) {
              if (stat.size > (reader ? 0n : 2048n)) return false;
              continue;
            }
            const inode = stat.dev > 0n && stat.ino > 0n ? `${stat.dev}:${stat.ino}` : file.name;
            measured.set(inode, stat.size > (measured.get(inode) ?? 0n) ? stat.size : measured.get(inode)!);
            if (measured.values().reduce((sum, bytes) => sum + bytes, 0n) > budget) return false;
          }
        } finally {
          await close(files);
        }
      }
    } finally {
      await close(directory);
    }
    return true;
  } catch {
    return false;
  }
}
