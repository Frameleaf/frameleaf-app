import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile, type FileHandle } from 'node:fs/promises';
import { Refusal } from './contracts.js';
import {
  closeImportCopyHandles,
  openImportParent,
  openImportRoot,
  importFdPath,
  importFileStable,
  assertImportDestinations,
  type ImportCopyRoot,
} from './import-copy.js';
import type {
  ImportTransfer,
  ImportTransferJournal,
} from './import-transfer-journal.js';

const mountId = async (handle: FileHandle): Promise<string> => {
  const info = await readFile(`/proc/self/fdinfo/${handle.fd}`, 'utf8');
  const match = /^mnt_id:\s*(\d+)$/m.exec(info);
  if (!match) throw new Refusal('import_relocation_mount_changed');
  return match[1];
};
const openFile = async (
  parent: FileHandle,
  name: string,
): Promise<FileHandle | undefined> => {
  try {
    return await open(
      importFdPath(parent, name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
};
const verify = async (
  handle: FileHandle,
  file: ImportTransfer,
  initial = false,
) => {
  const before = await handle.stat({ bigint: true });
  const expected = file.sourceIdentity;
  if (
    !before.isFile() ||
    before.nlink !== 1n ||
    String(before.dev) !== expected.device ||
    String(before.ino) !== expected.inode ||
    String(before.size) !== file.bytes ||
    String(before.mtimeNs) !== expected.mtimeNs ||
    (initial && String(before.ctimeNs) !== expected.ctimeNs)
  )
    throw new Refusal('import_relocation_source_changed');
  const hash = createHash('sha256');
  for await (const bytes of handle.createReadStream({
    autoClose: false,
    start: 0,
  }))
    hash.update(bytes);
  if (
    !importFileStable(before, await handle.stat({ bigint: true })) ||
    hash.digest('hex') !== file.sha256
  )
    throw new Refusal('import_relocation_verification_failed');
  return { sha256: file.sha256, bytes: file.bytes };
};
const move = async (
  source: FileHandle,
  sourceName: string,
  destination: FileHandle,
  destinationName: string,
  file: ImportTransfer,
) => {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      '/usr/local/bin/frameleaf-import-rename',
      [
        sourceName,
        destinationName,
        file.sourceIdentity.device,
        file.sourceIdentity.inode,
      ],
      {
        // A move still in flight must retain ownership if its Node parent dies.
        stdio: [
          'ignore',
          'ignore',
          'ignore',
          source.fd,
          destination.fd,
          ...(process.env.FRAMELEAF_IMPORT_EXECUTION_LOCK_FD === '3'
            ? [3]
            : []),
        ],
      },
    );
    child.once('error', () =>
      reject(new Refusal('import_relocation_move_failed')),
    );
    child.once('close', (code) => {
      if (code === 0) return resolve();
      const reasons: Record<number, string> = {
        77: 'atomic_move_unavailable',
        78: 'cross_filesystem',
        79: 'collision',
        80: 'source_changed',
      };
      reject(
        new Refusal(
          `import_relocation_${reasons[code ?? -1] ?? 'move_failed'}`,
        ),
      );
    });
  });
};

/** Requires the operation owner to keep source services/restart mechanisms fenced and bind these roots in its immutable plan. */
const transfer = async (
  journal: ImportTransferJournal,
  operationId: string,
  roots: Record<string, ImportCopyRoot>,
  rollback: boolean,
  resume: boolean,
) => {
  if (process.platform !== 'linux')
    throw new Refusal('import_relocation_requires_linux');
  const observedMounts = new Map<string, string>();
  let count = 0,
    total = 0n;
  let reviewed = false;
  try {
    for (const { file, state } of journal
      .files(operationId)
      .filter(({ file }) => file.mode === 'relocate')) {
      if (
        file.sourceIdentity.links !== '1' ||
        !(
          rollback
            ? [
                'intent',
                'verified',
                'rollback-intent',
                'rolled-back',
                'cancelled',
              ]
            : ['intent', 'verified']
        ).includes(state)
      )
        throw new Refusal('import_relocation_state_invalid');
      if (
        !Object.hasOwn(roots, file.sourceRoot) ||
        !Object.hasOwn(roots, file.destinationRoot)
      )
        throw new Refusal('import_relocation_root_missing');
      const sourceRoot = roots[file.sourceRoot],
        destinationRoot = roots[file.destinationRoot];
      if (
        sourceRoot.device !== file.sourceIdentity.device ||
        destinationRoot.device !== file.destinationDevice
      )
        throw new Refusal('import_relocation_mount_changed');
      if (sourceRoot.device !== destinationRoot.device)
        throw new Refusal('import_relocation_cross_filesystem');
      if (!rollback) journal.intent(operationId, file);
      else if (state === 'verified' || state === 'rollback-intent')
        journal.rollbackIntent(operationId, file.id);
      const handles: FileHandle[] = [];
      try {
        const mountIds: string[] = [];
        for (const [key, root] of [
          [file.sourceRoot, sourceRoot],
          [file.destinationRoot, destinationRoot],
        ] as const) {
          const handle = await openImportRoot(root.path);
          handles.push(handle);
          const identity = await handle.stat({ bigint: true });
          if (
            String(identity.dev) !== root.device ||
            String(identity.ino) !== root.inode
          )
            throw new Refusal('import_relocation_root_changed');
          const current = await mountId(handle);
          if (observedMounts.has(key) && observedMounts.get(key) !== current)
            throw new Refusal('import_relocation_mount_changed');
          observedMounts.set(key, current);
          mountIds.push(current);
        }
        if (mountIds[0] !== mountIds[1])
          throw new Refusal('import_relocation_cross_filesystem');
        const sourceParent = await openImportParent(
          sourceRoot,
          file.sourcePath,
          false,
        );
        handles.push(sourceParent);
        const destinationParent = await openImportParent(
          destinationRoot,
          file.destinationPath,
          true,
        );
        handles.push(destinationParent);
        const parents = [sourceParent, destinationParent] as const;
        const rootList = [sourceRoot, destinationRoot] as const;
        const paths = [file.sourcePath, file.destinationPath] as const;
        const names = paths.map((path) => path.split('/').at(-1)!);
        const identities = await Promise.all(
          parents.map((parent) => parent.stat({ bigint: true })),
        );
        for (let index = 0; index < parents.length; index++)
          if ((await mountId(parents[index])) !== mountIds[index])
            throw new Refusal('import_relocation_mount_changed');
        if (!rollback && !reviewed) {
          await assertImportDestinations(journal, operationId, roots);
          reviewed = true;
        }
        const source = await openFile(sourceParent, names[0]);
        if (source) handles.push(source);
        const destination = await openFile(destinationParent, names[1]);
        if (destination) handles.push(destination);
        if (source && destination)
          throw new Refusal('import_relocation_collision');
        if (!source && !destination)
          throw new Refusal('import_relocation_file_unavailable');
        const current = (source ?? destination)!;
        const currentIndex = source ? 0 : 1;
        if ((await mountId(current)) !== mountIds[currentIndex])
          throw new Refusal('import_relocation_mount_changed');
        if (
          !rollback &&
          ((state === 'verified' && source) || (!resume && destination))
        )
          throw new Refusal('import_relocation_resume_required');
        if (
          rollback &&
          ((state === 'verified' && source) ||
            (['rolled-back', 'cancelled'].includes(state) && destination))
        )
          throw new Refusal('import_relocation_state_invalid');
        const receipt = await verify(
          current,
          file,
          !!source && state === 'intent',
        );
        let finalIndex: number;
        if (rollback && source) {
          finalIndex = 0;
        } else if (rollback && destination) {
          if (state === 'intent') {
            journal.verified(operationId, file.id, receipt);
            journal.rollbackIntent(operationId, file.id);
          }
          await current.sync();
          await move(destinationParent, names[1], sourceParent, names[0], file);
          finalIndex = 0;
        } else if (source) {
          await current.sync();
          await move(sourceParent, names[0], destinationParent, names[1], file);
          finalIndex = 1;
        } else {
          finalIndex = 1;
        }
        await current.sync();
        for (const parent of parents) await parent.sync();
        await verify(current, file);
        for (let index = 0; index < parents.length; index++) {
          const parent = await openImportParent(
            rootList[index],
            paths[index],
            index === 1,
          );
          handles.push(parent);
          const identity = await parent.stat({ bigint: true });
          if (
            identity.dev !== identities[index].dev ||
            identity.ino !== identities[index].ino ||
            (await mountId(parent)) !== mountIds[index]
          )
            throw new Refusal('import_relocation_root_changed');
          const visible = await openFile(parent, names[index]);
          if (visible) handles.push(visible);
          if (index === finalIndex) {
            if (!visible) throw new Refusal('import_relocation_path_changed');
            if (
              !importFileStable(
                await current.stat({ bigint: true }),
                await visible.stat({ bigint: true }),
              )
            )
              throw new Refusal('import_relocation_path_changed');
          } else if (visible)
            throw new Refusal('import_relocation_path_changed');
        }
        if (!rollback) journal.verified(operationId, file.id, receipt);
        else if ((state === 'intent' && source) || state === 'cancelled')
          journal.cancelIntent(operationId, file.id, {
            ...receipt,
            sourceIdentity: file.sourceIdentity,
            destinationAbsent: true,
          });
        else journal.rolledBack(operationId, file.id, receipt);
        count++;
        total += BigInt(file.bytes);
      } finally {
        await closeImportCopyHandles(handles.reverse());
      }
    }
    return { files: count, bytes: String(total) };
  } catch (error) {
    if (error instanceof Refusal) throw error;
    throw new Refusal('import_relocation_failed');
  }
};
export const relocateImportFiles = (
  journal: ImportTransferJournal,
  operationId: string,
  roots: Record<string, ImportCopyRoot>,
  resume: boolean,
) => transfer(journal, operationId, roots, false, resume);
export const rollbackImportRelocations = (
  journal: ImportTransferJournal,
  operationId: string,
  roots: Record<string, ImportCopyRoot>,
) => transfer(journal, operationId, roots, true, true);
