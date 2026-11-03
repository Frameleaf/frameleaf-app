import { createHash } from 'node:crypto';
import { type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { importPlanSha256, parseImportPlan } from '#library-import-transfer/import-plan';
import { type ImportDatabase } from 'src/immich-import/types.js';
import {
  type LibraryImportCommandConfig,
  openPrivateImportFile,
  readPrivateImportJSON,
} from 'src/library-import/command-input.js';
import { bindDestinationImportPlan } from 'src/library-import/destination-plan.js';
import { type SourceKind, manifestFingerprint, parseImportManifest } from 'src/library-import/manifest.js';
import { loadPrivateOwnerInputs, parsePrivateOwnerInputs } from 'src/library-import/private-owners.js';
import { loadReviewedImportInputs } from 'src/library-import/reviewed-inputs.js';
import {
  EMPTY_SOURCE_ARCHIVE_HASH,
  advanceSourceArchiveHash,
  decodeSourceArchiveRecord,
} from 'src/library-import/source-archive-codec.js';
import { LibrarySourceArchive, parseSourceArchiveDescriptor } from 'src/library-import/source-archive.js';
import { LibraryImportJournal, LibraryImportRefused, parseLibraryImportBinding } from 'src/library-import/state.js';

const refuse = (code: string): never => {
  throw new LibraryImportRefused(code);
};
const metadataFiles = ['manifest.json', 'plan.json', 'owners.json', 'archive.json'] as const;
const fingerprintHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function* archiveLines(file: FileHandle) {
  let pending = Buffer.alloc(0);
  let complete = false;
  const stream = file.createReadStream({ autoClose: false, highWaterMark: 65_536 });
  const decode = (bytes: Buffer) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  try {
    for await (const chunk of stream) {
      pending = Buffer.concat([pending, Buffer.from(chunk)]);
      let end: number;
      while ((end = pending.indexOf(10)) !== -1) {
        if (end > 8 * 1024 * 1024) return refuse('SOURCE_ARCHIVE_RECORD_INVALID');
        yield decode(pending.subarray(0, end));
        pending = pending.subarray(end + 1);
      }
      if (pending.length > 8 * 1024 * 1024) return refuse('SOURCE_ARCHIVE_RECORD_INVALID');
    }
    if (pending.length > 0) yield decode(pending);
    complete = true;
  } finally {
    if (!complete) stream.destroy();
  }
}

/** A common plaintext bundle is an exporter contract; its source adapter still owns version/schema qualification. */
export async function loadLibraryImportBundle(config: LibraryImportCommandConfig, source: SourceKind) {
  const inputs = await Promise.all(
    metadataFiles.map((name) =>
      readPrivateImportJSON(join(config.bundleDirectory, name), name === 'archive.json' ? 65_536 : 512 * 1024 * 1024),
    ),
  );
  const [manifestInput, planInput, ownersInput, archiveInput] = inputs;
  const manifest = parseImportManifest(manifestInput.value);
  if (manifest.source.kind !== source) return refuse('IMPORT_SOURCE_KIND_CHANGED');
  if (manifest.version < 3) return refuse('IMPORT_REQUIRES_SEALED_MANIFEST');
  const parsedPlan = parseImportPlan(planInput.value);
  const binding = parseLibraryImportBinding({
    operationId: config.operationId,
    manifestSha256: manifestFingerprint(manifest),
    planSha256: importPlanSha256(parsedPlan),
    source: manifest.source,
  });
  const plan = bindDestinationImportPlan(parsedPlan, binding, manifest, config.destinationId);
  const context = { binding, destinationId: config.destinationId, manifest, plan };
  const owners = parsePrivateOwnerInputs(ownersInput.value, context).owners.map(({ intent, credential }) => ({
    intent,
    credential,
  }));
  const descriptor = parseSourceArchiveDescriptor(archiveInput.value);

  const records = async function* () {
    const file = await openPrivateImportFile(join(config.bundleDirectory, 'archive.jsonl'));
    let hash = EMPTY_SOURCE_ARCHIVE_HASH,
      count = 0n;
    try {
      const before = await file.stat({ bigint: true });
      for await (const line of archiveLines(file)) {
        if (!line) return refuse('SOURCE_ARCHIVE_RECORD_INVALID');
        let encoded: unknown;
        try {
          encoded = JSON.parse(line);
        } catch {
          return refuse('SOURCE_ARCHIVE_RECORD_INVALID');
        }
        hash = advanceSourceArchiveHash(hash, encoded);
        count++;
        if (count > BigInt(descriptor.rows)) return refuse('SOURCE_ARCHIVE_COUNT_MISMATCH');
        yield decodeSourceArchiveRecord(encoded);
      }
      const after = await file.stat({ bigint: true });
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs ||
        before.nlink !== after.nlink
      )
        return refuse('SOURCE_ARCHIVE_RECORD_CHANGED');
      if (String(count) !== descriptor.rows || hash !== descriptor.sha256)
        return refuse('SOURCE_ARCHIVE_RECORD_CHANGED');
    } finally {
      await file.close();
    }
  };
  const assertUnchanged = async () => {
    const current = await Promise.all(
      metadataFiles.map((name) =>
        readPrivateImportJSON(join(config.bundleDirectory, name), name === 'archive.json' ? 65_536 : 512 * 1024 * 1024),
      ),
    );
    if (current.some((value, index) => value.sha256 !== inputs[index].sha256)) return refuse('IMPORT_BUNDLE_CHANGED');
    for await (const _record of records()) {
      /* Exhaust the complete inventory, including its final seal. */
    }
  };
  return { context, owners, descriptor, records, assertUnchanged };
}

/** Recovery never reopens old export or original paths after a relocation. Missing evidence is an integrity failure. */
export async function loadRetainedLibraryImportBundle(
  db: ImportDatabase,
  config: LibraryImportCommandConfig,
  source: SourceKind,
) {
  const { run } = await new LibraryImportJournal(db).status();
  if (!run) return refuse('IMPORT_JOURNAL_MISSING');
  if (run.binding.operationId !== config.operationId || run.binding.source.kind !== source)
    return refuse('IMPORT_BINDING_CHANGED');
  // Terminal runs keep readable recovery evidence; the controller still refuses further import writes.
  const bound = { binding: run.binding, destinationId: config.destinationId };
  const context = { ...bound, ...(await loadReviewedImportInputs(db, bound)) };
  const owners = await loadPrivateOwnerInputs(db, context);
  const ownerFingerprint = (value: typeof owners) =>
    fingerprintHash(value.map(({ intent, credential }) => ({ intent, credential: credential?.forImport() })));
  const ownerHash = ownerFingerprint(owners);
  const archive = new LibrarySourceArchive(db, context);
  const report = await archive.verify();
  if (!report.sealed) return refuse('SOURCE_ARCHIVE_NOT_SEALED');
  const descriptor = parseSourceArchiveDescriptor({
    format: 'frameleaf-source-archive',
    version: 1,
    rows: report.records,
    sha256: report.sha256,
  });
  const assertUnchanged = async (destinationSession: ImportDatabase = db) => {
    await loadReviewedImportInputs(destinationSession, bound);
    if (ownerFingerprint(await loadPrivateOwnerInputs(destinationSession, context)) !== ownerHash)
      return refuse('IMPORT_PRIVATE_OWNERS_CHANGED');
    const current = await new LibrarySourceArchive(destinationSession, context).verify();
    if (!current.sealed || current.records !== descriptor.rows || current.sha256 !== descriptor.sha256)
      return refuse('SOURCE_ARCHIVE_RECORD_CHANGED');
  };
  const records = async function* () {
    let offset = '0';
    for (;;) {
      const page = await archive.page(offset);
      if (!page.sealed) return refuse('SOURCE_ARCHIVE_NOT_SEALED');
      yield* page.records;
      if (page.next === null) break;
      if (BigInt(page.next) <= BigInt(offset)) return refuse('SOURCE_ARCHIVE_PAGE_INVALID');
      offset = page.next;
    }
    await assertUnchanged();
  };
  return { context, owners, descriptor, records, assertUnchanged };
}
