import { UnsealError, blobId, openBlob } from './keys.js';
import { MissingBlobError, PACK_TARGET, PackWriter } from './repository.js';
const DAY = 86_400_000;
export const DEFAULT_RETENTION = { keepLast: 3, keepDays: 90, keepMonthly: 12 };
export function retain(snapshots, policy, now) {
    const keep = new Set(snapshots.slice(-Math.max(1, policy.keepLast)).map((snapshot) => snapshot.key));
    const month = (date) => date.getUTCFullYear() * 12 + date.getUTCMonth();
    const months = new Set();
    for (const snapshot of snapshots.toReversed()) {
        const time = new Date(snapshot.time);
        if (Number.isNaN(time.getTime()) || now.getTime() - time.getTime() <= policy.keepDays * DAY) {
            keep.add(snapshot.key);
        }
        else if (month(now) - month(time) < policy.keepMonthly && !months.has(month(time))) {
            months.add(month(time));
            keep.add(snapshot.key);
        }
    }
    return keep;
}
async function mark(repository, tree, live, missing) {
    if (live.has(tree)) {
        return;
    }
    live.add(tree);
    const read = async (id) => {
        try {
            return await repository.readBlob(id);
        }
        catch (error) {
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
    for (const entry of JSON.parse(data.toString()).entries) {
        if (entry.tree) {
            await mark(repository, entry.tree, live, missing);
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
export async function verify(repository, options = {}) {
    await repository.loadIndex();
    const live = new Set();
    const missing = new Set();
    const report = {
        snapshots: 0,
        blobs: 0,
        damagedSnapshots: [],
        missing: [],
        packsRead: 0,
        damagedPacks: [],
    };
    for (const { key } of await repository.listSnapshots()) {
        try {
            await mark(repository, (await repository.readSnapshot(key)).tree, live, missing);
            report.snapshots++;
        }
        catch (error) {
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
        }
        catch {
            report.damagedPacks.push(pack);
        }
    }
    return report;
}
export async function prune(repository, options = {}) {
    const now = options.now ?? new Date();
    const minAge = (options.minAgeDays ?? 90) * DAY;
    await repository.loadIndex();
    const snapshots = [];
    for (const { key } of await repository.listSnapshots()) {
        const { time, tree } = await repository.readSnapshot(key);
        snapshots.push({ key, time, tree });
    }
    const keep = retain(snapshots, options.policy ?? DEFAULT_RETENTION, now);
    const live = new Set();
    for (const snapshot of snapshots.filter((item) => keep.has(item.key))) {
        await mark(repository, snapshot.tree, live);
    }
    for (const id of live) {
        if (!repository.index.has(id)) {
            throw new MissingBlobError(id);
        }
    }
    const needed = new Map();
    for (const [id, location] of repository.index) {
        if (live.has(id)) {
            const blobs = needed.get(location.pack) ?? [];
            blobs.push({ id, location });
            needed.set(location.pack, blobs);
        }
    }
    const writer = new PackWriter(repository, options.packTarget ?? PACK_TARGET);
    const remove = [];
    let repackedPacks = 0;
    const moves = [];
    for (const pack of await repository.store.list('p/')) {
        if (now.getTime() - pack.modified.getTime() < minAge) {
            continue;
        }
        const blobs = needed.get(pack.key) ?? [];
        const bytes = blobs.reduce((sum, blob) => sum + blob.location.length, 0);
        if (bytes === 0) {
            remove.push(pack);
        }
        else if (bytes < pack.size * (options.repackBelow ?? 0.5)) {
            remove.push(pack);
            repackedPacks++;
            moves.push(async () => {
                for (const { id, location } of blobs) {
                    const range = { start: location.offset, end: location.offset + location.length };
                    const blob = await repository.store.get(pack.key, range);
                    openBlob(repository.keys, Buffer.from(id, 'hex'), blob);
                    await writer.addSealed(Buffer.from(id, 'hex'), blob);
                }
            });
        }
    }
    const removedSnapshots = snapshots.filter((snapshot) => !keep.has(snapshot.key)).map((snapshot) => snapshot.key);
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
    if (remove.length > 0 || (await repository.store.list('i/')).length > 8) {
        await repository.rewriteIndex();
    }
    for (const pack of remove) {
        await repository.store.delete(pack.key);
    }
    return {
        keptSnapshots: keep.size,
        removedSnapshots,
        deletedPacks: remove.length,
        repackedPacks,
        freedBytes: remove.reduce((sum, pack) => sum + pack.size, 0) - writer.storedBytes,
    };
}
