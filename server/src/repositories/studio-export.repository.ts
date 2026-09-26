import { Injectable } from '@nestjs/common';
import { Insertable, Kysely, Selectable, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { randomUUID } from 'node:crypto';
import {
  AssetType,
  AssetVisibility,
  ChecksumAlgorithm,
  MediaOperationDestination,
  MediaOperationStatus,
  StudioExportRemoteReason,
  StudioExportScope,
  StudioExportVersionState,
} from 'src/enum.js';
import { DerivativePrivacyRepository, LockedSourceRow } from 'src/repositories/derivative-privacy.repository.js';
import { getForkSchemaPhase } from 'src/repositories/fork-derived-results.js';
import { ForkEnrichmentRepository } from 'src/repositories/fork-enrichment.repository.js';
import { ForkPrivacyRepository } from 'src/repositories/fork-privacy.repository.js';
import { lockPublicForkWrites, withPublicForkWrites } from 'src/repositories/fork-write-guard.js';
import { MediaOperation, MediaOperationCreate } from 'src/repositories/media-operation.repository.js';
import { DB } from 'src/schema/index.js';
import {
  StudioExportRemoteReferenceTable,
  StudioExportVersionSourceTable,
  StudioExportVersionTable,
} from 'src/schema/tables/studio-export.table.js';
import {
  DerivativePrivacy,
  DerivativeSourceEvidence,
  satisfiesDerivativePrivacy,
  unionDerivativePrivacy,
} from 'src/utils/derivative-privacy.js';

/** FL-44 (FN-304): what every write here answers while a database handoff holds the schema. */
export const STUDIO_EXPORT_HANDOFF_REFUSAL = 'Studio exports are unavailable during database handoff';

export type StudioExportVersion = Selectable<StudioExportVersionTable>;
export type StudioExportVersionSource = Selectable<StudioExportVersionSourceTable>;
export type StudioExportRemoteReference = Selectable<StudioExportRemoteReferenceTable>;

export type StudioExportSourceInput = Omit<
  Insertable<StudioExportVersionSourceTable>,
  'versionId' | 'locked' | 'lockReason' | 'sensitive'
>;

/** Versions that are still somebody's pending work. */
export const PENDING_STUDIO_EXPORT_STATES: readonly StudioExportVersionState[] = [
  StudioExportVersionState.Rendering,
  StudioExportVersionState.Staged,
];

/** Library source kinds: the graph names a library asset by id and FL-90 recorded its owner. */
export const isLibrarySource = (source: Pick<StudioExportVersionSource, 'assetId' | 'ownerId'>): boolean =>
  !!source.assetId && !!source.ownerId;

/**
 * Why a publication stopped. `cancel` refusals end the version as `cancelled` (the owner, the
 * project or a source went away, or the database is being handed over); `fail` refusals end the
 * publication job's attempt and, once its automatic retry is spent, the version as `failed`.
 */
export type StudioExportRefusalCode =
  | 'owner-unavailable'
  | 'project-unavailable'
  | 'source-unavailable'
  | 'handoff-in-progress'
  | 'source-changed'
  | 'source-access-lost'
  | 'scope-changed'
  | 'quota-exceeded'
  | 'duplicate-restricted'
  | 'not-staged'
  | 'claim-lost';

const CANCELLING_REFUSALS: ReadonlySet<StudioExportRefusalCode> = new Set([
  'owner-unavailable',
  'project-unavailable',
  'source-unavailable',
  'handoff-in-progress',
]);

export class StudioExportRefusal extends Error {
  constructor(
    readonly code: StudioExportRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = 'StudioExportRefusal';
  }

  /** The version is cancelled rather than failed: pending work whose premise went away. */
  get cancels(): boolean {
    return CANCELLING_REFUSALS.has(this.code);
  }
}

export type StudioExportPublication = {
  versionId: string;
  /** The publication job holding the claim. Only its own staged version is published. */
  operationId: string;
  claimToken: string;
  ownerId: string;
  /** Library sources as the render recorded them, re-checked here under row locks. */
  sources: ReadonlyArray<Pick<StudioExportVersionSource, 'key' | 'kind' | 'assetId' | 'checksum'>>;
  /** The scope the service prepared the file for. A different union refuses rather than guesses. */
  expectedScope: StudioExportScope;
  nsfwHiding: boolean;
  /** Where the verified output now is: the asset's original for `library`, the project file otherwise. */
  path: string;
  checksum: Buffer;
  sizeInBytes: number;
  contentType: string;
  assetType: AssetType;
  originalFileName: string;
};

export type StudioExportPublished = {
  status: 'published';
  version: StudioExportVersion;
  privacy: DerivativePrivacy;
  /** The asset created for a `library` result. */
  createdAssetId: string | null;
  /** An existing asset of the owner's with the same bytes and at least the same privacy. */
  reusedAssetId: string | null;
};

const isUniqueViolation = (error: unknown): boolean => (error as { code?: string } | null)?.code === '23505';

/**
 * Studio export versions (FL-106, `STU-404`).
 *
 * As in the other media-operation repositories, every write that decides a race carries its guard in
 * the `WHERE` clause, and publication is one transaction that either leaves a numbered, restricted,
 * attributed result or nothing at all.
 */
@Injectable()
export class StudioExportRepository {
  constructor(
    @InjectKysely() private db: Kysely<DB>,
    private privacy: DerivativePrivacyRepository,
    private forkPrivacy: ForkPrivacyRepository,
    private forkEnrichment: ForkEnrichmentRepository,
  ) {}

  /** FL-44 (FN-304): a write, refused while a database handoff holds the schema. */
  private write<T>(query: (db: Kysely<DB>) => Promise<T>): Promise<T> {
    return withPublicForkWrites(this.db, query, STUDIO_EXPORT_HANDOFF_REFUSAL);
  }

  /* ------------------------------------------------------------------ */
  /* Versions                                                            */
  /* ------------------------------------------------------------------ */

  /** The render job and the version it will become, together or not at all. */
  async createWithRender(
    operation: MediaOperationCreate,
    version: Pick<
      Insertable<StudioExportVersionTable>,
      'ownerId' | 'projectId' | 'revision' | 'revisionDigest' | 'destination' | 'settings'
    >,
  ): Promise<{ operation: MediaOperation; version: StudioExportVersion }> {
    return this.db.transaction().execute(async (tx) => {
      await lockPublicForkWrites(tx, STUDIO_EXPORT_HANDOFF_REFUSAL);
      const created = await tx.insertInto('media_operation').values(operation).returningAll().executeTakeFirstOrThrow();
      const row = await tx
        .insertInto('studio_export_version')
        .values({ ...version, renderOperationId: created.id })
        .returningAll()
        .executeTakeFirstOrThrow();
      return { operation: created as unknown as MediaOperation, version: row as unknown as StudioExportVersion };
    });
  }

  getById(id: string): Promise<StudioExportVersion | undefined> {
    return this.db.selectFrom('studio_export_version').selectAll().where('id', '=', id).executeTakeFirst() as Promise<
      StudioExportVersion | undefined
    >;
  }

  /** Owner-scoped. Somebody else's version answers like one that does not exist. */
  getForOwner(id: string, ownerId: string): Promise<StudioExportVersion | undefined> {
    return this.db
      .selectFrom('studio_export_version')
      .selectAll()
      .where('id', '=', id)
      .where('ownerId', '=', ownerId)
      .executeTakeFirst() as Promise<StudioExportVersion | undefined>;
  }

  getByRenderOperation(operationId: string): Promise<StudioExportVersion | undefined> {
    return this.db
      .selectFrom('studio_export_version')
      .selectAll()
      .where('renderOperationId', '=', operationId)
      .executeTakeFirst() as Promise<StudioExportVersion | undefined>;
  }

  getByPublishOperation(operationId: string): Promise<StudioExportVersion | undefined> {
    return this.db
      .selectFrom('studio_export_version')
      .selectAll()
      .where('publishOperationId', '=', operationId)
      .executeTakeFirst() as Promise<StudioExportVersion | undefined>;
  }

  /** Newest first. Published versions by number, then everything still on its way or stopped. */
  async listForProject(
    projectId: string,
    ownerId: string,
    page: { take: number; skip: number; includeLocked: boolean },
  ): Promise<{ items: StudioExportVersion[]; total: number }> {
    // A result that inherited a lock exists only for its owner's unlocked session (FL-34): outside it
    // the row is not listed and not counted, like any Locked media.
    const query = this.db
      .selectFrom('studio_export_version')
      .where('projectId', '=', projectId)
      .where('ownerId', '=', ownerId)
      .$if(!page.includeLocked, (qb) => qb.where(sql<boolean>`coalesce("privacy" ->> 'lockReason', '') = ''`));
    const [items, total] = await Promise.all([
      query.selectAll().orderBy('createdAt', 'desc').orderBy('id', 'desc').limit(page.take).offset(page.skip).execute(),
      query
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .executeTakeFirst()
        .then((row) => Number(row?.count ?? 0)),
    ]);
    return { items: items as unknown as StudioExportVersion[], total };
  }

  /** The sources of several versions in one query, by version. */
  async getSourcesFor(versionIds: readonly string[]): Promise<Map<string, StudioExportVersionSource[]>> {
    const bySource = new Map<string, StudioExportVersionSource[]>(versionIds.map((id) => [id, []]));
    if (versionIds.length === 0) {
      return bySource;
    }
    const rows = (await this.db
      .selectFrom('studio_export_version_source')
      .selectAll()
      .where('versionId', 'in', [...versionIds])
      .orderBy('versionId')
      .orderBy('key', 'asc')
      .execute()) as StudioExportVersionSource[];
    for (const row of rows) {
      bySource.get(row.versionId)?.push(row);
    }
    return bySource;
  }

  getSources(versionId: string): Promise<StudioExportVersionSource[]> {
    return this.db
      .selectFrom('studio_export_version_source')
      .selectAll()
      .where('versionId', '=', versionId)
      .orderBy('key', 'asc')
      .execute() as Promise<StudioExportVersionSource[]>;
  }

  /**
   * Record what a render claim was granted: the worker, its engine and every source with the
   * checksum it may read. Every claim replaces the previous one's list, because the retry reads
   * what is authorized now. Only while the version is still rendering.
   */
  async recordRenderClaim(
    renderOperationId: string,
    claim: { workerId: string; engineDigest: string | null; sources: readonly StudioExportSourceInput[] },
  ): Promise<boolean> {
    return this.db.transaction().execute(async (tx) => {
      await lockPublicForkWrites(tx, STUDIO_EXPORT_HANDOFF_REFUSAL);
      const version = await tx
        .updateTable('studio_export_version')
        .set({ workerId: claim.workerId, engineDigest: claim.engineDigest, updatedAt: sql<Date>`now()` })
        .where('renderOperationId', '=', renderOperationId)
        .where('state', '=', StudioExportVersionState.Rendering)
        .returning('id')
        .executeTakeFirst();
      if (!version) {
        return false;
      }
      await tx.deleteFrom('studio_export_version_source').where('versionId', '=', version.id).execute();
      if (claim.sources.length > 0) {
        await tx
          .insertInto('studio_export_version_source')
          .values(claim.sources.map((source) => ({ ...source, versionId: version.id })))
          .execute();
      }
      return true;
    });
  }

  /**
   * The render reported a file: record it and queue its publication, in one transaction. Only a
   * current validating claim can move a rendering version; cancelled or replaced claims queue nothing.
   */
  async stage(
    renderOperationId: string,
    claimToken: string | null,
    output: {
      path: string;
      checksum: Buffer;
      sizeInBytes: number;
      contentType: string;
      remoteRef: string | null;
    },
    publish: (version: StudioExportVersion) => MediaOperationCreate,
  ): Promise<{ version: StudioExportVersion; operation: MediaOperation } | undefined> {
    return this.db.transaction().execute(async (tx) => {
      await lockPublicForkWrites(tx, STUDIO_EXPORT_HANDOFF_REFUSAL);
      if (!claimToken || !(await this.lockClaim(tx, renderOperationId, claimToken))) {
        return;
      }
      const version = (await tx
        .selectFrom('studio_export_version')
        .selectAll()
        .where('renderOperationId', '=', renderOperationId)
        .where('state', '=', StudioExportVersionState.Rendering)
        .forUpdate()
        .executeTakeFirst()) as StudioExportVersion | undefined;
      if (!version) {
        return;
      }

      const operation = await tx
        .insertInto('media_operation')
        .values(publish(version))
        .returningAll()
        .executeTakeFirstOrThrow();

      const staged = await tx
        .updateTable('studio_export_version')
        .set({
          state: StudioExportVersionState.Staged,
          outputPath: output.path,
          outputChecksum: output.checksum,
          outputSizeInBytes: String(output.sizeInBytes),
          outputContentType: output.contentType,
          outputRemoteRef: output.remoteRef,
          publishOperationId: operation.id,
          updatedAt: sql<Date>`now()`,
        })
        .where('id', '=', version.id)
        .returningAll()
        .executeTakeFirstOrThrow();

      return { version: staged as unknown as StudioExportVersion, operation: operation as unknown as MediaOperation };
    });
  }

  /** End a pending version as failed. A published version is never touched. */
  async markFailed(
    id: string,
    failure: { errorCode: string; error: string },
  ): Promise<StudioExportVersion | undefined> {
    return this.write((db) =>
      db
        .updateTable('studio_export_version')
        .set({
          state: StudioExportVersionState.Failed,
          errorCode: failure.errorCode,
          error: failure.error.slice(0, 4000),
          updatedAt: sql<Date>`now()`,
        })
        .where('id', '=', id)
        .where('state', 'in', [...PENDING_STUDIO_EXPORT_STATES])
        .returningAll()
        .executeTakeFirst(),
    ) as Promise<StudioExportVersion | undefined>;
  }

  /** End a pending version as cancelled. A published version is never touched. */
  async cancel(id: string, reason: { errorCode: string; error: string }): Promise<StudioExportVersion | undefined> {
    return this.write((db) =>
      db
        .updateTable('studio_export_version')
        .set({
          state: StudioExportVersionState.Cancelled,
          errorCode: reason.errorCode,
          error: reason.error.slice(0, 4000),
          cancelledAt: sql<Date>`now()`,
          updatedAt: sql<Date>`now()`,
        })
        .where('id', '=', id)
        .where('state', 'in', [...PENDING_STUDIO_EXPORT_STATES])
        .returningAll()
        .executeTakeFirst(),
    ) as Promise<StudioExportVersion | undefined>;
  }

  /** Serialize publication and staging against cancellation and claim recovery (FL-43). */
  private async lockClaim(tx: Kysely<DB>, operationId: string, claimToken: string): Promise<boolean> {
    const held = await tx
      .selectFrom('media_operation')
      .select('id')
      .where('id', '=', operationId)
      .where('claimToken', '=', claimToken)
      .where('status', '=', MediaOperationStatus.Validating)
      .forUpdate()
      .executeTakeFirst();
    return !!held;
  }

  /* ------------------------------------------------------------------ */
  /* Publication                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * Publish a staged version, atomically.
   *
   * In order, inside one transaction:
   *
   *   1. the current validating operation claim and its staged version are locked;
   *   2. the database must not be handed over or taken back right now (the fork state row is
   *      share-locked, so a cutover waits for this transaction or this one sees it);
   *   3. the owner (share-locked) must not be deleted, and the project (locked for the version
   *      number) must be theirs and not in the trash;
   *   4. every library source is share-locked and must still exist, be out of the trash, be online
   *      and have the checksum the render read; a source of somebody else's must still be shared
   *      with the owner, with the granting rows share-locked;
   *   5. the union of the sources' Locked and sensitive evidence, read under those locks, is
   *      computed and must put the result where the service prepared its file;
   *   6. a `library` result becomes an asset with that privacy installed before the transaction
   *      commits — or, when the owner already has these exact bytes restricted at least as much,
   *      that asset is referenced instead; a `project` result keeps its file with the version;
   *   7. the version is numbered, its provenance completed and it is marked `published`.
   *
   * Any refusal throws {@link StudioExportRefusal} and rolls everything back. Publishing a version
   * this job already published answers with it again, so a retry after an uncertain commit is safe.
   */
  async publish(input: StudioExportPublication): Promise<StudioExportPublished> {
    return this.db.transaction().execute(async (tx) => {
      if (!(await this.lockClaim(tx, input.operationId, input.claimToken))) {
        throw new StudioExportRefusal('claim-lost', 'The publication claim is no longer validating');
      }
      const version = (await tx
        .selectFrom('studio_export_version')
        .selectAll()
        .where('id', '=', input.versionId)
        .forUpdate()
        .executeTakeFirst()) as StudioExportVersion | undefined;

      if (version?.state === StudioExportVersionState.Published && version.publishOperationId === input.operationId) {
        const privacy = (version.privacy ?? {}) as unknown as DerivativePrivacy;
        return { status: 'published', version, privacy, createdAssetId: null, reusedAssetId: null };
      }
      if (
        !version ||
        version.state !== StudioExportVersionState.Staged ||
        version.publishOperationId !== input.operationId ||
        version.ownerId !== input.ownerId ||
        !version.projectId
      ) {
        throw new StudioExportRefusal('not-staged', 'This export is no longer waiting to be published');
      }

      await this.assertNoHandoff(tx);

      const owner = await tx
        .selectFrom('user')
        .select('id')
        .where('id', '=', input.ownerId)
        .where('deletedAt', 'is', null)
        .forShare()
        .executeTakeFirst();
      if (!owner) {
        throw new StudioExportRefusal('owner-unavailable', 'The account this export belongs to is being deleted');
      }

      const project = await tx
        .selectFrom('studio_project')
        .select(['id', 'ownerId', 'deletedAt'])
        .where('id', '=', version.projectId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!project || project.deletedAt || project.ownerId !== input.ownerId) {
        throw new StudioExportRefusal('project-unavailable', 'The project is gone or in the trash');
      }

      const librarySources = input.sources.filter((source) => !!source.assetId);
      const rows = await this.privacy.lockSources(tx, [...new Set(librarySources.map((source) => source.assetId!))]);
      for (const source of librarySources) {
        const row = rows.get(source.assetId!);
        if (!row || row.deleted || row.offline) {
          throw new StudioExportRefusal('source-unavailable', 'A source of this export was deleted or went offline');
        }
        if (source.checksum && this.checksumBearing(source.kind) && source.checksum !== row.checksum) {
          throw new StudioExportRefusal('source-changed', 'A source of this export changed after it was rendered');
        }
      }

      const evidence: LockedSourceRow[] = rows.values().toArray();
      const foreign = evidence.filter((row) => row.ownerId !== input.ownerId);
      if (foreign.length > 0) {
        const reachable = await this.privacy.lockSharedAccess(tx, input.ownerId, foreign);
        if (foreign.some((row) => !reachable.has(row.assetId))) {
          throw new StudioExportRefusal('source-access-lost', 'A shared source of this export is no longer shared');
        }
      }

      const privacy = unionDerivativePrivacy(
        input.ownerId,
        evidence.map((row): DerivativeSourceEvidence => ({
          assetId: row.assetId,
          ownerId: row.ownerId,
          lockReason: row.lockReason,
          sensitive: row.sensitive,
        })),
        { nsfwHiding: input.nsfwHiding },
      );
      if (privacy.scope !== input.expectedScope) {
        throw new StudioExportRefusal('scope-changed', 'The sources of this export changed hands');
      }

      let createdAssetId: string | null = null;
      let reusedAssetId: string | null = null;
      if (privacy.scope === StudioExportScope.Library) {
        // Locks an asset lockIn may also be locking; should Postgres pick this transaction as a deadlock
        // victim, the publication attempt fails and its automatic retry publishes it (FL-104).
        const duplicate = await tx
          .selectFrom('asset')
          .select(['id', 'deletedAt'])
          .where('ownerId', '=', input.ownerId)
          .where('libraryId', 'is', null)
          .where('checksum', '=', input.checksum)
          .forUpdate()
          .executeTakeFirst();
        if (duplicate) {
          const existing = await this.privacy.getEvidence(tx, duplicate.id);
          if (duplicate.deletedAt || !existing || !satisfiesDerivativePrivacy(existing, privacy)) {
            throw new StudioExportRefusal(
              'duplicate-restricted',
              'You already have this exact file with fewer restrictions than its sources need',
            );
          }
          reusedAssetId = duplicate.id;
        } else {
          createdAssetId = await this.createAsset(tx, input, privacy);
        }
      }

      const next = await tx
        .selectFrom('studio_export_version')
        .select((eb) => sql<number>`coalesce(max(${eb.ref('version')}), 0) + 1`.as('next'))
        .where('projectId', '=', project.id)
        .executeTakeFirstOrThrow();

      for (const row of evidence) {
        await tx
          .updateTable('studio_export_version_source')
          .set({ locked: row.lockReason !== null, lockReason: row.lockReason, sensitive: row.sensitive })
          .where('versionId', '=', version.id)
          .where('assetId', '=', row.assetId)
          .execute();
      }

      const published = await tx
        .updateTable('studio_export_version')
        .set({
          state: StudioExportVersionState.Published,
          version: Number(next.next),
          scope: privacy.scope,
          resultAssetId: createdAssetId ?? reusedAssetId,
          outputPath: reusedAssetId ? null : input.path,
          privacy: privacy as unknown as Record<string, unknown>,
          publishedAt: sql<Date>`now()`,
          updatedAt: sql<Date>`now()`,
          errorCode: null,
          error: null,
        })
        .where('id', '=', version.id)
        .returningAll()
        .executeTakeFirstOrThrow();

      return {
        status: 'published',
        version: published as unknown as StudioExportVersion,
        privacy,
        createdAssetId,
        reusedAssetId,
      };
    });
  }

  /** Library and audio-of-asset sources carry the asset checksum; an edited master carries its own. */
  private checksumBearing(kind: string): boolean {
    return kind === 'library-asset' || kind === 'audio';
  }

  /**
   * Nothing is published while the database is being handed to the official server or taken back
   * from it, and nothing after a handover (`inactive`) or a failed cutover. The state row is
   * share-locked so a cutover that starts now waits for this transaction.
   */
  private async assertNoHandoff(tx: Kysely<DB>): Promise<void> {
    const schema = await sql<{ present: boolean }>`
      SELECT to_regclass('immich_fork.state') IS NOT NULL AS present
    `.execute(tx);
    if (!schema.rows[0]?.present) {
      return;
    }
    const state = await sql<{ phase: string }>`SELECT phase FROM immich_fork.state WHERE id = 1 FOR SHARE`.execute(tx);
    const phase = state.rows[0]?.phase ?? (await getForkSchemaPhase(tx));
    if (phase === 'inactive' || phase === 'failed') {
      throw new StudioExportRefusal('handoff-in-progress', 'This server has been handed over; nothing is published');
    }
    const running = await sql`
      SELECT 1 FROM immich_fork.migration_audit
      WHERE status = 'running' AND name IN ('official-handoff-preparation', 'fork-return-reconciliation')
      LIMIT 1
    `.execute(tx);
    if (running.rows.length > 0) {
      throw new StudioExportRefusal('handoff-in-progress', 'A handover is in progress; nothing is published');
    }
  }

  /**
   * The result as a new asset of the owner's, with its privacy installed in the same transaction
   * before anything can list it. Quota is charged here, guarded, so a full account refuses instead
   * of going over. The asset is never linked to another account's physical file: publication only
   * adds a file, it never changes what an existing original or a deduplication reference points at.
   */
  private async createAsset(tx: Kysely<DB>, input: StudioExportPublication, privacy: DerivativePrivacy) {
    const quota = await tx
      .updateTable('user')
      .set({ quotaUsageInBytes: sql`"quotaUsageInBytes" + ${input.sizeInBytes}` })
      .where('id', '=', input.ownerId)
      .where(
        sql<boolean>`("quotaSizeInBytes" IS NULL OR "quotaUsageInBytes" + ${input.sizeInBytes} <= "quotaSizeInBytes")`,
      )
      .returning('id')
      .executeTakeFirst();
    if (!quota) {
      throw new StudioExportRefusal('quota-exceeded', 'This export does not fit in your storage quota');
    }

    const now = new Date();
    const assetId = randomUUID();
    await tx
      .insertInto('asset')
      .values({
        id: assetId,
        ownerId: input.ownerId,
        libraryId: null,
        checksum: input.checksum,
        checksumAlgorithm: ChecksumAlgorithm.sha256File,
        originalPath: input.path,
        originalFileName: input.originalFileName,
        type: input.assetType,
        fileCreatedAt: now,
        fileModifiedAt: now,
        localDateTime: now,
        // Locked is a lock record installed below, never a stored visibility.
        visibility: AssetVisibility.Timeline,
      })
      .execute();
    await tx.insertInto('asset_exif').values({ assetId, fileSizeInByte: input.sizeInBytes }).execute();

    await this.privacy.install(tx, assetId, privacy);
    await this.forkPrivacy.mirrorFromLegacy(assetId, tx);
    await this.forkEnrichment.initialize([assetId], tx);
    return assetId;
  }

  /* ------------------------------------------------------------------ */
  /* Sweeps                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * Pending versions whose premise went away: the owner is being deleted, the project is gone or
   * in the trash, a recorded library source is gone, in the trash or offline, or the database is
   * being handed over. The sweep cancels them and their jobs.
   */
  async listOrphanedWork(limit = 200): Promise<Array<StudioExportVersion & { orphanReason: StudioExportRefusalCode }>> {
    const handoff = await this.handoffInProgress();
    const rows = await sql<StudioExportVersion & { orphanReason: StudioExportRefusalCode }>`
      SELECT version.*,
        CASE
          WHEN ${handoff}::boolean THEN 'handoff-in-progress'
          WHEN owner."deletedAt" IS NOT NULL THEN 'owner-unavailable'
          WHEN project.id IS NULL OR project."deletedAt" IS NOT NULL THEN 'project-unavailable'
          ELSE 'source-unavailable'
        END AS "orphanReason"
      FROM studio_export_version version
      JOIN "user" owner ON owner.id = version."ownerId"
      LEFT JOIN studio_project project ON project.id = version."projectId"
      WHERE version.state = ANY(${[...PENDING_STUDIO_EXPORT_STATES]}::text[])
        AND (
          ${handoff}::boolean
          OR owner."deletedAt" IS NOT NULL
          OR project.id IS NULL
          OR project."deletedAt" IS NOT NULL
          OR EXISTS (
            SELECT 1 FROM studio_export_version_source source
            LEFT JOIN asset ON asset.id = source."assetId"
            WHERE source."versionId" = version.id
              AND source."assetId" IS NOT NULL
              AND (asset.id IS NULL OR asset."deletedAt" IS NOT NULL OR asset."isOffline")
          )
        )
      ORDER BY version."createdAt"
      LIMIT ${limit}
    `.execute(this.db);
    return rows.rows;
  }

  /**
   * Pending versions whose job already ended without them: a render or publication that failed or
   * was cancelled by the recovery sweep, a cancel, or a job row that is gone. The version follows its
   * job; an earlier published version is untouched.
   */
  async listSettledWork(limit = 200): Promise<Array<StudioExportVersion & { jobStatus: string | null }>> {
    const { rows } = await sql<StudioExportVersion & { jobStatus: string | null }>`
      SELECT version.*, job.status AS "jobStatus"
      FROM studio_export_version version
      LEFT JOIN media_operation job ON job.id = CASE
        WHEN version.state = ${StudioExportVersionState.Rendering} THEN version."renderOperationId"
        ELSE version."publishOperationId"
      END
      WHERE version.state = ANY(${[...PENDING_STUDIO_EXPORT_STATES]}::text[])
        AND (job.id IS NULL OR job.status IN ('failed', 'cancelled'))
      ORDER BY version."createdAt"
      LIMIT ${limit}
    `.execute(this.db);
    return rows;
  }

  /**
   * Files no published result references any more: the staged output of a version that failed or
   * was cancelled, and the file of a `project` result whose project was deleted for good. A
   * `library` result's file is its asset's original and is never listed.
   */
  listRemovableOutputs(limit = 200): Promise<StudioExportVersion[]> {
    return this.db
      .selectFrom('studio_export_version')
      .selectAll()
      .where('outputPath', 'is not', null)
      .where('outputRemovedAt', 'is', null)
      .where((eb) =>
        eb.or([
          eb('state', 'in', [StudioExportVersionState.Failed, StudioExportVersionState.Cancelled]),
          eb.and([
            eb('state', '=', StudioExportVersionState.Published),
            eb('scope', '=', StudioExportScope.Project),
            eb('projectId', 'is', null),
          ]),
        ]),
      )
      .orderBy('updatedAt', 'asc')
      .limit(limit)
      .execute() as Promise<StudioExportVersion[]>;
  }

  /** Record that retention removed a file. Guarded so a file that became referenced is never marked. */
  async markOutputRemoved(id: string): Promise<boolean> {
    const result = await this.write((db) =>
      db
        .updateTable('studio_export_version')
        .set({ outputRemovedAt: sql<Date>`now()`, updatedAt: sql<Date>`now()` })
        .where('id', '=', id)
        .where('outputRemovedAt', 'is', null)
        .where((eb) =>
          eb.or([
            eb('state', 'in', [StudioExportVersionState.Failed, StudioExportVersionState.Cancelled]),
            eb.and([eb('scope', '=', StudioExportScope.Project), eb('projectId', 'is', null)]),
          ]),
        )
        .executeTakeFirst(),
    );
    return Number(result.numUpdatedRows) === 1;
  }

  /** Whether the database is being handed over or taken back, or has been handed over. */
  async handoffInProgress(kysely: Kysely<DB> = this.db): Promise<boolean> {
    const schema = await sql<{ present: boolean }>`
      SELECT to_regclass('immich_fork.state') IS NOT NULL AS present
    `.execute(kysely);
    if (!schema.rows[0]?.present) {
      return false;
    }
    const phase = await getForkSchemaPhase(kysely);
    if (phase === 'inactive' || phase === 'failed') {
      return true;
    }
    const running = await sql`
      SELECT 1 FROM immich_fork.migration_audit
      WHERE status = 'running' AND name IN ('official-handoff-preparation', 'fork-return-reconciliation')
      LIMIT 1
    `.execute(kysely);
    return running.rows.length > 0;
  }

  /* ------------------------------------------------------------------ */
  /* Remote references                                                   */
  /* ------------------------------------------------------------------ */

  /**
   * Remember that a remote destination has to stop or delete something. Idempotent per render job,
   * worker and reason, and never erases an acknowledgement.
   */
  async recordRemoteReference(reference: {
    versionId: string | null;
    operationId: string;
    ownerId: string | null;
    workerId: string | null;
    destination: MediaOperationDestination;
    remoteRef: string | null;
    reason: StudioExportRemoteReason;
  }): Promise<void> {
    try {
      await this.db
        .insertInto('studio_export_remote_reference')
        .values(reference)
        .onConflict((oc) => oc.columns(['operationId', 'workerId', 'reason']).doNothing())
        .execute();
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
    }
  }

  /** What one worker still has to drop, oldest first. */
  listRemoteReferences(workerId: string, limit = 100): Promise<StudioExportRemoteReference[]> {
    return this.db
      .selectFrom('studio_export_remote_reference')
      .selectAll()
      .where('workerId', '=', workerId)
      .where('acknowledgedAt', 'is', null)
      .orderBy('requestedAt', 'asc')
      .limit(limit)
      .execute() as Promise<StudioExportRemoteReference[]>;
  }

  /** Every unacknowledged reference, for the operator's view and for tests. */
  listUnacknowledgedRemoteReferences(limit = 500): Promise<StudioExportRemoteReference[]> {
    return this.db
      .selectFrom('studio_export_remote_reference')
      .selectAll()
      .where('acknowledgedAt', 'is', null)
      .orderBy('requestedAt', 'asc')
      .limit(limit)
      .execute() as Promise<StudioExportRemoteReference[]>;
  }

  /** The worker that holds it confirms it is gone. Anybody else's acknowledgement changes nothing. */
  async acknowledgeRemoteReference(id: string, workerId: string): Promise<boolean> {
    const result = await this.db
      .updateTable('studio_export_remote_reference')
      .set({ acknowledgedAt: sql<Date>`now()` })
      .where('id', '=', id)
      .where('workerId', '=', workerId)
      .where('acknowledgedAt', 'is', null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  /** A render's cancel was acknowledged with its resources released: its cancel reference is settled. */
  async acknowledgeRemoteCancel(operationId: string, workerId: string): Promise<boolean> {
    const result = await this.db
      .updateTable('studio_export_remote_reference')
      .set({ acknowledgedAt: sql<Date>`now()` })
      .where('operationId', '=', operationId)
      .where('workerId', '=', workerId)
      .where('reason', '=', StudioExportRemoteReason.Cancel)
      .where('acknowledgedAt', 'is', null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }
}
