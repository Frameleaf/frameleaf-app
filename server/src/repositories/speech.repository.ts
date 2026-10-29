import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { Kysely, Selectable, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { SpeechRevisionDto, SpeechSearchDto, SpeechSettingsUpdateDto } from 'src/dtos/speech.dto.js';
import { columns } from 'src/database.js';
import { mapAsset } from 'src/dtos/asset-response.dto.js';
import {
  AlbumUserRole,
  AssetType,
  AssetVisibility,
  MediaOperationDestination,
  MediaOperationKind,
  MediaOperationStatus,
} from 'src/enum.js';
import { DerivativePrivacyRepository } from 'src/repositories/derivative-privacy.repository.js';
import { MediaOperation, MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { DB } from 'src/schema/index.js';
import { SpeechSettingsTable } from 'src/schema/tables/speech.table.js';
import { hiddenFromOthers, searchAssetBuilder } from 'src/utils/database.js';
import { getPrivacyQueryOptions } from 'src/utils/hidden-content.js';
import { getLockedVisibilityOptions } from 'src/utils/locked-visibility.js';
import { isNotLocked } from 'src/utils/locked.js';
import { ACTIVE_MEDIA_OPERATION_STATUSES } from 'src/utils/media-operation.js';
import {
  SPEECH_INDEX_VERSION,
  SpeechWord,
  speechExcerpt,
  speechTail,
  speechTsQuery,
  speechWindows,
} from 'src/utils/speech.js';

export type SpeechSettings = Selectable<SpeechSettingsTable>;
const occurrenceCursorSchema = z
  .object({
    assetId: z.uuid(),
    transcriptId: z.uuid(),
    startMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    endMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .refine((value) => value.endMs >= value.startMs);
export const speechDefaults = {
  enabled: false,
  scope: 'library' as const,
  albumIds: [] as string[],
  destinationId: null,
};

@Injectable()
export class SpeechRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  settings(ownerId: string) {
    return this.db.selectFrom('speech_settings').selectAll().where('ownerId', '=', ownerId).executeTakeFirst();
  }

  owners(after?: string) {
    return this.db
      .selectFrom('speech_settings')
      .select('ownerId')
      .$if(!!after, (qb) => qb.where('ownerId', '>', after!))
      .orderBy('ownerId')
      .limit(50)
      .execute();
  }

  async assetOwners(assetIds: string[]) {
    if (assetIds.length === 0) {
      return [];
    }
    const rows = await this.db.selectFrom('asset').select('ownerId').distinct().where('id', 'in', assetIds).execute();
    return rows.map(({ ownerId }) => ownerId);
  }

  async wake(ownerId: string) {
    await this.db
      .updateTable('speech_settings')
      .set({ cursor: null, nextScanAt: new Date() })
      .where('ownerId', '=', ownerId)
      .execute();
  }

  private eligible(
    ownerId: string,
    options: Pick<SpeechSearchDto, 'filter' | 'imageEnrichment'> = {},
    db = this.db,
    auth?: AuthDto,
  ) {
    return searchAssetBuilder(
      db,
      { ...options, ...(auth && getPrivacyQueryOptions(auth)) },
      {
        userIds: [ownerId],
        viewingUserId: ownerId,
        lockedOwnerId: '',
        lockedMotion: getLockedVisibilityOptions({ user: { id: ownerId } } as AuthDto),
      },
    )
      .innerJoin('speech_settings', 'speech_settings.ownerId', 'asset.ownerId')
      .where('asset.ownerId', '=', ownerId)
      .where('asset.type', '=', AssetType.Video)
      .where('asset.deletedAt', 'is', null)
      .where('asset.isOffline', '=', false)
      .where('asset.visibility', 'in', [AssetVisibility.Timeline, AssetVisibility.Archive])
      .where(isNotLocked())
      .where(sql<boolean>`not ${hiddenFromOthers(null)}`)
      .where('speech_settings.enabled', '=', true)
      .where(sql<boolean>`exists(select 1 from "user" u where u.id=asset."ownerId" and u."deletedAt" is null)`)
      .where(sql<boolean>`(speech_settings.scope='library' or exists (
        select 1 from album_asset aa join album_user au on au."albumId"=aa."albumId"
        where aa."assetId"=asset.id and au."userId"=asset."ownerId" and au.role='owner' and au."albumId"=any(speech_settings."albumIds")
      ))`);
  }

  private current(
    ownerId: string,
    options: Pick<SpeechSearchDto, 'filter' | 'imageEnrichment'> = {},
    db = this.db,
    auth?: AuthDto,
  ) {
    return this.eligible(ownerId, options, db, auth)
      .innerJoin('speech_transcript', 'speech_transcript.assetId', 'asset.id')
      .whereRef('speech_transcript.ownerId', '=', 'asset.ownerId')
      .whereRef('speech_transcript.generation', '=', 'speech_settings.generation')
      .whereRef('speech_transcript.checksum', '=', 'asset.checksum')
      .whereRef('speech_transcript.modelFingerprint', '=', 'speech_settings.modelFingerprint')
      .where('speech_transcript.indexVersion', '=', SPEECH_INDEX_VERSION);
  }

  private async cancel(db: Kysely<DB>, ownerId: string) {
    await db
      .updateTable('media_operation')
      .set({
        cancelRequestedAt: sql<Date>`clock_timestamp()`,
        status: sql<MediaOperationStatus>`case when status in ('queued','paused') then 'cancelled' else 'cancelling' end`,
        finishedAt: sql<Date | null>`case when status in ('queued','paused') then clock_timestamp() else "finishedAt" end`,
      })
      .where('ownerId', '=', ownerId)
      .where('kind', '=', MediaOperationKind.SpeechTranscription)
      .where('status', 'in', [...ACTIVE_MEDIA_OPERATION_STATUSES])
      .execute();
  }

  async configure(ownerId: string, request: SpeechSettingsUpdateDto | SpeechRevisionDto, purge = false) {
    return this.db.transaction().execute(async (tx) => {
      const inserted = await tx
        .insertInto('speech_settings')
        .values({ ownerId, generation: randomUUID() })
        .onConflict((oc) => oc.column('ownerId').doNothing())
        .returning('ownerId')
        .executeTakeFirst();
      const current = await tx
        .selectFrom('speech_settings')
        .selectAll()
        .where('ownerId', '=', ownerId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (request.expectedGeneration !== (inserted ? null : current.generation))
        throw new ConflictException('Speech settings changed; reload before saving');
      const dto = purge
        ? { enabled: false, scope: current.scope, albumIds: current.albumIds, destinationId: current.destinationId }
        : (request as SpeechSettingsUpdateDto);
      const albumIds = [...new Set(dto.albumIds)];
      if (dto.enabled && (!dto.destinationId || (dto.scope === 'albums' && albumIds.length === 0)))
        throw new BadRequestException('Choose a worker and at least one album, or your whole library');
      if (dto.enabled && albumIds.length > 0) {
        const owned = await tx
          .selectFrom('album_user')
          .select('albumId')
          .where('albumId', 'in', albumIds)
          .where('userId', '=', ownerId)
          .where('role', '=', AlbumUserRole.Owner)
          .forShare()
          .execute();
        if (owned.length !== albumIds.length) throw new BadRequestException('Speech indexing requires albums you own');
      }
      await this.cancel(tx, ownerId);
      const saved = await tx
        .updateTable('speech_settings')
        .set({
          scope: dto.scope,
          destinationId: dto.destinationId,
          albumIds,
          enabled: purge ? false : dto.enabled,
          generation: randomUUID(),
          modelFingerprint: null,
          cursor: null,
          nextScanAt: new Date(),
        })
        .where('ownerId', '=', ownerId)
        .returningAll()
        .executeTakeFirstOrThrow();
      if (purge) {
        await sql`delete from speech_window w using speech_transcript t where t."ownerId"=${ownerId}::uuid and w."assetId"=t."assetId"`.execute(
          tx,
        );
        await sql`delete from speech_checkpoint c using speech_transcript t where t."ownerId"=${ownerId}::uuid and c."assetId"=t."assetId"`.execute(
          tx,
        );
        await tx.deleteFrom('speech_transcript').where('ownerId', '=', ownerId).execute();
      }
      return saved;
    });
  }

  async setModel(ownerId: string, generation: string, fingerprint: string) {
    return this.db.transaction().execute(async (tx) => {
      const setting = await tx
        .selectFrom('speech_settings')
        .selectAll()
        .where('ownerId', '=', ownerId)
        .where('generation', '=', generation)
        .forUpdate()
        .executeTakeFirst();
      if (!setting?.enabled || setting.modelFingerprint === fingerprint) return;
      await this.cancel(tx, ownerId);
      await tx
        .updateTable('speech_settings')
        .set({ modelFingerprint: fingerprint, cursor: null, nextScanAt: new Date() })
        .where('ownerId', '=', ownerId)
        .execute();
    });
  }

  due() {
    return this.db
      .selectFrom('speech_settings')
      .selectAll()
      .where('enabled', '=', true)
      .where('nextScanAt', '<=', new Date())
      .orderBy('nextScanAt')
      .limit(10)
      .execute();
  }

  async defer(ownerId: string, generation: string) {
    await this.db
      .updateTable('speech_settings')
      .set({ nextScanAt: new Date(Date.now() + 30_000) })
      .where('ownerId', '=', ownerId)
      .where('generation', '=', generation)
      .execute();
  }

  async reconcile(ownerId: string) {
    await this.db.transaction().execute(async (tx) => {
      const setting = await tx
        .selectFrom('speech_settings')
        .selectAll()
        .where('ownerId', '=', ownerId)
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (!setting?.enabled || !setting.destinationId || !setting.modelFingerprint) return;
      const assets = await this.eligible(ownerId, {}, tx)
        .select(['asset.id', 'asset.checksum'])
        .$if(!!setting.cursor, (qb) => qb.where('asset.id', '>', setting.cursor!))
        .orderBy('asset.id')
        .limit(50)
        .execute();
      for (const asset of assets) {
        const existing = await tx
          .selectFrom('speech_transcript')
          .selectAll()
          .where('assetId', '=', asset.id)
          .executeTakeFirst();
        if (
          existing?.ownerId === ownerId &&
          existing.generation === setting.generation &&
          Buffer.from(existing.checksum).equals(asset.checksum) &&
          existing.modelFingerprint === setting.modelFingerprint &&
          existing.indexVersion === SPEECH_INDEX_VERSION
        )
          continue;
        const operation = await tx
          .insertInto('media_operation')
          .values({
            ownerId,
            assetId: asset.id,
            kind: MediaOperationKind.SpeechTranscription,
            destination: MediaOperationDestination.Local,
            destinationDetail: setting.destinationId,
            label: 'Spoken words',
            projectId: null,
            revisionId: null,
            resultAssetId: null,
            retryOfId: null,
            estimate: null,
            totalUnits: null,
            settings: {},
            snapshot: {
              assetId: asset.id,
              generation: setting.generation,
              checksum: asset.checksum.toString('base64'),
              destinationId: setting.destinationId,
              modelFingerprint: setting.modelFingerprint,
              indexVersion: SPEECH_INDEX_VERSION,
            },
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await tx.deleteFrom('speech_window').where('assetId', '=', asset.id).execute();
        await tx.deleteFrom('speech_checkpoint').where('assetId', '=', asset.id).execute();
        const values = {
          assetId: asset.id,
          ownerId,
          operationId: operation.id,
          generation: setting.generation,
          checksum: asset.checksum,
          modelFingerprint: setting.modelFingerprint,
          indexVersion: SPEECH_INDEX_VERSION,
          model: null,
          language: null,
          completedAt: null,
        };
        await tx
          .insertInto('speech_transcript')
          .values(values)
          .onConflict((oc) => oc.column('assetId').doUpdateSet(values))
          .execute();
      }
      await tx
        .updateTable('speech_settings')
        .set({
          cursor: assets.length === 50 ? assets.at(-1)!.id : null,
          nextScanAt: new Date(Date.now() + (assets.length === 50 ? 0 : 30_000)),
        })
        .where('ownerId', '=', ownerId)
        .execute();
    });
  }

  async retry(ownerId: string, expectedGeneration: string | null) {
    await this.db.transaction().execute(async (tx) => {
      const current = await tx
        .selectFrom('speech_settings')
        .selectAll()
        .where('ownerId', '=', ownerId)
        .forUpdate()
        .executeTakeFirst();
      if (!current || expectedGeneration !== current.generation)
        throw new ConflictException('Speech settings changed; reload before retrying');
      await tx
        .updateTable('speech_transcript')
        .set({ indexVersion: 0 })
        .where('ownerId', '=', ownerId)
        .where('completedAt', 'is', null)
        .where(
          sql<boolean>`not exists(select 1 from media_operation m where m.id=speech_transcript."operationId" and m.status not in ('failed','cancelled'))`,
        )
        .execute();
      await tx
        .updateTable('speech_settings')
        .set({ cursor: null, nextScanAt: new Date() })
        .where('ownerId', '=', ownerId)
        .execute();
    });
  }

  async source(operation: MediaOperation, claimToken: string, db = this.db) {
    return this.current(operation.ownerId, {}, db)
      .innerJoin('media_operation', 'media_operation.id', 'speech_transcript.operationId')
      .select(['asset.id', 'asset.originalPath', 'asset.checksum'])
      .where('media_operation.id', '=', operation.id)
      .where('media_operation.claimToken', '=', claimToken)
      .where('media_operation.claimExpiresAt', '>', sql<Date>`clock_timestamp()`)
      .where('media_operation.cancelRequestedAt', 'is', null)
      .where('media_operation.status', 'in', [
        MediaOperationStatus.Preparing,
        MediaOperationStatus.Rendering,
        MediaOperationStatus.Validating,
      ])
      .where('speech_settings.generation', '=', String(operation.snapshot.generation))
      .where('speech_settings.modelFingerprint', '=', String(operation.snapshot.modelFingerprint))
      .executeTakeFirst();
  }

  checkpoint(operationId: string) {
    return this.db
      .selectFrom('speech_checkpoint')
      .selectAll()
      .where('operationId', '=', operationId)
      .executeTakeFirst();
  }

  private async fence(tx: Kysely<DB>, operation: MediaOperation, claimToken: string) {
    await tx
      .selectFrom('speech_settings')
      .select('ownerId')
      .where('ownerId', '=', operation.ownerId)
      .forShare()
      .executeTakeFirst();
    if (!operation.assetId) return false;
    await new DerivativePrivacyRepository(tx).lockSources(tx, [operation.assetId]);
    await tx
      .selectFrom('album_asset')
      .select('albumId')
      .where('assetId', '=', operation.assetId)
      .orderBy('albumId')
      .forShare()
      .execute();
    await tx
      .selectFrom('album_user')
      .select('albumId')
      .where('userId', '=', operation.ownerId)
      .where('role', '=', AlbumUserRole.Owner)
      .orderBy('albumId')
      .forShare()
      .execute();
    // Match preference writers even before the first preferences row exists. Keep source/grant locks first,
    // as in DerivativePrivacyRepository, and acquire this before locking or reading preference rows.
    await sql`SELECT pg_advisory_xact_lock_shared(-2, hashtext(${operation.ownerId})::int)`.execute(tx);
    await tx.selectFrom('user_metadata').select('userId').where('userId', '=', operation.ownerId).forShare().execute();
    await tx
      .selectFrom('speech_transcript')
      .select('assetId')
      .where('assetId', '=', operation.assetId)
      .forUpdate()
      .executeTakeFirst();
    await tx.selectFrom('media_operation').select('id').where('id', '=', operation.id).forUpdate().executeTakeFirst();
    return !!(await this.source(operation, claimToken, tx));
  }

  async saveChunk(
    operation: MediaOperation,
    claimToken: string,
    sequence: number,
    words: SpeechWord[],
    model: string,
    language: string,
  ) {
    return this.db.transaction().execute(async (tx) => {
      if (!(await this.fence(tx, operation, claimToken))) return false;
      const previous = await tx
        .selectFrom('speech_checkpoint')
        .selectAll()
        .where('operationId', '=', operation.id)
        .executeTakeFirst();
      if (previous && (previous.nextChunk !== sequence || previous.model !== model))
        throw new Error('Speech checkpoint identity changed');
      const combined = [...(previous?.tail ?? []), ...words];
      const windows = speechWindows(combined);
      if (windows.length >= 10_000) throw new Error('The worker sent too many words for one audio chunk');
      for (const [index, window] of windows.entries()) {
        await tx
          .insertInto('speech_window')
          .values({
            operationId: operation.id,
            assetId: operation.assetId!,
            sequence: sequence * 10_000 + index,
            vector: sql<string>`${window.vector}::tsvector`,
            tokens: window.tokens,
            words: window.words,
          })
          .execute();
      }
      const checkpoint = {
        operationId: operation.id,
        assetId: operation.assetId!,
        nextChunk: sequence + 1,
        tail: speechTail(combined),
        model,
        language,
      };
      await tx
        .insertInto('speech_checkpoint')
        .values(checkpoint)
        .onConflict((oc) => oc.column('operationId').doUpdateSet(checkpoint))
        .execute();
      return true;
    });
  }

  async publish(operation: MediaOperation, claimToken: string, model: string, language: string | null) {
    return this.db.transaction().execute(async (tx) => {
      if (!(await this.fence(tx, operation, claimToken))) return false;
      await tx
        .updateTable('speech_transcript')
        .set({ model, language, completedAt: new Date() })
        .where('operationId', '=', operation.id)
        .execute();
      if (!(await new MediaOperationRepository(tx).complete(operation.id, claimToken, { resultAssetId: null }, tx)))
        throw new Error('Speech claim lost');
      await tx.deleteFrom('speech_checkpoint').where('operationId', '=', operation.id).execute();
      return true;
    });
  }

  async status(ownerId: string) {
    const rows = await this.current(ownerId)
      .leftJoin('media_operation', 'media_operation.id', 'speech_transcript.operationId')
      .select([
        'media_operation.status',
        sql<boolean>`speech_transcript."completedAt" is not null`.as('completed'),
        sql<number>`count(*)::integer`.as('count'),
      ])
      .groupBy(['media_operation.status', sql<boolean>`speech_transcript."completedAt" is not null`])
      .execute();
    return {
      indexed: rows.filter((r) => r.completed).reduce((a, r) => a + r.count, 0),
      pending: rows
        .filter((r) => r.status && ACTIVE_MEDIA_OPERATION_STATUSES.includes(r.status))
        .reduce((a, r) => a + r.count, 0),
      failed: rows
        // A cancelled (Activity) incomplete transcript is never re-reconciled, so it is offered for retry like a failure.
        .filter(
          (r) =>
            !r.completed &&
            (!r.status || r.status === MediaOperationStatus.Failed || r.status === MediaOperationStatus.Cancelled),
        )
        .reduce((a, r) => a + r.count, 0),
    };
  }

  async search(auth: AuthDto, dto: SpeechSearchDto, clauses: string[][]) {
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .execute(async (tx) => {
        const setting = await tx
          .selectFrom('speech_settings')
          .selectAll()
          .where('ownerId', '=', auth.user.id)
          .executeTakeFirst();
        if (!setting?.enabled) {
          if (dto.cursor || dto.hitCursor)
            throw new ConflictException({
              statusCode: 409,
              code: 'speech_cursor_stale',
              message: 'Search changed; start again from the first page',
            });
          return { items: [], total: 0, nextCursor: null };
        }
        const identity = createHash('sha256')
          .update(
            JSON.stringify([
              auth.user.id,
              dto.query,
              dto.filter,
              dto.imageEnrichment,
              setting.generation,
              setting.scope,
              setting.albumIds,
              setting.modelFingerprint,
              SPEECH_INDEX_VERSION,
            ]),
          )
          .digest('hex');
        const decode = (raw: string) => {
          try {
            const value = JSON.parse(Buffer.from(raw, 'base64url').toString());
            if (value.identity !== identity) throw new Error('Cursor identity changed');
            return value;
          } catch {
            throw new ConflictException({
              statusCode: 409,
              code: 'speech_cursor_stale',
              message: 'Search changed; start again from the first page',
            });
          }
        };
        let after: string | undefined;
        if (dto.cursor) {
          const parsed = z.uuid().safeParse(decode(dto.cursor).after);
          if (!parsed.success) throw new BadRequestException('Invalid video cursor');
          after = parsed.data;
        }
        let hitAfter: { startMs: number; endMs: number; transcriptId: string } | undefined;
        if (dto.hitCursor) {
          const parsed = occurrenceCursorSchema.safeParse(decode(dto.hitCursor));
          if (!parsed.success || !dto.assetId || parsed.data.assetId !== dto.assetId || dto.cursor)
            throw new BadRequestException('Invalid occurrence cursor');
          hitAfter = parsed.data;
        }
        let matched = this.current(auth.user.id, dto, tx, auth)
          .where('speech_transcript.completedAt', 'is not', null)
          .$if(!!dto.assetId, (qb) => qb.where('asset.id', '=', dto.assetId!));
        for (const clause of clauses) {
          matched = matched.where(
            sql<boolean>`exists(select 1 from speech_window w where w."operationId"=speech_transcript."operationId" and w.vector @@ ${speechTsQuery(clause)}::tsquery)`,
          );
        }
        const count = await matched.select(sql<number>`count(*)::integer`.as('total')).executeTakeFirstOrThrow();
        const assets = await matched
          .select(columns.searchAsset)
          .select(sql<boolean>`false`.as('isLocked'))
          .select('speech_transcript.operationId')
          .$if(!!after, (qb) => qb.where('asset.id', '>', after!))
          .orderBy('asset.id')
          .limit(dto.size + 1)
          .execute();
        if (hitAfter && assets[0]?.operationId !== hitAfter.transcriptId) {
          throw new ConflictException({
            statusCode: 409,
            code: 'speech_cursor_stale',
            message: 'Search changed; start again from the first page',
          });
        }
        const page = assets.slice(0, dto.size),
          items = [];
        for (const asset of page) {
          // Every bounded vector is a candidate. Deduplicate overlapping window occurrences in PostgreSQL,
          // then keyset-page timestamps, so late/repeated matches remain reachable without a corpus cap.
          const matches = sql`select distinct on (start_ms,end_ms) w.words, p.position, cardinality(c.tokens) length,
          start_ms, end_ms from speech_window w
          cross join (values ${sql.join(clauses.map((c) => sql`(${c}::text[])`))}) c(tokens)
          cross join lateral generate_series(1,cardinality(w.tokens)-cardinality(c.tokens)+1) p(position)
          cross join lateral (select (w.words->(p.position-1)->>'startMs')::double precision start_ms,
            (w.words->(p.position+cardinality(c.tokens)-2)->>'endMs')::double precision end_ms) times
          where w."operationId"=${asset.operationId}::uuid
            and w.vector @@ ${clauses.map((clause) => speechTsQuery(clause)).join(' | ')}::tsquery
            and w.tokens[p.position:p.position+cardinality(c.tokens)-1]=c.tokens
          order by start_ms,end_ms,w.sequence`;
          const occurrencePage = await sql<{
            words: SpeechWord[];
            position: number;
            length: number;
            start_ms: number;
            end_ms: number;
            total: number;
          }>`
          with matches as (${matches}), counted as (select *,count(*) over()::integer total from matches)
          select * from counted ${hitAfter ? sql`where (start_ms,end_ms)>(${hitAfter.startMs},${hitAfter.endMs})` : sql``}
          order by start_ms,end_ms limit 21`.execute(tx);
          const rows = occurrencePage.rows.slice(0, 20);
          const hits = rows.map((row) => {
            const context = row.words.slice(Math.max(0, row.position - 7), row.position + row.length + 5);
            return { startMs: row.start_ms, endMs: row.end_ms, text: speechExcerpt(context) };
          });
          const last = hits.at(-1);
          items.push({
            asset: mapAsset(asset, { auth }),
            transcriptId: asset.operationId,
            hits,
            hitsTotal: rows[0]?.total ?? 0,
            nextHitCursor:
              occurrencePage.rows.length > 20 && last
                ? Buffer.from(
                    JSON.stringify({
                      identity,
                      assetId: asset.id,
                      transcriptId: asset.operationId,
                      startMs: last.startMs,
                      endMs: last.endMs,
                    }),
                  ).toString('base64url')
                : null,
          });
        }
        return {
          items,
          total: count.total,
          nextCursor:
            assets.length > dto.size
              ? Buffer.from(JSON.stringify({ identity, after: page.at(-1)!.id })).toString('base64url')
              : null,
        };
      });
  }

  async cleanup() {
    await sql`delete from speech_checkpoint c where not exists(select 1 from speech_transcript t join media_operation m on m.id=t."operationId" where t."operationId"=c."operationId" and m.status not in ('completed','failed','cancelled'))`.execute(
      this.db,
    );
    await sql`delete from speech_window w where not exists(select 1 from speech_transcript t where t."operationId"=w."operationId")`.execute(
      this.db,
    );
  }
}
