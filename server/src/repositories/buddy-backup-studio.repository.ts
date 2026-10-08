import { type Kysely, type Transaction, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { DB } from 'src/schema/index.js';
import type { BuddyManifest } from 'src/services/buddy-backup-capture.service.js';
import type { CloudBackupManifestFile } from 'src/utils/cloud-backup.js';
import { AssetLockReason, MediaOperationKind, MediaOperationStatus, StudioExportScope } from 'src/enum.js';
import { DerivativePrivacyRepository } from 'src/repositories/derivative-privacy.repository.js';
import { lockFilePath } from 'src/repositories/physical-file.repository.js';
import {
  type BuddyStudioProject,
  type BuddyStudioSnapshot,
  buddyStudioAssetIds,
  buddyStudioCommentSchema,
  buddyStudioExportSchema,
  buddyStudioGeneratedSchema,
  buddyStudioImportSchema,
  buddyStudioPaths,
  buddyStudioProjectSchema,
  buddyStudioRevisionSchema,
  buddyStudioSourceSchema,
  readBuddyStudioProject,
  validateBuddyStudioImport,
} from 'src/utils/buddy-backup-studio.js';
import {
  satisfiesDerivativePrivacy,
  strongestLockReason,
  unionDerivativePrivacy,
} from 'src/utils/derivative-privacy.js';
import { canonicalJson } from 'src/utils/object.js';
import { STUDIO_IMPORT_MAX_PER_PROJECT } from 'src/utils/studio-imports.js';

type Row = Record<string, unknown>;
type RetiredFile = {
  path: string;
  checksum: string;
  size: number | null;
  importId?: string;
};
const tables = {
  project: 'public.studio_project',
  revision: 'public.studio_project_revision',
  comment: 'public.studio_project_comment',
  imported: 'public.studio_project_import',
  generated: 'public.studio_generated_resource',
  exported: 'public.studio_export_version',
  source: 'public.studio_export_version_source',
} as const;
type Table = (typeof tables)[keyof typeof tables];
const jsonColumns = new Set(['envelope', 'summary', 'derivedFrom', 'settings', 'privacy']);
// JSON numbers cannot represent every PostgreSQL bigint used for exact rational frame positions.
const recordJson = (table: Table) =>
  table === tables.comment
    ? sql`to_jsonb(item) || jsonb_build_object('timeNum', item."timeNum"::text, 'timeDen', item."timeDen"::text)`
    : table === tables.source
      ? sql`to_jsonb(item) || jsonb_build_object('sourceEpoch',item."sourceEpoch"::text)`
      : sql`to_jsonb(item)`;
/** Buddy-only typed archive adapter. Historical grants, worker state and operation IDs are deliberately absent. */
export class BuddyBackupStudioRepository {
  constructor(private db: Kysely<DB>) {}
  private async rows(table: Table, column: string, id: string): Promise<Row[]> {
    const { rows } = await sql<{
      record: Row;
    }>`SELECT ${recordJson(table)} AS record FROM ${sql.table(table)} item
      WHERE ${sql.ref(column)}=${id}::uuid ORDER BY ${sql.ref(table === tables.source ? 'key' : 'id')}`.execute(
      this.db,
    );
    return rows.map(({ record }) => record);
  }
  /** Uses the capture transaction's already-exported repeatable-read snapshot, including projects with no assets. */
  async capture(): Promise<BuddyStudioSnapshot> {
    const { rows } = await sql<{
      record: Row;
    }>`SELECT to_jsonb(project) AS record FROM public.studio_project project
      JOIN public.user owner ON owner.id=project."ownerId" WHERE owner."deletedAt" IS NULL ORDER BY project.id`.execute(
      this.db,
    );
    const projects: Record<string, BuddyStudioProject> = {};
    for (const { record } of rows) {
      const id = String(record.id);
      const exports = (await this.rows(tables.exported, 'projectId', id)).filter((row) => row.state === 'published');
      for (const exported of exports)
        exported.sources = await this.rows(tables.source, 'versionId', String(exported.id));
      projects[id] = buddyStudioProjectSchema.parse({
        ...record,
        version: 1,
        revisions: await this.rows(tables.revision, 'projectId', id),
        comments: await this.rows(tables.comment, 'projectId', id),
        imports: await this.rows(tables.imported, 'projectId', id),
        generated: await this.rows(tables.generated, 'projectId', id),
        exports,
        files: [],
      });
    }
    return { version: 1, projects };
  }
  bindFiles(project: BuddyStudioProject, inventory: ReadonlyMap<string, CloudBackupManifestFile>) {
    project.files = [...new Set(buddyStudioPaths(project))].sort().map((path) => {
      const file = inventory.get(path);
      if (!file) throw new Error('A retained Studio project file was not captured');
      return file;
    });
  }
  /** No asset anchor: a metadata-only project still needs the current administrator/PIN/operation and project locks. */
  async guarded<T>(
    options: {
      project: BuddyStudioProject;
      actorId: string;
      sessionId: string;
      operationId: string;
      claimToken: string;
      authorize: () => Promise<void>;
    },
    action: (trx: Transaction<DB>, owner: AuthDto) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      const actor = await trx
        .selectFrom('user')
        .select('id')
        .where('id', '=', options.actorId)
        .where('isAdmin', '=', true)
        .where('deletedAt', 'is', null)
        .forShare()
        .noWait()
        .executeTakeFirst();
      const session = await trx
        .selectFrom('session')
        .select('id')
        .where('id', '=', options.sessionId)
        .where('userId', '=', options.actorId)
        .where('pinExpiresAt', '>', sql<Date>`clock_timestamp()`)
        .where((eb) => eb.or([eb('expiresAt', 'is', null), eb('expiresAt', '>', sql<Date>`clock_timestamp()`)]))
        .forShare()
        .noWait()
        .executeTakeFirst();
      const operation = await trx
        .selectFrom('media_operation')
        .select('id')
        .where('id', '=', options.operationId)
        .where('ownerId', '=', options.actorId)
        .where('claimToken', '=', options.claimToken)
        .where('kind', '=', MediaOperationKind.BuddyRestore)
        .where('status', '=', MediaOperationStatus.Rendering)
        .where('cancelRequestedAt', 'is', null)
        .where('pauseRequestedAt', 'is', null)
        .where('claimExpiresAt', '>', sql<Date>`clock_timestamp()`)
        .forShare()
        .noWait()
        .executeTakeFirst();
      if (!actor || !session || !operation) throw new Error('Buddy Studio authorization or lease changed');
      const lock = await sql<{
        locked: boolean;
      }>`SELECT pg_try_advisory_xact_lock(hashtextextended(
        ${`buddy-studio:${options.project.id}`},0)) AS locked`.execute(trx);
      if (!lock.rows[0]?.locked) throw new Error('Buddy Studio project is changing');
      const current = await trx
        .selectFrom('studio_project')
        .select(['ownerId', 'leaseExpiresAt'])
        .select(sql<boolean>`"leaseExpiresAt" > clock_timestamp()`.as('leased'))
        .where('id', '=', options.project.id)
        .forUpdate()
        .noWait()
        .executeTakeFirst();
      if (current && (current.ownerId !== options.project.ownerId || current.leased))
        throw new Error('Buddy Studio project ownership or editor lease changed');
      const owner = await trx
        .selectFrom('user')
        .select(['id', 'name', 'email', 'isAdmin', 'quotaSizeInBytes', 'quotaUsageInBytes'])
        .where('id', '=', options.project.ownerId)
        .where('deletedAt', 'is', null)
        .forUpdate()
        .noWait()
        .executeTakeFirstOrThrow();
      await options.authorize();
      // Internal owned-input validation after an authorized administrator recovery; never an issued read grant.
      const result = await action(trx, { user: owner, session: { id: session.id, hasElevatedPermission: true } });
      await options.authorize();
      // Locks prevent revocation from racing publication; time can still pass while validators
      // verify retained text/files. Never commit after the PIN or operation lease has expired.
      const active = await sql`SELECT operation.id FROM public.media_operation operation
        JOIN public.session session ON session.id=${options.sessionId}::uuid
        WHERE operation.id=${options.operationId}::uuid AND operation."claimToken"=${options.claimToken}::uuid
          AND operation."claimExpiresAt" > clock_timestamp() AND session."pinExpiresAt" > clock_timestamp()
          AND (session."expiresAt" IS NULL OR session."expiresAt" > clock_timestamp())`.execute(trx);
      if (active.rows.length === 0) throw new Error('Buddy Studio authorization or lease expired during publication');
      return result;
    });
  }
  async publish(options: {
    manifest: BuddyManifest;
    projectId: string;
    actorId: string;
    operationId: string;
    mode: 'keep' | 'replace';
    paths: ReadonlyMap<string, string>;
    verify: () => Promise<void>;
    validateResources: (project: BuddyStudioProject) => Promise<void>;
    retireFile: (file: RetiredFile) => Promise<void>;
  }) {
    if (!this.db.isTransaction) throw new Error('Buddy Studio publication requires its authorization transaction');
    const trx = this.db as Transaction<DB>;
    const project = readBuddyStudioProject(options.manifest, options.projectId);
    const current = await trx
      .selectFrom('studio_project')
      .selectAll()
      .where('id', '=', project.id)
      .forUpdate()
      .executeTakeFirst();
    if (current && current.ownerId !== project.ownerId) throw new Error('Buddy Studio project ownership changed');
    if (current && options.mode === 'keep' && current.currentRevision === 0 && project.currentRevision > 0)
      throw new Error('Choose replace to restore revision history into an existing empty Studio project');
    if (current && options.mode === 'replace' && project.currentRevision === 0 && current.currentRevision > 0)
      throw new Error('A metadata-only Studio snapshot cannot replace an existing document; choose keep');
    // Project deletion detaches published exports instead of deleting them; their previous
    // file remains part of the rebind even while projectId is null.
    const exportIds = project.exports.map((row) => row.id);
    const observedExports = await sql<{
      record: Row;
    }>`SELECT to_jsonb(item) AS record FROM public.studio_export_version item
      WHERE id = ANY(${exportIds}::uuid[]) ORDER BY id`.execute(trx);
    const previousFiles = [
      ...(await this.rows(tables.imported, 'projectId', project.id)),
      ...(await this.rows(tables.generated, 'projectId', project.id)),
      ...observedExports.rows.map((row) => row.record),
    ];
    const previousPaths = previousFiles.flatMap((row) =>
      [row.path, row.outputPath, row.subtitlePath].filter((path): path is string => typeof path === 'string'),
    );
    const lockedPaths = new Set([...options.paths.values(), ...previousPaths]);
    for (const path of [...lockedPaths].sort()) await lockFilePath(trx, path);
    // Export cleanup takes its path before its row. Re-read under the same order so cleanup
    // can finish while we wait, then validate only the current, locked publication identity.
    const previousExports = await sql<{
      record: Row;
    }>`SELECT to_jsonb(item) AS record FROM public.studio_export_version item
      WHERE id = ANY(${exportIds}::uuid[]) ORDER BY id FOR UPDATE`.execute(trx);
    // A concurrent promotion may introduce another path. Refuse it without waiting for a
    // new path while holding the row; a cleanup-cleared path needs no additional lock.
    if (
      previousExports.rows.some(({ record }) =>
        [record.outputPath, record.subtitlePath].some((path) => typeof path === 'string' && !lockedPaths.has(path)),
      )
    )
      throw new Error('Buddy Studio previous file changed');
    const retireFile = async (file: RetiredFile) => {
      if (!lockedPaths.has(file.path)) throw new Error('Buddy Studio previous file changed');
      await options.retireFile(file);
    };
    await options.verify();
    const target = (path: string) => {
      const value = options.paths.get(path);
      if (!value) throw new Error('Buddy Studio file closure is incomplete');
      return value;
    };
    for (const imported of project.imports) await validateBuddyStudioImport(imported, target(imported.path));
    const assetIds = buddyStudioAssetIds(options.manifest, project);
    const privacy = new DerivativePrivacyRepository(trx);
    const currentResultIds = previousExports.rows.flatMap(({ record }) =>
      typeof record.resultAssetId === 'string' ? [record.resultAssetId] : [],
    );
    const sources = await privacy.lockSources(trx, [...new Set([...assetIds, ...currentResultIds])].sort());
    for (const id of assetIds) {
      const source = sources.get(id);
      if (!source || source.ownerId !== project.ownerId || source.deleted || source.offline)
        throw new Error('Buddy Studio input is no longer owned and available');
      const captured = options.manifest.assetFidelity?.[id]?.source;
      const expected = new Set([
        captured?.checksum,
        options.manifest.library.assets[id].files.find((file) => file.role === 'original')?.sha256,
      ]);
      if (!expected.has(Buffer.from(source.checksum, 'base64').toString('hex')))
        throw new Error('Buddy Studio source content changed');
    }
    await options.validateResources(project);
    await options.verify();
    const personIds = [
      ...new Set([
        ...project.revisions.flatMap((row) => (row.authorId ? [row.authorId] : [])),
        ...project.comments.flatMap((row) => [row.authorId, ...(row.resolvedById ? [row.resolvedById] : [])]),
      ]),
    ];
    const people = new Set(
      personIds.length > 0
        ? (
            await trx
              .selectFrom('user')
              .select('id')
              .where('id', 'in', personIds)
              .where('deletedAt', 'is', null)
              .forShare()
              .execute()
          ).map((row) => row.id)
        : [],
    );
    if (project.comments.some((row) => !people.has(row.authorId)))
      throw new Error('Buddy Studio comment author is unavailable');
    if (!current)
      await trx
        .insertInto('studio_project')
        .values({
          id: project.id,
          ownerId: project.ownerId,
          name: project.name,
          createdAt: project.createdAt,
          currentRevision: 0,
          archivedAt: project.archivedAt,
          thumbnailAssetId: project.thumbnailAssetId,
          importedFromDigest: project.importedFromDigest,
        })
        .execute();
    for (const revision of project.revisions)
      await this.put(
        tables.revision,
        { ...revision, authorId: revision.authorId && people.has(revision.authorId) ? revision.authorId : null },
        ['id'],
        ['projectId', 'revision', 'envelope', 'digest', 'graphBytes', 'summary', 'restoredFromRevision', 'createdAt'],
        (row) => buddyStudioRevisionSchema.parse(row),
        [],
      );
    for (const comment of project.comments)
      await this.put(
        tables.comment,
        {
          ...comment,
          resolvedById: comment.resolvedById && people.has(comment.resolvedById) ? comment.resolvedById : null,
        },
        ['id'],
        ['projectId', 'authorId', 'revision', 'timeNum', 'timeDen', 'createdAt'],
        (row) => buddyStudioCommentSchema.parse(row),
        options.mode === 'replace' ? ['text', 'resolvedAt', 'resolvedById'] : [],
      );
    let importBytes = 0;
    for (const imported of project.imports) {
      const inserted = await this.put(
        tables.imported,
        { ...imported, path: target(imported.path) },
        ['projectId', 'id'],
        ['ownerId', 'contentType', 'checksum', 'sizeBytes', 'fileName', 'externalReferences'],
        (row) => buddyStudioImportSchema.parse(row),
        ['path'],
        retireFile,
      );
      if (inserted) importBytes += imported.sizeBytes;
    }
    for (const generated of project.generated) {
      await this.put(
        tables.generated,
        { ...generated, path: target(generated.path) },
        ['projectId', 'id'],
        ['ownerId', 'sourceRevision', 'producer', 'checksum', 'derivedFrom'],
        (row) => buddyStudioGeneratedSchema.parse(row),
        ['path'],
        retireFile,
      );
    }
    for (const exported of project.exports) {
      const evidence = exported.sources.flatMap((row) => (row.assetId ? [sources.get(row.assetId)!] : []));
      const inherited = unionDerivativePrivacy(project.ownerId, evidence, { nsfwHiding: true });
      const previous = previousExports.rows.find(({ record }) => record.id === exported.id)?.record;
      // Save to library promotes this same immutable publication. Both restore policies keep
      // its current result binding; Replace only restores the project document, never demotes
      // a published library item or retires the file already adopted by that item.
      const promoted =
        exported.scope === StudioExportScope.Project &&
        exported.resultAssetId === null &&
        previous?.scope === StudioExportScope.Library &&
        typeof previous.resultAssetId === 'string'
          ? buddyStudioExportSchema.parse({
              ...previous,
              projectId: previous.projectId ?? exported.projectId,
              sources: [],
            })
          : null;
      for (const value of [exported.privacy, previous?.privacy as Row | null | undefined]) {
        const reason = value?.lockReason;
        if (
          reason !== null &&
          reason !== undefined &&
          !Object.values(AssetLockReason).includes(reason as AssetLockReason)
        )
          throw new Error('Buddy Studio export privacy is invalid');
        inherited.lockReason = strongestLockReason([inherited.lockReason, (reason ?? null) as AssetLockReason | null]);
        inherited.sensitive ||= value?.sensitive === true;
      }
      const resultAssetId = promoted?.resultAssetId ?? exported.resultAssetId;
      if (resultAssetId) {
        const result = sources.get(resultAssetId);
        if (!result || result.ownerId !== project.ownerId || result.deleted || result.offline)
          throw new Error('Buddy Studio result is no longer owned and available');
        if (promoted && Buffer.from(result.checksum, 'base64').toString('hex') !== exported.outputChecksum)
          throw new Error('Buddy Studio promoted result content changed');
        if (!satisfiesDerivativePrivacy(result, inherited)) throw new Error('Buddy Studio result privacy changed');
      }
      const { sources: capturedSources, ...record } = exported;
      const scope = promoted?.scope ?? exported.scope;
      await this.put(
        tables.exported,
        {
          ...record,
          scope,
          resultAssetId,
          outputPath: promoted ? promoted.outputPath : record.outputPath ? target(record.outputPath) : null,
          subtitlePath: record.subtitlePath ? target(record.subtitlePath) : null,
          outputRemovedAt: promoted ? (previous?.outputRemovedAt ?? null) : null,
          privacy: { ...inherited, scope },
        },
        ['id'],
        [
          'projectId',
          'ownerId',
          'revision',
          'revisionDigest',
          'version',
          'scope',
          'outputChecksum',
          'outputSizeInBytes',
          'outputContentType',
          'settings',
          'engineDigest',
          'subtitleChecksum',
          'subtitleSizeInBytes',
          'subtitleRemovedAt',
          'resultAssetId',
          'createdAt',
        ],
        (row) =>
          buddyStudioExportSchema.parse({
            ...row,
            projectId: row.projectId ?? exported.projectId,
            resultAssetId: row.resultAssetId ?? exported.resultAssetId,
            sources: [],
          }),
        ['projectId', 'resultAssetId', 'outputPath', 'outputRemovedAt', 'subtitlePath', 'privacy'],
        retireFile,
      );
      for (const source of capturedSources) {
        const currentSource = source.assetId ? sources.get(source.assetId)! : undefined;
        // Translate only the exact snapshot original identity; historical provenance stays historical.
        const checksum = (value: string | null) => {
          const captured = source.assetId && options.manifest.assetFidelity?.[source.assetId]?.source;
          return captured &&
            currentSource &&
            ['library-asset', 'audio'].includes(source.kind) &&
            value === Buffer.from(captured.checksum, 'hex').toString('base64')
            ? currentSource.checksum
            : value;
        };
        const row = {
          ...source,
          checksum: checksum(source.checksum),
          locked: currentSource ? !!currentSource.lockReason : source.locked,
          lockReason: currentSource?.lockReason ?? source.lockReason,
          sensitive: currentSource?.sensitive || source.sensitive,
        };
        await this.put(
          tables.source,
          row,
          ['versionId', 'key'],
          ['kind', 'resourceId', 'assetId', 'ownerId', 'sourceAccess', 'checksum', 'sourceEpoch'],
          (row) => ({
            ...buddyStudioSourceSchema.parse(row),
            checksum: checksum(buddyStudioSourceSchema.parse(row).checksum),
          }),
          ['checksum', 'locked', 'lockReason', 'sensitive'],
        );
      }
    }
    // Reuse Studio's import ledger. Generated/project render outputs use the restore's free-disk
    // admission; normal Studio does not add those derivatives to the library usage counter.
    const totals = await sql<{
      imports: number;
      count: number;
    }>`SELECT
      (SELECT coalesce(sum("sizeBytes"),0)::float8 FROM public.studio_project_import WHERE "ownerId"=${project.ownerId}::uuid) AS imports,
      (SELECT count(*)::int FROM public.studio_project_import WHERE "projectId"=${project.id}::uuid) AS count`.execute(
      trx,
    );
    if (totals.rows[0].count > STUDIO_IMPORT_MAX_PER_PROJECT) throw new Error('Buddy Studio has too many imports');
    if (importBytes) {
      const quota = await trx
        .selectFrom('user')
        .select('id')
        .where('id', '=', project.ownerId)
        .where(
          sql<boolean>`"quotaSizeInBytes" IS NULL OR "quotaUsageInBytes" + ${totals.rows[0].imports} <= "quotaSizeInBytes"`,
        )
        .executeTakeFirst();
      if (!quota) throw new Error('More storage quota is needed to restore Studio projects');
    }
    const latest = await trx
      .selectFrom('studio_project_revision')
      .select((eb) => eb.fn.max<number>('revision').as('revision'))
      .where('projectId', '=', project.id)
      .executeTakeFirstOrThrow();
    const selected =
      current && options.mode === 'keep'
        ? await trx
            .selectFrom('studio_project_revision')
            .selectAll()
            .where('projectId', '=', project.id)
            .where('revision', '=', current.currentRevision)
            .executeTakeFirst()
        : project.revisions.find((row) => row.revision === project.currentRevision);
    const requestKey = `buddy:${options.operationId}`;
    const replay = await trx
      .selectFrom('studio_project_revision')
      .select(['revision', 'digest'])
      .where('projectId', '=', project.id)
      .where('requestKey', '=', requestKey)
      .executeTakeFirst();
    let next = current?.currentRevision ?? 0;
    if (selected && !replay && (!current || options.mode === 'replace' || (latest.revision ?? 0) > next)) {
      next = Math.max(next, latest.revision ?? 0) + 1;
      // Keep preserves the current document. When filling later missing history, append that
      // same document so the normal editor's next immutable revision cannot collide with it.
      await trx
        .insertInto('studio_project_revision')
        .values({
          id: randomUUID(),
          projectId: project.id,
          revision: next,
          authorId: options.actorId,
          envelope: selected.envelope,
          digest: selected.digest,
          graphBytes: selected.graphBytes,
          summary: { restoredFromBuddySnapshot: options.manifest.snapshotId },
          requestKey,
          restoredFromRevision: selected.revision,
        })
        .execute();
    }
    if (!current || options.mode === 'replace') {
      // A replay never rewinds a revision the owner saved after the first publication.
      await trx
        .updateTable('studio_project')
        .set({
          name: project.name,
          archivedAt: project.archivedAt,
          thumbnailAssetId: project.thumbnailAssetId,
          deletedAt: null,
          purgeAfter: null,
          ...(!replay && { currentRevision: next }),
        })
        .where('id', '=', project.id)
        .execute();
    } else if (next !== current.currentRevision && !replay)
      await trx.updateTable('studio_project').set({ currentRevision: next }).where('id', '=', project.id).execute();
    await options.verify();
    return project.id;
  }
  /** Runs after every selected project exists, so duplicate lineage never depends on restore ordering. */
  async restoreLineage(project: BuddyStudioProject, mode: 'keep' | 'replace') {
    if (!this.db.isTransaction) throw new Error('Buddy Studio lineage requires its authorization transaction');
    const current = await this.db
      .selectFrom('studio_project')
      .select(['ownerId', 'duplicatedFromId'])
      .where('id', '=', project.id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (current.ownerId !== project.ownerId) throw new Error('Buddy Studio lineage ownership changed');
    if (project.duplicatedFromId)
      await this.db
        .selectFrom('studio_project')
        .select('id')
        .where('id', '=', project.duplicatedFromId)
        .where('ownerId', '=', project.ownerId)
        .forShare()
        .executeTakeFirstOrThrow();
    if (mode === 'replace' || !current.duplicatedFromId)
      await this.db
        .updateTable('studio_project')
        .set({ duplicatedFromId: project.duplicatedFromId })
        .where('id', '=', project.id)
        .execute();
  }
  private async put(
    table: Table,
    row: Row,
    keys: string[],
    immutable: string[],
    normalize: (row: Row) => Row,
    update: string[],
    retireFile?: (file: RetiredFile) => Promise<void>,
  ) {
    const columns = Object.keys(row);
    const value = (column: string) =>
      jsonColumns.has(column)
        ? sql`${JSON.stringify(row[column])}::text::jsonb`
        : ['outputChecksum', 'subtitleChecksum'].includes(column) && row[column] !== null
          ? sql`${Buffer.from(String(row[column]), 'hex')}`
          : sql`${row[column]}`;
    const where = sql.join(
      keys.map((key) => sql`${sql.ref(key)}=${row[key]}`),
      sql` AND `,
    );
    const inserted = await sql`INSERT INTO ${sql.table(table)} (${sql.join(columns.map((column) => sql.ref(column)))})
      VALUES (${sql.join(columns.map((column) => value(column)))}) ON CONFLICT DO NOTHING RETURNING ${sql.ref(keys[0])}`.execute(
      this.db,
    );
    const stored = await sql<{
      record: Row;
    }>`SELECT ${recordJson(table)} AS record FROM ${sql.table(table)} item
      WHERE ${where} FOR UPDATE`.execute(this.db);
    if (!stored.rows[0]) throw new Error('Buddy Studio revision identity conflicts with existing history');
    const current = normalize(stored.rows[0].record);
    if (immutable.some((key) => canonicalJson(current[key]) !== canonicalJson(row[key])))
      throw new Error('Buddy Studio immutable identity changed');
    for (const pathColumn of table === tables.exported ? ['outputPath', 'subtitlePath'] : ['path']) {
      if (retireFile && typeof current[pathColumn] === 'string' && current[pathColumn] !== row[pathColumn]) {
        // Queue acceptance precedes the rebind while old+new paths are locked. A queue failure
        // rolls back the row, and a consumer cannot unlink before this transaction finishes.
        await retireFile({
          path: current[pathColumn] as string,
          checksum: String(
            current[
              table === tables.exported
                ? pathColumn === 'subtitlePath'
                  ? 'subtitleChecksum'
                  : 'outputChecksum'
                : 'checksum'
            ],
          ),
          size:
            table === tables.imported
              ? Number(current.sizeBytes)
              : table === tables.exported
                ? Number(current[pathColumn === 'subtitlePath' ? 'subtitleSizeInBytes' : 'outputSizeInBytes'])
                : null,
          ...(table === tables.imported && { importId: String(current.id) }),
        });
      }
    }
    if (update.length > 0)
      await sql`UPDATE ${sql.table(table)} SET
      ${sql.join(update.map((column) => sql`${sql.ref(column)}=${value(column)}`))} WHERE ${where}`.execute(this.db);
    return inserted.rows.length > 0;
  }
}
