import { StorageCore } from 'src/cores/storage.core.js';
import { StorageFolder } from 'src/enum.js';
import { basename, join } from 'node:path';
import { journalOwnsPath, type ReleasingPublicationRole } from 'src/utils/studio-import-reference-roles.js';
import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { type Kysely, type Transaction, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { countPathReferences, lockFilePath } from 'src/repositories/physical-file.repository.js';
import {
  type StudioProjectImport,
  lockStudioImportProject,
  insertStudioImport,
  readStudioImport,
} from 'src/repositories/studio-project.repository.js';
import { assertStudioStorageAdmission } from 'src/repositories/studio-storage-admission.js';
import type { DB } from 'src/schema/index.js';
import { canonicalJson } from 'src/utils/object.js';
import { RetainedProcessingProvenanceSchema, sameProvenance } from 'src/utils/studio-import-provenance.js';
import type {
  CancelResult,
  ImportDeclaration,
  JournalPort,
  PreparedImport,
  PrepareResult,
  PublicationKey,
  PublicationReceipt,
  PublicationState,
  ReceiptPage,
} from 'src/utils/studio-import-publication.js';
import { STUDIO_IMPORT_MAX_BYTES, STUDIO_IMPORT_MAX_PER_PROJECT, studioImportKind } from 'src/utils/studio-imports.js';
import { isStudioUuid } from 'src/utils/studio-resources.js';

type Journal = {
  id: string;
  ownerId: string;
  projectId: string;
  importId: string;
  state: PublicationState;
  createdAt: Date;
  expiresAt: Date;
  stagedPath: string | null;
  targetPath: string | null;
  declaration: ImportDeclaration | null;
  stagedIdentity: PreparedImport['identity'] | null;
  cursorCreatedAt?: string;
};
const states = new Set<PublicationState>(['registered', 'preparing', 'published', 'aborted']);
const fileOf = (row: Journal): PreparedImport | null => {
  if (row.stagedPath === null && row.targetPath === null && row.declaration === null && row.stagedIdentity === null)
    return null;
  if (!row.stagedPath || !row.targetPath || !row.declaration || !row.stagedIdentity)
    throw new ConflictException('publication_file_evidence_incomplete');
  return {
    stagedPath: row.stagedPath,
    targetPath: row.targetPath,
    declaration: row.declaration,
    identity: row.stagedIdentity,
  };
};
const validateKey = (key: PublicationKey): PublicationKey => {
  if ([key.ownerId, key.projectId, key.importId, key.publicationId].some((id) => !isStudioUuid(id)))
    throw new BadRequestException('invalid_publication_key');
  return {
    ownerId: key.ownerId.toLowerCase(),
    projectId: key.projectId.toLowerCase(),
    importId: key.importId.toLowerCase(),
    publicationId: key.publicationId.toLowerCase(),
  };
};
const validateFile = (file: PreparedImport) => {
  const declaration = file.declaration;
  if (
    [file.stagedPath, file.targetPath].some(
      (path) => !isAbsolute(path) || resolve(path) !== path || path.includes('\0'),
    ) ||
    file.stagedPath === file.targetPath ||
    !/^\.[a-zA-Z0-9]+$/.test(declaration.extension) ||
    !/^[a-z]+\/[\w.+-]+$/.test(declaration.contentType) ||
    !/^[a-f0-9]{64}$/.test(declaration.checksum) ||
    !Number.isSafeInteger(declaration.sizeBytes) ||
    declaration.sizeBytes < 1 ||
    declaration.sizeBytes > STUDIO_IMPORT_MAX_BYTES ||
    declaration.sizeBytes !== file.identity.size ||
    !/^\d+$/.test(file.identity.dev) ||
    !/^\d+$/.test(file.identity.ino) ||
    typeof declaration.fileName !== 'string' ||
    !declaration.fileName ||
    declaration.fileName.length > 255 ||
    (declaration.externalReferences !== null &&
      (!Number.isSafeInteger(declaration.externalReferences) || declaration.externalReferences < 0))
  )
    throw new BadRequestException('invalid_publication_file');
  if (declaration.processingProvenance !== null) {
    RetainedProcessingProvenanceSchema.parse(declaration.processingProvenance);
    if (
      Buffer.byteLength(JSON.stringify(declaration.processingProvenance), 'utf8') > 4096 ||
      declaration.processingProvenance.outputSha256 !== declaration.checksum
    )
      throw new BadRequestException('invalid_publication_provenance');
  }
};
const absent = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

/** Read-only evidence check. Qualified namespace/barrier authority remains with the FilePort callback. */
const verifyBytes = async (path: string, declaration: ImportDeclaration, identity?: PreparedImport['identity']) => {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink < 1n ||
      (identity && before.nlink > 2n) ||
      Number(before.size) !== declaration.sizeBytes ||
      (identity &&
        (String(before.dev) !== identity.dev ||
          String(before.ino) !== identity.ino ||
          Number(before.size) !== identity.size))
    )
      throw new ConflictException('publication_identity_changed');
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    const after = await handle.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    if (
      hash.digest('hex') !== declaration.checksum ||
      !current.isFile() ||
      [after, current].some(
        (stat) =>
          stat.dev !== before.dev ||
          stat.ino !== before.ino ||
          stat.size !== before.size ||
          stat.mtimeNs !== before.mtimeNs ||
          stat.ctimeNs !== before.ctimeNs ||
          stat.nlink !== before.nlink,
      )
    )
      throw new ConflictException('publication_identity_changed');
  } finally {
    await handle.close();
  }
};
const verifyReady = async (item: StudioProjectImport) => {
  try {
    await verifyBytes(item.path, { ...item, extension: '', processingProvenance: item.processingProvenance ?? null });
  } catch (error) {
    if (absent(error)) throw new ConflictException('studio_import_repair_required', { cause: error });
    throw error;
  }
};
const matchesReady = (
  item: StudioProjectImport,
  key: PublicationKey,
  declaration: ImportDeclaration,
  omitted: boolean,
) => {
  if (
    item.ownerId !== key.ownerId ||
    item.projectId !== key.projectId ||
    item.id !== key.importId ||
    item.checksum !== declaration.checksum ||
    item.sizeBytes !== declaration.sizeBytes ||
    item.contentType !== declaration.contentType
  )
    throw new ConflictException('publication_ready_conflict');
  if (
    !(omitted && declaration.processingProvenance === null) &&
    !sameProvenance(item.processingProvenance ?? null, declaration.processingProvenance)
  )
    throw new ConflictException('provenance_conflict');
};
const lockPaths = async (tx: Transaction<DB>, paths: string[]) => {
  for (const path of [...new Set(paths)].sort()) await lockFilePath(tx, path);
};
const cursorFor = (ownerId: string, projectId: string, state: PublicationState | undefined, row: Journal) =>
  Buffer.from(
    JSON.stringify({
      ownerId,
      projectId,
      state: state ?? null,
      at: row.cursorCreatedAt ?? row.createdAt.toISOString(),
      id: row.id,
    }),
  ).toString('base64url');
const parseCursor = (cursor: string | undefined, ownerId: string, projectId: string, state?: PublicationState) => {
  if (cursor === undefined) return null;
  try {
    if (!cursor || cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
    const bytes = Buffer.from(cursor, 'base64url');
    if (bytes.toString('base64url') !== cursor) throw new Error();
    const value = JSON.parse(bytes.toString('utf8'));
    if (
      !value ||
      Object.keys(value).sort().join(',') !== 'at,id,ownerId,projectId,state' ||
      value.ownerId !== ownerId ||
      value.projectId !== projectId ||
      value.state !== (state ?? null) ||
      !isStudioUuid(value.id) ||
      typeof value.at !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value.at) ||
      new Date(value.at).toISOString() !== value.at.replace(/(\.\d{3})\d{3}Z$/, '$1Z')
    )
      throw new Error();
    return { at: value.at as string, id: value.id as string };
  } catch {
    throw new BadRequestException('invalid_publication_cursor');
  }
};

/** Durable intent transactions. FilePort must establish qualified durability before acknowledging callbacks. */
@Injectable()
export class StudioImportPublicationRepository implements JournalPort {
  constructor(@InjectKysely() private readonly db: Kysely<DB>) {}

  private async lock(tx: Transaction<DB>, key: PublicationKey) {
    validateKey(key);
    // Shared with import/restore/purge writers, before the exact receipt or import row.
    const project = await lockStudioImportProject(tx, key.projectId);
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`studio-publication:${key.publicationId}`},0))`.execute(
      tx,
    );
    const { rows } = await sql<Journal>`SELECT * FROM public.studio_import_publication
      WHERE id=${key.publicationId}::uuid FOR UPDATE`.execute(tx);
    const row = rows[0];
    if (row && (row.ownerId !== key.ownerId || row.projectId !== key.projectId || row.importId !== key.importId))
      throw new ConflictException('publication_binding_conflict');
    if (project && project.ownerId !== key.ownerId) throw new ConflictException('publication_owner_unavailable');
    return { project, row };
  }
  private requireProject(
    project: Awaited<ReturnType<typeof lockStudioImportProject>>,
    key: PublicationKey,
    editable: boolean,
  ) {
    if (
      !project ||
      project.ownerId !== key.ownerId ||
      project.ownerDeletedAt ||
      (editable && (project.deletedAt || project.archivedAt))
    )
      throw new ConflictException('publication_owner_project_unavailable');
  }
  private async create(tx: Transaction<DB>, key: PublicationKey, state: 'registered' | 'aborted'): Promise<Journal> {
    const { rows } = await sql<Journal>`WITH stamp AS (SELECT clock_timestamp() AS at)
      INSERT INTO public.studio_import_publication (id,"ownerId","projectId","importId",state,"createdAt","expiresAt")
      SELECT ${key.publicationId}::uuid,${key.ownerId}::uuid,${key.projectId}::uuid,${key.importId}::uuid,${state},at,at+interval '6 hours'
      FROM stamp RETURNING *`.execute(tx);
    return rows[0];
  }
  private async state(tx: Transaction<DB>, row: Journal, state: PublicationState): Promise<Journal> {
    const { rows } = await sql<Journal>`UPDATE public.studio_import_publication SET state=${state}
      WHERE id=${row.id}::uuid RETURNING *`.execute(tx);
    return rows[0];
  }
  private async receipt(tx: Transaction<DB>, row: Journal): Promise<PublicationReceipt> {
    const result: PublicationReceipt = {
      publicationId: row.id,
      importId: row.importId,
      state: row.state,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      cleanupPending: fileOf(row) !== null,
    };
    if (row.state === 'published') {
      const imported = await readStudioImport(tx, row.projectId, row.importId);
      if (imported && imported.ownerId === row.ownerId)
        result.imported = {
          id: imported.id,
          contentType: imported.contentType,
          checksum: imported.checksum,
          sizeBytes: imported.sizeBytes,
          fileName: imported.fileName,
          externalReferences: imported.externalReferences,
          processingProvenance: imported.processingProvenance ?? null,
          createdAt: new Date(imported.createdAt).toISOString(),
          kind: studioImportKind(imported.contentType),
        };
    }
    return result;
  }
  private async expired(tx: Transaction<DB>, row: Journal) {
    const { rows } = await sql<{
      expired: boolean;
    }>`SELECT ${row.expiresAt}::timestamptz <= clock_timestamp() AS expired`.execute(tx);
    return rows[0].expired;
  }
  private async references(tx: Transaction<DB>, path: string, ownRole: number | ReleasingPublicationRole = 0) {
    const { rows } = await sql<{
      count: number;
    }>`SELECT count(*)::int AS count FROM public.physical_file WHERE path=${path}`.execute(tx);
    if (
      (await countPathReferences(tx, path, undefined, typeof ownRole === 'number' ? undefined : ownRole)) -
        (typeof ownRole === 'number' ? ownRole : 0) +
        rows[0].count >
      0
    )
      throw new ConflictException('publication_path_referenced');
  }
  private async discard(
    tx: Transaction<DB>,
    incoming: PreparedImport,
    original: PreparedImport | null,
    discardDuplicate: (file: PreparedImport) => Promise<void>,
  ) {
    if (original?.stagedPath === incoming.stagedPath) {
      if (canonicalJson(original.identity) !== canonicalJson(incoming.identity))
        throw new ConflictException('publication_identity_changed');
      return;
    }
    if (original?.targetPath === incoming.stagedPath) throw new ConflictException('publication_scratch_not_exclusive');
    await this.references(tx, incoming.stagedPath);
    const stat = await lstat(incoming.stagedPath, { bigint: true });
    if (stat.nlink !== 1n) throw new ConflictException('publication_scratch_not_exclusive');
    await verifyBytes(incoming.stagedPath, incoming.declaration, incoming.identity);
    await discardDuplicate(incoming);
  }

  async register(key: PublicationKey): Promise<PublicationReceipt> {
    key = validateKey(key);
    return this.db.transaction().execute(async (tx) => {
      const { project, row } = await this.lock(tx, key);
      if (row?.state === 'aborted') throw new ConflictException('publication_aborted');
      this.requireProject(project, key, true);
      await assertStudioStorageAdmission(tx, key.ownerId, 0);
      return this.receipt(tx, row ?? (await this.create(tx, key, 'registered')));
    });
  }
  async get(key: PublicationKey): Promise<PublicationReceipt | null> {
    key = validateKey(key);
    return this.db.transaction().execute(async (tx) => {
      const { project, row } = await this.lock(tx, key);
      this.requireProject(project, key, false);
      await assertStudioStorageAdmission(tx, key.ownerId, 0);
      return row ? this.receipt(tx, row) : null;
    });
  }
  async discover(ownerId: string, projectId: string, cursor?: string, state?: PublicationState): Promise<ReceiptPage> {
    if (!isStudioUuid(ownerId) || !isStudioUuid(projectId) || (state !== undefined && !states.has(state)))
      throw new BadRequestException('invalid_publication_discovery');
    ownerId = ownerId.toLowerCase();
    projectId = projectId.toLowerCase();
    const after = parseCursor(cursor, ownerId, projectId, state);
    return this.db.transaction().execute(async (tx) => {
      const project = await lockStudioImportProject(tx, projectId);
      this.requireProject(project, { ownerId, projectId, importId: '', publicationId: '' }, false);
      const { rows } = await sql<Journal>`SELECT *,
        to_char("createdAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorCreatedAt"
        FROM public.studio_import_publication
        WHERE "ownerId"=${ownerId}::uuid AND "projectId"=${projectId}::uuid
        ${state ? sql`AND state=${state}` : sql``}
        ${after ? sql`AND ("createdAt",id)>(${after.at}::timestamptz,${after.id}::uuid)` : sql``}
        ORDER BY "createdAt",id LIMIT 101 FOR UPDATE`.execute(tx);
      await assertStudioStorageAdmission(tx, ownerId, 0);
      const page = rows.slice(0, 100),
        items: PublicationReceipt[] = [];
      for (const row of page) items.push(await this.receipt(tx, row));
      return { items, nextCursor: rows.length > 100 ? cursorFor(ownerId, projectId, state, page[99]) : null };
    });
  }

  /** Exact owner/project lookup supplies the immutable import binding, then reuses the locked get gate. */
  async getByPublication(
    ownerId: string,
    projectId: string,
    publicationId: string,
  ): Promise<PublicationReceipt | null> {
    if ([ownerId, projectId, publicationId].some((id) => !isStudioUuid(id)))
      throw new BadRequestException('invalid_publication_id');
    const { rows } = await sql<{ importId: string }>`SELECT "importId" FROM public.studio_import_publication
      WHERE id=${publicationId.toLowerCase()}::uuid AND "ownerId"=${ownerId.toLowerCase()}::uuid AND "projectId"=${projectId.toLowerCase()}::uuid`.execute(
      this.db,
    );
    return rows[0] ? this.get({ ownerId, projectId, publicationId, importId: rows[0].importId }) : null;
  }
  async prepare(
    key: PublicationKey,
    file: PreparedImport,
    discardDuplicate: (file: PreparedImport) => Promise<void>,
    reservationId?: string,
  ): Promise<PrepareResult> {
    key = validateKey(key);
    validateFile(file);
    if (reservationId !== undefined && !isStudioUuid(reservationId))
      throw new BadRequestException('invalid_upload_reservation');
    const result = await this.db.transaction().execute(async (tx): Promise<PrepareResult | 'expired'> => {
      const { project, row } = await this.lock(tx, key);
      if (!row) throw new ConflictException('publication_registration_required');
      if (row.state === 'aborted') throw new ConflictException('publication_aborted');
      this.requireProject(project, key, true);
      const original = fileOf(row);
      const ready = await readStudioImport(tx, key.projectId, key.importId, true);
      await lockPaths(tx, [
        file.stagedPath,
        file.targetPath,
        ...(original ? [original.stagedPath, original.targetPath] : []),
        ...(ready ? [ready.path] : []),
      ]);
      await assertStudioStorageAdmission(tx, key.ownerId, 0);
      if (reservationId) {
        const { rows: uploads } = await sql<{ path: string; sizeBytes: string; digest: string; current: boolean }>`
          SELECT path,"sizeBytes",digest,"expiresAt">clock_timestamp() AS current FROM public.studio_bundle_upload
          WHERE id=${reservationId}::uuid AND "ownerId"=${key.ownerId}::uuid FOR UPDATE`.execute(tx);
        const upload = uploads[0];
        if (upload) {
          if (
            upload.path !== file.stagedPath ||
            Number(upload.sizeBytes) < file.declaration.sizeBytes ||
            upload.digest !== '' ||
            !upload.current
          )
            throw new ConflictException('publication_reservation_conflict');
        } else {
          const { rows: existing } = await sql`SELECT id FROM public.studio_bundle_upload
            WHERE id=${reservationId}::uuid`.execute(tx);
          if (
            existing.length ||
            !original ||
            original.stagedPath !== file.stagedPath ||
            canonicalJson(original.identity) !== canonicalJson(file.identity)
          )
            throw new ConflictException('publication_reservation_conflict');
        }
      }
      // Exclusion and consumption share the owner lock/transaction; expiry keeps request ownership.
      const admission = { excludeUploadId: reservationId };
      const consumeReservation = async () => {
        if (reservationId)
          await sql`DELETE FROM public.studio_bundle_upload
          WHERE id=${reservationId}::uuid AND "ownerId"=${key.ownerId}::uuid`.execute(tx);
      };
      if (ready) {
        matchesReady(ready, key, file.declaration, true);
        if (original && ready.path !== original.targetPath) throw new ConflictException('publication_ready_conflict');
        await verifyReady(ready);
        await assertStudioStorageAdmission(tx, key.ownerId, 0, undefined, admission);
        await this.discard(tx, file, original, discardDuplicate);
        if (row.state !== 'published') await this.state(tx, row, 'published');
        await consumeReservation();
        return { status: 'ready', imported: ready };
      }
      if (row.state === 'published') throw new ConflictException('studio_import_repair_required');
      // Full declaration equality applies to preparing retries; ready rows retain their stored labels/lineage.
      if (original && canonicalJson(original.declaration) !== canonicalJson(file.declaration))
        throw new ConflictException('publication_declaration_conflict');
      if (await this.expired(tx, row)) {
        await this.state(tx, row, 'aborted');
        return 'expired';
      }
      if (original) {
        await assertStudioStorageAdmission(tx, key.ownerId, 0, undefined, admission);
        await verifyBytes(original.stagedPath, original.declaration, original.identity);
        await this.discard(tx, file, original, discardDuplicate);
        if (await this.expired(tx, row)) {
          await this.state(tx, row, 'aborted');
          return 'expired';
        }
        await consumeReservation();
        return { status: 'prepared', file: original };
      }
      const { rows: busy } =
        await sql`SELECT id FROM public.studio_import_publication WHERE "projectId"=${key.projectId}::uuid
        AND "importId"=${key.importId}::uuid AND ("stagedPath" IS NOT NULL OR "targetPath" IS NOT NULL)`.execute(tx);
      if (busy.length) throw new ConflictException('publication_busy');
      await this.references(tx, file.stagedPath);
      await this.references(tx, file.targetPath);
      await verifyBytes(file.stagedPath, file.declaration, file.identity);
      if ((await lstat(file.stagedPath, { bigint: true })).nlink !== 1n)
        throw new ConflictException('publication_stage_not_exclusive');
      await assertStudioStorageAdmission(tx, key.ownerId, file.declaration.sizeBytes, undefined, admission);
      const { rows: counts } = await sql<{ count: number }>`SELECT
        ((SELECT count(*) FROM public.studio_project_import WHERE "projectId"=${key.projectId}::uuid)+
        (SELECT count(*) FROM public.studio_import_publication WHERE "projectId"=${key.projectId}::uuid AND state='preparing'))::int AS count`.execute(
        tx,
      );
      if (counts[0].count >= STUDIO_IMPORT_MAX_PER_PROJECT)
        throw new BadRequestException('The project has too many imports');
      if (await this.expired(tx, row)) {
        await this.state(tx, row, 'aborted');
        return 'expired';
      }
      await sql`UPDATE public.studio_import_publication SET state='preparing',"stagedPath"=${file.stagedPath},"targetPath"=${file.targetPath},
        declaration=${JSON.stringify(file.declaration)}::text::jsonb,"stagedIdentity"=${JSON.stringify(file.identity)}::text::jsonb
        WHERE id=${row.id}::uuid`.execute(tx);
      await consumeReservation();
      return { status: 'prepared', file };
    });
    if (result === 'expired') throw new ConflictException('publication_expired');
    return result;
  }
  async publish(
    key: PublicationKey,
    linkAndSync: (file: PreparedImport) => Promise<void>,
  ): Promise<StudioProjectImport> {
    key = validateKey(key);
    const result = await this.db.transaction().execute(async (tx): Promise<StudioProjectImport | 'expired'> => {
      const { project, row } = await this.lock(tx, key);
      if (!row) throw new ConflictException('publication_registration_required');
      if (row.state === 'aborted') throw new ConflictException('publication_aborted');
      this.requireProject(project, key, true);
      const file = fileOf(row),
        ready = await readStudioImport(tx, key.projectId, key.importId, true);
      await lockPaths(tx, [...(file ? [file.stagedPath, file.targetPath] : []), ...(ready ? [ready.path] : [])]);
      if (ready) {
        if (file) {
          matchesReady(ready, key, file.declaration, false);
          if (ready.path !== file.targetPath) throw new ConflictException('publication_ready_conflict');
        } else if (row.state !== 'published') throw new ConflictException('publication_not_prepared');
        await verifyReady(ready);
        await assertStudioStorageAdmission(tx, key.ownerId, 0, undefined, {
          excludePublicationId: row.id,
          checkExisting: true,
        });
        if (row.state !== 'published') await this.state(tx, row, 'published');
        return ready;
      }
      if (row.state === 'published') throw new ConflictException('studio_import_repair_required');
      if (await this.expired(tx, row)) {
        await this.state(tx, row, 'aborted');
        return 'expired';
      }
      if (row.state !== 'preparing' || !file) throw new ConflictException('publication_not_prepared');
      await this.references(tx, file.stagedPath, 1);
      await this.references(tx, file.targetPath, 1);
      await verifyBytes(file.stagedPath, file.declaration, file.identity);
      try {
        const target = await lstat(file.targetPath, { bigint: true });
        if (!target.isFile() || String(target.dev) !== file.identity.dev || String(target.ino) !== file.identity.ino)
          throw Object.assign(new ConflictException('publication_target_exists'), { code: 'EEXIST' });
        await verifyBytes(file.targetPath, file.declaration, file.identity);
      } catch (error) {
        if (!absent(error)) throw error;
      }
      await assertStudioStorageAdmission(tx, key.ownerId, file.declaration.sizeBytes, undefined, {
        excludePublicationId: row.id,
      });
      await linkAndSync(file);
      await verifyBytes(file.stagedPath, file.declaration, file.identity);
      await verifyBytes(file.targetPath, file.declaration, file.identity);
      if (await this.expired(tx, row)) {
        await this.state(tx, row, 'aborted');
        return 'expired';
      }
      const imported = await insertStudioImport(
        tx,
        {
          ...file.declaration,
          ownerId: key.ownerId,
          projectId: key.projectId,
          id: key.importId,
          path: file.targetPath,
        },
        row.id,
      );
      await this.state(tx, row, 'published');
      return imported;
    });
    if (result === 'expired') throw new ConflictException('publication_expired');
    return result;
  }
  async cancel(key: PublicationKey): Promise<CancelResult> {
    key = validateKey(key);
    return this.db.transaction().execute(async (tx) => {
      const { project, row } = await this.lock(tx, key);
      // Existing terminal cleanup bindings survive deletion; they do not authorize a new publication.
      if (!row) this.requireProject(project, key, true);
      else if (project) this.requireProject(project, key, false);
      let current = row;
      const file = current ? fileOf(current) : null;
      const ready = await readStudioImport(tx, key.projectId, key.importId, true);
      await lockPaths(tx, [...(file ? [file.stagedPath, file.targetPath] : []), ...(ready ? [ready.path] : [])]);
      if (project) await assertStudioStorageAdmission(tx, key.ownerId, 0);
      else await tx.selectFrom('user').select('id').where('id', '=', key.ownerId).forUpdate().execute();
      if (current?.state === 'published')
        return { status: 'already-published', receipt: await this.receipt(tx, current) };
      if (current?.state === 'preparing' && file && ready) {
        matchesReady(ready, key, file.declaration, false);
        if (ready.path !== file.targetPath) throw new ConflictException('publication_ready_conflict');
        await verifyReady(ready);
        current = await this.state(tx, current, 'published');
        return { status: 'already-published', receipt: await this.receipt(tx, current) };
      }
      current = current
        ? current.state === 'aborted'
          ? current
          : await this.state(tx, current, 'aborted')
        : await this.create(tx, key, 'aborted');
      return { status: 'cancelled', receipt: await this.receipt(tx, current) };
    });
  }

  /** Internal bounded scan; release rechecks every candidate under project/path/Buddy/owner locks. */
  async listRecovery(limit = 200, after?: string): Promise<PublicationKey[]> {
    if (after !== undefined && !isStudioUuid(after)) throw new BadRequestException('invalid_recovery_cursor');
    const { rows } =
      await sql<PublicationKey>`SELECT journal."ownerId",journal."projectId",journal."importId",journal.id AS "publicationId"
      FROM public.studio_import_publication journal
      LEFT JOIN public.studio_project project ON project.id=journal."projectId"
      LEFT JOIN public."user" owner ON owner.id=journal."ownerId"
      WHERE ((journal.state IN ('registered','preparing') AND
        (journal."expiresAt"<=clock_timestamp() OR project.id IS NULL OR project."deletedAt" IS NOT NULL
          OR owner.id IS NULL OR owner."deletedAt" IS NOT NULL))
        OR (journal.state IN ('published','aborted') AND journal."stagedPath" IS NOT NULL))
        AND (${after ?? null}::uuid IS NULL OR journal.id>${after ?? null}::uuid)
      ORDER BY journal.id LIMIT ${Math.max(1, Math.min(500, limit))}`.execute(this.db);
    return rows;
  }

  /** Request TTL cleanup cannot race a journal transition or an authenticated reservation admission. */
  async cleanupIncoming(
    ownerId: string,
    path: string,
    cutoff: Date,
    removeExact: (identity: string | null) => Promise<void>,
  ): Promise<boolean> {
    const name = basename(path);
    if (
      !isStudioUuid(ownerId) ||
      !name.endsWith('.upload') ||
      !isStudioUuid(name.slice(0, -7)) ||
      path !== join(StorageCore.getBaseFolder(StorageFolder.Exports), ownerId, 'studio-imports', 'incoming', name)
    )
      throw new BadRequestException('invalid_publication_stage');
    return this.db.transaction().execute(async (tx) => {
      await lockFilePath(tx, path);
      await tx.selectFrom('user').select('id').where('id', '=', ownerId).forUpdate().execute();
      const { rows: reservations } = await sql<{ id: string; ownerId: string; digest: string; expired: boolean }>`
        SELECT id,"ownerId",digest,"expiresAt"<=clock_timestamp() AS expired
        FROM public.studio_bundle_upload WHERE path=${path} FOR UPDATE`.execute(tx);
      if (reservations.some((row) => row.ownerId !== ownerId || row.digest !== '' || !row.expired)) return false;
      await this.references(tx, path);
      let identity: string | null = null;
      try {
        const stat = await lstat(path, { bigint: true });
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n)
          throw new ConflictException('publication_identity_changed');
        if (stat.mtimeMs >= BigInt(cutoff.getTime())) return false;
        identity = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
      } catch (error) {
        if (!absent(error)) throw error;
      }
      await removeExact(identity);
      try {
        await lstat(path);
        throw new ConflictException('publication_cleanup_incomplete');
      } catch (error) {
        if (!absent(error)) throw error;
      }
      for (const reservation of reservations)
        await tx
          .deleteFrom('studio_bundle_upload')
          .where('id', '=', reservation.id)
          .where('ownerId', '=', ownerId)
          .execute();
      return true;
    });
  }

  /** Commit expiry separately so a pin, unavailable mount or cleanup failure cannot undo abortion. */
  private async expireForRecovery(key: PublicationKey): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      const { project, row } = await this.lock(tx, key);
      if (!row || (row.state !== 'registered' && row.state !== 'preparing')) return;
      const file = fileOf(row);
      await lockPaths(tx, file ? [file.stagedPath, file.targetPath] : []);
      await tx.selectFrom('user').select('id').where('id', '=', key.ownerId).forUpdate().execute();
      if (!project || project.deletedAt || project.ownerDeletedAt || (await this.expired(tx, row)))
        await this.state(tx, row, 'aborted');
    });
  }

  async release(
    key: PublicationKey,
    removeAndSync: (file: PreparedImport, role: 'stage' | 'aborted') => Promise<void>,
  ): Promise<void> {
    key = validateKey(key);
    await this.expireForRecovery(key);
    await this.db.transaction().execute(async (tx) => {
      const { row } = await this.lock(tx, key);
      if (!row) throw new ConflictException('publication_registration_required');
      const file = fileOf(row);
      const ready = await readStudioImport(tx, key.projectId, key.importId, true);
      await lockPaths(tx, [...(file ? [file.stagedPath, file.targetPath] : []), ...(ready ? [ready.path] : [])]);
      await tx.selectFrom('user').select('id').where('id', '=', key.ownerId).forUpdate().execute();
      const current = row;
      if (!file) return;
      if (current.state !== 'aborted' && current.state !== 'published')
        throw new ConflictException('publication_cleanup_not_terminal');
      if (current.state === 'published') {
        if (!ready) throw new ConflictException('studio_import_repair_required');
        matchesReady(ready, key, file.declaration, false);
        if (ready.path !== file.targetPath) throw new ConflictException('publication_ready_conflict');
        await verifyReady(ready);
      }
      const paths = current.state === 'published' ? [file.stagedPath] : [file.stagedPath, file.targetPath];
      for (const path of paths) {
        if (
          !journalOwnsPath(
            { ...key, state: current.state, createdAt: current.createdAt, expiresAt: current.expiresAt, file },
            path,
          )
        )
          throw new ConflictException('publication_cleanup_role_invalid');
        await this.references(tx, path, {
          publicationId: current.id,
          role: path === file.stagedPath ? 'stage' : 'target',
        });
        try {
          await verifyBytes(path, file.declaration, file.identity);
        } catch (error) {
          if (!absent(error)) throw error;
        }
      }
      // Cleanup authority is the exact retained binding, even when its project/account no longer exists.
      await removeAndSync(file, current.state === 'published' ? 'stage' : 'aborted');
      for (const path of paths) {
        try {
          await lstat(path);
        } catch (error) {
          if (absent(error)) continue;
          throw error;
        }
        throw new ConflictException('publication_cleanup_incomplete');
      }
      if (current.state === 'published') await verifyReady(ready!);
      await sql`UPDATE public.studio_import_publication SET "stagedPath"=NULL,"targetPath"=NULL,declaration=NULL,"stagedIdentity"=NULL
        WHERE id=${row.id}::uuid`.execute(tx);
    });
  }
}
