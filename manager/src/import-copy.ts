import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Refusal } from './contracts.js';
import type { ImportTransferJournal } from './import-transfer-journal.js';

export type ImportCopyRoot = { path: string; device: string; inode: string };
const same = (a: BigIntStats, b: BigIntStats) =>
  a.dev === b.dev && a.ino === b.ino;
const stable = (a: BigIntStats, b: BigIntStats) =>
  same(a, b) &&
  a.size === b.size &&
  a.mtimeNs === b.mtimeNs &&
  a.ctimeNs === b.ctimeNs &&
  a.nlink === b.nlink;
const fdPath = (handle: FileHandle, name: string) =>
  `/proc/self/fd/${handle.fd}/${name}`;
export async function closeImportCopyHandles(
  handles: Pick<FileHandle, 'close'>[],
): Promise<void> {
  const results = await Promise.allSettled(
    handles.map(async (handle) => handle.close()),
  );
  if (results.some((result) => result.status === 'rejected'))
    throw new Refusal('import_copy_cleanup_failed');
}
async function directory(path: string): Promise<FileHandle> {
  if (path === '/' || !path.startsWith('/') || resolve(path) !== path)
    throw new Refusal('import_copy_root_invalid');
  let handle = await open('/', constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    for (const part of path.slice(1).split('/')) {
      const next = await open(
        fdPath(handle, part),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        await handle.close();
      } catch (error) {
        await next.close();
        throw error;
      }
      handle = next;
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}
async function parent(
  root: ImportCopyRoot,
  path: string,
  privateRoot: boolean,
): Promise<FileHandle> {
  const rootHandle = await directory(root.path);
  let handle = rootHandle;
  try {
    const identity = await handle.stat({ bigint: true });
    if (
      String(identity.dev) !== root.device ||
      String(identity.ino) !== root.inode ||
      (privateRoot && (identity.mode & 0o077n) !== 0n)
    )
      throw new Refusal('import_copy_root_changed');
    for (const part of path.split('/').slice(0, -1)) {
      const next = await open(
        fdPath(handle, part),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      if (handle !== rootHandle) {
        try {
          await handle.close();
        } catch (error) {
          await closeImportCopyHandles([next]);
          throw error;
        }
      }
      handle = next;
    }
    if (String((await handle.stat({ bigint: true })).dev) !== root.device)
      throw new Refusal('import_copy_mount_changed');
    if (handle !== rootHandle) await rootHandle.close();
    return handle;
  } catch (error) {
    await closeImportCopyHandles([...new Set([handle, rootHandle])]);
    throw error;
  }
}
async function checksum(file: FileHandle): Promise<string> {
  const hash = createHash('sha256');
  const bytes = Buffer.alloc(1024 * 1024);
  let position = 0;
  while (true) {
    const { bytesRead } = await file.read(bytes, 0, bytes.length, position);
    if (!bytesRead) break;
    hash.update(bytes.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest('hex');
}

/** Caller supplies a private, exclusively fenced destination namespace bound to the reviewed plan. Never deletes or overwrites bytes. */
export async function copyImportFiles(
  journal: ImportTransferJournal,
  operationId: string,
  roots: Record<string, ImportCopyRoot>,
  resume: boolean,
): Promise<{ files: number; bytes: string }> {
  if (process.platform !== 'linux')
    throw new Refusal('import_copy_requires_linux');
  let count = 0,
    total = 0n;
  try {
    for (const entry of journal.files(operationId)) {
      const { file, state } = entry;
      if (file.mode !== 'copy' || !['intent', 'verified'].includes(state))
        throw new Refusal('import_copy_state_invalid');
      if (
        !Object.hasOwn(roots, file.sourceRoot) ||
        !Object.hasOwn(roots, file.destinationRoot)
      )
        throw new Refusal('import_copy_root_missing');
      journal.intent(operationId, file);
      const sourceRoot = roots[file.sourceRoot],
        destinationRoot = roots[file.destinationRoot];
      if (
        file.sourceIdentity.device !== sourceRoot.device ||
        file.destinationDevice !== destinationRoot.device
      )
        throw new Refusal('import_copy_mount_changed');
      const handles: FileHandle[] = [];
      try {
        const sourceParent = await parent(sourceRoot, file.sourcePath, false);
        handles.push(sourceParent);
        const destinationParent = await parent(
          destinationRoot,
          file.destinationPath,
          true,
        );
        handles.push(destinationParent);
        const sourceParentIdentity = await sourceParent.stat({ bigint: true }),
          destinationParentIdentity = await destinationParent.stat({
            bigint: true,
          });
        const sourceName = file.sourcePath.split('/').at(-1)!,
          destinationName = file.destinationPath.split('/').at(-1)!;
        const source = await open(
          fdPath(sourceParent, sourceName),
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        handles.push(source);
        const before = await source.stat({ bigint: true });
        const actual = {
          device: String(before.dev),
          inode: String(before.ino),
          bytes: String(before.size),
          mtimeNs: String(before.mtimeNs),
          ctimeNs: String(before.ctimeNs),
          links: String(before.nlink),
        };
        if (
          !before.isFile() ||
          JSON.stringify(actual) !== JSON.stringify(file.sourceIdentity) ||
          before.size > BigInt(Number.MAX_SAFE_INTEGER)
        )
          throw new Refusal('import_copy_source_changed');
        let destination: FileHandle;
        try {
          if (state === 'verified' || resume) {
            try {
              destination = await open(
                fdPath(destinationParent, destinationName),
                constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
              );
            } catch (error) {
              if (
                state === 'verified' ||
                (error as NodeJS.ErrnoException).code !== 'ENOENT'
              )
                throw error;
              destination = await open(
                fdPath(destinationParent, destinationName),
                constants.O_RDWR |
                  constants.O_CREAT |
                  constants.O_EXCL |
                  constants.O_NOFOLLOW,
                0o600,
              );
            }
          } else
            destination = await open(
              fdPath(destinationParent, destinationName),
              constants.O_RDWR |
                constants.O_CREAT |
                constants.O_EXCL |
                constants.O_NOFOLLOW,
              0o600,
            );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST')
            throw new Refusal('import_copy_collision');
          throw error;
        }
        handles.push(destination);
        const target = await destination.stat({ bigint: true });
        if (
          !target.isFile() ||
          target.nlink !== 1n ||
          (target.mode & 0o077n) !== 0n ||
          same(target, before) ||
          String(target.dev) !== destinationRoot.device ||
          target.size > before.size ||
          (state === 'verified' && target.size !== before.size)
        )
          throw new Refusal('import_copy_destination_changed');
        const prefix = Number(target.size),
          buffer = Buffer.alloc(1024 * 1024),
          existing = Buffer.alloc(1024 * 1024);
        let position = 0;
        const sourceHash = createHash('sha256');
        while (position < Number(before.size)) {
          const { bytesRead } = await source.read(
            buffer,
            0,
            Math.min(buffer.length, Number(before.size) - position),
            position,
          );
          if (!bytesRead) throw new Refusal('import_copy_source_changed');
          sourceHash.update(buffer.subarray(0, bytesRead));
          const compare = Math.min(bytesRead, Math.max(0, prefix - position));
          if (compare) {
            const read = await destination.read(existing, 0, compare, position);
            if (
              read.bytesRead !== compare ||
              !existing.subarray(0, compare).equals(buffer.subarray(0, compare))
            )
              throw new Refusal('import_copy_prefix_changed');
          }
          let offset = compare;
          while (offset < bytesRead) {
            const { bytesWritten } = await destination.write(
              buffer,
              offset,
              bytesRead - offset,
              position + offset,
            );
            if (!bytesWritten) throw new Refusal('import_copy_write_failed');
            offset += bytesWritten;
          }
          position += bytesRead;
        }
        if (
          sourceHash.digest('hex') !== file.sha256 ||
          !stable(before, await source.stat({ bigint: true }))
        )
          throw new Refusal('import_copy_source_changed');
        await destination.sync();
        await destinationParent.sync();
        const copied = await destination.stat({ bigint: true });
        const hash = await checksum(destination);
        if (
          hash !== file.sha256 ||
          String(copied.size) !== file.bytes ||
          !same(target, copied) ||
          copied.nlink !== 1n ||
          !stable(copied, await destination.stat({ bigint: true }))
        )
          throw new Refusal('import_copy_verification_failed');
        for (const [root, path, identity, fileIdentity] of [
          [sourceRoot, file.sourcePath, sourceParentIdentity, before],
          [
            destinationRoot,
            file.destinationPath,
            destinationParentIdentity,
            copied,
          ],
        ] as const) {
          const current = await parent(root, path, root === destinationRoot);
          try {
            if (!same(identity, await current.stat({ bigint: true })))
              throw new Refusal('import_copy_root_changed');
            const currentFile = await open(
              fdPath(current, path.split('/').at(-1)!),
              constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
            );
            try {
              if (
                !stable(fileIdentity, await currentFile.stat({ bigint: true }))
              )
                throw new Refusal('import_copy_path_changed');
            } finally {
              await currentFile.close();
            }
          } finally {
            await current.close();
          }
        }
        journal.verified(operationId, file.id, {
          sha256: hash,
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
      : new Refusal('import_copy_unavailable');
  }
}
