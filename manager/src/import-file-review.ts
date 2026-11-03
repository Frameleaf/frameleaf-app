import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile, type FileHandle } from 'node:fs/promises';
import { z } from 'zod';
import { Refusal } from './contracts.js';
import {
  closeImportCopyHandles,
  importFdPath,
  importFileStable,
  openImportParent,
  openImportRoot,
} from './import-copy.js';
import {
  importRelativePathSchema,
  parseImportPlan,
  type ImportPlan,
} from './import-plan.js';

const id = z.string().min(1).max(1024);
const decimal = z.string().regex(/^(0|[1-9]\d*)$/);
const draftFiles = z.array(
  z.strictObject({
    id,
    sourceAssetId: id,
    sourceFileId: id,
    mode: z.enum(['copy', 'adopt', 'relocate']).default('copy'),
    sourceRoot: id,
    sourcePath: importRelativePathSchema,
    destinationRoot: id,
    destinationPath: importRelativePathSchema,
    expectedBytes: decimal.optional(),
    expectedSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  }),
);
const mountId = async (handle: FileHandle) => {
  const match = /^mnt_id:\s*(\d+)$/m.exec(
    await readFile(`/proc/self/fdinfo/${handle.fd}`, 'utf8'),
  );
  if (!match) throw new Refusal('import_file_review_mount_unavailable');
  return match[1];
};

/** Caller qualifies source inventory/privacy and holds all source writers/restart mechanisms fenced. No media is changed. */
export async function reviewImportFiles(
  input: unknown,
  mode: 'capture' | 'recheck' = 'capture',
): Promise<ImportPlan> {
  if (process.platform !== 'linux')
    throw new Refusal('import_file_review_requires_linux');
  try {
    if (!['capture', 'recheck'].includes(mode))
      throw new Refusal('import_file_review_mode_invalid');
    const { files, ...header } = z.record(z.string(), z.unknown()).parse(input);
    const drafts = draftFiles.parse(files);
    const base = parseImportPlan({ ...header, files: [] });
    if (base.version !== 2)
      throw new Refusal('import_file_review_plan_version');
    const roots = new Map(base.roots.map((root) => [root.id, root]));
    const reviewed: ImportPlan['files'] = [];
    const destinations = new Set<string>();
    for (const draft of drafts) {
      const { expectedBytes, expectedSha256, ...placement } = draft;
      if (
        mode === 'recheck' &&
        (expectedBytes === undefined || expectedSha256 === undefined)
      )
        throw new Refusal('import_file_review_evidence_required');
      const sourceRoot = roots.get(draft.sourceRoot),
        destinationRoot = roots.get(draft.destinationRoot);
      if (!sourceRoot || !destinationRoot)
        throw new Refusal('import_file_review_root_missing');
      const handles: FileHandle[] = [];
      try {
        const sourceParent = await openImportParent(
          sourceRoot,
          draft.sourcePath,
          false,
        );
        handles.push(sourceParent);
        const sourceName = draft.sourcePath.split('/').at(-1)!;
        const source = await open(
          importFdPath(sourceParent, sourceName),
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        handles.push(source);
        const before = await source.stat({ bigint: true });
        if (
          !before.isFile() ||
          before.size > BigInt(Number.MAX_SAFE_INTEGER) ||
          (draft.mode !== 'copy' && before.nlink !== 1n)
        )
          throw new Refusal('import_file_review_original_invalid');
        if (String(before.dev) !== sourceRoot.device)
          throw new Refusal('import_file_review_mount_changed');
        let sha256: string;
        if (mode === 'recheck') {
          // Compare the returned identities with the sealed plan; transfer still verifies actual bytes.
          sha256 = expectedSha256!;
        } else {
          const hash = createHash('sha256');
          for await (const bytes of source.createReadStream({
            start: 0,
            autoClose: false,
          }))
            hash.update(bytes);
          sha256 = hash.digest('hex');
        }
        const bytes = String(before.size);
        if (!importFileStable(before, await source.stat({ bigint: true })))
          throw new Refusal('import_file_review_original_changed');
        if (
          (expectedBytes !== undefined && expectedBytes !== bytes) ||
          (expectedSha256 !== undefined && expectedSha256 !== sha256)
        )
          throw new Refusal('import_file_review_evidence_mismatch');
        const currentParent = await openImportParent(
          sourceRoot,
          draft.sourcePath,
          false,
        );
        handles.push(currentParent);
        const current = await open(
          importFdPath(currentParent, sourceName),
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        handles.push(current);
        if (!importFileStable(before, await current.stat({ bigint: true })))
          throw new Refusal('import_file_review_original_changed');
        const destinationParent = await openImportParent(
          destinationRoot,
          draft.destinationPath,
          false,
        );
        handles.push(destinationParent);
        const destinationDirectory = await destinationParent.stat({
          bigint: true,
        });
        const destinationKey = JSON.stringify([
          String(destinationDirectory.dev),
          String(destinationDirectory.ino),
          draft.destinationPath.split('/').at(-1)!,
        ]);
        if (destinations.has(destinationKey))
          throw new Refusal('import_file_review_destination_alias');
        destinations.add(destinationKey);
        if (
          draft.mode === 'relocate' &&
          (await mountId(sourceParent)) !== (await mountId(destinationParent))
        )
          throw new Refusal('import_file_review_cross_filesystem');
        let destination: FileHandle | undefined;
        try {
          destination = await open(
            importFdPath(
              destinationParent,
              draft.destinationPath.split('/').at(-1)!,
            ),
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        if (destination) handles.push(destination);
        if (draft.mode === 'adopt') {
          const sourceDirectory = await currentParent.stat({ bigint: true });
          if (
            !destination ||
            !importFileStable(
              before,
              await destination.stat({ bigint: true }),
            ) ||
            sourceDirectory.dev !== destinationDirectory.dev ||
            sourceDirectory.ino !== destinationDirectory.ino ||
            sourceName !== draft.destinationPath.split('/').at(-1)!
          )
            throw new Refusal('import_file_review_adoption_layout');
        } else if (destination)
          throw new Refusal('import_file_review_destination_collision');
        reviewed.push({
          ...placement,
          sha256,
          bytes,
          destinationDevice: destinationRoot.device,
          sourceIdentity: {
            device: String(before.dev),
            inode: String(before.ino),
            bytes,
            mtimeNs: String(before.mtimeNs),
            ctimeNs: String(before.ctimeNs),
            links: String(before.nlink),
          },
        });
      } finally {
        await closeImportCopyHandles(handles.reverse());
      }
    }
    for (const root of roots.values()) {
      const handle = await openImportRoot(root.path);
      try {
        const actual = await handle.stat({ bigint: true });
        if (
          String(actual.dev) !== root.device ||
          String(actual.ino) !== root.inode
        )
          throw new Refusal('import_file_review_root_changed');
      } finally {
        await handle.close();
      }
    }
    return parseImportPlan({ ...base, files: reviewed });
  } catch (error) {
    if (
      error instanceof Refusal &&
      (error.code.startsWith('import_file_review_') ||
        error.code === 'import_plan_invalid')
    )
      throw error;
    throw new Refusal('import_file_review_failed');
  }
}
