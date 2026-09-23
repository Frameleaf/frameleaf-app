import { Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { DateTime } from 'luxon';
import { InjectKysely } from 'nestjs-kysely';
import type { ForkSchemaPhase } from 'src/repositories/fork-schema.repository.js';
import { AssetLockReason, AssetVisibility } from 'src/enum.js';
import { isForkWriteEnabled } from 'src/fork-schema/authority.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { DB } from 'src/schema/index.js';

type Values = { isFavorite?: boolean; isHidden?: boolean; fileCreatedAt?: string };
type Baseline = {
  signature: string;
  updatedAt: string;
  source: Values;
  applied: { isFavorite?: boolean; visibility?: AssetVisibility; fileCreatedAt?: string };
  overridden: string[];
  status: 'applied' | 'needs-review';
  reason?: string;
};
type Candidate = { id: string; assetId: string; signature: string; previous?: Baseline };
type Target = {
  isFavorite: boolean;
  visibility: AssetVisibility;
  fileCreatedAt: Date;
  timeZone: string | null;
  lockedProperties: string[] | null;
};

@Injectable()
export class ICloudMetadataRepository {
  constructor(@InjectKysely() private readonly db: Kysely<DB>) {}

  private candidate(db: Kysely<DB>, connectionId: string, ownerId: string, assetId?: string) {
    return sql<Candidate>`SELECT DISTINCT ON (r."assetId") r.id,r."assetId",version.signature,baseline.previous
      FROM immich_fork.icloud_resource r JOIN asset a ON a.id=r."assetId"
      JOIN asset_job_status jobs ON jobs."assetId"=a.id AND jobs."metadataExtractedAt" IS NOT NULL
      CROSS JOIN LATERAL (SELECT md5(coalesce(string_agg(jsonb_build_object('id',s.id,'favorite',s.source->'isFavorite','hidden',s.source->'isHidden','date',s.source->'fileCreatedAt')::text,',' ORDER BY s.id),'') || jobs."metadataExtractedAt"::text) signature
        FROM immich_fork.icloud_resource s WHERE s."ownerId"=${ownerId}::uuid AND s."assetId"=r."assetId"
        AND coalesce((s.source->>'current')::boolean,true) AND s.role<>'motion' AND s.status IN ('committed','finalized','reused')) version
      LEFT JOIN LATERAL (SELECT s.source#>'{_sync,metadata}' previous FROM immich_fork.icloud_resource s
        WHERE s."ownerId"=${ownerId}::uuid AND s."assetId"=r."assetId" AND s.source#>'{_sync,metadata}' IS NOT NULL
        ORDER BY s.source#>>'{_sync,metadata,updatedAt}' DESC,s.id LIMIT 1) baseline ON true
      WHERE r."connectionId"=${connectionId}::uuid AND r."ownerId"=${ownerId}::uuid AND a."ownerId"=${ownerId}::uuid
        AND a."deletedAt" IS NULL AND r.role<>'motion' AND coalesce((r.source->>'current')::boolean,true)
        AND r.status IN ('committed','finalized','reused') AND baseline.previous->>'signature' IS DISTINCT FROM version.signature
        ${assetId ? sql`AND a.id=${assetId}::uuid` : sql``}
      ORDER BY r."assetId",r.id LIMIT 1`
      .execute(db)
      .then(({ rows }) => rows[0]);
  }

  /**
   * One destination asset per transaction; at most 100 source descriptors are inspected. The ids of
   * any assets it locks (FL-34) are added to `locked`, for the caller's follow-up once it commits.
   */
  async reconcile(connectionId: string, ownerId: string, assetId?: string, locked: string[] = []): Promise<boolean> {
    return this.db.transaction().execute(async (db) => {
      const phase = await sql<{ phase: ForkSchemaPhase }>`SELECT phase FROM immich_fork.state WHERE id=1 FOR SHARE`
        .execute(db)
        .then(({ rows }) => rows[0]?.phase);
      if (!phase || !isForkWriteEnabled(phase)) {
        return true;
      }
      const handoff =
        await sql`SELECT 1 FROM immich_fork.migration_audit WHERE status='running' AND name IN ('official-handoff-preparation','fork-return-reconciliation') LIMIT 1`.execute(
          db,
        );
      if (handoff.rows.length > 0) {
        return true;
      }
      const connection =
        await sql`SELECT id FROM immich_fork.icloud_connection WHERE id=${connectionId}::uuid AND "ownerId"=${ownerId}::uuid AND state='connected' FOR UPDATE`.execute(
          db,
        );
      if (connection.rows.length === 0) {
        return true;
      }
      let candidate = await this.candidate(db, connectionId, ownerId, assetId);
      if (!candidate) {
        return true;
      }
      await sql`SELECT pg_advisory_xact_lock(-1,hashtext(${candidate.assetId})::int)`.execute(db);
      candidate = await this.candidate(db, connectionId, ownerId, candidate.assetId);
      if (!candidate) {
        return true;
      }
      const target =
        await sql<Target>`SELECT a."isFavorite",a.visibility,a."fileCreatedAt",e."timeZone",e."lockedProperties" FROM asset a
        LEFT JOIN asset_exif e ON e."assetId"=a.id WHERE a.id=${candidate.assetId}::uuid AND a."ownerId"=${ownerId}::uuid AND a."deletedAt" IS NULL FOR UPDATE OF a`
          .execute(db)
          .then(({ rows }) => rows[0]);
      if (!target) {
        return false;
      }
      const { rows: resources } = await sql<{
        source: Values;
      }>`SELECT source FROM immich_fork.icloud_resource WHERE "ownerId"=${ownerId}::uuid AND "assetId"=${candidate.assetId}::uuid
        AND coalesce((source->>'current')::boolean,true) AND role<>'motion' AND status IN ('committed','finalized','reused') ORDER BY id LIMIT 101`.execute(
        db,
      );
      const state: Baseline = {
        signature: candidate.signature,
        updatedAt: new Date().toISOString(),
        source: {},
        applied: { ...candidate.previous?.applied },
        overridden: [...(candidate.previous?.overridden ?? [])],
        status: 'applied',
      };
      if (resources.length > 100) {
        state.status = 'needs-review';
        state.reason = 'source_metadata_family_too_large';
      } else {
        for (const key of ['isFavorite', 'isHidden', 'fileCreatedAt'] as const) {
          const values = resources.map(({ source }) => source[key]).filter((value) => value !== undefined);
          const distinct = new Set(values);
          if (distinct.size > 1) {
            state.status = 'needs-review';
            state.reason = 'source_metadata_conflict';
            state.overridden.push(key);
          } else if (values.length > 0) {
            Object.assign(state.source, { [key]: values[0] });
          }
        }
        const favorite = state.source.isFavorite;
        if (typeof favorite === 'boolean' && !state.overridden.includes('isFavorite')) {
          const prior = candidate.previous?.applied.isFavorite;
          if (prior === undefined ? !target.isFavorite || favorite : target.isFavorite === prior) {
            await db
              .updateTable('asset')
              .set({ isFavorite: favorite })
              .where('id', '=', candidate.assetId)
              .where('ownerId', '=', ownerId)
              .execute();
            state.applied.isFavorite = favorite;
          } else {
            state.overridden.push('isFavorite');
          }
        }
        // Apple Hidden is private. Immich Hidden is reserved for motion companions;
        // tighten to Locked (FL-34: a lock record, never a stored visibility) and never
        // automatically remove a destination privacy choice.
        if (
          state.source.isHidden === true &&
          target.visibility === AssetVisibility.Timeline &&
          !state.overridden.includes('isHidden')
        ) {
          if (candidate.previous?.applied.visibility === undefined) {
            // the lock also releases every cover, featured photo and face thumbnail it was (FL-53)
            locked.push(...(await new AssetRepository(db).lock([candidate.assetId], AssetLockReason.Marked, null)));
            state.applied.visibility = AssetVisibility.Locked;
          } else {
            state.overridden.push('isHidden');
          }
        }
        const date = state.source.fileCreatedAt;
        if (typeof date === 'string' && !state.overridden.includes('fileCreatedAt')) {
          const parsed = DateTime.fromISO(date, { setZone: true });
          const locked = target.lockedProperties?.includes('dateTimeOriginal');
          if (parsed.isValid && !locked) {
            const prior = candidate.previous?.applied.fileCreatedAt;
            // Extraction can reset unlocked date columns; user date edits take the
            // native dateTimeOriginal lock. An existing provenance override persists.
            const extractedAgain = candidate.previous?.source.fileCreatedAt === date;
            if (!prior || target.fileCreatedAt.toISOString() === prior || extractedAgain) {
              const utc = parsed.toUTC().toJSDate();
              await new AssetRepository(db).upsertExif({
                exif: { assetId: candidate.assetId, dateTimeOriginal: utc },
                lockedPropertiesBehavior: 'skip',
              });
              const local = target.timeZone ? parsed.setZone(target.timeZone) : parsed;
              await db
                .updateTable('asset')
                .set({ fileCreatedAt: utc, localDateTime: local.setZone('UTC', { keepLocalTime: true }).toJSDate() })
                .where('id', '=', candidate.assetId)
                .where('ownerId', '=', ownerId)
                .execute();
              state.applied.fileCreatedAt = utc.toISOString();
            } else {
              state.overridden.push('fileCreatedAt');
            }
          } else if (locked) {
            state.overridden.push('fileCreatedAt');
          }
        }
      }
      state.overridden = [...new Set(state.overridden)];
      await sql`UPDATE immich_fork.icloud_resource SET source=jsonb_set(source,'{_sync}',coalesce(source->'_sync','{}') || jsonb_build_object('metadata',${state}::jsonb)) WHERE id=${candidate.id}::uuid AND "ownerId"=${ownerId}::uuid`.execute(
        db,
      );
      return !(await this.candidate(db, connectionId, ownerId, assetId));
    });
  }

  /** Returns the ids of the assets it locked (FL-34). */
  async afterExtraction(assetId: string, ownerId: string): Promise<string[]> {
    const locked: string[] = [];
    const { rows } = await sql<{
      connectionId: string;
    }>`SELECT DISTINCT r."connectionId" FROM immich_fork.icloud_resource r
      JOIN immich_fork.icloud_connection c ON c.id=r."connectionId" WHERE r."assetId"=${assetId}::uuid AND r."ownerId"=${ownerId}::uuid
      AND c."ownerId"=${ownerId}::uuid AND c.state='connected' AND r.role<>'motion' LIMIT 100`.execute(this.db);
    for (const { connectionId } of rows) {
      await this.reconcile(connectionId, ownerId, assetId, locked);
    }
    return locked;
  }
}
