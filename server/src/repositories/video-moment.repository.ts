import { Injectable } from '@nestjs/common';
import { Insertable, Kysely, Selectable, Updateable, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { HiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { AssetStatus, AssetType, AssetVisibility, VectorIndex, VideoMomentSource } from 'src/enum.js';
import { probes } from 'src/repositories/database.repository.js';
import { DB } from 'src/schema/index.js';
import {
  VideoMomentFrameTable,
  VideoMomentIndexTable,
  VideoMomentTable,
} from 'src/schema/tables/video-moment.table.js';
import { anyUuid, asUuid, withHiddenContentFilter, withVideoFormat, withVideoStream } from 'src/utils/database.js';
import { sourceFingerprint } from 'src/utils/enrichment-plan.js';
import { notLockedOrOwnedBy } from 'src/utils/locked.js';

export type VideoMomentIndex = Selectable<VideoMomentIndexTable>;
export type VideoMomentFrame = Selectable<VideoMomentFrameTable>;
export type VideoMoment = Selectable<VideoMomentTable>;

export type VideoMomentFrameInsert = Pick<
  Insertable<VideoMomentFrameTable>,
  'frameIndex' | 'timestampMs' | 'path' | 'width' | 'height' | 'score' | 'rank'
>;

export type VideoMomentIndexPatch = Omit<Updateable<VideoMomentIndexTable>, 'assetId' | 'createdAt' | 'updatedAt'>;

/** What the frame cutter and the fingerprint need to know about a video. */
export type VideoMomentSourceRow = NonNullable<Awaited<ReturnType<VideoMomentRepository['getVideoSource']>>>;

export type VideoMomentSearchHit = {
  assetId: string;
  frameId: string;
  /** The frame's generated moment, when it has one. */
  momentId: string | null;
  timestampMs: number;
  distance: number;
  caption: string | null;
};

export type VideoMomentTextHit = {
  assetId: string;
  momentId: string;
  timestampMs: number;
  source: VideoMomentSource;
  caption: string | null;
  transcript: string | null;
};

export type VideoMomentSearchScope = {
  /** The library searched. */
  ownerId: string;
  /** The same owner, only when their session is unlocked; otherwise Locked videos are left out. */
  lockedOwnerId?: string;
  /** The session's hidden-content filter: suppressed people, pets and tags, and sensitive media while locked. */
  privacy?: HiddenContentQueryOptions;
  limit: number;
  /** A frame never returned: the one a frame-to-moment search started from. */
  excludeFrameId?: string;
};

/**
 * Reusable video frames, their embeddings and the timestamped moments of a video (FL-59).
 *
 * Generated results (frames, embeddings, generated moments) and manual ones (the owner's moments,
 * transcripts and cover choice) live side by side and are written by different methods on purpose:
 * nothing that replaces generated results ever deletes a manual moment.
 */
@Injectable()
export class VideoMomentRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /** A video with the stream and format the frame cutter needs, and the columns its fingerprint uses. */
  getVideoSource(assetId: string, db: Kysely<DB> = this.db) {
    return db
      .selectFrom('asset')
      .innerJoin('asset_video', 'asset_video.assetId', 'asset.id')
      .innerJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .select([
        'asset.id',
        'asset.ownerId',
        'asset.type',
        'asset.status',
        'asset.deletedAt',
        'asset.visibility',
        'asset.originalPath',
        'asset.checksum',
        'asset.fileModifiedAt',
        'asset.duration',
      ])
      .select((eb) => withVideoStream(eb).$notNull().as('videoStream'))
      .select((eb) => withVideoFormat(eb).$notNull().as('format'))
      .where('asset.id', '=', asUuid(assetId))
      .where('asset.type', '=', sql.lit(AssetType.Video))
      .executeTakeFirst();
  }

  /** The current fingerprint of each asset's original. Assets that no longer exist are left out. */
  async getFingerprints(assetIds: string[], db: Kysely<DB> = this.db): Promise<Map<string, string>> {
    if (assetIds.length === 0) {
      return new Map();
    }
    const rows = await db
      .selectFrom('asset')
      .select(['asset.id', 'asset.checksum', 'asset.originalPath', 'asset.fileModifiedAt'])
      .where('asset.id', '=', anyUuid(assetIds))
      .execute();
    return new Map(rows.map((row) => [row.id, sourceFingerprint(row as Parameters<typeof sourceFingerprint>[0])]));
  }

  /**
   * Whether the frames on record were cut from the original as it is now, read inside the caller's
   * transaction. Holds off a replacement of the original until the caller commits, as `replaceFrames`
   * does, so embeddings or captions of frames from a replaced original are never published.
   */
  private async framesMatchSource(trx: Kysely<DB>, assetId: string): Promise<boolean> {
    const current = await trx
      .selectFrom('asset')
      .select(['asset.checksum', 'asset.fileModifiedAt'])
      .where('asset.id', '=', asUuid(assetId))
      .forShare()
      .executeTakeFirst();
    const index = await trx
      .selectFrom('video_moment_index')
      .select('sourceFingerprint')
      .where('assetId', '=', asUuid(assetId))
      .executeTakeFirst();
    return (
      !!current &&
      !!index &&
      sourceFingerprint(current as Parameters<typeof sourceFingerprint>[0]) === index.sourceFingerprint
    );
  }

  /** Kind and owner of each asset, for a plan deciding which stages apply. Missing assets are left out. */
  async getAssetKinds(assetIds: string[]): Promise<Map<string, { type: AssetType; ownerId: string }>> {
    if (assetIds.length === 0) {
      return new Map();
    }
    const rows = await this.db
      .selectFrom('asset')
      .select(['asset.id', 'asset.type', 'asset.ownerId'])
      .where('asset.id', '=', anyUuid(assetIds))
      .execute();
    return new Map(rows.map((row) => [row.id, { type: row.type as AssetType, ownerId: row.ownerId }]));
  }

  /**
   * One cut of one video's frames at a time, across every worker and process (FL-59). A description
   * job and a plan can reach the same video together; without this the second publish would delete
   * the files the first had just handed to its caller. A session advisory lock on its own connection,
   * held for the cut (six seeks at most), keyed apart from the asset metadata lock.
   */
  withFrameLock<R>(assetId: string, callback: () => Promise<R>): Promise<R> {
    return this.db.connection().execute(async (connection) => {
      await sql`SELECT pg_advisory_lock(-59, hashtext(${assetId})::int)`.execute(connection);
      try {
        return await callback();
      } finally {
        await sql`SELECT pg_advisory_unlock(-59, hashtext(${assetId})::int)`.execute(connection);
      }
    });
  }

  getIndex(assetId: string): Promise<VideoMomentIndex | undefined> {
    return this.db
      .selectFrom('video_moment_index')
      .selectAll()
      .where('assetId', '=', asUuid(assetId))
      .executeTakeFirst() as Promise<VideoMomentIndex | undefined>;
  }

  async updateIndex(assetId: string, patch: VideoMomentIndexPatch): Promise<void> {
    await this.db.updateTable('video_moment_index').set(patch).where('assetId', '=', asUuid(assetId)).execute();
  }

  getFrames(assetId: string): Promise<VideoMomentFrame[]> {
    return this.db
      .selectFrom('video_moment_frame')
      .selectAll()
      .where('assetId', '=', asUuid(assetId))
      .orderBy('frameIndex', 'asc')
      .execute() as Promise<VideoMomentFrame[]>;
  }

  /** One frame with the owner of its video, for access checks before serving it. */
  getFrame(frameId: string) {
    return this.db
      .selectFrom('video_moment_frame')
      .innerJoin('asset', 'asset.id', 'video_moment_frame.assetId')
      .select([
        'video_moment_frame.id',
        'video_moment_frame.assetId',
        'video_moment_frame.path',
        'video_moment_frame.timestampMs',
        'asset.ownerId',
      ])
      .where('video_moment_frame.id', '=', asUuid(frameId))
      .executeTakeFirst();
  }

  /**
   * A frame's stored search embedding and the model it came from, with its video, for a search that
   * starts from the frame (FL-59). Undefined when the frame has not been indexed.
   */
  @GenerateSql({ params: [DummyValue.UUID] })
  getFrameEmbedding(frameId: string) {
    return this.db
      .selectFrom('video_moment_frame_embedding')
      .innerJoin('video_moment_frame', 'video_moment_frame.id', 'video_moment_frame_embedding.frameId')
      .select([
        'video_moment_frame.assetId',
        'video_moment_frame_embedding.embedding',
        'video_moment_frame_embedding.modelName',
      ])
      .where('video_moment_frame_embedding.frameId', '=', asUuid(frameId))
      .executeTakeFirst();
  }

  /** Frames that already have a search embedding from this model. */
  async getIndexedFrameIds(assetId: string, modelName: string): Promise<Set<string>> {
    const rows = await this.db
      .selectFrom('video_moment_frame_embedding')
      .innerJoin('video_moment_frame', 'video_moment_frame.id', 'video_moment_frame_embedding.frameId')
      .select('video_moment_frame_embedding.frameId')
      .where('video_moment_frame.assetId', '=', asUuid(assetId))
      .where('video_moment_frame_embedding.modelName', '=', modelName)
      .execute();
    return new Set(rows.map(({ frameId }) => frameId));
  }

  /**
   * Swap in a new set of frames, atomically, only if the original is still the one they were cut
   * from. The fingerprint is read again inside the transaction: a replacement that landed while the
   * frames were being cut must not be published as its frames.
   *
   * Generated moments go with the old frames; manual moments stay, losing only their frame link.
   * The index row keeps the owner's cover choice. Returns the files the old frames used, for the
   * caller to delete, or `source-changed` when nothing was written.
   */
  async replaceFrames(
    assetId: string,
    expectedFingerprint: string,
    frames: VideoMomentFrameInsert[],
    index: { extractorVersion: string },
  ): Promise<{ status: 'replaced'; stalePaths: string[]; frames: VideoMomentFrame[] } | { status: 'source-changed' }> {
    return this.db.transaction().execute(async (trx) => {
      const current = await trx
        .selectFrom('asset')
        .select(['asset.id', 'asset.checksum', 'asset.originalPath', 'asset.fileModifiedAt'])
        .where('asset.id', '=', asUuid(assetId))
        // Holds off a replacement of the original until the new frames are in.
        .forShare()
        .executeTakeFirst();
      if (!current || sourceFingerprint(current as Parameters<typeof sourceFingerprint>[0]) !== expectedFingerprint) {
        return { status: 'source-changed' as const };
      }

      await trx
        .deleteFrom('video_moment')
        .where('assetId', '=', asUuid(assetId))
        .where('source', '=', VideoMomentSource.Generated)
        .execute();
      const removed = await trx
        .deleteFrom('video_moment_frame')
        .where('assetId', '=', asUuid(assetId))
        .returning('path')
        .execute();

      const inserted =
        frames.length > 0
          ? ((await trx
              .insertInto('video_moment_frame')
              .values(frames.map((frame) => ({ ...frame, assetId })))
              .returningAll()
              .execute()) as VideoMomentFrame[])
          : [];

      await trx
        .insertInto('video_moment_index')
        .values({
          assetId,
          sourceFingerprint: expectedFingerprint,
          extractorVersion: index.extractorVersion,
          frameCount: inserted.length,
          framesExtractedAt: sql<Date>`now()`,
        })
        .onConflict((oc) =>
          oc.column('assetId').doUpdateSet({
            sourceFingerprint: expectedFingerprint,
            extractorVersion: index.extractorVersion,
            frameCount: inserted.length,
            framesExtractedAt: sql<Date>`now()`,
            // Everything generated from the old frames is gone with them.
            embeddingModel: null,
            embeddingDestinationId: null,
            indexedAt: null,
            captionModel: null,
            captionConfigHash: null,
            captionIdentityHash: null,
            captionDestinationId: null,
            captionedAt: null,
          }),
        )
        .execute();

      const kept = new Set(inserted.map(({ path }) => path));
      return {
        status: 'replaced' as const,
        stalePaths: removed.map(({ path }) => path).filter((path) => !kept.has(path)),
        frames: [...inserted].sort((a, b) => a.frameIndex - b.frameIndex),
      };
    });
  }

  /**
   * Drop every generated result of a video whose original changed (FL-59): frames, their
   * embeddings and generated moments. Manual moments, transcripts and the cover choice stay. The
   * index row records the new fingerprint with no frames, so the next plan knows to cut them again.
   */
  async invalidateGenerated(assetId: string, newFingerprint: string): Promise<string[]> {
    return this.db.transaction().execute(async (trx) => {
      await trx
        .deleteFrom('video_moment')
        .where('assetId', '=', asUuid(assetId))
        .where('source', '=', VideoMomentSource.Generated)
        .execute();
      const removed = await trx
        .deleteFrom('video_moment_frame')
        .where('assetId', '=', asUuid(assetId))
        .returning('path')
        .execute();
      await trx
        .updateTable('video_moment_index')
        .set({
          sourceFingerprint: newFingerprint,
          frameCount: 0,
          framesExtractedAt: null,
          embeddingModel: null,
          embeddingDestinationId: null,
          indexedAt: null,
          captionModel: null,
          captionConfigHash: null,
          captionIdentityHash: null,
          captionDestinationId: null,
          captionedAt: null,
        })
        .where('assetId', '=', asUuid(assetId))
        .execute();
      return removed.map(({ path }) => path);
    });
  }

  /**
   * Store frame embeddings and make sure every frame has its generated moment, only while the
   * frames are still the ones the embeddings were computed from: a frame replaced in the meantime
   * has a new id, so its stale embedding matches nothing and is not written. Nothing is written
   * either when the original was replaced after the frames were cut and before they were invalidated.
   */
  async publishIndex(
    assetId: string,
    embeddings: { frameId: string; embedding: string }[],
    patch: { embeddingModel: string; embeddingDestinationId: string | null },
  ): Promise<number> {
    return this.db.transaction().execute(async (trx) => {
      if (!(await this.framesMatchSource(trx, assetId))) {
        return 0;
      }
      const frames = await trx
        .selectFrom('video_moment_frame')
        .select(['id', 'timestampMs'])
        .where('assetId', '=', asUuid(assetId))
        .forUpdate()
        .execute();
      const current = new Map(frames.map((frame) => [frame.id, frame]));
      const rows = embeddings.filter(({ frameId }) => current.has(frameId));
      if (rows.length === 0) {
        return 0;
      }

      await trx
        .insertInto('video_moment_frame_embedding')
        .values(rows.map((row) => ({ ...row, modelName: patch.embeddingModel })))
        .onConflict((oc) =>
          oc.column('frameId').doUpdateSet((eb) => ({
            embedding: eb.ref('excluded.embedding'),
            modelName: eb.ref('excluded.modelName'),
          })),
        )
        .execute();

      const existing = await trx
        .selectFrom('video_moment')
        .select('frameId')
        .where('assetId', '=', asUuid(assetId))
        .where('source', '=', VideoMomentSource.Generated)
        .execute();
      const withMoment = new Set(existing.map(({ frameId }) => frameId));
      const missing = frames.filter(({ id }) => !withMoment.has(id));
      if (missing.length > 0) {
        await trx
          .insertInto('video_moment')
          .values(
            missing.map((frame) => ({
              assetId,
              source: VideoMomentSource.Generated,
              timestampMs: frame.timestampMs,
              frameId: frame.id,
            })),
          )
          .execute();
      }

      await trx
        .updateTable('video_moment_index')
        .set({ ...patch, indexedAt: sql<Date>`now()` })
        .where('assetId', '=', asUuid(assetId))
        .execute();
      return rows.length;
    });
  }

  /**
   * Store generated captions for frames that are still current, creating their generated moment
   * when the index stage has not. Manual moments are never written here, and nothing is written
   * when the original was replaced after the frames were cut.
   */
  async publishCaptions(
    assetId: string,
    captions: { frameId: string; caption: string }[],
    provenance: Record<string, unknown>,
    patch: {
      captionModel: string;
      captionConfigHash: string;
      captionIdentityHash: string;
      captionDestinationId: string | null;
    },
    /**
     * FL-57: checked under the asset's metadata lock (the lock a face change's invalidation takes):
     * false when the video's confirmed names changed while it was captioned, and nothing is written.
     */
    namesStillCurrent?: () => Promise<boolean>,
  ): Promise<number | 'identity-changed'> {
    return this.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(-1, hashtext(${assetId})::int)`.execute(trx);
      if (!(await this.framesMatchSource(trx, assetId))) {
        return 0;
      }
      if (namesStillCurrent && !(await namesStillCurrent())) {
        return 'identity-changed' as const;
      }
      const frames = await trx
        .selectFrom('video_moment_frame')
        .select(['id', 'timestampMs'])
        .where('assetId', '=', asUuid(assetId))
        .forUpdate()
        .execute();
      const current = new Map(frames.map((frame) => [frame.id, frame]));
      let written = 0;
      for (const { frameId, caption } of captions) {
        const frame = current.get(frameId);
        if (!frame) {
          continue;
        }
        const updated = await trx
          .updateTable('video_moment')
          .set({ caption, provenance })
          .where('assetId', '=', asUuid(assetId))
          .where('frameId', '=', asUuid(frameId))
          .where('source', '=', VideoMomentSource.Generated)
          .executeTakeFirst();
        if (Number(updated.numUpdatedRows) === 0) {
          await trx
            .insertInto('video_moment')
            .values({
              assetId,
              source: VideoMomentSource.Generated,
              timestampMs: frame.timestampMs,
              frameId,
              caption,
              provenance,
            })
            .execute();
        }
        written++;
      }

      if (written > 0) {
        await trx
          .updateTable('video_moment_index')
          .set({ ...patch, captionedAt: sql<Date>`now()` })
          .where('assetId', '=', asUuid(assetId))
          .execute();
      }
      return written;
    });
  }

  /**
   * FL-57: withdraws the generated captions of a video made with other confirmed names than
   * `identityHash`: their text is removed (so moment search no longer finds the old names) and their
   * provenance notes why. Manual moments are never touched. Taken under the asset's metadata lock, as
   * `publishCaptions` is. Returns how many were withdrawn.
   */
  async withdrawStaleCaptions(assetId: string, identityHash: string): Promise<number> {
    return this.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(-1, hashtext(${assetId})::int)`.execute(trx);
      const result = await trx
        .updateTable('video_moment')
        .set({
          caption: null,
          provenance: sql`coalesce(provenance, '{}'::jsonb) || jsonb_build_object('withdrawn', 'identity-changed', 'withdrawnAt', now())`,
        })
        .where('assetId', '=', asUuid(assetId))
        .where('source', '=', VideoMomentSource.Generated)
        .where('caption', 'is not', null)
        .where(sql<boolean>`(provenance ->> 'identityHash') is distinct from ${identityHash}`)
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0);
    });
  }

  listMoments(assetId: string): Promise<VideoMoment[]> {
    return this.db
      .selectFrom('video_moment')
      .selectAll()
      .where('assetId', '=', asUuid(assetId))
      .orderBy('timestampMs', 'asc')
      .orderBy('source', 'asc')
      .execute() as Promise<VideoMoment[]>;
  }

  getMoment(momentId: string): Promise<VideoMoment | undefined> {
    return this.db
      .selectFrom('video_moment')
      .selectAll()
      .where('id', '=', asUuid(momentId))
      .executeTakeFirst() as Promise<VideoMoment | undefined>;
  }

  createManualMoment(values: {
    assetId: string;
    timestampMs: number;
    endMs: number | null;
    caption: string | null;
    transcript: string | null;
    createdById: string;
  }): Promise<VideoMoment> {
    return this.db
      .insertInto('video_moment')
      .values({ ...values, source: VideoMomentSource.Manual })
      .returningAll()
      .executeTakeFirstOrThrow() as Promise<VideoMoment>;
  }

  /** Edits a manual moment. A generated moment is never edited in place; returns undefined for one. */
  updateManualMoment(
    momentId: string,
    patch: { timestampMs?: number; endMs?: number | null; caption?: string | null; transcript?: string | null },
  ): Promise<VideoMoment | undefined> {
    return this.db
      .updateTable('video_moment')
      .set(patch)
      .where('id', '=', asUuid(momentId))
      .where('source', '=', VideoMomentSource.Manual)
      .returningAll()
      .executeTakeFirst() as Promise<VideoMoment | undefined>;
  }

  async deleteManualMoment(momentId: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('video_moment')
      .where('id', '=', asUuid(momentId))
      .where('source', '=', VideoMomentSource.Manual)
      .executeTakeFirst();
    return Number(result.numDeletedRows) === 1;
  }

  /** The owner's cover choice. Kept as a time so it survives the frames being cut again. */
  async setCover(assetId: string, coverTimestampMs: number | null, userId: string): Promise<void> {
    await this.db
      .updateTable('video_moment_index')
      .set({
        coverTimestampMs,
        coverSetById: coverTimestampMs === null ? null : userId,
        coverSetAt: coverTimestampMs === null ? null : sql<Date>`now()`,
      })
      .where('assetId', '=', asUuid(assetId))
      .execute();
  }

  /**
   * Frames nearest a text or frame embedding in one library. Only embeddings from `modelName`, the
   * model the query was encoded with: vectors from another model are not comparable. Only videos an ordinary
   * read may show: active, not deleted, Timeline or Archive, and not Locked unless the owner's
   * session is unlocked.
   */
  @GenerateSql({
    params: [
      DummyValue.VECTOR,
      DummyValue.STRING,
      {
        ownerId: DummyValue.UUID,
        lockedOwnerId: DummyValue.UUID,
        privacy: { excludeNsfw: true },
        limit: 24,
        excludeFrameId: DummyValue.UUID,
      },
    ],
  })
  async searchFrames(
    embedding: string,
    modelName: string,
    scope: VideoMomentSearchScope,
  ): Promise<VideoMomentSearchHit[]> {
    const rows = await this.db.transaction().execute(async (trx) => {
      // Like every other vector search, set the probes here rather than relying on a database default.
      await sql`set local vchordrq.probes = ${sql.lit(probes[VectorIndex.VideoMomentFrame])}`.execute(trx);
      return trx
        .selectFrom('video_moment_frame_embedding')
        .innerJoin('video_moment_frame', 'video_moment_frame.id', 'video_moment_frame_embedding.frameId')
        .innerJoin('asset', 'asset.id', 'video_moment_frame.assetId')
        .leftJoin('video_moment', (join) =>
          join
            .onRef('video_moment.frameId', '=', 'video_moment_frame.id')
            .on('video_moment.source', '=', VideoMomentSource.Generated),
        )
        .select([
          'video_moment_frame.assetId',
          'video_moment_frame.id as frameId',
          'video_moment.id as momentId',
          'video_moment_frame.timestampMs',
          'video_moment.caption',
          sql<number>`video_moment_frame_embedding.embedding <=> ${embedding}`.as('distance'),
        ])
        .where('video_moment_frame_embedding.modelName', '=', modelName)
        .where('asset.ownerId', '=', asUuid(scope.ownerId))
        .where('asset.status', '=', AssetStatus.Active)
        .where('asset.deletedAt', 'is', null)
        .where('asset.visibility', 'in', [AssetVisibility.Timeline, AssetVisibility.Archive])
        .where(notLockedOrOwnedBy(scope.lockedOwnerId))
        .$call((qb) => withHiddenContentFilter(qb, scope.privacy))
        .$if(!!scope.excludeFrameId, (qb) =>
          qb.where('video_moment_frame_embedding.frameId', '!=', asUuid(scope.excludeFrameId!)),
        )
        .orderBy(sql`video_moment_frame_embedding.embedding <=> ${embedding}`)
        .limit(scope.limit)
        .execute();
    });
    return rows.map((row) => ({ ...row, distance: Number(row.distance) }));
  }

  /** Moments whose caption or typed transcript mentions the text, under the same visibility rules. */
  @GenerateSql({
    params: [
      DummyValue.STRING,
      { ownerId: DummyValue.UUID, lockedOwnerId: DummyValue.UUID, privacy: { excludeNsfw: true }, limit: 24 },
    ],
  })
  searchMomentText(text: string, scope: VideoMomentSearchScope): Promise<VideoMomentTextHit[]> {
    const pattern = `%${text.replaceAll(/[%_\\]/g, (match) => `\\${match}`)}%`;
    return this.db
      .selectFrom('video_moment')
      .innerJoin('asset', 'asset.id', 'video_moment.assetId')
      .select([
        'video_moment.assetId',
        'video_moment.id as momentId',
        'video_moment.timestampMs',
        'video_moment.source',
        'video_moment.caption',
        'video_moment.transcript',
      ])
      .where('asset.ownerId', '=', asUuid(scope.ownerId))
      .where('asset.status', '=', AssetStatus.Active)
      .where('asset.deletedAt', 'is', null)
      .where('asset.visibility', 'in', [AssetVisibility.Timeline, AssetVisibility.Archive])
      .where(notLockedOrOwnedBy(scope.lockedOwnerId))
      .$call((qb) => withHiddenContentFilter(qb, scope.privacy))
      .where((eb) =>
        eb.or([eb('video_moment.caption', 'ilike', pattern), eb('video_moment.transcript', 'ilike', pattern)]),
      )
      .orderBy('video_moment.source', 'desc')
      .orderBy('video_moment.updatedAt', 'desc')
      .limit(scope.limit)
      .execute() as Promise<VideoMomentTextHit[]>;
  }
}
