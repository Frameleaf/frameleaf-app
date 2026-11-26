import { UnsealError, blobId, openBlob } from './keys.js';
import { type Location, MissingBlobError, PACK_TARGET, PackWriter, type Repository } from './repository.js';
import type { StoredObject } from './store.js';
import type { Entry } from './tree.js';

const DAY = 86_400_000;

export interface RetentionPolicy {
  /** The newest backups are kept whatever their age, so a wrong clock can never empty a repository. */
  keepLast: number;
  /** Every backup this recent is kept. */
  keepDays: number;
  /** Beyond that, the newest backup of each month, for this many months. */
  keepMonthly: number;
}

/** Wasabi bills every object for 90 days, so keeping every version that long costs nothing extra. */
export const DEFAULT_RETENTION: RetentionPolicy = { keepLast: 3, keepDays: 90, keepMonthly: 12 };

/** Which backups to keep. `snapshots` is oldest first. A backup whose time can't be read is kept. */
export function retain(snapshots: { key: string; time: string }[], policy: RetentionPolicy, now: Date): Set<string> {
  const keep = new Set(snapshots.slice(-Math.max(1, policy.keepLast)).map((snapshot) => snapshot.key));
  const month = (date: Date) => date.getUTCFullYear() * 12 + date.getUTCMonth();
  const months = new Set<number>();
  for (const snapshot of snapshots.toReversed()) {
    const time = new Date(snapshot.time);
    if (Number.isNaN(time.getTime()) || now.getTime() - time.getTime() <= policy.keepDays * DAY) {
      keep.add(snapshot.key);
    } else if (month(now) - month(time) < policy.keepMonthly && !months.has(month(time))) {
      months.add(month(time));
      keep.add(snapshot.key);
    }
  }
  return keep;
}

/** Adds every blob a tree needs to `live`. With `missing`, a blob that isn't stored is noted there instead of thrown. */
async function mark(
  repository: Repository,
  tree: string,
  live: Set<string>,
  /** Trees already walked. Kept apart from `live`: a file's chunk can have the same id as a folder's tree. */
  visited: Set<string>,
  missing?: Set<string>,
): Promise<void> {
  if (visited.has(tree)) {
    return;
  }
  visited.add(tree);
  live.add(tree);
  const read = async (id: string) => {
    try {
      return await repository.readBlob(id);
    } catch (error) {
      if (missing && (error instanceof MissingBlobError || error instanceof UnsealError)) {
        missing.add(id);
        return null;
      }
      throw error;
    }
  };
  const data = await read(tree);
  if (!data) {
    return;
  }
  for (const entry of (JSON.parse(data.toString()) as { entries: Entry[] }).entries) {
    if (entry.tree) {
      await mark(repository, entry.tree, live, visited, missing);
    }
    for (const id of entry.chunks ?? []) {
      live.add(id);
    }
    for (const list of entry.lists ?? []) {
      live.add(list);
      const ids = await read(list);
      for (let at = 0; ids && at < ids.length; at += 32) {
        live.add(ids.toString('hex', at, at + 32));
      }
    }
  }
}

export interface VerifyReport {
  snapshots: number;
  blobs: number;
  /** Backups that could not be opened at all. */
  damagedSnapshots: string[];
  /** Pieces a backup needs that storage does not hold. */
  missing: string[];
  packsRead: number;
  /** Packs whose content no longer matches what was written. */
  damagedPacks: string[];
  /** Index objects that can no longer be opened. Nothing is lost: packs describe themselves. The next prune replaces them. */
  damagedIndexes: string[];
  /** With damaged packs: whether they were noted in storage, so the next backup stores their pieces again. */
  damageRecorded?: boolean;
}

export interface VerifyOptions {
  /** Which packs to download and check byte for byte. Default none: only that every needed piece is listed. */
  readPack?: (pack: string, index: number) => boolean;
  /** False to change nothing at all. By default damaged packs are noted in storage, so the next backup stores their pieces again. */
  recordDamage?: boolean;
}

/**
 * Checks that every backup can still be restored. The only change it makes: damaged packs are noted beside them
 * (see `Repository.recordDamagedPacks`), so the next backup stores those pieces again from the files.
 */
export async function verify(repository: Repository, options: VerifyOptions = {}): Promise<VerifyReport> {
  await repository.loadIndex();
  const live = new Set<string>();
  const visited = new Set<string>();
  const missing = new Set<string>();
  const report: VerifyReport = {
    snapshots: 0,
    blobs: 0,
    damagedSnapshots: [],
    missing: [],
    packsRead: 0,
    damagedPacks: [],
    damagedIndexes: [...repository.damagedIndexes],
  };
  for (const { key } of await repository.listSnapshots()) {
    try {
      await mark(repository, (await repository.readSnapshot(key)).tree, live, visited, missing);
      report.snapshots++;
    } catch (error) {
      if (!(error instanceof UnsealError)) {
        throw error;
      }
      report.damagedSnapshots.push(key);
    }
  }
  for (const id of live) {
    if (!repository.index.has(id)) {
      missing.add(id);
    }
  }
  report.blobs = live.size;
  report.missing = [...missing].sort();

  const packs = (await repository.store.list('p/')).map((object) => object.key).sort();
  for (const [index, pack] of packs.entries()) {
    if (!options.readPack?.(pack, index)) {
      continue;
    }
    report.packsRead++;
    try {
      const body = await repository.store.get(pack);
      for (const entry of await repository.readTrailer(pack)) {
        const id = Buffer.from(entry.id, 'hex');
        const plain = openBlob(repository.keys, id, body.subarray(entry.offset, entry.offset + entry.length));
        if (!blobId(repository.keys, plain).equals(id)) {
          throw new UnsealError();
        }
      }
    } catch {
      report.damagedPacks.push(pack);
    }
  }
  if (report.damagedPacks.length > 0 && options.recordDamage !== false) {
    // A check that can only read still reports what it found; only the note for the next backup is missing.
    report.damageRecorded = await repository.recordDamagedPacks(report.damagedPacks).then(
      () => true,
      () => false,
    );
  }
  return report;
}

export interface PruneOptions {
  policy?: RetentionPolicy;
  /**
   * Chooses which backups to keep, in place of `policy`, for a caller with retention rules of its own.
   * `snapshots` is oldest first. Whatever it answers, the newest backup is kept.
   */
  keep?: (snapshots: { key: string; time: string }[]) => Iterable<string>;
  /** Works out what a prune would remove and changes nothing. */
  dryRun?: boolean;
  now?: Date;
  /** A pack younger than this is never deleted or rewritten: it is billed for that long anyway. */
  minAgeDays?: number;
  /** A pack with less than this share of its bytes still needed is rewritten without the rest. */
  repackBelow?: number;
  packTarget?: number;
}

export interface PruneReport {
  keptSnapshots: number;
  removedSnapshots: string[];
  deletedPacks: number;
  repackedPacks: number;
  freedBytes: number;
}

/**
 * Removes backups the policy no longer keeps, and the stored data only they needed.
 *
 * The caller must hold the repository's lock: prune and backup never run together.
 *
 * The order makes every stopping point safe:
 * 1. backups that are no longer kept are removed, so nothing points at what goes next;
 * 2. needed pieces of mostly-unneeded packs are copied into new packs;
 * 3. one new index replaces the old ones (new written before old deleted);
 * 4. unneeded packs are deleted last.
 * Whatever step a stop lands on, the next run finds a repository in which every remaining backup is whole.
 */
export async function prune(repository: Repository, options: PruneOptions = {}): Promise<PruneReport> {
  const now = options.now ?? new Date();
  const minAge = (options.minAgeDays ?? 90) * DAY;
  await repository.loadIndex();

  const snapshots: { key: string; time: string; tree: string }[] = [];
  for (const { key } of await repository.listSnapshots()) {
    const { time, tree } = await repository.readSnapshot(key);
    snapshots.push({ key, time, tree });
  }
  const keep = options.keep
    ? new Set(options.keep(snapshots.map(({ key, time }) => ({ key, time }))))
    : retain(snapshots, options.policy ?? DEFAULT_RETENTION, now);
  // Whoever chooses, a repository is never left without its newest backup.
  const newest = snapshots.at(-1);
  if (newest) {
    keep.add(newest.key);
  }
  for (const key of keep) {
    if (!snapshots.some((snapshot) => snapshot.key === key)) {
      keep.delete(key);
    }
  }

  // A kept backup with a missing piece stops the prune here: a damaged repository is never thinned.
  const live = new Set<string>();
  const visited = new Set<string>();
  for (const snapshot of snapshots.filter((item) => keep.has(item.key))) {
    await mark(repository, snapshot.tree, live, visited);
  }

  for (const id of live) {
    if (!repository.index.has(id)) {
      throw new MissingBlobError(id);
    }
  }

  const needed = new Map<string, { id: string; location: Location }[]>();
  for (const [id, location] of repository.index) {
    if (live.has(id)) {
      const blobs = needed.get(location.pack) ?? [];
      blobs.push({ id, location });
      needed.set(location.pack, blobs);
    }
  }

  const writer = new PackWriter(repository, options.packTarget ?? PACK_TARGET);
  const remove: StoredObject[] = [];
  let repackedPacks = 0;
  let copiedBytes = 0;
  const moves: (() => Promise<void>)[] = [];
  for (const pack of await repository.store.list('p/')) {
    if (now.getTime() - pack.modified.getTime() < minAge) {
      continue;
    }
    const blobs = needed.get(pack.key) ?? [];
    const bytes = blobs.reduce((sum, blob) => sum + blob.location.length, 0);
    if (bytes === 0) {
      remove.push(pack);
    } else if (bytes < pack.size * (options.repackBelow ?? 0.5)) {
      remove.push(pack);
      repackedPacks++;
      copiedBytes += bytes;
      moves.push(async () => {
        for (const { id, location } of blobs) {
          const range = { start: location.offset, end: location.offset + location.length };
          const blob = await repository.store.get(pack.key, range);
          // Opened before it is copied, so damage is found here and never carried into a new pack.
          openBlob(repository.keys, Buffer.from(id, 'hex'), blob);
          await writer.addSealed(Buffer.from(id, 'hex'), blob);
        }
      });
    }
  }

  const removedSnapshots = snapshots.filter((snapshot) => !keep.has(snapshot.key)).map((snapshot) => snapshot.key);
  if (options.dryRun) {
    // Nothing above changed anything. The bytes freed are an estimate: new packs add a few bytes of their own.
    return {
      keptSnapshots: keep.size,
      removedSnapshots,
      deletedPacks: remove.length,
      repackedPacks,
      freedBytes: remove.reduce((sum, pack) => sum + pack.size, 0) - copiedBytes,
    };
  }
  for (const key of removedSnapshots) {
    await repository.store.delete(key);
  }
  for (const move of moves) {
    await move();
  }
  await writer.flush();

  const gone = new Set(remove.map((pack) => pack.key));
  for (const [id, location] of repository.index) {
    if (gone.has(location.pack)) {
      repository.index.delete(id);
    }
  }
  // Left alone when nothing changed, so a quiet week doesn't rewrite the index for no reason.
  // A damaged index object is replaced here too: the rewrite leaves it out and then removes it.
  if (remove.length > 0 || repository.damagedIndexes.length > 0 || (await repository.store.list('i/')).length > 8) {
    await repository.rewriteIndex();
  }
  for (const pack of remove) {
    await repository.store.delete(pack.key);
  }
  if (remove.length > 0) {
    await repository.removeSettledDamageNotes();
  }
  return {
    keptSnapshots: keep.size,
    removedSnapshots,
    deletedPacks: remove.length,
    repackedPacks,
    freedBytes: remove.reduce((sum, pack) => sum + pack.size, 0) - writer.storedBytes,
  };
}
