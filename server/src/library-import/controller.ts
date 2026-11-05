import { assertCanonicalDestination } from 'src/immich-import/destination-schema.js';
import { type ImportDatabase, ImportRefused } from 'src/immich-import/types.js';
import { readLibraryImportActivation, sealLibraryImportActivation } from 'src/library-import/activation-proof.js';
import { assertFreshImportDestination } from 'src/library-import/admission.js';
import { reconcileImportedAlbums } from 'src/library-import/album-reconciliation.js';
import { CanonicalAlbumWriter } from 'src/library-import/album-writer.js';
import { reconcileImportedAssets } from 'src/library-import/asset-reconciliation.js';
import { CanonicalAssetWriter } from 'src/library-import/asset-writer.js';
import {
  type ManagerLibrarySetup,
  libraryImportDerivedRunId,
  parseManagerLibrarySetup,
} from 'src/library-import/derived-work.js';
import { bindDestinationImportPlan } from 'src/library-import/destination-plan.js';
import { BundleVerificationError, verifyImportFiles } from 'src/library-import/files.js';
import { LIBRARY_IMPORT_LOCK } from 'src/library-import/lock.js';
import { parseImportManifest } from 'src/library-import/manifest.js';
import {
  CanonicalOwnerWriter,
  prepareImportedOwners,
  reconcileImportedOwners,
} from 'src/library-import/owner-reconciliation.js';
import { loadPrivateOwnerInputs, retainPrivateOwnerInputs } from 'src/library-import/private-owners.js';
import {
  type ReviewedImportContext,
  loadReviewedImportInputs,
  retainReviewedImportInputs,
} from 'src/library-import/reviewed-inputs.js';
import { LibrarySourceArchive } from 'src/library-import/source-archive.js';
import { reconcileImportedStacks } from 'src/library-import/stack-reconciliation.js';
import { CanonicalStackWriter } from 'src/library-import/stack-writer.js';
import { LibraryImportJournal, LibraryImportRefused, parseLibraryImportBinding } from 'src/library-import/state.js';
import { withLibraryImportReadback } from 'src/library-import/verification.js';
import { type JobRepository } from 'src/repositories/job.repository.js';

const refuse = (code: string): never => {
  throw new LibraryImportRefused(code);
};

/** Internal coordinator. Caller owns qualified source fencing and journalled media transfer. */
export class LibraryImportController {
  private readonly context;
  constructor(
    private readonly db: ImportDatabase,
    input: ReviewedImportContext & { manifest: unknown; plan: unknown },
  ) {
    const binding = parseLibraryImportBinding(input.binding);
    const manifest = parseImportManifest(input.manifest);
    if (manifest.version !== 3 && manifest.version !== 4 && manifest.version !== 5)
      throw new LibraryImportRefused('IMPORT_REQUIRES_SEALED_MANIFEST');
    const plan = bindDestinationImportPlan(input.plan, binding, manifest, input.destinationId);
    this.context = { binding, manifest, plan, destinationId: plan.destinationId };
  }
  private async safe<T>(body: () => Promise<T>): Promise<T> {
    try {
      return await body();
    } catch (error) {
      if (error instanceof LibraryImportRefused) throw error;
      if (error instanceof BundleVerificationError || error instanceof ImportRefused)
        throw new LibraryImportRefused(error.code);
      // Driver failures and source iterators may contain credentials or private source metadata.
      throw new LibraryImportRefused('IMPORT_CONTROLLER_UNAVAILABLE');
    }
  }
  private items() {
    const { manifest } = this.context;
    const motion = new Set(manifest.version === 5 ? manifest.livePhotos.map((pair) => pair.videoAssetId) : []);
    return manifest.assets
      .map((asset) => ({
        sourceAssetId: asset.id,
        type: asset.type,
        fileModifiedAt: asset.fileModifiedAt,
        originalFileNames: asset.originalFileNames,
      }))
      .sort((a, b) => Number(motion.has(b.sourceAssetId)) - Number(motion.has(a.sourceAssetId)));
  }
  status() {
    return this.safe(async () => {
      const status = await new LibraryImportJournal(this.db).status();
      if (status.run && JSON.stringify(status.run.binding) !== JSON.stringify(this.context.binding))
        return refuse('IMPORT_BINDING_CHANGED');
      return {
        run: status.run
          ? {
              operationId: status.run.binding.operationId,
              source: { kind: status.run.binding.source.kind, version: status.run.binding.source.version },
              status: status.run.status,
            }
          : null,
        mappings: status.mappings,
      };
    });
  }
  preflight(owners: unknown) {
    return this.safe(async () => {
      const { manifest } = this.context;
      if (manifest.losses.some((loss) => !loss.acknowledged)) return refuse('IMPORT_LOSSES_NOT_ACKNOWLEDGED');
      const preparedOwners = prepareImportedOwners(this.context, owners);
      if (new Set(preparedOwners.map(({ owner }) => owner.email)).size !== preparedOwners.length)
        return refuse('OWNER_EMAIL_COLLISION');
      const writer = new CanonicalAssetWriter(this.db, this.context);
      for (const item of this.items()) writer.prepare(item);
      if (manifest.albums.some((album) => album.members.some((member) => member.userId === album.ownerId)))
        return refuse('ALBUM_OWNER_MEMBER_CONFLICT');
      await assertCanonicalDestination(this.db);
      const status = await this.status();
      if (status.run?.status === 'activated') return refuse('IMPORT_ALREADY_ACTIVATED');
      if (status.run?.status === 'abandoned') return refuse('ABANDONED_DESTINATION_REQUIRES_FRESH_DATABASE');
      if (!status.run) await assertFreshImportDestination(this.db, { allowBootstrapAdmin: true });
      const administrators = await this.db.query(`SELECT id::text,lower(email) AS email FROM public."user"
        WHERE "isAdmin" AND status='active' AND "deletedAt" IS NULL AND NOT "importClaimPending" LIMIT 2`);
      if (administrators.length !== 1) return refuse('DESTINATION_ADMIN_REQUIRED');
      if (preparedOwners.some(({ owner }) => owner.destinationUserId === administrators[0].id))
        return refuse('OWNER_DESTINATION_COLLISION');
      if (preparedOwners.some(({ owner }) => owner.email === administrators[0].email))
        return refuse('OWNER_EMAIL_COLLISION');
      return {
        status: status.run?.status ?? 'fresh',
        owners: manifest.users.length,
        assets: manifest.assets.length,
        files: this.context.plan.files.length,
        albums: manifest.albums.length,
      };
    });
  }
  /** Retain sealed recovery inputs before the caller starts journalled media transfer. */
  prepare(owners: unknown, descriptor: unknown, records: AsyncIterable<unknown> | Iterable<unknown>) {
    return this.safe(async () => {
      const report = await this.preflight(owners);
      if (report.status !== 'fresh' && report.status !== 'copying') return refuse('IMPORT_NOT_COPYING');
      await this.retain(owners, descriptor, records);
      return this.status();
    });
  }
  private async retain(owners: unknown, descriptor: unknown, records: AsyncIterable<unknown> | Iterable<unknown>) {
    const journal = new LibraryImportJournal(this.db);
    await journal.begin(this.context.binding);
    await retainReviewedImportInputs(this.db, this.context, {
      manifest: this.context.manifest,
      plan: this.context.plan,
    });
    await retainPrivateOwnerInputs(this.db, this.context, owners);
    const archive = new LibrarySourceArchive(this.db, this.context);
    await archive.begin(descriptor);
    let offset = 0n;
    let batch: unknown[] = [];
    for await (const record of records) {
      batch.push(record);
      if (batch.length === 1000) {
        await archive.append(String(offset), batch);
        offset += BigInt(batch.length);
        batch = [];
      }
    }
    if (batch.length > 0) await archive.append(String(offset), batch);
    await archive.seal();
  }
  run(owners: unknown, descriptor: unknown, records: AsyncIterable<unknown> | Iterable<unknown>) {
    return this.copy(owners, descriptor, records, false);
  }
  resume(owners: unknown, descriptor: unknown, records: AsyncIterable<unknown> | Iterable<unknown>) {
    return this.copy(owners, descriptor, records, true);
  }
  private copy(
    owners: unknown,
    descriptor: unknown,
    records: AsyncIterable<unknown> | Iterable<unknown>,
    resume: boolean,
  ) {
    return this.safe(async () => {
      const report = await this.preflight(owners);
      if (resume && report.status === 'fresh') return refuse('NO_IMPORT_TO_RESUME');
      if (!resume && report.status !== 'fresh') return refuse('USE_RESUME_FOR_PARTIAL_IMPORT');
      if (report.status === 'verifying') {
        await loadReviewedImportInputs(this.db, this.context);
        await loadPrivateOwnerInputs(this.db, this.context);
        const archive = new LibrarySourceArchive(this.db, this.context);
        if (!(await archive.verify()).sealed) return refuse('SOURCE_ARCHIVE_NOT_SEALED');
        await retainPrivateOwnerInputs(this.db, this.context, owners);
        await archive.begin(descriptor);
        return this.status();
      }
      // Manager owns the transfer journal; canonical records never precede independent destination-byte verification.
      const identities = new Set<string>();
      for (const root of this.context.plan.roots) {
        const files = this.context.plan.files.filter((file) => file.destinationRoot === root.id);
        if (files.length > 0)
          await verifyImportFiles(
            root.path,
            files.map((file) => ({
              id: file.id,
              path: file.destinationPath,
              bytes: file.bytes,
              sha256: file.sha256,
              role: 'original',
            })),
            { device: root.device, inode: root.inode },
            identities,
          );
      }
      await this.retain(owners, descriptor, records);
      const journal = new LibraryImportJournal(this.db);
      const ownerWriter = new CanonicalOwnerWriter(this.db, this.context);
      for (const owner of await loadPrivateOwnerInputs(this.db, this.context))
        await ownerWriter.write(owner.intent, owner.credential);
      const assets = new CanonicalAssetWriter(this.db, this.context);
      for (const item of this.items()) await assets.write(item);
      const albums = new CanonicalAlbumWriter(this.db, this.context);
      for (const album of this.context.manifest.albums) await albums.write(album.id);
      const stacks = new CanonicalStackWriter(this.db, this.context);
      if ('stacks' in this.context.manifest)
        for (const stack of this.context.manifest.stacks) await stacks.write(stack.id);
      await journal.phase(this.context.binding, 'verifying');
      return this.status();
    });
  }
  verify() {
    return this.safe(async () => {
      await assertCanonicalDestination(this.db);
      return withLibraryImportReadback(this.db, async (tx) => {
        const status = await new LibraryImportJournal(tx).status();
        if (status.run && JSON.stringify(status.run.binding) !== JSON.stringify(this.context.binding))
          return refuse('IMPORT_BINDING_CHANGED');
        if (status.run?.status !== 'verifying') return refuse('IMPORT_NOT_VERIFYING');
        await loadReviewedImportInputs(tx, this.context);
        const owners = await loadPrivateOwnerInputs(tx, this.context);
        const archive = await new LibrarySourceArchive(tx, this.context).verify();
        if (!archive.sealed) return refuse('SOURCE_ARCHIVE_NOT_SEALED');
        const ownerReport = await reconcileImportedOwners(tx, this.context, owners);
        const assets = await reconcileImportedAssets(tx, this.context, this.items());
        const albums = await reconcileImportedAlbums(tx, this.context);
        const stacks = await reconcileImportedStacks(tx, this.context);
        return {
          format: 'frameleaf-library-import-verification' as const,
          version: 1 as const,
          operationId: this.context.binding.operationId,
          manifestSha256: this.context.binding.manifestSha256,
          planSha256: this.context.binding.planSha256,
          owners: ownerReport,
          assets,
          albums,
          stacks,
          archive,
        };
      });
    });
  }
  private async activation(db: ImportDatabase, manager: ManagerLibrarySetup | undefined) {
    const [row] = await db.query(
      'SELECT binding,status,activation,activation_sha256 FROM public.frameleaf_library_import',
    );
    if (!row) return refuse('IMPORT_JOURNAL_MISSING');
    if (JSON.stringify(parseLibraryImportBinding(row.binding)) !== JSON.stringify(this.context.binding))
      return refuse('IMPORT_BINDING_CHANGED');
    if (row.status !== 'activated') {
      if (row.status !== 'verifying') return refuse('IMPORT_NOT_VERIFYING');
      return null;
    }
    if (typeof row.activation_sha256 !== 'string') return refuse('IMPORT_ACTIVATION_PROOF_INVALID');
    const proof = readLibraryImportActivation({ payload: row.activation, sha256: row.activation_sha256 }, this.context);
    if (JSON.stringify(proof.manager) !== JSON.stringify(manager ?? null))
      return refuse('DERIVED_MANAGER_SETUP_IDENTITY_MISMATCH');
    return { runId: proof.runId, activatedAt: proof.activatedAt, report: proof.report, sha256: row.activation_sha256 };
  }
  /**
   * Caller keeps source writers fenced and verifies transfer completion; the hook rechecks the frozen source.
   * Retained destination archive checks use the supplied owning session to keep the activation fence.
   * Retained activation never revisits the source or re-holds completed work.
   */
  activate(
    jobs: JobRepository,
    assertSourceUnchanged: (destinationSession: ImportDatabase) => Promise<void>,
    managerInput?: ManagerLibrarySetup,
  ) {
    return this.safe(async () => {
      const manager = parseManagerLibrarySetup(managerInput, this.context.binding);
      const retained = await this.activation(this.db, manager);
      if (retained) return retained;
      if (!this.db.withSession) return refuse('IMPORT_SESSION_REQUIRED');
      // Dispatch takes this lock on its own connection; finish the source-check session first.
      const concurrentActivation = await this.db.withSession(async (session) => {
        const [lock] = await session.query('SELECT pg_try_advisory_lock($1::bigint) AS acquired', [
          LIBRARY_IMPORT_LOCK,
        ]);
        if (!lock?.acquired) return refuse('IMPORT_ALREADY_RUNNING');
        const retained = await this.activation(session, manager);
        if (!retained) await assertSourceUnchanged(session);
        return retained;
      });
      if (concurrentActivation) return concurrentActivation;
      const runId = libraryImportDerivedRunId(this.context.binding);
      if ((await jobs.dispatchImportedLibraryWork(this.context, manager)) !== runId)
        return refuse('DERIVED_RUN_IDENTITY_MISMATCH');
      return this.db.withSession(async (session) => {
        const [lock] = await session.query('SELECT pg_try_advisory_lock($1::bigint) AS acquired', [
          LIBRARY_IMPORT_LOCK,
        ]);
        if (!lock?.acquired) return refuse('IMPORT_ALREADY_RUNNING');
        const retained = await this.activation(session, manager);
        if (retained) return retained;
        const report = await new LibraryImportController(session, this.context).verify();
        await assertSourceUnchanged(session);
        return session.transaction(async (tx) => {
          if ((await jobs.validateImportedLibraryWork(tx, this.context, manager)) !== runId)
            return refuse('DERIVED_RUN_IDENTITY_MISMATCH');
          const sealed = sealLibraryImportActivation(this.context, report, manager, new Date().toISOString());
          const updated = await tx.query(
            `UPDATE public.frameleaf_library_import SET status='activated',activation=$1::text::jsonb,
              activation_sha256=$2,updated_at=now()
             WHERE status='verifying' AND operation_id=$3::uuid AND binding=$4::text::jsonb
               AND activation IS NULL AND activation_sha256 IS NULL RETURNING operation_id`,
            [
              JSON.stringify(sealed.payload),
              sealed.sha256,
              this.context.binding.operationId,
              JSON.stringify(this.context.binding),
            ],
          );
          if (updated.length !== 1) return refuse('IMPORT_ACTIVATION_CHANGED');
          if (!manager)
            await tx.query(`UPDATE job_selection SET state='ready' WHERE "runId"=$1::uuid AND state='enumerating'`, [
              runId,
            ]);
          return {
            runId,
            activatedAt: sealed.payload.activatedAt,
            report: sealed.payload.report,
            sha256: sealed.sha256,
          };
        });
      });
    });
  }
  abandon() {
    return this.safe(async () => {
      await new LibraryImportJournal(this.db).phase(this.context.binding, 'abandoned');
      return this.status();
    });
  }
}
