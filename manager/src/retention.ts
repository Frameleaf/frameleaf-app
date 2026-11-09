import { lstat, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Operation } from './contracts.js';
import type { Store } from './store.js';

/** Verified release bundles kept beyond those a live review still points at. */
export const RETAINED_RELEASE_BUNDLES = 3;
/** Files of a checkpoint that exist only to be snapshotted: the plaintext dump and the recovery record. */
export const CHECKPOINT_SNAPSHOT_FILES = ['database.dump', 'recovery.json'];
/** Secrets in an import's working folder; each run of the import writes them again. */
export const IMPORT_RUNTIME_SECRETS = ['bootstrap-admin.json', 'database-url'];
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
type Reviewed = { expires?: number; release?: { directory?: string }; checkpoint?: string };

/**
 * Garbage collection for Manager's state directory (review M3). Every backup, update and import leaves a
 * full plaintext `pg_dump` plus a `recovery.json` (which carries the database password) in
 * `checkpoints/<operation>`, imports keep `imports/<operation>.dump`, every restore review restores a whole
 * snapshot into `restore-<review>`, media-move reviews keep `media-moves/<review>` and every review downloads
 * a release bundle into `releases/<uuid>`. Nothing used to delete them, so a NAS filled with dumps until
 * ENOSPC. The sweep keeps what a journaled operation may still need (any operation that is not complete,
 * and any review that has not expired), then removes the rest; release bundles keep the N most recent.
 * A common import's working folder `stack/import-runtime-<operation>` (also inside a cancelled stack's archive)
 * holds a copy of the source database, the prepared bundle, the database URL and, while it runs, the
 * destination administrator's password: a settled import loses the folder, and a stopped one keeps what a
 * resume or a safe cancel reads but not those two secrets, which its next run writes again.
 * It runs after every operation settles and when Manager starts; it never throws.
 */
export class Retention {
  constructor(
    private store: Store,
    private directory: string,
    private releaseRoot: string,
    private keepReleases = RETAINED_RELEASE_BUNDLES,
  ) {}
  private reviews(prefix: string): Map<string, Reviewed | null> {
    const found = new Map<string, Reviewed | null>();
    for (const key of this.store.keys(`${prefix}:`))
      found.set(key.slice(prefix.length + 1), this.store.get<Reviewed>(key));
    return found;
  }
  /** Whether a review is still in use: an operation that is not complete points at it, or it has not expired. */
  private live(review: Reviewed | null | undefined, id: string, operations: Operation[], now: number): boolean {
    const referencing = operations.filter((operation) =>
      operation.input.reviewId === id ||
      (operation.kind === 'import' && operation.id === id && typeof operation.receipts['reviewed-common-import'] === 'string'),
    );
    if (referencing.some((operation) => operation.state !== 'complete')) return true;
    if (referencing.length) return false; // its operation finished; the review is spent
    return !!review && typeof review.expires === 'number' && review.expires > now;
  }
  private settled(operations: Operation[], id: string): boolean {
    const operation = operations.find((entry) => entry.id === id);
    return !operation || operation.state === 'complete';
  }
  private async remove(path: string, removed: string[]): Promise<void> {
    try {
      await rm(path, { recursive: true, force: true });
      removed.push(path);
    } catch (error) {
      console.error(`manager: could not remove ${path}: ${(error as NodeJS.ErrnoException).code ?? error}`);
    }
  }
  private async entries(path: string): Promise<string[]> {
    try {
      return await readdir(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
  async sweep(now = Date.now()): Promise<string[]> {
    const removed: string[] = [];
    try {
      // Every directory is listed before the journal is read: an operation that starts between the two
      // would be missing from an earlier snapshot, so its new checkpoint would look settled and lose its
      // dump while the checkpoint is still being taken. Listed first, every entry's operation is in the snapshot.
      const checkpoints = await this.entries(join(this.directory, 'checkpoints'));
      const imports = await this.entries(join(this.directory, 'imports'));
      const stateEntries = await this.entries(this.directory);
      const mediaMoves = await this.entries(join(this.directory, 'media-moves'));
      const runtimes: { id: string; path: string }[] = [];
      for (const stack of ['stack', ...stateEntries.filter((name) => name.startsWith('cancelled-stack-'))])
        for (const name of await this.entries(join(this.directory, stack))) {
          const id = name.replace(/^import-runtime-/, '');
          if (name.startsWith('import-runtime-') && UUID.test(id))
            runtimes.push({ id, path: join(this.directory, stack, name) });
        }
      const operations = this.store.history();
      // Checkpoints of settled operations: restic holds the dump and recovery record; compose.json stays
      // (a library move reads the checkpoint's compose.json while the operation is open; it is small).
      for (const id of checkpoints) {
        if (!UUID.test(id) || !this.settled(operations, id)) continue;
        for (const name of CHECKPOINT_SNAPSHOT_FILES) {
          const file = join(this.directory, 'checkpoints', id, name);
          if (await stat(file).then(() => true, () => false)) await this.remove(file, removed);
        }
      }
      // The copy of the stopped Immich database taken for an import, once that import has settled.
      for (const name of imports) {
        const id = name.replace(/\.dump$/, '');
        if (!name.endsWith('.dump') || !UUID.test(id) || !this.settled(operations, id)) continue;
        await this.remove(join(this.directory, 'imports', name), removed);
      }
      for (const runtime of runtimes) {
        if (this.settled(operations, runtime.id)) {
          await this.remove(runtime.path, removed);
          continue;
        }
        for (const secret of IMPORT_RUNTIME_SECRETS) {
          // Rechecked per file: a resume started since the journal was read stages these again.
          const state = this.store.history().find((operation) => operation.id === runtime.id)?.state;
          if (state !== 'failed' && state !== 'interrupted') break;
          const file = join(runtime.path, 'config', secret);
          if (await lstat(file).then(() => true, () => false)) await this.remove(file, removed);
        }
      }
      // A restore review restores a whole snapshot into restore-<review>; spent or expired reviews lose it.
      const restores = this.reviews('restore');
      for (const name of stateEntries) {
        const id = name.replace(/^restore-/, '');
        if (!name.startsWith('restore-') || !UUID.test(id)) continue;
        if (this.live(restores.get(id), id, operations, now)) continue;
        await this.remove(join(this.directory, name), removed);
      }
      const moves = this.reviews('media-move');
      for (const id of mediaMoves) {
        if (!UUID.test(id) || this.live(moves.get(id), id, operations, now)) continue;
        await this.remove(join(this.directory, 'media-moves', id), removed);
      }
      // Release bundles a live review still points at stay; of the others the newest few are kept.
      const pinned = new Set<string>();
      for (const prefix of ['review', 'update', 'restore', 'database-move'])
        for (const [id, review] of this.reviews(prefix))
          if (review?.release?.directory && this.live(review, id, operations, now)) pinned.add(review.release.directory);
      const bundles: { path: string; modified: number }[] = [];
      for (const id of await this.entries(this.releaseRoot)) {
        const path = join(this.releaseRoot, id);
        if (!UUID.test(id) || pinned.has(path)) continue;
        const info = await stat(path).catch(() => null);
        if (info?.isDirectory()) bundles.push({ path, modified: info.mtimeMs });
      }
      bundles.sort((a, b) => b.modified - a.modified);
      for (const bundle of bundles.slice(this.keepReleases)) await this.remove(bundle.path, removed);
    } catch (error) {
      // A closed store means Manager is shutting down; the next start sweeps again.
      if ((error as NodeJS.ErrnoException).code !== 'ERR_INVALID_STATE')
        console.error(`manager: state cleanup did not finish: ${(error as NodeJS.ErrnoException).code ?? error}`);
    }
    return removed;
  }
}
