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
  MediaCreatorItemsQueryDto,
  MediaImportCreateDto,
  MediaInspectDto,
  MediaSubscriptionCreateDto,
  MediaSubscriptionUpdateDto,
} from 'src/dtos/media-import.dto.js';
import type { MediaDownloadInspection } from 'src/repositories/media-downloader.repository.js';
import type { DB } from 'src/schema/index.js';
import type {
  MediaConnectionTable,
  MediaCreatorTable,
  MediaHistory,
  MediaImportItemTable,
  MediaImportTable,
  MediaSubscriptionTable,
} from 'src/schema/tables/media-import.table.js';
import {
  AlbumUserRole,
  AssetStatus,
  AssetType,
  LibraryScope,
  Permission,
  UserMetadataKey,
  UserStatus,
} from 'src/enum.js';
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
import {
  MEDIA_RECENT_COUNT,
  mediaEntryDetails,
  mediaPublicUrl,
  mediaReachWidened,
  mediaSourceKey,
  nextMediaCheck,
} from 'src/utils/media-import.js';
import { canonicalJson } from 'src/utils/object.js';
import { getPreferences } from 'src/utils/preferences.js';
import { TrashReviewAction } from 'src/utils/trash-review.js';

export type MediaImport = Selectable<MediaImportTable>;
export type MediaImportItem = Selectable<MediaImportItemTable>;
export type MediaConnection = Selectable<MediaConnectionTable>;
export type MediaSubscription = Selectable<MediaSubscriptionTable>;
export type MediaCreator = Selectable<MediaCreatorTable>;
export type MediaCreatorItem = Awaited<ReturnType<MediaImportRepository['creatorItems']>>[number];
type CreatorIdentity = Pick<MediaDownloadInspection, 'kind' | 'provider' | 'creatorId' | 'creator' | 'canonicalUrl'> &
  Pick<Partial<MediaDownloadInspection>, 'profile'>;
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
const reach = (history: MediaHistory): MediaHistory =>
  history.mode === 'recent' ? { mode: 'recent', count: history.count ?? MEDIA_RECENT_COUNT } : history;
const CREATOR_ITEMS_PAGE = 50;

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
      // Saving one post adds its creator without following them; their collection is made on first use.
      const creator = await this.upsertCreator(tx, auth.user.id, preview.inspection);
      const albumId = dto.albumId ?? (creator ? await this.creatorAlbum(tx, creator) : null);
      if (!albumId) throw new BadRequestException('Choose a Boards collection for this media');
      await this.destination(tx, auth.user.id, albumId, dto.tagIds);
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
          albumId,
          mediaCreatorId: creator?.id ?? null,
          quality: dto.quality,
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
      // Each check brings the account's current name and pictures.
      if (row.subscriptionId) await this.upsertCreator(tx, row.ownerId, inspection);
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
      if (row.mediaCreatorId)
        await tx
          .updateTable('asset_source')
          .set({ mediaCreatorId: row.mediaCreatorId })
          .where('assetId', '=', existing.id)
          .where('provider', '=', item.entry.provider)
          .where('postId', '=', item.entry.postId)
          .where('mediaCreatorId', 'is', null)
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
        mediaCreatorId: row.mediaCreatorId,
        ...mediaEntryDetails(entry),
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
  /** The owner's record of this account. What a single post does not say is left as it was. */
  private async upsertCreator(tx: Kysely<DB>, ownerId: string, info: CreatorIdentity | null) {
    if (!info?.creatorId || !info.provider) return null;
    const profile = info.profile ?? {};
    const text = (value: string | undefined, limit: number) => value?.trim().slice(0, limit) || null;
    const known = Object.fromEntries(
      Object.entries({
        handle: text(profile.handle, 255),
        about: text(profile.about, 4000),
        url: mediaPublicUrl(profile.url ?? (info.kind === 'feed' ? info.canonicalUrl : null)),
        avatarUrl: mediaPublicUrl(profile.avatarUrl),
        bannerUrl: mediaPublicUrl(profile.bannerUrl),
      }).filter(([, value]) => value !== null),
    );
    const name = (info.creator ?? info.creatorId).slice(0, 255);
    // A picture that moved is fetched again; the copy of the old one is no longer served.
    const moved = (column: 'avatar' | 'banner') =>
      sql<
        string | null
      >`case when media_creator.${sql.ref(`${column}Url`)} is distinct from excluded.${sql.ref(`${column}Url`)}
        then null else media_creator.${sql.ref(`${column}Path`)} end`;
    return tx
      .insertInto('media_creator')
      .values({ ownerId, provider: info.provider, creatorId: info.creatorId, name, ...known })
      .onConflict((oc) =>
        oc.columns(['ownerId', 'provider', 'creatorId']).doUpdateSet({
          name,
          ...known,
          ...(known.avatarUrl && { avatarPath: moved('avatar') }),
          ...(known.bannerUrl && { bannerPath: moved('banner') }),
          updatedAt: new Date(),
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
  }
  /** The creator's own private collection, made the first time something is filed into it. */
  private async creatorAlbum(tx: Kysely<DB>, creator: MediaCreator, parentId?: string) {
    if (creator.albumId) {
      try {
        await this.destination(tx, creator.ownerId, creator.albumId);
        return creator.albumId;
      } catch (error) {
        if (!(error instanceof NotFoundException)) throw error;
      }
    }
    const album = await new AlbumRepository(tx).create(
      {
        albumName: `${creator.name} · ${creator.provider}`.slice(0, 255),
        libraryScope: LibraryScope.Design,
        parentId: parentId ?? null,
      },
      [],
      [{ userId: creator.ownerId, role: AlbumUserRole.Owner }],
      creator.ownerId,
    );
    await tx.updateTable('media_creator').set({ albumId: album.id }).where('id', '=', creator.id).execute();
    return album.id;
  }
  private async privateParent(tx: Kysely<DB>, ownerId: string, parentId: string) {
    await this.destination(tx, ownerId, parentId);
    const shared = await tx
      .selectFrom('album_closure')
      .innerJoin('album_user', 'album_user.albumId', 'album_closure.id_ancestor')
      .select('album_user.userId')
      .where('id_descendant', '=', parentId)
      .where('userId', '!=', ownerId)
      .executeTakeFirst();
    const links = await tx
      .selectFrom('album_closure')
      .innerJoin('shared_link', 'shared_link.albumId', 'album_closure.id_ancestor')
      .select('shared_link.id')
      .where('id_descendant', '=', parentId)
      .executeTakeFirst();
    if (shared || links) throw new BadRequestException('Choose a private parent collection');
  }

  async creator(ownerId: string, id: string, db: Kysely<DB> = this.db) {
    const row = await db
      .selectFrom('media_creator')
      .selectAll()
      .where('id', '=', id)
      .where('ownerId', '=', ownerId)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('Creator unavailable');
    return row;
  }
  /** Every creator of one account with its folder, live subscription and counts, in three queries. */
  async creators(ownerId: string, id?: string) {
    const rows = await this.db
      .selectFrom('media_creator')
      .leftJoin('album', 'album.id', 'media_creator.albumId')
      .selectAll('media_creator')
      .select('album.parentId as parentAlbumId')
      .where('media_creator.ownerId', '=', ownerId)
      .$if(!!id, (qb) => qb.where('media_creator.id', '=', id!))
      .orderBy('media_creator.name')
      .orderBy('media_creator.id')
      .execute();
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const subscriptions = await this.db
      .selectFrom('media_subscription')
      .selectAll()
      .where('ownerId', '=', ownerId)
      .where('mediaCreatorId', 'in', ids)
      .where('status', '!=', 'unsubscribed')
      .orderBy('createdAt', 'desc')
      .execute();
    const counts = await this.creatorSources(ownerId)
      .select((eb) => [
        'creator.id',
        eb.fn.countAll<string>().as('saved'),
        eb.fn.countAll<string>().filterWhereRef('source.createdAt', '>', 'creator.seenAt').as('fresh'),
      ])
      .where('creator.id', 'in', ids)
      .groupBy('creator.id')
      .execute();
    return rows.map((row) => {
      const count = counts.find((item) => item.id === row.id);
      return {
        ...row,
        subscription: subscriptions.find((subscription) => subscription.mediaCreatorId === row.id) ?? null,
        savedCount: Number(count?.saved ?? 0),
        newCount: Number(count?.fresh ?? 0),
      };
    });
  }
  /** Folders are parent collections: the creator's collection moves under a private one, or to the top. */
  async moveCreator(ownerId: string, id: string, parentAlbumId: string | null) {
    return this.db.transaction().execute(async (tx) => {
      const creator = await this.creator(ownerId, id, tx);
      await this.destination(tx, ownerId, creator.albumId);
      if (parentAlbumId) await this.privateParent(tx, ownerId, parentAlbumId);
      await new AlbumRepository(tx).reparentIn(tx, creator.albumId!, parentAlbumId);
    });
  }
  async seen(ownerId: string, id: string) {
    const row = await this.db
      .updateTable('media_creator')
      .set({ seenAt: new Date() })
      .where('id', '=', id)
      .where('ownerId', '=', ownerId)
      .returning('id')
      .executeTakeFirst();
    if (!row) throw new NotFoundException('Creator unavailable');
  }
  setCreatorImage(id: string, kind: 'avatar' | 'banner', url: string, path: string) {
    return this.db
      .updateTable('media_creator')
      .set(kind === 'avatar' ? { avatarPath: path } : { bannerPath: path })
      .where('id', '=', id)
      .where(kind === 'avatar' ? 'avatarUrl' : 'bannerUrl', '=', url)
      .execute();
  }

  /** One row per saved item of the owner's creators; nothing of another account, the Trash or Locked. */
  private creatorSources(ownerId: string) {
    return this.db
      .selectFrom('asset_source as source')
      .innerJoin('asset', 'asset.id', 'source.assetId')
      .innerJoin('media_creator as creator', 'creator.id', 'source.mediaCreatorId')
      .leftJoin('media_watch as watch', (join) =>
        join.onRef('watch.assetId', '=', 'asset.id').on('watch.ownerId', '=', ownerId),
      )
      .where('creator.ownerId', '=', ownerId)
      .where('asset.ownerId', '=', ownerId)
      .where('asset.deletedAt', 'is', null)
      .where(isNotLocked())
      .where(sql<boolean>`not ${hiddenFromOthers(undefined)}`)
      .where(
        sql<boolean>`not exists (select 1 from asset_source later where later."assetId" = source."assetId"
          and later."mediaCreatorId" = source."mediaCreatorId" and later.id > source.id)`,
      );
  }
  private itemRows(ownerId: string) {
    return this.creatorSources(ownerId).select([
      'asset.id as assetId',
      'asset.type',
      'creator.id as creatorId',
      'source.section',
      'source.title',
      'source.postText',
      'source.tags',
      'source.publishedAt',
      'source.createdAt as savedAt',
      'source.duration',
      'source.postId',
      'source.playlistId',
      'source.playlistTitle',
      'source.pageUrl',
      'source.posterPath',
      'watch.watched',
      'watch.position',
      sql<boolean>`exists (select 1 from media_import_item item join media_import operation on operation.id = item."importId"
        where item."assetId" = source."assetId" and item."uploadId" = source."captureId"
        and operation."subscriptionId" is not null)`.as('subscribed'),
    ]);
  }
  /** One page of a creator's items, with one more row than the page when another page follows. */
  async creatorItems(ownerId: string, id: string, dto: MediaCreatorItemsQueryDto) {
    await this.creator(ownerId, id);
    const words = dto.q ? `%${dto.q.replaceAll(/[\\%_]/g, String.raw`\$&`)}%` : null;
    const published = sql<Date>`coalesce(source."publishedAt", source."createdAt")`;
    return this.itemRows(ownerId)
      .where('creator.id', '=', id)
      .$if(!!dto.section, (qb) => qb.where('source.section', '=', dto.section!))
      .$if(!!dto.kind, (qb) => qb.where('asset.type', '=', dto.kind!.toUpperCase() as AssetType))
      .$if(!!dto.unwatched, (qb) => qb.where(sql<boolean>`coalesce(watch.watched, false) = false`))
      .$if(!!words, (qb) =>
        qb.where(
          sql<boolean>`(source.title ilike ${words} or source."postText" ilike ${words} or source.tags::text ilike ${words})`,
        ),
      )
      .$if(dto.sort === 'longest', (qb) => qb.orderBy('source.duration', (ob) => ob.desc().nullsLast()))
      .orderBy(published, dto.sort === 'oldest' ? 'asc' : 'desc')
      .orderBy('source.id')
      .offset((dto.page - 1) * CREATOR_ITEMS_PAGE)
      .limit(CREATOR_ITEMS_PAGE + 1)
      .execute();
  }
  /** The newest items saved since their creator was last opened, across every creator. */
  newItems(ownerId: string, limit: number) {
    return this.itemRows(ownerId)
      .whereRef('source.createdAt', '>', 'creator.seenAt')
      .orderBy('source.createdAt', 'desc')
      .orderBy('source.id')
      .limit(limit)
      .execute();
  }
  async watch(ownerId: string, assetId: string, state: { watched: boolean; position: number }) {
    return this.db.transaction().execute(async (tx) => {
      const asset = await tx
        .selectFrom('asset')
        .select('id')
        .where('id', '=', assetId)
        .where('ownerId', '=', ownerId)
        .where('deletedAt', 'is', null)
        .where(isNotLocked())
        .forShare()
        .executeTakeFirst();
      if (!asset) throw new NotFoundException('Media unavailable');
      return tx
        .insertInto('media_watch')
        .values({ ownerId, assetId, ...state })
        .onConflict((oc) => oc.columns(['ownerId', 'assetId']).doUpdateSet({ ...state, updatedAt: new Date() }))
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }
  /** The site's cover of a saved video, set once by the import that saved it. */
  setPoster(ownerId: string, assetId: string, entry: MediaImportItem['entry'], path: string) {
    return this.db
      .updateTable('asset_source')
      .set({ posterPath: path })
      .where('assetId', '=', assetId)
      .where('provider', '=', entry.provider)
      .where('postId', '=', entry.postId)
      .where('attachmentId', '=', entry.attachmentId)
      .where('posterPath', 'is', null)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('asset')
            .select('asset.id')
            .whereRef('asset.id', '=', 'asset_source.assetId')
            .where('asset.ownerId', '=', ownerId),
        ),
      )
      .returning('id')
      .executeTakeFirst();
  }
  async poster(ownerId: string, assetId: string) {
    const row = await this.creatorSources(ownerId)
      .select('source.posterPath')
      .where('asset.id', '=', assetId)
      .where('source.posterPath', 'is not', null)
      .executeTakeFirst();
    if (!row?.posterPath) throw new NotFoundException('Cover unavailable');
    return row.posterPath;
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
      if (dto.parentId) await this.privateParent(tx, auth.user.id, dto.parentId);
      const creator = (await this.upsertCreator(tx, auth.user.id, info))!;
      // Following a creator again changes the subscription they have; a second one would check the site
      // twice and outlive Unfollow. The creator upsert above serialises two such requests. How far back
      // is left alone here: it changes on their page, where looking again from the start is handled.
      const followed = await tx
        .selectFrom('media_subscription')
        .select('id')
        .where('ownerId', '=', auth.user.id)
        .where('mediaCreatorId', '=', creator.id)
        .where('status', '!=', 'unsubscribed')
        .orderBy('createdAt', 'desc')
        .executeTakeFirst();
      if (followed)
        return tx
          .updateTable('media_subscription')
          .set({ saves: dto.saves, quality: dto.quality, intervalMinutes: dto.intervalMinutes })
          .where('id', '=', followed.id)
          .returningAll()
          .executeTakeFirstOrThrow();
      // A creator added by an earlier single download keeps the collection they already have.
      const kept = creator.albumId;
      const albumId = await this.creatorAlbum(tx, creator, dto.parentId);
      if (dto.parentId && albumId === kept) await new AlbumRepository(tx).reparentIn(tx, albumId, dto.parentId);
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
          albumId,
          mediaCreatorId: creator.id,
          connectionId: preview.connectionId,
          history: reach(dto.history),
          saves: dto.saves,
          quality: dto.quality,
          intervalMinutes: dto.intervalMinutes,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }
  async updateSubscription(ownerId: string, id: string, dto: MediaSubscriptionUpdateDto) {
    return this.db.transaction().execute(async (tx) => {
      const before = await this.subscription(ownerId, id, tx);
      const history = dto.history && reach(dto.history);
      // Reaching further back looks again from the start; work already running would end it early.
      const widened = !!history && mediaReachWidened(before.history, history, before.createdAt);
      const changedAuthority =
        widened || dto.connectionId !== undefined || ['pause', 'resume', 'unsubscribe'].includes(dto.action ?? '');
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
          ...(history && { history }),
          ...(dto.saves && { saves: dto.saves }),
          ...(dto.quality && { quality: dto.quality }),
          ...(widened && { historyComplete: false, checkpoint: null, lastReconcileAt: null, nextCheckAt: new Date() }),
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
            mediaCreatorId: subscription.mediaCreatorId,
            quality: subscription.quality,
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
