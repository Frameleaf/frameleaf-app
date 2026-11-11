import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Kysely, Selectable, Transaction, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { createHash, randomUUID } from 'node:crypto';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type {
  MediaImportCreateDto,
  MediaInspectDto,
  MediaSubscriptionCreateDto,
  MediaSubscriptionUpdateDto,
} from 'src/dtos/media-import.dto.js';
import type { MediaDownloadInspection } from 'src/repositories/media-downloader.repository.js';
import type { DB } from 'src/schema/index.js';
import type {
  MediaConnectionTable,
  MediaImportItemTable,
  MediaImportTable,
  MediaSubscriptionTable,
} from 'src/schema/tables/media-import.table.js';
import { AlbumUserRole, AssetStatus, LibraryScope, Permission, UserMetadataKey, UserStatus } from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { CaptureRepository } from 'src/repositories/capture.repository.js';
import {
  associatedSeeds,
  lockEditFamilyAssets,
  requireEditFamilyCoverage,
} from 'src/repositories/icloud-edit-transaction.js';
import { TrashRepository } from 'src/repositories/trash.repository.js';
import { hiddenFromOthers, tagIsSuppressed } from 'src/utils/database.js';
import { isNotLocked } from 'src/utils/locked.js';
import { mediaSourceKey, nextMediaCheck } from 'src/utils/media-import.js';
import { canonicalJson } from 'src/utils/object.js';
import { getPreferences } from 'src/utils/preferences.js';
import { TrashReviewAction } from 'src/utils/trash-review.js';

export type MediaImport = Selectable<MediaImportTable>;
export type MediaImportItem = Selectable<MediaImportItemTable>;
export type MediaConnection = Selectable<MediaConnectionTable>;
export type MediaSubscription = Selectable<MediaSubscriptionTable>;
export type MediaImportAuthority = {
  ownerId: string;
  importId: string;
  itemId?: string;
  generation: number;
  subscriptionGeneration: number | null;
  jobId: string;
  jobToken: string;
};
const active = ['inspecting', 'queued', 'downloading', 'assembling', 'importing'] as const;
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');

/** One item cannot be published; the rest of its import carries on. */
export class MediaItemConflict extends ConflictException {}

@Injectable()
export class MediaImportRepository {
  constructor(
    @InjectKysely() private db: Kysely<DB>,
    private captures: CaptureRepository,
  ) {}

  async actor(auth: AuthDto, permission: Permission) {
    if (auth.oauthApp) throw new ForbiddenException('Authorize a Library session or media API key');
    await this.db
      .transaction()
      .execute((tx) => this.captures.assertActor(auth, tx, permission, permission === Permission.MediaImportCreate));
  }

  private async workerKey(ownerId: string, apiKeyId: string | null, db: Kysely<DB>) {
    if (!apiKeyId) return null;
    const extension = await db
      .selectFrom('browser_extension_access')
      .select('apiKeyId')
      .where('userId', '=', ownerId)
      .where('apiKeyId', '=', apiKeyId)
      .executeTakeFirst();
    // Accepted Library work survives extension sign-out; site disconnect and owner grants still fence it.
    return extension ? null : apiKeyId;
  }

  async destination(tx: Kysely<DB>, ownerId: string, albumId: string | null, tagIds: string[] = []) {
    if (!albumId) throw new NotFoundException('Boards collection is unavailable');
    const album = await tx
      .selectFrom('album')
      .innerJoin('album_user', 'album.id', 'album_user.albumId')
      .select('album.id')
      .where('album.id', '=', albumId)
      .where('album_user.userId', '=', ownerId)
      .where('album_user.role', 'in', [AlbumUserRole.Owner, AlbumUserRole.Editor])
      .where('album.libraryScope', 'in', [LibraryScope.Design, LibraryScope.Both])
      .where('album.deletedAt', 'is', null)
      .where('album.isLocked', '=', false)
      .forShare()
      .executeTakeFirst();
    if (!album) throw new NotFoundException('Boards collection is unavailable');
    if (tagIds.length > 0) {
      const metadata = await tx
        .selectFrom('user_metadata')
        .selectAll()
        .where('userId', '=', ownerId)
        .where('key', '=', UserMetadataKey.Preferences)
        .forShare()
        .execute();
      const hiddenTags = getPreferences(metadata).privacy.suppression.tagIds;
      const tags = await tx
        .selectFrom('tag')
        .select('id')
        .where('userId', '=', ownerId)
        .where('id', 'in', tagIds)
        .where(sql<boolean>`not ${tagIsSuppressed(sql.ref('tag.id'), hiddenTags)}`)
        .forShare()
        .execute();
      if (tags.length !== new Set(tagIds).size) throw new NotFoundException('Tag is unavailable');
    }
  }

  async connection(ownerId: string, id: string, db: Kysely<DB> = this.db) {
    const row = await db
      .selectFrom('media_connection')
      .selectAll()
      .where('id', '=', id)
      .where('ownerId', '=', ownerId)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('Connection unavailable');
    return row;
  }
  connections(ownerId: string) {
    return this.db
      .selectFrom('media_connection')
      .selectAll()
      .where('ownerId', '=', ownerId)
      .orderBy('createdAt', 'desc')
      .execute();
  }
  addSiteConnection(input: {
    id: string;
    ownerId: string;
    provider: string;
    label: string;
    domains: string[];
    encryptedSession: string;
  }) {
    return this.db.insertInto('media_connection').values(input).returningAll().executeTakeFirstOrThrow();
  }
  async updateConnection(ownerId: string, id: string, encryptedSession: string | null, domains?: string[]) {
    return this.db.transaction().execute(async (tx) => {
      await this.connection(ownerId, id, tx);
      await this.cancelJobs(tx, sql<boolean>`"connectionId" = ${id}::uuid`);
      const row = await tx
        .updateTable('media_connection')
        .set({
          encryptedSession,
          ...(domains && { domains }),
          status: encryptedSession ? 'connected' : 'disconnected',
          revision: sql`revision + 1`,
          updatedAt: new Date(),
        })
        .where('id', '=', id)
        .where('ownerId', '=', ownerId)
        .returningAll()
        .executeTakeFirstOrThrow();
      await tx
        .updateTable('media_import')
        .set({
          state: 'paused',
          generation: sql`generation + 1`,
          error: 'Connection changed; retry to use its current access',
          updatedAt: new Date(),
        })
        .where('connectionId', '=', id)
        .where('state', 'in', active)
        .execute();
      await tx
        .updateTable('media_subscription')
        .set({
          status: 'attention',
          generation: sql`generation + 1`,
          error: 'Connection changed; resume to use its current access',
          updatedAt: new Date(),
        })
        .where('connectionId', '=', id)
        .where('status', '!=', 'unsubscribed')
        .execute();
      return row;
    });
  }

  async inspect(
    ownerId: string,
    apiKeyId: string | null,
    dto: MediaInspectDto,
    authorization: MediaImport['authorization'] = Permission.MediaImportCreate,
  ) {
    return this.db.transaction().execute(async (tx) => {
      // The owner row serializes the count with the insert, as assertActor does for create.
      const owner = await tx
        .selectFrom('user')
        .select('id')
        .where('id', '=', ownerId)
        .where('deletedAt', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!owner) throw new NotFoundException('Media import unavailable');
      const pending = await tx
        .selectFrom('media_import')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('ownerId', '=', ownerId)
        .where('state', 'in', active)
        .executeTakeFirstOrThrow();
      if (Number(pending.count) >= 20)
        throw new ConflictException('Wait for existing inspections and downloads to finish');
      const connection = dto.connectionId ? await this.connection(ownerId, dto.connectionId, tx) : null;
      if (connection && connection.status !== 'connected') throw new ConflictException('Refresh this connection first');
      return tx
        .insertInto('media_import')
        .values({
          ownerId,
          apiKeyId: await this.workerKey(ownerId, apiKeyId, tx),
          urls: dto.urls,
          authorization,
          connectionId: connection?.id ?? null,
          connectionRevision: connection?.revision ?? null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }
  /** One query for every listed import, so a history page never fans out per row. */
  async itemsByImport(importIds: string[]) {
    const grouped = new Map<string, MediaImportItem[]>(importIds.map((id) => [id, []]));
    if (importIds.length === 0) return grouped;
    const rows = await this.db
      .selectFrom('media_import_item')
      .selectAll()
      .where('importId', 'in', importIds)
      .orderBy('id')
      .execute();
    for (const row of rows) grouped.get(row.importId)?.push(row);
    return grouped;
  }
  async get(ownerId: string, id: string, db: Kysely<DB> = this.db) {
    const row = await db
      .selectFrom('media_import')
      .selectAll()
      .where('id', '=', id)
      .where('ownerId', '=', ownerId)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('Media import unavailable');
    return row;
  }
  getWorker(id: string) {
    return this.db.selectFrom('media_import').selectAll().where('id', '=', id).executeTakeFirst();
  }
  list(ownerId: string) {
    return this.db
      .selectFrom('media_import')
      .selectAll()
      .where('ownerId', '=', ownerId)
      .orderBy('createdAt', 'desc')
      .limit(100)
      .execute();
  }
  items(importId: string) {
    return this.db.selectFrom('media_import_item').selectAll().where('importId', '=', importId).orderBy('id').execute();
  }
  async create(auth: AuthDto, dto: MediaImportCreateDto) {
    return this.db.transaction().execute(async (tx) => {
      await this.captures.assertActor(auth, tx, Permission.MediaImportCreate, true);
      const requestHash = hash(dto);
      const existing = await tx
        .selectFrom('media_import')
        .selectAll()
        .where('ownerId', '=', auth.user.id)
        .where('idempotencyKey', '=', dto.idempotencyKey)
        .executeTakeFirst();
      if (existing) {
        if (existing.requestHash !== requestHash)
          throw new ConflictException('Idempotency key already used for a different request');
        return existing;
      }
      const preview = await this.get(auth.user.id, dto.inspectionId, tx);
      if (preview.state !== 'ready') throw new ConflictException('Wait for inspection to finish');
      if (preview.connectionId) {
        const connection = await this.connection(auth.user.id, preview.connectionId, tx);
        if (connection.status !== 'connected' || connection.revision !== preview.connectionRevision)
          throw new ConflictException('Site access changed; inspect the URL again');
      }
      await this.destination(tx, auth.user.id, dto.albumId, dto.tagIds);
      const selected = await tx
        .selectFrom('media_import_item')
        .selectAll()
        .where('importId', '=', preview.id)
        .where('id', 'in', dto.itemIds)
        .execute();
      if (selected.length !== new Set(dto.itemIds).size) throw new NotFoundException('Media selection unavailable');
      const created = await tx
        .insertInto('media_import')
        .values({
          ownerId: auth.user.id,
          apiKeyId: await this.workerKey(auth.user.id, auth.apiKey?.id ?? null, tx),
          idempotencyKey: dto.idempotencyKey,
          requestHash,
          urls: preview.urls,
          inspection: preview.inspection,
          connectionId: preview.connectionId,
          connectionRevision: preview.connectionRevision,
          albumId: dto.albumId,
          tagIds: [...new Set(dto.tagIds)],
          streamMp4: dto.streamMp4,
          overrideSuppression: dto.overrideSuppression,
          state: 'queued',
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await tx
        .insertInto('media_import_item')
        .values(
          selected.map(({ entry, sourceKey }) => ({ importId: created.id, ownerId: auth.user.id, entry, sourceKey })),
        )
        .execute();
      return created;
    });
  }

  async cancel(ownerId: string, id: string) {
    return this.db.transaction().execute(async (tx) => {
      await this.get(ownerId, id, tx);
      await this.cancelJobs(tx, sql<boolean>`id = ${id}::uuid`);
      await tx
        .updateTable('media_import')
        .set({ state: 'cancelled', generation: sql`generation + 1`, updatedAt: new Date() })
        .where('id', '=', id)
        .execute();
    });
  }
  private async cancelJobs(tx: Transaction<DB>, predicate: ReturnType<typeof sql<boolean>>) {
    await sql`update job set "cancelRequestedAt" = clock_timestamp(), "cancelReason" = 'request'
      where name = 'media-import' and state in ('active','pending','waiting')
      and data->>'id' in (select id::text from media_import where ${predicate})`.execute(tx);
  }
  async retry(ownerId: string, id: string, key: string) {
    return this.db.transaction().execute(async (tx) => {
      const row = await tx
        .selectFrom('media_import')
        .selectAll()
        .where('id', '=', id)
        .where('ownerId', '=', ownerId)
        .forUpdate()
        .executeTakeFirst();
      if (!row) throw new NotFoundException('Import unavailable');
      if (row.retryKeys.includes(key)) return row;
      if (!['partial', 'failed', 'paused', 'cancelled'].includes(row.state))
        throw new ConflictException('This import is not ready to retry');
      const connection = row.connectionId ? await this.connection(ownerId, row.connectionId, tx) : null;
      if (connection && connection.status !== 'connected') throw new ConflictException('Refresh this connection first');
      if (row.subscriptionId) throw new ConflictException('Use Check now on the subscription');
      const hasItems = await tx
        .selectFrom('media_import_item')
        .select('id')
        .where('importId', '=', id)
        .executeTakeFirst();
      await tx
        .updateTable('media_import_item')
        .set({ state: 'discovered', error: null, updatedAt: new Date() })
        .where('importId', '=', id)
        .where('state', 'not in', ['saved', 'skipped'])
        .execute();
      return tx
        .updateTable('media_import')
        .set({
          state: row.albumId && hasItems ? 'queued' : 'inspecting',
          error: null,
          generation: row.generation + 1,
          connectionRevision: connection?.revision ?? null,
          retries: 0,
          availableAt: new Date(),
          retryKeys: [...row.retryKeys, key],
          jobRunId: null,
          updatedAt: new Date(),
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }
  async recoverable() {
    return this.db
      .selectFrom('media_import')
      .selectAll()
      .where('state', 'in', active)
      .where('availableAt', '<=', new Date())
      .orderBy('createdAt')
      .limit(100)
      .execute();
  }
  async metrics() {
    const {
      rows: [value],
    } = await sql<{
      queueAge: number;
      bytes: number;
      failures: number;
      authenticationFailures: number;
      retries: number;
      subscriptionLag: number;
    }>`select
      coalesce((select extract(epoch from now()-min("createdAt")) from media_import where state in ('queued','inspecting')),0)::float8 as "queueAge",
      coalesce((select sum(bytes) from media_import_item),0)::float8 as bytes,
      (select count(*) from media_import_item where state='failed')::float8 as failures,
      (select count(*) from media_connection where status='expired')::float8 as "authenticationFailures",
      coalesce((select sum(retries + jsonb_array_length("retryKeys")) from media_import),0)::float8 as retries,
      coalesce((select greatest(0,extract(epoch from now()-min("nextCheckAt"))) from media_subscription where status='active'),0)::float8 as "subscriptionLag"`.execute(
      this.db,
    );
    const { rows: providers } = await sql<{ provider: string; failures: number }>`
      select entry->>'provider' as provider, count(*)::float8 as failures
      from media_import_item where state = 'failed'
      and entry->>'provider' ~ '^[a-zA-Z0-9_.:-]{1,100}$'
      group by entry->>'provider' order by count(*) desc limit 200`.execute(this.db);
    return { ...value, providers };
  }

  setRun(id: string, runId: string) {
    return this.db.updateTable('media_import').set({ jobRunId: runId }).where('id', '=', id).execute();
  }

  authority(row: MediaImport, itemId?: string): MediaImportAuthority {
    const context = queueExecution.getStore();
    if (!context || context.claim.data.id !== row.id)
      throw new ConflictException('Media import requires its current job');
    return {
      ownerId: row.ownerId,
      importId: row.id,
      itemId,
      generation: row.generation,
      subscriptionGeneration: row.subscriptionGeneration,
      jobId: context.claim.id,
      jobToken: context.claim.token,
    };
  }
  async assertAuthority(authority: MediaImportAuthority, db: Kysely<DB> = this.db) {
    queueExecution.getStore()?.signal.throwIfAborted();
    const claim = await db
      .selectFrom('job')
      .select('id')
      .where('id', '=', authority.jobId)
      .where('token', '=', authority.jobToken)
      .where('state', '=', 'active')
      .where('cancelRequestedAt', 'is', null)
      .where('leaseExpiresAt', '>', sql<Date>`clock_timestamp()`)
      .forUpdate()
      .executeTakeFirst();
    if (!claim) throw new ConflictException('Media import job was revoked');
    const user = await db
      .selectFrom('user')
      .selectAll()
      .where('id', '=', authority.ownerId)
      .where('deletedAt', 'is', null)
      .where('status', '=', UserStatus.Active)
      .forUpdate()
      .executeTakeFirst();
    if (!user || user.uploadsPaused) throw new ForbiddenException('Media imports are paused for this account');
    const row = await db
      .selectFrom('media_import')
      .selectAll()
      .where('id', '=', authority.importId)
      .where('ownerId', '=', authority.ownerId)
      .where('generation', '=', authority.generation)
      .where('state', 'in', active)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw new ConflictException('Media import was cancelled or changed');
    if (row.apiKeyId) {
      const key = await db
        .selectFrom('api_key')
        .select('id')
        .where('id', '=', row.apiKeyId)
        .where('userId', '=', authority.ownerId)
        .where(sql<boolean>`${row.authorization} = any(permissions) or ${Permission.All} = any(permissions)`)
        .forShare()
        .executeTakeFirst();
      if (!key) throw new ForbiddenException('Media authorization was revoked');
    }
    if (row.connectionId) {
      const connection = await db
        .selectFrom('media_connection')
        .select('id')
        .where('id', '=', row.connectionId)
        .where('ownerId', '=', row.ownerId)
        .where('revision', '=', row.connectionRevision!)
        .where('status', '=', 'connected')
        .forShare()
        .executeTakeFirst();
      if (!connection) throw new ConflictException('Refresh site access before continuing');
    }
    if (row.subscriptionId) {
      const subscription = await db
        .selectFrom('media_subscription')
        .select('id')
        .where('id', '=', row.subscriptionId)
        .where('ownerId', '=', row.ownerId)
        .where('generation', '=', authority.subscriptionGeneration!)
        .where('status', '=', 'active')
        .forShare()
        .executeTakeFirst();
      if (!subscription) throw new ConflictException('Subscription was paused or changed');
    }
    if (row.albumId || row.state !== 'inspecting' || row.subscriptionId)
      await this.destination(db, row.ownerId, row.albumId, row.tagIds);
    if (
      authority.itemId &&
      !(await db
        .selectFrom('media_import_item')
        .select('id')
        .where('id', '=', authority.itemId)
        .where('importId', '=', row.id)
        .where('ownerId', '=', row.ownerId)
        .executeTakeFirst())
    )
      throw new NotFoundException('Media item unavailable');
    return { row, user };
  }
  async fenced<T>(authority: MediaImportAuthority, action: (tx: Transaction<DB>, row: MediaImport) => Promise<T>) {
    return this.db.transaction().execute(async (tx) => {
      const { row } = await this.assertAuthority(authority, tx);
      const result = await action(tx, row);
      await this.assertAuthority(authority, tx);
      return result;
    });
  }
  async discovered(authority: MediaImportAuthority, inspection: MediaDownloadInspection, preview: boolean) {
    return this.fenced(authority, async (tx, row) => {
      let entries = inspection.entries;
      if (row.subscriptionId && entries.length > 0) {
        const receipts = await tx
          .selectFrom('media_import_item as receipt')
          .innerJoin('media_import as operation', 'operation.id', 'receipt.importId')
          .select('receipt.sourceKey')
          .where('operation.subscriptionId', '=', row.subscriptionId)
          .where('receipt.ownerId', '=', row.ownerId)
          .where('receipt.state', 'in', ['saved', 'skipped'])
          .where(
            'receipt.sourceKey',
            'in',
            entries.map((entry) => mediaSourceKey(entry)),
          )
          .execute();
        const saved = new Set(receipts.map((receipt) => receipt.sourceKey));
        entries = entries.filter((entry) => !saved.has(mediaSourceKey(entry)));
      }
      if (entries.length > 0)
        await tx
          .insertInto('media_import_item')
          .values(
            entries.map((entry) => ({
              importId: row.id,
              ownerId: row.ownerId,
              sourceKey: mediaSourceKey(entry),
              entry,
            })),
          )
          .onConflict((oc) => oc.columns(['importId', 'sourceKey']).doNothing())
          .execute();
      const { entries: _, ...summary } = inspection;
      await tx
        .updateTable('media_import')
        .set({ inspection: summary, updatedAt: new Date() })
        .where('id', '=', row.id)
        .execute();
    }).then(async () => {
      if (preview) await this.transition(authority, 'ready');
    });
  }
  async transition(authority: MediaImportAuthority, state: MediaImport['state'], error: string | null = null) {
    return this.db.transaction().execute(async (tx) => {
      await this.assertAuthority(authority, tx);
      await tx
        .updateTable('media_import')
        .set({ state, error, updatedAt: new Date() })
        .where('id', '=', authority.importId)
        .execute();
    });
  }
  async progress(
    authority: MediaImportAuthority,
    state: MediaImportItem['state'],
    bytes?: number,
    error: string | null = null,
  ) {
    return this.fenced(authority, async (tx) => {
      await tx
        .updateTable('media_import_item')
        .set({ state, ...(bytes !== undefined && { bytes }), error, updatedAt: new Date() })
        .where('id', '=', authority.itemId!)
        .where('state', '!=', 'saved')
        .execute();
    });
  }
  async uploadId(authority: MediaImportAuthority, file?: { sha256: string; filename: string }) {
    return this.fenced(authority, async (tx) => {
      const item = await tx
        .selectFrom('media_import_item')
        .selectAll()
        .where('id', '=', authority.itemId!)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (item.uploadId) {
        const upload = await tx
          .selectFrom('asset_upload_resource')
          .selectAll()
          .where('id', '=', item.uploadId)
          .where('ownerId', '=', authority.ownerId)
          .executeTakeFirst();
        if (
          !file ||
          upload?.state === 'published' ||
          (upload &&
            upload.expiresAt > new Date() &&
            !['rejected', 'cancelled'].includes(upload.state) &&
            upload.expectedChecksum.toString('hex') === file.sha256 &&
            upload.metadata.filename === file.filename)
        )
          return item.uploadId;
        if (upload)
          await tx
            .updateTable('asset_upload_resource')
            .set({ state: 'cancelled', expiresAt: new Date() })
            .where('id', '=', upload.id)
            .execute();
      }
      const uploadId = randomUUID();
      await tx.updateTable('media_import_item').set({ uploadId }).where('id', '=', item.id).execute();
      return uploadId;
    });
  }
  async suppressed(row: MediaImport, item: MediaImportItem, db: Kysely<DB> = this.db) {
    if (row.overrideSuppression && !row.subscriptionId) return false;
    const previous = await db
      .selectFrom('media_import_item as receipt')
      .innerJoin('media_import as operation', 'operation.id', 'receipt.importId')
      .select(['receipt.suppression', 'receipt.assetId', 'operation.subscriptionId'])
      .where('receipt.ownerId', '=', row.ownerId)
      .where('receipt.sourceKey', '=', item.sourceKey)
      .where('receipt.id', '!=', item.id)
      .execute();
    return previous.some(
      (receipt) =>
        receipt.suppression === 'owner' ||
        (row.subscriptionId && receipt.subscriptionId === row.subscriptionId && receipt.suppression === 'subscription'),
    );
  }
  async reusePublished(authority: MediaImportAuthority, item: MediaImportItem) {
    return this.fenced(authority, async (tx, row) => {
      const existing = await tx
        .selectFrom('media_import_item as receipt')
        .innerJoin('media_import as operation', 'operation.id', 'receipt.importId')
        .innerJoin('asset', 'asset.id', 'receipt.assetId')
        .innerJoin('album_asset', 'album_asset.assetId', 'asset.id')
        .select('asset.id')
        .where('asset.ownerId', '=', row.ownerId)
        .where('receipt.ownerId', '=', row.ownerId)
        .where('receipt.sourceKey', '=', item.sourceKey)
        .where('receipt.state', '=', 'saved')
        .where('asset.deletedAt', 'is', null)
        .where('album_asset.albumId', '=', row.albumId!)
        .where(isNotLocked())
        .where(sql<boolean>`not ${hiddenFromOthers(undefined)}`)
        .executeTakeFirst();
      if (!existing) return false;
      if (row.tagIds.length > 0)
        await tx
          .insertInto('tag_asset')
          .values(row.tagIds.map((tagId) => ({ tagId, assetId: existing.id })))
          .onConflict((oc) => oc.doNothing())
          .execute();
      await tx
        .updateTable('media_import_item')
        .set({ assetId: existing.id, state: 'saved', error: null, updatedAt: new Date() })
        .where('id', '=', item.id)
        .execute();
      return true;
    });
  }
  async publish(
    tx: Transaction<DB>,
    authority: MediaImportAuthority,
    publish: () => Promise<{ id: string; status: 'created' | 'duplicate' }>,
  ) {
    const { row } = await this.assertAuthority(authority, tx);
    const item = await tx
      .selectFrom('media_import_item')
      .selectAll()
      .where('id', '=', authority.itemId!)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (item.state === 'saved') return item.assetId!;
    if (await this.suppressed(row, item, tx)) throw new MediaItemConflict('This media was removed locally');
    if (row.overrideSuppression && !row.subscriptionId) await lockEditFamilyAssets(tx, row.ownerId);
    const result = await publish();
    const asset = await tx
      .selectFrom('asset')
      .select(['id', 'deletedAt', 'status'])
      .where('id', '=', result.id)
      .where('ownerId', '=', row.ownerId)
      .where(isNotLocked())
      .where(sql<boolean>`not ${hiddenFromOthers(undefined)}`)
      .forUpdate()
      .executeTakeFirst();
    if (!asset) throw new MediaItemConflict('Existing media is in Trash or unavailable');
    if (asset.deletedAt) {
      if (!row.overrideSuppression || row.subscriptionId || asset.status !== AssetStatus.Trashed)
        throw new MediaItemConflict('Existing media is in Trash or unavailable');
      const seeds = await associatedSeeds(tx, row.ownerId, [asset.id]);
      const binding = requireEditFamilyCoverage(
        tx,
        { ...seeds, assetIds: [...new Set([...seeds.assetIds, asset.id])] },
        seeds.items.length > 0,
      );
      await lockEditFamilyAssets(tx, row.ownerId);
      const trash = new TrashRepository(tx);
      const restored = await trash.applyReviewedWithin(
        tx,
        row.ownerId,
        TrashReviewAction.Restore,
        [asset.id],
        {},
        (rows) => rows.length === 1 && rows[0].id === asset.id,
      );
      if (restored?.length !== 1) throw new MediaItemConflict('Existing media cannot be restored');
      await trash.appendStatusEffects(tx, row.ownerId, restored, AssetStatus.Active, binding.family.assetIds);
      await this.assertAuthority(authority, tx);
    }
    await tx
      .insertInto('album_asset')
      .values({ albumId: row.albumId!, assetId: asset.id })
      .onConflict((oc) => oc.doNothing())
      .execute();
    if (row.tagIds.length > 0)
      await tx
        .insertInto('tag_asset')
        .values(row.tagIds.map((tagId) => ({ tagId, assetId: asset.id })))
        .onConflict((oc) => oc.doNothing())
        .execute();
    const entry = item.entry;
    await tx
      .insertInto('asset_source')
      .values({
        assetId: asset.id,
        captureId: item.uploadId!,
        pageUrl: entry.pageUrl,
        mediaUrl: null,
        title: entry.title,
        capturedAt: new Date(),
        creator: entry.creator,
        note: entry.description || null,
        provider: entry.provider,
        creatorId: entry.creatorId,
        postId: entry.postId,
        attachmentId: entry.attachmentId,
        publishedAt: entry.publishedAt,
        postText: entry.description,
      })
      .onConflict((oc) => oc.column('captureId').doNothing())
      .execute();
    await tx
      .updateTable('media_import_item')
      .set({ state: 'saved', assetId: asset.id, error: null, updatedAt: new Date() })
      .where('id', '=', item.id)
      .execute();
    await this.assertAuthority(authority, tx);
    return asset.id;
  }

  async withCapacity<T>(row: Pick<MediaImport, 'connectionId'>, provider: string | null, action: () => Promise<T>) {
    return this.db.connection().execute(async (connection) => {
      const session = row.connectionId ?? 'public';
      // Inspection has no trusted provider identity yet, so it excludes downloads for this session.
      const gate = provider
        ? await sql<{ ok: boolean }>`select pg_try_advisory_lock_shared(-1429, hashtext(${session})) as ok`.execute(
            connection,
          )
        : await sql<{ ok: boolean }>`select pg_try_advisory_lock(-1429, hashtext(${session})) as ok`.execute(
            connection,
          );
      if (!gate.rows[0].ok) return;
      const key = `${provider}:${session}`;
      let providerHeld = false;
      let slot: number | undefined;
      try {
        if (provider) {
          const lock = await sql<{ ok: boolean }>`select pg_try_advisory_lock(-1427, hashtext(${key})) as ok`.execute(
            connection,
          );
          if (!lock.rows[0].ok) return;
          providerHeld = true;
        }
        for (const candidate of [0, 1]) {
          const lock = await sql<{ ok: boolean }>`select pg_try_advisory_lock(-1428, ${candidate}) as ok`.execute(
            connection,
          );
          if (lock.rows[0].ok) {
            slot = candidate;
            break;
          }
        }
        if (slot === undefined) return;
        return await action();
      } finally {
        if (slot !== undefined) await sql`select pg_advisory_unlock(-1428, ${slot})`.execute(connection);
        if (providerHeld) await sql`select pg_advisory_unlock(-1427, hashtext(${key}))`.execute(connection);
        if (provider) await sql`select pg_advisory_unlock_shared(-1429, hashtext(${session}))`.execute(connection);
        else await sql`select pg_advisory_unlock(-1429, hashtext(${session}))`.execute(connection);
      }
    });
  }

  async defer(authority: MediaImportAuthority, seconds: number, error: string, retry = true) {
    return this.fenced(authority, async (tx) => {
      await tx
        .updateTable('media_import')
        .set({
          availableAt: new Date(Date.now() + seconds * 1000),
          retries: sql`retries + ${Number(retry)}`,
          error,
          updatedAt: new Date(),
        })
        .where('id', '=', authority.importId)
        .execute();
    });
  }
  async subscription(ownerId: string, id: string, db: Kysely<DB> = this.db) {
    const row = await db
      .selectFrom('media_subscription')
      .selectAll()
      .where('ownerId', '=', ownerId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('Subscription unavailable');
    return row;
  }
  subscriptions(ownerId: string) {
    return this.db
      .selectFrom('media_subscription')
      .selectAll()
      .where('ownerId', '=', ownerId)
      .orderBy('createdAt', 'desc')
      .execute();
  }
  async subscriptionCounts(id: string) {
    const rows = await this.db
      .selectFrom('media_import_item')
      .innerJoin('media_import', 'media_import.id', 'media_import_item.importId')
      .select(['media_import_item.sourceKey', 'media_import_item.state', 'media_import_item.suppression'])
      .where('media_import.subscriptionId', '=', id)
      .orderBy('media_import_item.createdAt')
      .orderBy('media_import_item.id')
      .execute();
    const latest = new Map(rows.map((row) => [row.sourceKey, row.suppression ? 'skipped' : row.state]));
    const states = latest.values().toArray();
    return {
      discovered: latest.size,
      saved: states.filter((state) => state === 'saved').length,
      skipped: states.filter((state) => state === 'skipped').length,
      failed: states.filter((state) => state === 'failed').length,
    };
  }
  async createSubscription(auth: AuthDto, dto: MediaSubscriptionCreateDto) {
    return this.db.transaction().execute(async (tx) => {
      await this.captures.assertActor(auth, tx, Permission.MediaSubscriptionWrite, true);
      const existing = await tx
        .selectFrom('media_subscription')
        .selectAll()
        .where('ownerId', '=', auth.user.id)
        .where('idempotencyKey', '=', dto.idempotencyKey)
        .executeTakeFirst();
      if (existing) {
        if (existing.requestHash !== hash(dto)) throw new ConflictException('Idempotency key already used');
        return existing;
      }
      const preview = await this.get(auth.user.id, dto.inspectionId, tx);
      const info = preview.inspection;
      if (preview.state !== 'ready' || info?.kind !== 'feed' || !info.creatorId)
        throw new BadRequestException('Inspect a supported creator feed before subscribing');
      if (dto.parentId) {
        await this.destination(tx, auth.user.id, dto.parentId);
        const shared = await tx
          .selectFrom('album_closure')
          .innerJoin('album_user', 'album_user.albumId', 'album_closure.id_ancestor')
          .select('album_user.userId')
          .where('id_descendant', '=', dto.parentId)
          .where('userId', '!=', auth.user.id)
          .executeTakeFirst();
        const links = await tx
          .selectFrom('album_closure')
          .innerJoin('shared_link', 'shared_link.albumId', 'album_closure.id_ancestor')
          .select('shared_link.id')
          .where('id_descendant', '=', dto.parentId)
          .executeTakeFirst();
        if (shared || links) throw new BadRequestException('Choose a private parent collection');
      }
      const album = await new AlbumRepository(tx).create(
        {
          albumName: `${info.creator ?? info.creatorId} · ${info.provider}`.slice(0, 255),
          libraryScope: LibraryScope.Design,
          parentId: dto.parentId ?? null,
        },
        [],
        [{ userId: auth.user.id, role: AlbumUserRole.Owner }],
        auth.user.id,
      );
      return tx
        .insertInto('media_subscription')
        .values({
          ownerId: auth.user.id,
          idempotencyKey: dto.idempotencyKey,
          requestHash: hash(dto),
          apiKeyId: await this.workerKey(auth.user.id, auth.apiKey?.id ?? null, tx),
          provider: info.provider,
          creatorId: info.creatorId,
          creator: info.creator ?? info.creatorId,
          url: info.canonicalUrl,
          extractionUrl: preview.urls[0],
          albumId: album.id,
          connectionId: preview.connectionId,
          history: dto.history,
          intervalMinutes: dto.intervalMinutes,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }
  async updateSubscription(ownerId: string, id: string, dto: MediaSubscriptionUpdateDto) {
    return this.db.transaction().execute(async (tx) => {
      await this.subscription(ownerId, id, tx);
      const changedAuthority =
        dto.connectionId !== undefined || ['pause', 'resume', 'unsubscribe'].includes(dto.action ?? '');
      if (changedAuthority) await this.cancelJobs(tx, sql<boolean>`"subscriptionId" = ${id}::uuid`);
      const current = await tx
        .selectFrom('media_subscription')
        .selectAll()
        .where('id', '=', id)
        .where('ownerId', '=', ownerId)
        .forUpdate()
        .executeTakeFirst();
      if (!current) throw new NotFoundException('Subscription unavailable');
      if (current.status === 'unsubscribed')
        throw new ConflictException('This subscription ended; create a new subscription');
      if (dto.connectionId) {
        const connection = await this.connection(ownerId, dto.connectionId, tx);
        if (connection.status !== 'connected') throw new ConflictException('Refresh this connection first');
      }
      const status =
        dto.action === 'unsubscribe'
          ? 'unsubscribed'
          : dto.action === 'pause'
            ? 'paused'
            : dto.action === 'resume'
              ? 'active'
              : current.status;
      const row = await tx
        .updateTable('media_subscription')
        .set({
          status,
          ...(dto.intervalMinutes && { intervalMinutes: dto.intervalMinutes }),
          ...(dto.connectionId !== undefined && { connectionId: dto.connectionId }),
          generation: changedAuthority ? current.generation + 1 : current.generation,
          ...(dto.action === 'resume' || dto.action === 'check' ? { nextCheckAt: new Date(), error: null } : {}),
          updatedAt: new Date(),
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      if (changedAuthority) {
        await tx
          .updateTable('media_import')
          .set({ state: 'cancelled', generation: sql`generation + 1`, updatedAt: new Date() })
          .where('subscriptionId', '=', id)
          .where('state', 'in', active)
          .execute();
      }
      return row;
    });
  }
  async schedule() {
    return this.db.transaction().execute(async (tx) => {
      const due = await tx
        .selectFrom('media_subscription')
        .selectAll()
        .where('status', '=', 'active')
        .where('nextCheckAt', '<=', new Date())
        .orderBy('nextCheckAt')
        .forUpdate()
        .skipLocked()
        .limit(20)
        .execute();
      for (const subscription of due) {
        const running = await tx
          .selectFrom('media_import')
          .select('id')
          .where('subscriptionId', '=', subscription.id)
          .where('state', 'in', active)
          .executeTakeFirst();
        if (running) continue;
        const connection = subscription.connectionId
          ? await this.connection(subscription.ownerId, subscription.connectionId, tx)
          : null;
        await tx
          .insertInto('media_import')
          .values({
            ownerId: subscription.ownerId,
            apiKeyId: subscription.apiKeyId,
            authorization: Permission.MediaSubscriptionWrite,
            subscriptionId: subscription.id,
            subscriptionGeneration: subscription.generation,
            albumId: subscription.albumId,
            urls: [subscription.extractionUrl ?? subscription.url],
            connectionId: connection?.id ?? null,
            connectionRevision: connection?.revision ?? null,
            inspection: {
              kind: 'feed',
              provider: subscription.provider,
              creatorId: subscription.creatorId,
              creator: subscription.creator,
              title: subscription.creator,
              canonicalUrl: subscription.url,
              checkpoint: subscription.checkpoint,
              complete: false,
              limitation: subscription.limitation,
            },
          })
          .execute();
        await tx
          .updateTable('media_subscription')
          .set({ nextCheckAt: nextMediaCheck(subscription.intervalMinutes) })
          .where('id', '=', subscription.id)
          .execute();
      }
    });
  }
  async finishSubscription(authority: MediaImportAuthority, inspection: MediaDownloadInspection, failed: boolean) {
    return this.fenced(authority, async (tx, row) => {
      if (!row.subscriptionId) return;
      const subscription = await this.subscription(row.ownerId, row.subscriptionId, tx);
      const resumable = !inspection.complete && !!inspection.checkpoint && !failed;
      await tx
        .updateTable('media_subscription')
        .set({
          checkpoint: failed ? subscription.checkpoint : inspection.checkpoint,
          historyComplete: subscription.historyComplete || (!failed && inspection.complete),
          limitation: inspection.limitation,
          lastSuccessAt: failed ? subscription.lastSuccessAt : new Date(),
          nextCheckAt: nextMediaCheck(resumable ? 1 : subscription.intervalMinutes),
          ...(!failed &&
            inspection.complete && {
              checkpoint: null,
              ...(!subscription.lastReconcileAt || Date.now() - subscription.lastReconcileAt.getTime() >= 7 * 86_400_000
                ? { lastReconcileAt: new Date() }
                : {}),
            }),
          updatedAt: new Date(),
        })
        .where('id', '=', subscription.id)
        .execute();
    });
  }
  async failAttempt(
    authority: MediaImportAuthority,
    error: string,
    state: 'failed' | 'partial' | 'paused',
    expired = false,
  ) {
    // Failure settlement may record a lost destination/owner grant, but can never publish media.
    return this.db.transaction().execute(async (tx) => {
      const claim = await tx
        .selectFrom('job')
        .select('id')
        .where('id', '=', authority.jobId)
        .where('token', '=', authority.jobToken)
        .where('state', '=', 'active')
        .where('leaseExpiresAt', '>', sql<Date>`clock_timestamp()`)
        .where('cancelRequestedAt', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!claim) return;
      const row = await tx
        .updateTable('media_import')
        .set({ state, error, updatedAt: new Date() })
        .where('id', '=', authority.importId)
        .where('ownerId', '=', authority.ownerId)
        .where('generation', '=', authority.generation)
        .where('state', 'in', active)
        .returningAll()
        .executeTakeFirst();
      if (expired && row?.connectionId)
        await tx
          .updateTable('media_connection')
          .set({ status: 'expired', updatedAt: new Date() })
          .where('id', '=', row.connectionId)
          .where('revision', '=', row.connectionRevision!)
          .execute();
      if (row?.subscriptionId)
        await tx
          .updateTable('media_subscription')
          .set({ status: 'attention', error, updatedAt: new Date() })
          .where('id', '=', row.subscriptionId)
          .where('generation', '=', authority.subscriptionGeneration!)
          .execute();
    });
  }
}
