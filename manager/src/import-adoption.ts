import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { Refusal } from './contracts.js';
import {
  assertImportDestinations,
  closeImportCopyHandles,
  importFdPath,
  importFileStable,
  openImportParent,
  type ImportCopyRoot,
} from './import-copy.js';
import type { ImportTransferJournal } from './import-transfer-journal.js';

/** Caller owns source/destination writer fencing and reviewed local plaintext layout admission. */
export async function adoptImportFiles(
  journal: ImportTransferJournal,
  operationId: string,
  roots: Record<string, ImportCopyRoot>,
): Promise<{ files: number; bytes: string }> {
  if (process.platform !== 'linux')
    throw new Refusal('import_adoption_requires_linux');
  try {
    const plan = journal.review(operationId).plan;
    if (!plan) throw new Refusal('import_adoption_plan_required');
    // Enforce ownership and lifecycle boundaries even when the plan has no files.
    journal.sealPlan(operationId, plan);
    for (const root of plan.roots) {
      const actual = Object.hasOwn(roots, root.id) ? roots[root.id] : undefined;
      if (
        !actual ||
        actual.path !== root.path ||
        actual.device !== root.device ||
        actual.inode !== root.inode
      )
        throw new Refusal('import_adoption_root_changed');
    }
    if (plan.files.some((file) => file.mode !== 'adopt'))
      throw new Refusal('import_adoption_state_invalid');
    await assertImportDestinations(journal, operationId, roots);
    let count = 0;
    let total = 0n;
    for (const file of plan.files) {
      journal.intent(operationId, file);
      const handles: FileHandle[] = [];
      try {
        const sourceRoot = roots[file.sourceRoot];
        const destinationRoot = roots[file.destinationRoot];
        const sourceParent = await openImportParent(
          sourceRoot,
          file.sourcePath,
          false,
        );
        handles.push(sourceParent);
        const destinationParent = await openImportParent(
          destinationRoot,
          file.destinationPath,
          false,
        );
        handles.push(destinationParent);
        const sourceDirectory = await sourceParent.stat({ bigint: true });
        const destinationDirectory = await destinationParent.stat({
          bigint: true,
        });
        const sourceName = file.sourcePath.split('/').at(-1)!;
        const destinationName = file.destinationPath.split('/').at(-1)!;
        // Adoption retains one directory entry; identical bytes or a hardlink are insufficient.
        if (
          sourceDirectory.dev !== destinationDirectory.dev ||
          sourceDirectory.ino !== destinationDirectory.ino ||
          sourceName !== destinationName
        )
          throw new Refusal('import_adoption_layout_changed');
        const original = await open(
          importFdPath(sourceParent, sourceName),
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        handles.push(original);
        const before = await original.stat({ bigint: true });
        const observed = {
          device: String(before.dev),
          inode: String(before.ino),
          bytes: String(before.size),
          mtimeNs: String(before.mtimeNs),
          ctimeNs: String(before.ctimeNs),
          links: String(before.nlink),
        };
        if (
          !before.isFile() ||
          before.nlink !== 1n ||
          before.size > BigInt(Number.MAX_SAFE_INTEGER) ||
          JSON.stringify(observed) !== JSON.stringify(file.sourceIdentity) ||
          String(before.dev) !== sourceRoot.device ||
          String(before.dev) !== file.destinationDevice
        )
          throw new Refusal('import_adoption_source_changed');
        const hash = createHash('sha256');
        for await (const bytes of original.createReadStream({
          autoClose: false,
        }))
          hash.update(bytes);
        if (
          hash.digest('hex') !== file.sha256 ||
          !importFileStable(before, await original.stat({ bigint: true }))
        )
          throw new Refusal('import_adoption_source_changed');
        await original.sync();
        await sourceParent.sync();
        for (const [root, path, directory] of [
          [sourceRoot, file.sourcePath, sourceDirectory],
          [destinationRoot, file.destinationPath, destinationDirectory],
        ] as const) {
          const currentParent = await openImportParent(root, path, false);
          let current: FileHandle | undefined;
          try {
            const actual = await currentParent.stat({ bigint: true });
            if (actual.dev !== directory.dev || actual.ino !== directory.ino)
              throw new Refusal('import_adoption_root_changed');
            current = await open(
              importFdPath(currentParent, path.split('/').at(-1)!),
              constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
            );
            if (!importFileStable(before, await current.stat({ bigint: true })))
              throw new Refusal('import_adoption_source_changed');
          } finally {
            await closeImportCopyHandles(
              current ? [current, currentParent] : [currentParent],
            );
          }
        }
        journal.verified(operationId, file.id, {
          sha256: file.sha256,
          bytes: file.bytes,
        });
        count++;
        total += BigInt(file.bytes);
      } finally {
        await closeImportCopyHandles(handles.reverse());
      }
    }
    return { files: count, bytes: String(total) };
  } catch (error) {
    throw error instanceof Refusal
      ? error
      : new Refusal('import_adoption_unavailable');
  }
}
