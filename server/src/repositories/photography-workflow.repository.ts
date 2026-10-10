import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { randomUUID } from 'node:crypto';
import type { PhotographySite, PhotographyStudioPreset } from 'src/dtos/photography-workflow.dto.js';
import type { PhotographyWorkflow } from 'src/services/photography-workflow.service.js';
import { AlbumUserRole, AssetFileType, AssetStatus, AssetType, UserStatus } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { isNotLocked, lockedAssetIdExists } from 'src/utils/locked.js';

export type WorkflowRow = {
  id: string;
  ownerId: string;
  albumId: string;
  revision: string;
  value: PhotographyWorkflow;
};
const TABLE = sql`public.photography_workflow`;
@Injectable()
export class PhotographyWorkflowRepository {
  constructor(
    @InjectKysely()
    private db: Kysely<DB>,
  ) {}
  async list(ownerId: string, ids: string[]) {
    if (ids.length === 0) return [];
    const { rows } = await sql<{
      shootId: string;
      albumId: string;
      revision: string;
      title: string;
      mode: string;
      selectionDeadline: string | null;
      expiresAt: string | null;
      published: boolean;
      submittedRounds: number;
      unpaidOrders: number;
      readyCount: number;
      pendingEdits: number;
    }>`
      SELECT workflow.id AS "shootId",workflow."albumId",workflow.revision,workflow.value->'config'->>'title' AS title,workflow.value->'config'->>'mode' AS mode,
      workflow.value->'config'->>'selectionDeadline' AS "selectionDeadline",workflow.value->'config'->>'expiresAt' AS "expiresAt",
      (workflow.value->'published' IS NOT NULL AND workflow.value->'published' <> 'null'::jsonb) AS published,
      jsonb_array_length(workflow.value->'rounds') AS "submittedRounds",
      (SELECT count(*)::int FROM jsonb_array_elements(workflow.value->'orders') orders WHERE orders->>'status' IN ('quoted','accepted')) AS "unpaidOrders",
      (SELECT count(*)::int FROM jsonb_array_elements(workflow.value->'orders') orders,jsonb_array_elements(orders->'items') item WHERE orders->>'status' IN ('settled','free') AND item->>'approved'='true' AND item->>'finalPath' IS NOT NULL) AS "readyCount",
      (SELECT count(DISTINCT item->>'captureId')::int FROM jsonb_array_elements(workflow.value->'orders') orders,jsonb_array_elements(orders->'items') item WHERE orders->>'status' IN ('accepted','settled','free') AND (orders->>'paymentTiming' <> 'before-editing' OR orders->>'status' IN ('settled','free')) AND (CASE WHEN item ? 'outputs' THEN EXISTS(SELECT 1 FROM jsonb_array_elements(item->'outputs') output WHERE output->>'approved' <> 'true' OR output->>'revisionId' IS NULL) ELSE item->>'approved' <> 'true' OR item->>'revisionId' IS NULL END)) AS "pendingEdits"
      FROM public.photography_workflow workflow JOIN public.album album ON album.id=workflow."albumId"
      JOIN public.album_user membership ON membership."albumId"=album.id AND membership."userId"=workflow."ownerId" AND membership.role='owner'
      JOIN public."user" studio ON studio.id=workflow."ownerId"
      WHERE workflow."ownerId"=${ownerId}::uuid AND workflow.id=ANY(${ids}::uuid[]) AND album."deletedAt" IS NULL AND studio."deletedAt" IS NULL AND studio.status='active' ORDER BY workflow."updatedAt" DESC LIMIT 200`.execute(
      this.db,
    );
    return rows;
  }
  async get(id: string): Promise<WorkflowRow | undefined> {
    const { rows } = await sql<WorkflowRow>`SELECT * FROM ${TABLE} WHERE id=${id}::uuid`.execute(this.db);
    return rows[0];
  }
  async mutate<T>(
    id: string,
    ownerId: string,
    albumId: string,
    expected: string | null | undefined,
    initial: PhotographyWorkflow,
    change: (value: PhotographyWorkflow, tx: Kysely<DB>) => Promise<T> | T,
  ): Promise<{
    row: WorkflowRow;
    result: T;
  }> {
    return this.db.transaction().execute(async (tx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${id}, 0))`.execute(tx);
      const owner = await tx
        .selectFrom('album')
        .innerJoin('album_user', 'album.id', 'album_user.albumId')
        .innerJoin('user', 'user.id', 'album_user.userId')
        .select('album.id')
        .where('album.id', '=', albumId)
        .where('album.deletedAt', 'is', null)
        .where('album_user.userId', '=', ownerId)
        .where('album_user.role', '=', AlbumUserRole.Owner)
        .where('user.deletedAt', 'is', null)
        .where('user.status', '=', UserStatus.Active)
        .forShare()
        .executeTakeFirst();
      if (!owner) throw new ForbiddenException('Shoot is unavailable');
      const { rows } = await sql<WorkflowRow>`SELECT * FROM ${TABLE} WHERE id=${id}::uuid FOR UPDATE`.execute(tx);
      const current = rows[0];
      if (current && (current.ownerId !== ownerId || current.albumId !== albumId)) throw new ForbiddenException();
      if (expected !== undefined && (current?.revision ?? null) !== expected)
        throw new ConflictException('Workflow changed; reload before saving');
      const value = current?.value ?? structuredClone(initial);
      const result = await change(value, tx);
      const revision = randomUUID();
      const encoded = JSON.stringify(value);
      if (Buffer.byteLength(encoded) > 20_000_000)
        throw new ConflictException('Workflow history storage limit reached');
      await sql`INSERT INTO ${TABLE} (id,"ownerId","albumId",revision,value)
        VALUES (${id}::uuid,${ownerId}::uuid,${albumId}::uuid,${revision}::uuid,${encoded}::text::jsonb)
        ON CONFLICT (id) DO UPDATE SET revision=EXCLUDED.revision,value=EXCLUDED.value,"updatedAt"=clock_timestamp()`.execute(
        tx,
      );
      return { row: { id, ownerId, albumId, revision, value }, result };
    });
  }
  async assets(ownerId: string, albumId: string, ids?: string[]) {
    let query = this.db
      .selectFrom('asset')
      .innerJoin('album_asset', 'asset.id', 'album_asset.assetId')
      .leftJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
      .select([
        'asset.id',
        'asset.ownerId',
        'asset.stackId',
        'asset.checksum',
        'asset.originalFileName',
        'asset.originalPath',
        'asset.fileCreatedAt',
        'asset.libraryId',
        'asset.isOffline',
        'asset.width',
        'asset.height',
        'asset_exif.make',
        'asset_exif.model',
        'asset_exif.dateTimeOriginal',
        'asset_exif.rating',
        'asset_exif.autoStackId',
        'asset.duplicateId',
        sql<boolean>`EXISTS (SELECT 1 FROM public.asset_file proof WHERE proof."assetId"=asset.id AND proof.type='preview' AND NOT proof."isEdited")`.as(
          'baseProofReady',
        ),
      ])
      .where('asset.ownerId', '=', ownerId)
      .where('album_asset.albumId', '=', albumId)
      .where('asset.type', '=', AssetType.Image)
      .where(isNotLocked())
      .where('asset.status', '=', AssetStatus.Active)
      .where('asset.deletedAt', 'is', null)
      .orderBy('asset.fileCreatedAt')
      .orderBy('asset.id')
      .limit(10_001);
    if (ids) {
      if (ids.length === 0) return [];
      query = query.where('asset.id', 'in', ids);
    }
    return query.execute();
  }
  async logo(ownerId: string, id: string) {
    return this.db
      .selectFrom('asset')
      .innerJoin('user', 'user.id', 'asset.ownerId')
      .leftJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
      .select(['asset.id', 'asset.originalPath', 'asset.isOffline'])
      .where('user.status', '=', UserStatus.Active)
      .where('user.deletedAt', 'is', null)
      .where('asset.id', '=', id)
      .where('asset.ownerId', '=', ownerId)
      .where('asset.type', '=', AssetType.Image)
      .where('asset.isOffline', '=', false)
      .where(isNotLocked())
      .where('asset.status', '=', AssetStatus.Active)
      .where('asset.deletedAt', 'is', null)
      .where('asset_exif.fileSizeInByte', '<=', 512_000)
      .execute();
  }
  async eligibleRevisions(row: WorkflowRow, ids: string[]) {
    if (ids.length === 0) return new Set<string>();
    const { rows } = await sql<{
      id: string;
    }>`SELECT revision.id FROM public.asset_develop_revision revision
      JOIN public.asset asset ON asset.id=revision."assetId"
      JOIN public.album_asset membership ON membership."assetId"=asset.id
      WHERE revision.id=ANY(${ids}::uuid[]) AND revision."ownerId"=${row.ownerId}::uuid
      AND asset."ownerId"=${row.ownerId}::uuid AND membership."albumId"=${row.albumId}::uuid
      AND ${isNotLocked()} AND asset.status='active' AND asset."deletedAt" IS NULL AND NOT asset."isOffline"
      AND revision.status='rendered' AND revision."masterPath" IS NOT NULL
      AND (revision."sourceChecksum" IS NULL OR revision."sourceChecksum"=asset.checksum)`.execute(this.db);
    return new Set(rows.map((r) => r.id));
  }
  async proofSource(assetId: string) {
    return this.db
      .selectFrom('asset_file')
      .select('path')
      .where('assetId', '=', assetId)
      .where('type', '=', AssetFileType.Preview)
      .where('isEdited', '=', false)
      .where(sql<boolean>`not ${lockedAssetIdExists(sql.ref('asset_file.assetId'))}`)
      .executeTakeFirst();
  }
  async live(row: WorkflowRow) {
    const owner = await this.db
      .selectFrom('album')
      .innerJoin('album_user', 'album.id', 'album_user.albumId')
      .innerJoin('user', 'user.id', 'album_user.userId')
      .select('album.id')
      .where('album.id', '=', row.albumId)
      .where('album.deletedAt', 'is', null)
      .where('user.deletedAt', 'is', null)
      .where('user.status', '=', UserStatus.Active)
      .where('album_user.userId', '=', row.ownerId)
      .where('album_user.role', '=', AlbumUserRole.Owner)
      .executeTakeFirst();
    if (!owner) throw new NotFoundException('Gallery unavailable');
  }
  async paymentOrder(orderId: string) {
    const { rows } = await sql<WorkflowRow>`SELECT * FROM ${TABLE} WHERE value->'orders' @>
      ${JSON.stringify([{ id: orderId }])}::text::jsonb LIMIT 1`.execute(this.db);
    return rows[0];
  }
  async studioLive(ownerId: string) {
    const user = await this.db
      .selectFrom('user')
      .select('id')
      .where('id', '=', ownerId)
      .where('status', '=', UserStatus.Active)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
    if (!user) throw new NotFoundException('Studio unavailable');
  }
  async site(ownerId: string) {
    const { rows } = await sql<{
      revision: string;
      value: PhotographySite | null;
    }>`SELECT revision,CASE WHEN value ? 'site' THEN value->'site' ELSE value END AS value FROM public.photography_studio_site WHERE "ownerId"=${ownerId}::uuid`.execute(
      this.db,
    );
    return rows[0];
  }
  async studioPresets(ownerId: string) {
    await this.studioLive(ownerId);
    const { rows } = await sql<{
      revision: string;
      presets: PhotographyStudioPreset[];
    }>`SELECT revision,CASE WHEN value ? 'site' THEN COALESCE(value->'presets','[]'::jsonb) ELSE '[]'::jsonb END AS presets FROM public.photography_studio_site WHERE "ownerId"=${ownerId}::uuid`.execute(
      this.db,
    );
    return rows[0] ?? { revision: null, presets: [] };
  }
  async pinnedStudioPreset(tx: Kysely<DB>, ownerId: string, expected: string, presetId: string) {
    const { rows } = await sql<{
      revision: string;
      presets: PhotographyStudioPreset[];
    }>`SELECT revision,COALESCE(value->'presets','[]'::jsonb) AS presets FROM public.photography_studio_site WHERE "ownerId"=${ownerId}::uuid FOR SHARE`.execute(
      tx,
    );
    if (rows[0]?.revision !== expected) throw new ConflictException('Studio preset changed; reload');
    const preset = rows[0].presets.find((preset) => preset.id === presetId);
    if (!preset) throw new NotFoundException('Studio preset unavailable');
    return preset;
  }
  async mutateStudio<T>(
    ownerId: string,
    expected: string | null,
    change: (record: { site: PhotographySite | null; presets: PhotographyStudioPreset[] }) => Promise<T> | T,
  ) {
    return this.db.transaction().execute(async (tx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${ownerId},0))`.execute(tx);
      const owner = await tx
        .selectFrom('user')
        .select('id')
        .where('id', '=', ownerId)
        .where('status', '=', UserStatus.Active)
        .where('deletedAt', 'is', null)
        .forShare()
        .executeTakeFirst();
      if (!owner) throw new ForbiddenException('Studio unavailable');
      const { rows } = await sql<{
        revision: string;
        value:
          | PhotographySite
          | {
              site: PhotographySite | null;
              presets: PhotographyStudioPreset[];
            };
      }>`SELECT revision,value FROM public.photography_studio_site WHERE "ownerId"=${ownerId}::uuid FOR UPDATE`.execute(
        tx,
      );
      if ((rows[0]?.revision ?? null) !== expected) throw new ConflictException('Studio settings changed; reload');
      const stored = rows[0]?.value;
      const record = stored && 'site' in stored ? stored : { site: stored ?? null, presets: [] };
      const result = await change(record);
      const encoded = JSON.stringify(record);
      if (Buffer.byteLength(encoded) > 20_000_000) throw new ConflictException('Studio settings storage limit reached');
      const revision = randomUUID();
      await sql`INSERT INTO public.photography_studio_site ("ownerId",revision,value) VALUES (${ownerId}::uuid,${revision}::uuid,${encoded}::text::jsonb) ON CONFLICT ("ownerId") DO UPDATE SET revision=EXCLUDED.revision,value=EXCLUDED.value`.execute(
        tx,
      );
      return { revision, record, result };
    });
  }
  async saveSite(ownerId: string, expected: string | null, value: PhotographySite) {
    const result = await this.mutateStudio(ownerId, expected, (record) => {
      record.site = value;
    });
    return { revision: result.revision, site: value };
  }
  async unfinished(cursor: string | null = null) {
    const { rows } = await sql<WorkflowRow>`SELECT * FROM ${TABLE}
      WHERE value->'publication'->>'status' IN ('queued','rendering') AND (${cursor}::uuid IS NULL OR id > ${cursor}::uuid) ORDER BY id LIMIT 200`.execute(
      this.db,
    );
    return rows;
  }
}
