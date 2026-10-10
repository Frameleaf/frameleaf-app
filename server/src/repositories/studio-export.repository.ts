import { Injectable } from '@nestjs/common';
import { Insertable, Kysely, Selectable, Transaction, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { randomUUID } from 'node:crypto';
import type { VideoPacketInfo } from 'src/types.js';
import type { HiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import type { RenderArtifact } from 'src/utils/render-artifact.js';
import {
  AssetType,
  AssetVisibility,
  ChecksumAlgorithm,
  MediaOperationDestination,
  MediaOperationStatus,
  Permission,
  StudioExportRemoteReason,
  StudioExportScope,
  StudioExportVersionState,
} from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { DerivativePrivacyRepository, LockedSourceRow } from 'src/repositories/derivative-privacy.repository.js';
import { currentAuth } from 'src/repositories/icloud-audit.repository.js';
import { MediaOperation, MediaOperationCreate } from 'src/repositories/media-operation.repository.js';
import { PhysicalFileRepository, lockFilePath } from 'src/repositories/physical-file.repository.js';
import { holdSourceAdmission } from 'src/repositories/studio-source-admission.js';
import { DB } from 'src/schema/index.js';
import {
  StudioExportRemoteReferenceTable,
  StudioExportVersionSourceTable,
  StudioExportVersionTable,
} from 'src/schema/tables/studio-export.table.js';
import { checkAccess } from 'src/utils/access.js';
import { hiddenFromSession } from 'src/utils/database.js';
import {
  DerivativePrivacy,
  DerivativeSourceEvidence,
  satisfiesDerivativePrivacy,
  unionDerivativePrivacy,
} from 'src/utils/derivative-privacy.js';
import { getHiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import { getLockedOwnerId } from 'src/utils/locked.js';
import { canonicalJson } from 'src/utils/studio-project.js';
import { sidecarSealOf } from 'src/utils/studio-subtitle-sidecar.js';

/**
 * FL-195 follow-up (owner decision, September 27, 2026): which sessions a version is hidden from. A
 * result carries the lock its sources had when it was published, and any source lock added later
 * (`lockDerivedResults`); on top of that it is judged by its sources as they stand at read time, so a
 * version with a source that is now hidden from the session — Locked while the session is locked, or
 * matched by the owner's Locked rules — is hidden too, whenever it was rendered, and so is one whose
 * library item the owner locked directly. Unlocking the last locked source releases an inherited lock
 * (`releaseDerivedResults`), so the version shows again. `revealed` is the owner's unlocked session.
 */
export type StudioExportVisibility = HiddenContentQueryOptions & {
  revealed: boolean;
};
const versionHiddenFrom = (visibility: StudioExportVisibility) => {
  const hiddenSource = sql<boolean>`exists (
    select 1
    from studio_export_version_source as hidden_source
    inner join asset as hidden_source_asset on hidden_source_asset.id = hidden_source."assetId"
    where hidden_source."versionId" = studio_export_version.id
      and ${hiddenFromSession(visibility, 'hidden_source_asset')}
  )`;
  // a result the owner locked directly, whatever its sources: its entry goes with its library item
  const hiddenResult = sql<boolean>`exists (
    select 1
    from asset as hidden_result_asset
    where hidden_result_asset.id = studio_export_version."resultAssetId"
      and ${hiddenFromSession(visibility, 'hidden_result_asset')}
  )`;
  return visibility.revealed
    ? sql<boolean>`(${hiddenSource} or ${hiddenResult})`
    : sql<boolean>`(coalesce(studio_export_version."privacy" ->> 'lockReason', '') <> '' or ${hiddenSource} or ${hiddenResult})`;
};
export type StudioExportVersion = Selectable<StudioExportVersionTable>;
// C2 epochs are compared as decimal integers, never rounded through JS Number.
export type StudioExportVersionSource = Omit<Selectable<StudioExportVersionSourceTable>, 'sourceEpoch'> & {
  sourceEpoch: string | null;
};
export type StudioExportRemoteReference = Selectable<StudioExportRemoteReferenceTable>;
export type StudioExportSourceInput = Omit<
  Insertable<StudioExportVersionSourceTable>,
  'versionId' | 'locked' | 'lockReason' | 'sensitive'
>;
/** One source's persisted stream facts (FL-93 / FL-102). */
export type StudioSourceMediaFacts = {
  assetId: string;
  video: {
    timeBase: number;
    pixelFormat: string;
    colorTransfer: number;
  } | null;
  packets: VideoPacketInfo | null;
  audio: {
    codecName: string;
    channels: number | null;
    channelLayout: string | null;
    sampleRate: number | null;
  } | null;
};
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
 * project or a source went away); `fail` refusals end the
 * publication job's attempt and, once its automatic retry is spent, the version as `failed`.
 */
export type StudioExportRefusalCode =
  | 'owner-unavailable'
  | 'project-unavailable'
  | 'source-unavailable'
  | 'source-changed'
  | 'source-access-lost'
  | 'scope-changed'
  | 'quota-exceeded'
  | 'duplicate-restricted'
  | 'not-staged'
  | 'claim-lost'
  /** FL-102: the rendered file does not have the precision or audio its export promised. */
  | 'output-rejected';
const CANCELLING_REFUSALS: ReadonlySet<StudioExportRefusalCode> = new Set([
  'owner-unavailable',
  'project-unavailable',
  'source-unavailable',
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
  sources: ReadonlyArray<
    Pick<StudioExportVersionSource, 'key' | 'kind' | 'assetId' | 'checksum'> &
      Partial<Pick<StudioExportVersionSource, 'ownerId' | 'sourceEpoch'>>
  >;
  /** The scope the service prepared the file for. A different union refuses rather than guesses. */
  expectedScope: StudioExportScope;
  /** Keep the result with its project even when every source is the owner's (FL-194). */
  retainInProject?: boolean;
  nsfwHiding: boolean;
  /** Where the verified output now is: the asset's original for `library`, the project file otherwise. */
  path: string;
  checksum: Buffer;
  sizeInBytes: number;
  contentType: string;
  assetType: AssetType;
  originalFileName: string;
  subtitle?: RenderArtifact;
  /** Server-owned pair moves; runs only under the publication's source/claim/version/path locks. */
  files?: { paths: readonly string[]; move: () => Promise<void>; rollback: () => Promise<void> };
};
/** Durable acceptance record. External dispatch has no safe replay without an acknowledgement. */
export type StudioPublicationFollowups = {
  revision: 1;
  metadataAssetId: string | null;
  metadataAccepted: boolean;
  notification: 'pending' | 'dispatching' | 'accepted' | 'needs_attention';
  smoothMotion: 'pending' | 'dispatching' | 'accepted' | 'needs_attention';
  smoothMotionReceipt?: { restorationId: string; operationId: string };
};
type ScheduleStudioNotification = (tx: Transaction<DB>, version: StudioExportVersion, label: string) => Promise<void>;
type ScheduleStudioMetadata = (tx: Transaction<DB>, assetId: string) => Promise<void>;

/** A `project` result the owner saves to their library (FL-194). */
export type StudioExportLibrarySave = Pick<
  StudioExportPublication,
  | 'versionId'
  | 'ownerId'
  | 'sources'
  | 'nsfwHiding'
  | 'path'
  | 'checksum'
  | 'sizeInBytes'
  | 'contentType'
  | 'assetType'
  | 'originalFileName'
>;
type StudioExportAssetInput = Pick<
  StudioExportPublication,
  'ownerId' | 'path' | 'checksum' | 'sizeInBytes' | 'assetType' | 'originalFileName'
>;
export type StudioExportPublished = {
  status: 'published';
  version: StudioExportVersion;
  privacy: DerivativePrivacy;
  /** The asset created for a `library` result. */
  createdAssetId: string | null;
  /** An existing asset of the owner's with the same bytes and at least the same privacy. */
  reusedAssetId: string | null;
};
const isUniqueViolation = (error: unknown): boolean =>
  (
    error as {
      code?: string;
    } | null
  )?.code === '23505';
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
    @InjectKysely()
    private db: Kysely<DB>,
    private privacy: DerivativePrivacyRepository,
  ) {}
  /** Execute the write in a database transaction. */
  private write<T>(query: (db: Kysely<DB>) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(query);
  }
  /* ------------------------------------------------------------------ */
  /* Versions                                                            */
  /* ------------------------------------------------------------------ */
  /**
   * FL-93 / FL-102: what the library already knows about each source's streams — the video time
   * base, colour, packet scan and the audio layout — so an export can declare its cadence, carry
   * each source's timing map and state the audio and precision its result must have. Assets with
   * no video or audio row come back with nulls rather than not at all.
   */
  async getSourceMediaFacts(assetIds: readonly string[]): Promise<StudioSourceMediaFacts[]> {
    if (assetIds.length === 0) {
      return [];
    }
    const rows = await this.db
      .selectFrom('asset')
      .leftJoin('asset_video', 'asset_video.assetId', 'asset.id')
      .leftJoin('asset_keyframe', 'asset_keyframe.assetId', 'asset.id')
      .leftJoin('asset_audio', 'asset_audio.assetId', 'asset.id')
      .select([
        'asset.id as assetId',
        'asset_video.timeBase',
        'asset_video.pixelFormat',
        'asset_video.colorTransfer',
        'asset_keyframe.pts as keyframePts',
        'asset_keyframe.accDuration as keyframeAccDuration',
        'asset_keyframe.ownDuration as keyframeOwnDuration',
        'asset_keyframe.totalDuration',
        'asset_keyframe.packetCount',
        'asset_keyframe.outputFrames',
        'asset_audio.codecName as audioCodecName',
        'asset_audio.channels',
        'asset_audio.channelLayout',
        'asset_audio.sampleRate',
      ])
      .where('asset.id', 'in', [...assetIds])
      .execute();
    return rows.map((row) => ({
      assetId: row.assetId,
      video:
        row.timeBase === null || row.pixelFormat === null
          ? null
          : { timeBase: row.timeBase, pixelFormat: row.pixelFormat, colorTransfer: row.colorTransfer as number },
      packets:
        row.keyframePts === null
          ? null
          : {
              keyframePts: row.keyframePts,
              keyframeAccDuration: row.keyframeAccDuration ?? [],
              keyframeOwnDuration: row.keyframeOwnDuration ?? [],
              totalDuration: Number(row.totalDuration ?? 0),
              packetCount: Number(row.packetCount ?? 0),
              outputFrames: Number(row.outputFrames ?? 0),
            },
      audio:
        row.audioCodecName === null
          ? null
          : {
              codecName: row.audioCodecName,
              channels: row.channels ?? null,
              channelLayout: row.channelLayout ?? null,
              sampleRate: row.sampleRate ?? null,
            },
    }));
  }
  /** The render job and the version it will become, together or not at all. */
  async createWithRender(
    operation: MediaOperationCreate,
    version: Pick<
      Insertable<StudioExportVersionTable>,
      'ownerId' | 'projectId' | 'revision' | 'revisionDigest' | 'destination' | 'settings'
    >,
  ): Promise<{
    operation: MediaOperation;
    version: StudioExportVersion;
  }> {
    return this.db.transaction().execute(async (tx) => {
      await holdSourceAdmission(tx, operation.snapshot);
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
  getForOwner(
    id: string,
    ownerId: string,
    visibility?: StudioExportVisibility,
  ): Promise<StudioExportVersion | undefined> {
    return this.db
      .selectFrom('studio_export_version')
      .selectAll()
      .where('id', '=', id)
      .where('ownerId', '=', ownerId)
      .$if(!!visibility, (qb) => qb.where(sql<boolean>`not ${versionHiddenFrom(visibility!)}`))
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
    page: {
      take: number;
      skip: number;
      visibility: StudioExportVisibility;
    },
  ): Promise<{
    items: StudioExportVersion[];
    total: number;
  }> {
    // A result that inherited a lock, or whose source is hidden from the session now, exists only for
    // a session that may see it (FL-34, FL-195): elsewhere the row is not listed and not counted.
    const query = this.db
      .selectFrom('studio_export_version')
      .where('projectId', '=', projectId)
      .where('ownerId', '=', ownerId)
      .where(sql<boolean>`not ${versionHiddenFrom(page.visibility)}`);
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
      .select(sql<string | null>`"sourceEpoch"::text`.as('sourceEpoch'))
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
      .select(sql<string | null>`"sourceEpoch"::text`.as('sourceEpoch'))
      .where('versionId', '=', versionId)
      .orderBy('key', 'asc')
      .execute() as Promise<StudioExportVersionSource[]>;
  }
  /** Interactive SRT reads use the current session and source epochs, never a worker's background grant. */
  async withSubtitleAccess<T>(
    versionId: string,
    ownerId: string,
    sessionId: string,
    action: (version: StudioExportVersion) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction().execute(async (tx) => {
      const observed = await tx
        .selectFrom('studio_export_version')
        .selectAll()
        .where('id', '=', versionId)
        .where('ownerId', '=', ownerId)
        .executeTakeFirst();
      if (!observed) throw new StudioExportRefusal('source-access-lost', 'Subtitle unavailable');
      if (observed.scope === StudioExportScope.Project) {
        const project = observed.projectId
          ? await tx
              .selectFrom('studio_project')
              .select('id')
              .where('id', '=', observed.projectId)
              .where('ownerId', '=', ownerId)
              .forShare()
              .executeTakeFirst()
          : undefined;
        if (!project) throw new StudioExportRefusal('source-access-lost', 'Subtitle unavailable');
      }
      if (observed.scope === StudioExportScope.Library && !observed.resultAssetId)
        throw new StudioExportRefusal('source-access-lost', 'Subtitle unavailable');
      const scoped = new StudioExportRepository(tx, this.privacy);
      const sources = await scoped.getSources(versionId);
      if (sources.some((s) => s.assetId && (!s.ownerId || s.sourceEpoch === null)))
        throw new StudioExportRefusal('source-access-lost', 'Subtitle source authority unavailable');
      const ids = [
        ...new Set([
          ...sources.flatMap((s) => (s.assetId ? [s.assetId] : [])),
          ...(observed.resultAssetId ? [observed.resultAssetId] : []),
        ]),
      ].sort();
      const evidence = await this.privacy.lockSources(tx, ids);
      await holdSourceAdmission(tx, {
        sourceEpochs: sources
          .filter((s) => s.assetId)
          .map((s) => ({ assetId: s.assetId, ownerId: s.ownerId, epoch: s.sourceEpoch })),
      });
      await tx
        .selectFrom('studio_export_version')
        .select('id')
        .where('id', '=', versionId)
        .forShare()
        .executeTakeFirstOrThrow();
      const auth = await currentAuth(tx, ownerId, sessionId, true);
      if (!auth) throw new StudioExportRefusal('source-access-lost', 'Subtitle unavailable');
      const shared = await this.privacy.lockSharedAccess(tx, ownerId, evidence.values().toArray());
      if (evidence.values().some((row) => row.ownerId !== ownerId && !shared.has(row.assetId)))
        throw new StudioExportRefusal('source-access-lost', 'Subtitle unavailable');
      const afterGrants = await currentAuth(tx, ownerId, sessionId, true);
      if (!afterGrants) throw new StudioExportRefusal('source-access-lost', 'Subtitle unavailable');
      const current = await scoped.getForOwner(versionId, ownerId, {
        ...getHiddenContentQueryOptions(afterGrants),
        revealed: !!getLockedOwnerId(afterGrants),
      });
      const seal = current ? sidecarSealOf(current.settings) : null;
      if (
        !current ||
        current.state !== StudioExportVersionState.Published ||
        current.scope !== observed.scope ||
        current.projectId !== observed.projectId ||
        current.resultAssetId !== observed.resultAssetId ||
        (current.scope === StudioExportScope.Project && !current.projectId) ||
        (current.scope === StudioExportScope.Library && !current.resultAssetId) ||
        !seal ||
        !current.subtitlePath ||
        current.subtitleRemovedAt ||
        current.subtitleChecksum?.toString('hex') !== seal.expectedSrtSha256 ||
        String(current.subtitleSizeInBytes) !== seal.sizeInBytes ||
        canonicalJson(await scoped.getSources(versionId)) !== canonicalJson(sources)
      )
        throw new StudioExportRefusal('source-access-lost', 'Subtitle unavailable');
      const rows = ids.length > 0 ? await new AssetRepository(tx).getByIds(ids) : [];
      if (rows.length !== ids.length || rows.some((row) => row.isOffline || row.deletedAt !== null))
        throw new StudioExportRefusal('source-unavailable', 'Subtitle unavailable');
      const allowed = await checkAccess(new AccessRepository(tx), {
        auth: afterGrants,
        permission: Permission.AssetRead,
        ids: new Set(ids),
      });
      if (ids.some((id) => !allowed.has(id)))
        throw new StudioExportRefusal('source-access-lost', 'Subtitle unavailable');
      const fresh = await currentAuth(tx, ownerId, sessionId, true);
      if (!fresh || !!getLockedOwnerId(fresh) !== !!getLockedOwnerId(afterGrants))
        throw new StudioExportRefusal('source-access-lost', 'Subtitle unavailable');
      return action(current);
    });
  }
  /**
   * Record what a render claim was granted: the worker, its engine and every source with the
   * checksum it may read. Every claim replaces the previous one's list, because the retry reads
   * what is authorized now. Only while the version is still rendering.
   */
  async recordRenderClaim(
    renderOperationId: string,
    claim: {
      workerId: string;
      engineDigest: string | null;
      sources: readonly StudioExportSourceInput[];
    },
  ): Promise<boolean> {
    return this.db.transaction().execute(async (tx) => {
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
      subtitle?: RenderArtifact;
    },
    publish: (version: StudioExportVersion) => MediaOperationCreate,
    requireActiveClaim = false,
  ): Promise<
    | {
        version: StudioExportVersion;
        operation: MediaOperation;
      }
    | undefined
  > {
    return this.db.transaction().execute(async (tx) => {
      const observed = await tx
        .selectFrom('media_operation')
        .select('snapshot')
        .where('id', '=', renderOperationId)
        .executeTakeFirst();
      if (observed) await holdSourceAdmission(tx, observed.snapshot);
      if (!claimToken || !(await this.lockClaim(tx, renderOperationId, claimToken, requireActiveClaim))) {
        return;
      }
      const version = (await tx
        .selectFrom('studio_export_version')
        .selectAll()
        .where('renderOperationId', '=', renderOperationId)
        .where('state', '=', StudioExportVersionState.Rendering)
        .forUpdate()
        .executeTakeFirst()) as StudioExportVersion | undefined;
      if (!version || (requireActiveClaim && !(await this.lockClaim(tx, renderOperationId, claimToken, true)))) {
        return;
      }
      const seal = sidecarSealOf(version.settings);
      if (
        seal &&
        (!output.subtitle ||
          output.subtitle.outputChecksum.toString('hex') !== seal.expectedSrtSha256 ||
          String(output.subtitle.sizeInBytes) !== seal.sizeInBytes)
      )
        throw new StudioExportRefusal('output-rejected', 'The required subtitle sibling is unavailable');
      if (!seal && output.subtitle) throw new StudioExportRefusal('output-rejected', 'Unexpected subtitle sibling');
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
          subtitlePath: output.subtitle?.outputPath ?? null,
          subtitleChecksum: output.subtitle?.outputChecksum ?? null,
          subtitleSizeInBytes: output.subtitle ? String(output.subtitle.sizeInBytes) : null,
          publishOperationId: operation.id,
          updatedAt: sql<Date>`now()`,
        })
        .where('id', '=', version.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      if (requireActiveClaim && !(await this.lockClaim(tx, renderOperationId, claimToken, true)))
        throw new StudioExportRefusal('claim-lost', 'The render claim expired during staging');
      return { version: staged as unknown as StudioExportVersion, operation: operation as unknown as MediaOperation };
    });
  }
  /** End a pending version as failed. A published version is never touched. */
  async markFailed(
    id: string,
    failure: {
      errorCode: string;
      error: string;
    },
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
  async cancel(
    id: string,
    reason: {
      errorCode: string;
      error: string;
    },
  ): Promise<StudioExportVersion | undefined> {
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
  private async lockClaim(
    tx: Kysely<DB>,
    operationId: string,
    claimToken: string,
    requireActiveClaim = false,
  ): Promise<boolean> {
    const held = await tx
      .selectFrom('media_operation')
      .select('id')
      .where('id', '=', operationId)
      .where('claimToken', '=', claimToken)
      .where('status', '=', MediaOperationStatus.Validating)
      .$if(requireActiveClaim, (qb) =>
        qb
          .where('claimExpiresAt', '>', sql<Date>`clock_timestamp()`)
          .where('cancelRequestedAt', 'is', null)
          .where('pauseRequestedAt', 'is', null),
      )
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
   *   2. the owner (share-locked) must not be deleted, and the project (locked for the version
   *      number) must be theirs and not in the trash;
   *   3. every library source is share-locked and must still exist, be out of the trash, be online
   *      and have the checksum the render read; a source of somebody else's must still be shared
   *      with the owner, with the granting rows share-locked;
   *   4. the union of the sources' Locked and sensitive evidence, read under those locks, is
   *      computed and must put the result where the service prepared its file;
   *   5. a `library` result becomes an asset with that privacy installed before the transaction
   *      commits — or, when the owner already has these exact bytes restricted at least as much,
   *      that asset is referenced instead; a `project` result keeps its file with the version;
   *   6. the version is numbered, its provenance completed and it is marked `published`;
   *   7. supplied metadata and notification schedulers enqueue in this transaction, the claim
   *      is rechecked, and the operation records the durable follow-up checkpoint.
   *
   * Any refusal throws {@link StudioExportRefusal} and rolls everything back. Publishing a version
   * this job already published answers with it again, so a retry after an uncertain commit is safe.
   */
  async publish(
    input: StudioExportPublication,
    scheduleMetadata?: ScheduleStudioMetadata,
    scheduleNotification?: ScheduleStudioNotification,
  ): Promise<StudioExportPublished> {
    return this.db.transaction().execute(async (tx) => {
      for (const path of [...new Set(input.files?.paths)].sort()) await lockFilePath(tx, path);
      if (
        input.subtitle &&
        input.sources.some(
          (row) => row.assetId && (!row.ownerId || row.sourceEpoch === null || row.sourceEpoch === undefined),
        )
      )
        throw new StudioExportRefusal('source-access-lost', 'Required subtitle source epoch is unavailable');
      await holdSourceAdmission(tx, {
        sourceEpochs: input.sources
          .filter((row) => row.assetId && row.ownerId && row.sourceEpoch !== null && row.sourceEpoch !== undefined)
          .map((row) => ({ assetId: row.assetId, ownerId: row.ownerId, epoch: String(row.sourceEpoch) })),
      });
      if (!(await this.lockClaim(tx, input.operationId, input.claimToken, true))) {
        throw new StudioExportRefusal('claim-lost', 'The publication claim is no longer validating');
      }
      const version = (await tx
        .selectFrom('studio_export_version')
        .selectAll()
        .where('id', '=', input.versionId)
        .forUpdate()
        .executeTakeFirst()) as StudioExportVersion | undefined;
      if (version?.state === StudioExportVersionState.Published && version.publishOperationId === input.operationId) {
        const sealed = sidecarSealOf(version.settings);
        if (
          sealed &&
          (!input.subtitle ||
            !version.subtitleChecksum ||
            !version.outputChecksum ||
            version.subtitleRemovedAt ||
            input.subtitle.outputPath !== version.subtitlePath ||
            !input.subtitle.outputChecksum.equals(version.subtitleChecksum!) ||
            input.subtitle.outputChecksum.toString('hex') !== sealed.expectedSrtSha256 ||
            String(input.subtitle.sizeInBytes) !== String(version.subtitleSizeInBytes) ||
            String(input.subtitle.sizeInBytes) !== sealed.sizeInBytes ||
            !input.checksum.equals(version.outputChecksum!) ||
            String(input.sizeInBytes) !== String(version.outputSizeInBytes))
        )
          throw new StudioExportRefusal('output-rejected', 'Published pair identity changed');
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

      const seal = sidecarSealOf(version.settings);
      if (
        seal &&
        (!input.subtitle ||
          input.subtitle.outputChecksum.toString('hex') !== seal.expectedSrtSha256 ||
          String(input.subtitle.sizeInBytes) !== seal.sizeInBytes)
      )
        throw new StudioExportRefusal('output-rejected', 'The required subtitle sibling changed');
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
      const privacy = await this.lockSourcePrivacy(tx, input);
      const scope = input.retainInProject ? StudioExportScope.Project : privacy.union.scope;
      if (scope !== input.expectedScope) {
        throw new StudioExportRefusal('scope-changed', 'The sources of this export changed hands');
      }
      if (!(await this.lockClaim(tx, input.operationId, input.claimToken, true)))
        throw new StudioExportRefusal('claim-lost', 'The publication claim expired while checking sources');
      try {
        await input.files?.move();
        const { createdAssetId, reusedAssetId } =
          scope === StudioExportScope.Library
            ? await this.adoptLibraryAsset(tx, input, privacy.union)
            : { createdAssetId: null, reusedAssetId: null };
        const next = await tx
          .selectFrom('studio_export_version')
          .select((eb) => sql<number>`coalesce(max(${eb.ref('version')}), 0) + 1`.as('next'))
          .where('projectId', '=', project.id)
          .executeTakeFirstOrThrow();
        for (const row of privacy.evidence) {
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
            scope,
            resultAssetId: createdAssetId ?? reusedAssetId,
            outputPath: reusedAssetId ? null : input.path,
            subtitlePath: input.subtitle?.outputPath ?? null,
            subtitleChecksum: input.subtitle?.outputChecksum ?? null,
            subtitleSizeInBytes: input.subtitle ? String(input.subtitle.sizeInBytes) : null,
            outputChecksum: input.checksum,
            outputSizeInBytes: input.sizeInBytes,
            privacy: { ...privacy.union, scope } as unknown as Record<string, unknown>,
            publishedAt: sql<Date>`now()`,
            updatedAt: sql<Date>`now()`,
            errorCode: null,
            error: null,
          })
          .where('id', '=', version.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        const operation = await tx
          .selectFrom('media_operation')
          .select(['snapshot', 'result', 'label'])
          .where('id', '=', input.operationId)
          .executeTakeFirstOrThrow();
        if (createdAssetId && scheduleMetadata) await scheduleMetadata(tx, createdAssetId);
        if (scheduleNotification) await scheduleNotification(tx, published as StudioExportVersion, operation.label);
        if (!(await this.lockClaim(tx, input.operationId, input.claimToken, true))) {
          throw new StudioExportRefusal('claim-lost', 'The publication claim expired during queue admission');
        }
        const followups: StudioPublicationFollowups = {
          revision: 1,
          metadataAssetId: createdAssetId,
          metadataAccepted: !createdAssetId || !!scheduleMetadata,
          notification: scheduleNotification ? 'accepted' : 'pending',
          smoothMotion: operation.snapshot.smoothMotion ? 'pending' : 'accepted',
        };
        await tx
          .updateTable('media_operation')
          .set({
            resultAssetId: createdAssetId ?? reusedAssetId,
            result: { ...operation.result, studioPublication: followups },
          })
          .where('id', '=', input.operationId)
          .execute();
        return {
          status: 'published',
          version: published as unknown as StudioExportVersion,
          privacy: { ...privacy.union, scope },
          createdAssetId,
          reusedAssetId,
        };
      } catch (error) {
        // Transaction failure has not committed: undo while the same authority and paths remain held.
        try {
          await input.files?.rollback();
        } catch (error_) {
          throw new AggregateError([error, error_], 'Publication failed and paired file recovery is pending', {
            cause: error_,
          });
        }
        throw error;
      }
    });
  }
  /** A lost COMMIT acknowledgement never authorizes an unguarded reverse move. */
  async restorePublicationFiles(
    input: Pick<StudioExportPublication, 'versionId' | 'operationId' | 'claimToken' | 'sources'>,
    files: NonNullable<StudioExportPublication['files']>,
  ): Promise<boolean> {
    return this.db.transaction().execute(async (tx) => {
      for (const path of [...new Set(files.paths)].sort()) await lockFilePath(tx, path);
      await holdSourceAdmission(tx, {
        sourceEpochs: input.sources
          .filter((s) => s.assetId && s.ownerId && s.sourceEpoch !== null && s.sourceEpoch !== undefined)
          .map((s) => ({ assetId: s.assetId, ownerId: s.ownerId, epoch: s.sourceEpoch })),
      });
      if (!(await this.lockClaim(tx, input.operationId, input.claimToken, true))) return false;
      const version = await tx
        .selectFrom('studio_export_version')
        .select(['state', 'publishOperationId'])
        .where('id', '=', input.versionId)
        .forUpdate()
        .executeTakeFirst();
      if (version?.state !== StudioExportVersionState.Staged || version.publishOperationId !== input.operationId)
        return false;
      if (!(await this.lockClaim(tx, input.operationId, input.claimToken, true))) return false;
      await files.rollback();
      return true;
    });
  }
  /** Replay database-only scheduling under the same claim; never re-publish an accepted version. */
  async publicationFollowups(
    operationId: string,
    claimToken: string,
    scheduleMetadata: ScheduleStudioMetadata,
    scheduleNotification: ScheduleStudioNotification,
  ) {
    return this.db.transaction().execute(async (tx) => {
      if (!(await this.lockClaim(tx, operationId, claimToken, true))) {
        throw new StudioExportRefusal('claim-lost', 'The publication follow-up claim expired');
      }
      const operation = await tx
        .selectFrom('media_operation')
        .select(['result', 'label'])
        .where('id', '=', operationId)
        .executeTakeFirstOrThrow();
      const followups = operation.result?.studioPublication as StudioPublicationFollowups | undefined;
      // Old publications have no evidence that external effects were delivered. Never invent it.
      if (followups?.revision !== 1) return null;
      if (!followups.metadataAccepted && followups.metadataAssetId) {
        await scheduleMetadata(tx, followups.metadataAssetId);
        followups.metadataAccepted = true;
        await tx
          .updateTable('media_operation')
          .set({ result: { ...operation.result, studioPublication: followups } })
          .where('id', '=', operationId)
          .execute();
      }
      if (followups.notification === 'pending') {
        const version = await tx
          .selectFrom('studio_export_version')
          .selectAll()
          .where('publishOperationId', '=', operationId)
          .where('state', '=', StudioExportVersionState.Published)
          .executeTakeFirstOrThrow();
        await scheduleNotification(tx, version as StudioExportVersion, operation.label);
        followups.notification = 'accepted';
        await tx
          .updateTable('media_operation')
          .set({ result: { ...operation.result, studioPublication: followups } })
          .where('id', '=', operationId)
          .execute();
      }
      if (!(await this.lockClaim(tx, operationId, claimToken, true))) {
        throw new StudioExportRefusal('claim-lost', 'The publication follow-up claim expired during queue admission');
      }
      return followups;
    });
  }

  /** A committed dispatch marker fences non-idempotent effects across crashes and lease replacement. */
  async transitionPublicationFollowup(
    operationId: string,
    claimToken: string,
    effect: 'notification' | 'smoothMotion',
    expected: StudioPublicationFollowups['notification'],
    next: StudioPublicationFollowups['notification'],
    receipt?: StudioPublicationFollowups['smoothMotionReceipt'],
  ): Promise<boolean> {
    const updated = await this.db
      .updateTable('media_operation')
      .set({
        result: sql<
          Record<string, unknown>
        >`jsonb_set(result, '{studioPublication}', (result->'studioPublication') || ${JSON.stringify({ [effect]: next, ...(receipt && { smoothMotionReceipt: receipt }) })}::text::jsonb)`,
      })
      .where('id', '=', operationId)
      .where('claimToken', '=', claimToken)
      .where('status', '=', MediaOperationStatus.Validating)
      .where('claimExpiresAt', '>', sql<Date>`clock_timestamp()`)
      .where('cancelRequestedAt', 'is', null)
      .where('pauseRequestedAt', 'is', null)
      .where(sql<string>`result->'studioPublication'->>${effect}`, '=', expected)
      .returning('id')
      .executeTakeFirst();
    return !!updated;
  }

  /** Failed operation, successful publication: never turn uncertainty into automatic duplicate effects. */
  async publicationNeedsAttention(operationId: string, claimToken: string): Promise<void> {
    await this.db
      .updateTable('media_operation')
      .set({
        result: sql<Record<string, unknown>>`coalesce(result, '{}'::jsonb) || '{"status":"needs_attention"}'::jsonb`,
      })
      .where('id', '=', operationId)
      .where('claimToken', '=', claimToken)
      .where('claimExpiresAt', '>', sql<Date>`clock_timestamp()`)
      .where('status', '=', MediaOperationStatus.Validating)
      .execute();
  }

  /**
   * Save a published `project` result to its owner's library (FL-194), atomically: the version is
   * locked, every library source is re-checked under locks
   * as at publication and must still make a `library` result (the owner's own, none gone), and the
   * file becomes an asset with the sources' privacy installed — or the owner's existing asset with
   * the same bytes, restricted at least as much, is referenced. A version already in the library
   * answers with itself.
   */
  async saveToLibrary(input: StudioExportLibrarySave): Promise<{
    version: StudioExportVersion;
    createdAssetId: string | null;
    reusedAssetId: string | null;
  }> {
    return this.db.transaction().execute(async (tx) => {
      const version = (await tx
        .selectFrom('studio_export_version')
        .selectAll()
        .where('id', '=', input.versionId)
        .where('ownerId', '=', input.ownerId)
        .forUpdate()
        .executeTakeFirst()) as StudioExportVersion | undefined;
      if (version?.state === StudioExportVersionState.Published && version.scope === StudioExportScope.Library) {
        return { version, createdAssetId: null, reusedAssetId: null };
      }
      if (
        !version ||
        version.state !== StudioExportVersionState.Published ||
        version.scope !== StudioExportScope.Project ||
        !version.outputPath ||
        version.outputRemovedAt
      ) {
        throw new StudioExportRefusal('not-staged', 'This export has no file to save');
      }

      const privacy = await this.lockSourcePrivacy(tx, input);
      if (privacy.union.scope !== StudioExportScope.Library) {
        throw new StudioExportRefusal('source-access-lost', 'A result made with shared media stays with its project');
      }
      const { createdAssetId, reusedAssetId } = await this.adoptLibraryAsset(tx, input, privacy.union);
      const saved = await tx
        .updateTable('studio_export_version')
        .set({
          scope: StudioExportScope.Library,
          resultAssetId: createdAssetId ?? reusedAssetId,
          outputPath: reusedAssetId ? null : input.path,
          privacy: privacy.union as unknown as Record<string, unknown>,
          updatedAt: sql<Date>`now()`,
        })
        .where('id', '=', version.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return { version: saved as unknown as StudioExportVersion, createdAssetId, reusedAssetId };
    });
  }
  /**
   * Share-lock every library source and read the union of their Locked and sensitive evidence. A
   * source gone, in the trash, offline or with another checksum refuses; a source of somebody
   * else's must still be shared with the owner.
   */
  private async lockSourcePrivacy(
    tx: Kysely<DB>,
    input: Pick<StudioExportPublication, 'ownerId' | 'sources' | 'nsfwHiding'>,
  ): Promise<{
    union: DerivativePrivacy;
    evidence: LockedSourceRow[];
  }> {
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
    const union = unionDerivativePrivacy(
      input.ownerId,
      evidence.map((row): DerivativeSourceEvidence => ({
        assetId: row.assetId,
        ownerId: row.ownerId,
        lockReason: row.lockReason,
        sensitive: row.sensitive,
      })),
      { nsfwHiding: input.nsfwHiding },
    );
    return { union, evidence };
  }
  /**
   * The result as an asset of the owner's: an existing asset with the same bytes and at least the
   * same restrictions, or a new one.
   */
  private async adoptLibraryAsset(
    tx: Kysely<DB>,
    input: StudioExportAssetInput,
    privacy: DerivativePrivacy,
  ): Promise<{
    createdAssetId: string | null;
    reusedAssetId: string | null;
  }> {
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
      return { createdAssetId: null, reusedAssetId: duplicate.id };
    }
    return { createdAssetId: await this.createAsset(tx, input, privacy), reusedAssetId: null };
  }
  /** Library and audio-of-asset sources carry the asset checksum; an edited master carries its own. */
  private checksumBearing(kind: string): boolean {
    return kind === 'library-asset' || kind === 'audio';
  }
  /**
   * The result as a new asset of the owner's, with its privacy installed in the same transaction
   * before anything can list it. Quota is charged here, guarded, so a full account refuses instead
   * of going over. The asset is never linked to another account's physical file: publication only
   * adds a file, it never changes what an existing original or a deduplication reference points at.
   */
  private async createAsset(tx: Kysely<DB>, input: StudioExportAssetInput, privacy: DerivativePrivacy) {
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
    return assetId;
  }
  /* ------------------------------------------------------------------ */
  /* Sweeps                                                              */
  /* ------------------------------------------------------------------ */
  /**
   * Pending versions whose premise went away: the owner is being deleted, the project is gone or
   * in the trash, or a recorded library source is gone, in the trash or offline.
   * The sweep cancels them and their jobs.
   */
  async listOrphanedWork(limit = 200): Promise<
    Array<
      StudioExportVersion & {
        orphanReason: StudioExportRefusalCode;
      }
    >
  > {
    const rows = await sql<
      StudioExportVersion & {
        orphanReason: StudioExportRefusalCode;
      }
    >`
      SELECT version.*,
        CASE
          WHEN owner."deletedAt" IS NOT NULL THEN 'owner-unavailable'
          WHEN project.id IS NULL OR project."deletedAt" IS NOT NULL THEN 'project-unavailable'
          ELSE 'source-unavailable'
        END AS "orphanReason"
      FROM studio_export_version version
      JOIN "user" owner ON owner.id = version."ownerId"
      LEFT JOIN studio_project project ON project.id = version."projectId"
      WHERE version.state = ANY(${[...PENDING_STUDIO_EXPORT_STATES]}::text[])
        AND (
          owner."deletedAt" IS NOT NULL
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
  async listSettledWork(limit = 200): Promise<
    Array<
      StudioExportVersion & {
        jobStatus: string | null;
      }
    >
  > {
    const { rows } = await sql<
      StudioExportVersion & {
        jobStatus: string | null;
      }
    >`
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
  async listRemovableOutputs(limit = 200): Promise<(StudioExportVersion & { role: 'media' | 'subtitle' })[]> {
    const { rows } = await sql<StudioExportVersion & { role: 'media' | 'subtitle' }>`SELECT * FROM (
      SELECT version.*, 'media'::text AS role FROM studio_export_version version
      WHERE "outputPath" IS NOT NULL AND "outputRemovedAt" IS NULL AND
        (state IN ('failed','cancelled') OR (state='published' AND scope='project' AND "projectId" IS NULL))
      UNION ALL SELECT version.*, 'subtitle'::text AS role FROM studio_export_version version
      WHERE "subtitlePath" IS NOT NULL AND "subtitleRemovedAt" IS NULL AND
        (state IN ('failed','cancelled') OR (state='published' AND
          ((scope='project' AND "projectId" IS NULL) OR (scope='library' AND "resultAssetId" IS NULL))))
    ) retired ORDER BY "updatedAt",id,role LIMIT ${limit}`.execute(this.db);
    return rows;
  }
  /** The output row is durable cleanup intent until its exact, unreferenced file is removed. */
  async markOutputRemoved(
    id: string,
    unlink: (version: StudioExportVersion) => Promise<void>,
    role: 'media' | 'subtitle' = 'media',
  ): Promise<boolean> {
    const version = await this.db
      .selectFrom('studio_export_version')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    const path = role === 'subtitle' ? version?.subtitlePath : version?.outputPath;
    if (!version || !path) return false;
    const result = await new PhysicalFileRepository(this.db).deleteUnreferencedPath(path, () => unlink(version), {
      retiredStudioExport: {
        id: version.id,
        ownerId: version.ownerId,
        role,
        checksum: role === 'subtitle' ? version.subtitleChecksum : version.outputChecksum,
        sizeBytes: role === 'subtitle' ? version.subtitleSizeInBytes : version.outputSizeInBytes,
      },
    });
    return result.deleted;
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
