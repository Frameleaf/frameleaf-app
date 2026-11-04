import { constants } from 'node:fs';
import { type FileHandle, mkdtemp, open, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { openImportRoot } from '#library-import-transfer/import-copy';
import { importPlanSha256, parseImportPlan } from '#library-import-transfer/import-plan';
import { privateImportPathSchema } from 'src/library-import/command-input.js';
import { type DestinationImportPlan, bindDestinationImportPlan } from 'src/library-import/destination-plan.js';
import { type ImportManifest, manifestFingerprint, parseImportManifest } from 'src/library-import/manifest.js';
import { preparePrivateOwnerInputs } from 'src/library-import/private-owners.js';
import {
  EMPTY_SOURCE_ARCHIVE_HASH,
  advanceSourceArchiveHash,
  encodeSourceArchiveRecord,
} from 'src/library-import/source-archive-codec.js';
import { parseSourceArchiveDescriptor } from 'src/library-import/source-archive.js';
import {
  type LibraryImportBinding,
  LibraryImportRefused,
  parseLibraryImportBinding,
} from 'src/library-import/state.js';

export function summarizeReviewedImport(manifest: ImportManifest, plan: DestinationImportPlan) {
  const copyBytes = plan.files.reduce((total, file) => total + (file.mode === 'copy' ? BigInt(file.bytes) : 0n), 0n);
  if (copyBytes > BigInt(Number.MAX_SAFE_INTEGER))
    throw new LibraryImportRefused('IMPORT_BUNDLE_MEDIA_SIZE_UNSUPPORTED');
  return {
    requiredMediaBytes: Number(copyBytes),
    summary: {
      owners: manifest.users.length,
      assets: manifest.assets.length,
      files: plan.files.length,
      albums: manifest.albums.length,
      preservationDifferences: manifest.losses.length,
    },
  };
}

type BundleOutput = {
  bundleDirectory: string;
  receipt: {
    bundleName: string;
    binding: LibraryImportBinding;
    destinationId: string;
  } & ReturnType<typeof summarizeReviewedImport>;
};

/** Serialize qualified adapter output only; source fencing, ownership/privacy evidence and activation remain caller duties. */
export async function writeLibraryImportBundle(input: {
  stagingRoot: string;
  operationId: string;
  destinationId: string;
  manifest: unknown;
  plan: unknown;
  owners: unknown;
  records: AsyncIterable<unknown> | Iterable<unknown>;
}): Promise<BundleOutput> {
  let root: FileHandle | undefined, directory: FileHandle | undefined, temporary: string | undefined;
  let result: BundleOutput | undefined;
  let failure: LibraryImportRefused | undefined;
  try {
    if (!privateImportPathSchema.safeParse(input.stagingRoot).success)
      throw new LibraryImportRefused('IMPORT_BUNDLE_STAGING_INVALID');
    const manifest = parseImportManifest(input.manifest);
    if (manifest.version < 3) throw new LibraryImportRefused('IMPORT_REQUIRES_SEALED_MANIFEST');
    const parsedPlan = parseImportPlan(input.plan);
    const binding = parseLibraryImportBinding({
      operationId: input.operationId,
      manifestSha256: manifestFingerprint(manifest),
      planSha256: importPlanSha256(parsedPlan),
      source: manifest.source,
    });
    const plan = bindDestinationImportPlan(parsedPlan, binding, manifest, input.destinationId);
    const summary = summarizeReviewedImport(manifest, plan);
    const owners = preparePrivateOwnerInputs(
      { binding, destinationId: input.destinationId, manifest, plan },
      input.owners,
    ).archive;
    try {
      root = await openImportRoot(input.stagingRoot);
    } catch {
      throw new LibraryImportRefused('IMPORT_BUNDLE_STAGING_INVALID');
    }
    const parent = await root.stat({ bigint: true });
    if ((parent.mode & 0o777n) !== 0o700n || parent.uid !== BigInt(process.geteuid?.() ?? -1))
      throw new LibraryImportRefused('IMPORT_BUNDLE_STAGING_INVALID');
    // Persist ownership before sensitive writes, including interruptions that cannot return a bundle path.
    temporary = await mkdtemp(`/proc/self/fd/${root.fd}/bundle-${binding.operationId}-`);
    await root.sync();
    const bundleDirectory = join(input.stagingRoot, basename(temporary));
    if (!privateImportPathSchema.safeParse(join(bundleDirectory, 'manifest.json')).success)
      throw new LibraryImportRefused('IMPORT_BUNDLE_STAGING_INVALID');
    directory = await open(temporary, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const directoryPath = `/proc/self/fd/${directory.fd}`;
    const write = async (name: string, value: unknown) => {
      const bytes = JSON.stringify(value);
      if (Buffer.byteLength(bytes) > 512 * 1024 * 1024) throw new LibraryImportRefused('IMPORT_BUNDLE_INPUT_TOO_LARGE');
      const file = await open(
        `${directoryPath}/${name}`,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
    };
    await write('manifest.json', manifest);
    await write('plan.json', plan);
    await write('owners.json', owners);
    const archive = await open(
      `${directoryPath}/archive.jsonl`,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    let rows = 0n,
      sha256 = EMPTY_SOURCE_ARCHIVE_HASH;
    try {
      for await (const record of input.records) {
        const encoded = encodeSourceArchiveRecord(record);
        const line = JSON.stringify(encoded);
        if (Buffer.byteLength(line) > 8 * 1024 * 1024) throw new LibraryImportRefused('SOURCE_ARCHIVE_RECORD_INVALID');
        await archive.writeFile(line + '\n');
        rows++;
        sha256 = advanceSourceArchiveHash(sha256, encoded);
      }
      await archive.sync();
    } finally {
      await archive.close();
    }
    // The existing descriptor seals the complete inventory; no consumer receives a path before durable completion.
    await write(
      'archive.json',
      parseSourceArchiveDescriptor({ format: 'frameleaf-source-archive', version: 1, rows: String(rows), sha256 }),
    );
    await directory.sync();
    await root.sync();
    const visible = await openImportRoot(bundleDirectory);
    try {
      const expected = await directory.stat({ bigint: true }),
        actual = await visible.stat({ bigint: true });
      if (actual.dev !== expected.dev || actual.ino !== expected.ino)
        throw new LibraryImportRefused('IMPORT_BUNDLE_STAGING_CHANGED');
    } finally {
      await visible.close();
    }
    result = {
      bundleDirectory,
      receipt: {
        bundleName: basename(bundleDirectory),
        binding,
        destinationId: plan.destinationId,
        ...summary,
      },
    };
  } catch (error) {
    failure = error instanceof LibraryImportRefused ? error : new LibraryImportRefused('IMPORT_BUNDLE_WRITE_FAILED');
    if (temporary) {
      try {
        await rm(temporary, { recursive: true });
        await root!.sync();
      } catch {
        failure = new LibraryImportRefused('IMPORT_BUNDLE_CLEANUP_FAILED');
      }
    }
  } finally {
    const closed = await Promise.allSettled([directory?.close(), root?.close()]);
    if (closed.some((result) => result.status === 'rejected'))
      failure = new LibraryImportRefused('IMPORT_BUNDLE_CLEANUP_FAILED');
  }
  if (failure) throw failure;
  return result!;
}
