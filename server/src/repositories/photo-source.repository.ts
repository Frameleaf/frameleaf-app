import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Kysely, Selectable, Transaction, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { createHash } from 'node:crypto';
import type {
  PhotoSourceCreateInput,
  PhotoSourceItemDto,
  PhotoSourceReferenceDto,
  PhotoSourceRunDto,
  PhotoSourceRunStateDto,
} from 'src/dtos/photo-source.dto.js';
import type { DB } from 'src/schema/index.js';
import type { PhotoSourceResourceTable } from 'src/schema/tables/photo-source.table.js';
import type { FolderUploadSourceIdentity } from 'src/utils/asset-upload-resource.js';
import { AssetStatus, AssetType, AssetVisibility, ChecksumAlgorithm, QueueName } from 'src/enum.js';
import { lockChecksum, lockFilePath } from 'src/repositories/physical-file.repository.js';
import { retireReferenceVersion } from 'src/repositories/reference-version-retirement.js';
import { AssetSourceChangedError } from 'src/utils/asset-source-authority.js';
import { isLocked, isNotLocked } from 'src/utils/locked.js';
import { lockSourceAuthorities } from 'src/utils/source-authority-lock.js';
import { sourceOriginalPath } from 'src/utils/source-original.js';

export type SourceAuthority = { ownerId: string; sessionId: string };
type Item = Selectable<PhotoSourceResourceTable>;
export type SourceCopyTarget = { item: Item; assetId: string; path: string; uploadResourceId: string };
@Injectable()
export class PhotoSourceRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}
  private async owner(tx: Transaction<DB>, auth: SourceAuthority) {
    const session = await tx
      .selectFrom('session')
      .innerJoin('user', 'user.id', 'session.userId')
      .select(['session.id', 'session.pinExpiresAt', 'session.expiresAt'])
      .where('session.id', '=', auth.sessionId)
      .where('session.userId', '=', auth.ownerId)
      .where('user.deletedAt', 'is', null)
      .where((eb) =>
        eb.or([eb('session.expiresAt', 'is', null), eb('session.expiresAt', '>', sql<Date>`clock_timestamp()`)]),
      )
      .forShare('session')
      .forShare('user')
      .executeTakeFirst();
    if (!session || (session.expiresAt && new Date(session.expiresAt).getTime() <= Date.now()))
      throw new NotFoundException('Photo source unavailable');
    return session;
  }
  private async source(tx: Transaction<DB>, auth: SourceAuthority, id: string) {
    const photo = await this.owner(tx, auth);
    const source = await tx
      .selectFrom('photo_source')
      .selectAll()
      .where('id', '=', id)
      .where('ownerId', '=', auth.ownerId)
      .where('revokedAt', 'is', null)
      .forShare()
      .executeTakeFirst();
    if (!source) throw new NotFoundException('Photo source unavailable');
    const device = await tx
      .selectFrom('desktop_device')
      .select(['state', 'authorizationEpoch'])
      .where('id', '=', source.deviceId)
      .where('userId', '=', auth.ownerId)
      .where('revokedAt', 'is', null)
      .forShare()
      .executeTakeFirst();
    if (!device || device.state === 'paused' || device.state === 'revoked' || source.photoSessionId !== auth.sessionId)
      throw new ConflictException('photo_source_device_changed');
    return { source, photo, device };
  }
  private async activeRun(tx: Transaction<DB>, auth: SourceAuthority, sourceId: string, runId: string, open = true) {
    const context = await this.source(tx, auth, sourceId);
    const run = await tx
      .selectFrom('photo_source_run')
      .selectAll()
      .where('id', '=', runId)
      .where('sourceId', '=', sourceId)
      .forUpdate()
      .executeTakeFirst();
    if (!run) throw new NotFoundException('Photo source run unavailable');
    if (open && run.state !== 'open') throw new ConflictException('photo_source_run_not_open');
    return { ...context, run };
  }
  async assertUpload(
    auth: SourceAuthority,
    binding: FolderUploadSourceIdentity,
    checksum: Buffer,
    size: number | undefined,
    transaction?: Transaction<DB>,
  ): Promise<void> {
    const check = async (tx: Transaction<DB>) => {
      const { source } = await this.activeRun(tx, auth, binding.sourceId, binding.runId);
      if (source.mode !== 'copy') throw new ConflictException('photo_source_copy_required');
      const item = await tx
        .selectFrom('photo_source_resource')
        .selectAll()
        .where('id', '=', binding.itemId)
        .where('runId', '=', binding.runId)
        .forShare()
        .executeTakeFirst();
      if (!item || item.state !== 'planned' || size !== Number(item.bytes) || !item.checksum.equals(checksum))
        throw new ConflictException('photo_source_upload_changed');
      await this.owner(tx, auth);
    };
    if (transaction) await check(transaction);
    else await this.db.transaction().execute(check);
  }
  create(auth: SourceAuthority, dto: PhotoSourceCreateInput) {
    return this.db.transaction().execute(async (tx) => {
      await this.owner(tx, auth);
      const device = await tx
        .selectFrom('desktop_device')
        .select(['id', 'state'])
        .where('id', '=', dto.deviceId)
        .where('userId', '=', auth.ownerId)
        .where('revokedAt', 'is', null)
        .forShare()
        .executeTakeFirst();
      if (!device || device.state === 'paused' || device.state === 'revoked')
        throw new NotFoundException('Photo source device unavailable');
      const row = await tx
        .insertInto('photo_source')
        .values({ ...dto, ownerId: auth.ownerId, photoSessionId: auth.sessionId })
        .onConflict((oc) => oc.column('id').doNothing())
        .returningAll()
        .executeTakeFirst();
      if (row) return row;
      const existing = await tx
        .selectFrom('photo_source')
        .selectAll()
        .where('id', '=', dto.id)
        .where('ownerId', '=', auth.ownerId)
        .forUpdate()
        .executeTakeFirst();
      if (
        !existing ||
        existing.revokedAt ||
        existing.deviceId !== dto.deviceId ||
        existing.kind !== dto.kind ||
        existing.mode !== dto.mode ||
        existing.name !== dto.name ||
        existing.scopeFingerprint !== dto.scopeFingerprint
      )
        throw new ConflictException('photo_source_identity_changed');
      if (existing.photoSessionId === auth.sessionId) return existing;
      return tx
        .updateTable('photo_source')
        .set({ photoSessionId: auth.sessionId })
        .where('id', '=', existing.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }
  revoke(auth: SourceAuthority, id: string) {
    return this.db.transaction().execute(async (tx) => {
      await this.owner(tx, auth);
      const row = await tx
        .updateTable('photo_source')
        .set({ revokedAt: sql`coalesce("revokedAt", now())` })
        .where('id', '=', id)
        .where('ownerId', '=', auth.ownerId)
        .returning('id')
        .executeTakeFirst();
      if (!row) throw new NotFoundException('Photo source unavailable');
    });
  }
  run(auth: SourceAuthority, sourceId: string, dto: PhotoSourceRunDto) {
    return this.db.transaction().execute(async (tx) => {
      await this.source(tx, auth, sourceId);
      const inserted = await tx
        .insertInto('photo_source_run')
        .values({ ...dto, sourceId })
        .onConflict((oc) => oc.column('id').doNothing())
        .returningAll()
        .executeTakeFirst();
      if (inserted) return inserted;
      const row = await tx
        .selectFrom('photo_source_run')
        .selectAll()
        .where('id', '=', dto.id)
        .where('sourceId', '=', sourceId)
        .executeTakeFirst();
      if (!row || Number(row.maxBytes) !== dto.maxBytes || row.maxItems !== dto.maxItems)
        throw new ConflictException('photo_source_run_changed');
      return row;
    });
  }
  plan(auth: SourceAuthority, sourceId: string, runId: string, dto: PhotoSourceItemDto) {
    return this.db.transaction().execute(async (tx) => {
      const { run } = await this.activeRun(tx, auth, sourceId, runId);
      const matches = await tx
        .selectFrom('photo_source_resource')
        .selectAll()
        .where('runId', '=', runId)
        .where((eb) =>
          eb.or([
            eb('id', '=', dto.id),
            eb.and([eb('resourceKey', '=', dto.resourceKey), eb('version', '=', dto.version)]),
          ]),
        )
        .limit(2)
        .execute();
      if (matches.length > 1) throw new ConflictException('photo_source_item_changed');
      const [existing] = matches;
      const checksum = Buffer.from(dto.sha256, 'hex');
      if (existing) {
        if (
          existing.resourceKey !== dto.resourceKey ||
          existing.version !== dto.version ||
          !existing.checksum.equals(checksum) ||
          Number(existing.bytes) !== dto.bytes
        )
          throw new ConflictException('photo_source_item_changed');
        return existing;
      }
      const usage = await tx
        .selectFrom('photo_source_resource')
        .select((eb) => [eb.fn.countAll<number>().as('items'), eb.fn.sum<string>('bytes').as('bytes')])
        .where('runId', '=', runId)
        .executeTakeFirstOrThrow();
      if (Number(usage.items) >= run.maxItems || BigInt(usage.bytes ?? 0) + BigInt(dto.bytes) > BigInt(run.maxBytes))
        throw new ConflictException('photo_source_run_budget_exceeded');
      const inserted = await tx
        .insertInto('photo_source_resource')
        .values({ id: dto.id, resourceKey: dto.resourceKey, version: dto.version, bytes: dto.bytes, runId, checksum })
        .onConflict((oc) => oc.column('id').doNothing())
        .returningAll()
        .executeTakeFirst();
      if (!inserted) throw new ConflictException('photo_source_item_changed');
      return inserted;
    });
  }
  snapshot(auth: SourceAuthority, sourceId: string, runId: string, after?: string) {
    return this.db.transaction().execute(async (tx) => {
      const { run } = await this.activeRun(tx, auth, sourceId, runId, false);
      const rows = await tx
        .selectFrom('photo_source_resource')
        .select(['id', 'resourceKey', 'version', 'bytes', 'state', 'verifiedAt'])
        .where('runId', '=', runId)
        .$if(!!after, (qb) => qb.where('id', '>', after!))
        .orderBy('id')
        .limit(101)
        .execute();
      return { run, items: rows.slice(0, 100), nextCursor: rows.length > 100 ? rows[99].id : null };
    });
  }
  setState(auth: SourceAuthority, sourceId: string, runId: string, dto: PhotoSourceRunStateDto) {
    return this.db.transaction().execute(async (tx) => {
      const { run } = await this.activeRun(tx, auth, sourceId, runId, false);
      if (['cancelled', 'complete'].includes(run.state) && run.state !== dto.state)
        throw new ConflictException('photo_source_run_terminal');
      if (dto.state === 'complete') {
        const pending = await tx
          .selectFrom('photo_source_resource')
          .select('id')
          .where('runId', '=', runId)
          .where('state', '!=', 'verified')
          .limit(1)
          .executeTakeFirst();
        if (pending) throw new ConflictException('photo_source_items_pending');
      }
      return tx
        .updateTable('photo_source_run')
        .set(dto)
        .where('id', '=', runId)
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }
  referenceReceipt(auth: SourceAuthority, sourceId: string, runId: string, itemId: string) {
    return this.db.transaction().execute(async (tx) => {
      if (!(await lockSourceAuthorities(tx, [{ sourceId, ownerId: auth.ownerId }])))
        throw new NotFoundException('Photo source unavailable');
      const { source, device } = await this.activeRun(tx, auth, sourceId, runId, false);
      if (source.mode !== 'reference') throw new ConflictException('photo_source_reference_required');
      const item = await tx
        .selectFrom('photo_source_resource')
        .selectAll()
        .where('id', '=', itemId)
        .where('runId', '=', runId)
        .forShare()
        .executeTakeFirst();
      if (!item) throw new NotFoundException('Photo source item unavailable');
      const conflict = () => new ConflictException('photo_source_reference_changed');
      if (item.state !== 'verified' || !item.assetId || !item.verifiedAt) throw conflict();
      const library = await tx
        .selectFrom('library')
        .selectAll()
        .where('id', '=', sourceId)
        .forShare()
        .executeTakeFirst();
      if (
        !library ||
        library.ownerId !== auth.ownerId ||
        library.deletedAt ||
        !library.readOnly ||
        library.importPaths.length > 0 ||
        library.exclusionPatterns.length > 0
      )
        throw conflict();
      const originalPath = sourceOriginalPath({ sourceId, resourceKey: item.resourceKey });
      // A committed receipt remains recoverable when its original is offline; it grants no byte access.
      const asset = await tx
        .selectFrom('asset')
        .select('id')
        .where('id', '=', item.assetId)
        .where('ownerId', '=', auth.ownerId)
        .where('libraryId', '=', library.id)
        .where('isExternal', '=', true)
        .where('physicalOriginalFileId', 'is', null)
        .where('originalPath', '=', originalPath)
        .where('checksum', '=', createHash('sha1').update(originalPath).digest())
        .where('checksumAlgorithm', '=', ChecksumAlgorithm.sha1Path)
        .where('type', 'in', [AssetType.Image, AssetType.Video])
        .where('status', '=', AssetStatus.Active)
        .where('deletedAt', 'is', null)
        .forShare()
        .executeTakeFirst();
      const binding = await tx
        .selectFrom('source_original')
        .selectAll()
        .where('assetId', '=', item.assetId)
        .forShare()
        .executeTakeFirst();
      if (
        !asset ||
        !binding ||
        binding.resourceId !== item.id ||
        binding.scopeFingerprint !== source.scopeFingerprint ||
        binding.authorizationEpoch !== device.authorizationEpoch
      )
        throw conflict();
      // Lock writers take the asset row first; use a fresh snapshot after any wait on that row.
      const privacy = await tx
        .selectFrom('asset')
        .select('visibility')
        .select(isLocked().as('locked'))
        .where('id', '=', item.assetId)
        .executeTakeFirstOrThrow();
      const photo = await this.owner(tx, auth);
      if (
        (privacy.visibility === AssetVisibility.Hidden || privacy.locked) &&
        (!photo.pinExpiresAt || new Date(photo.pinExpiresAt).getTime() <= Date.now())
      )
        throw conflict();
      return { item, assetId: item.assetId, resourceId: item.id };
    });
  }
  publishReference(
    auth: SourceAuthority,
    sourceId: string,
    runId: string,
    itemId: string,
    dto: PhotoSourceReferenceDto,
    admit: (tx: Transaction<DB>, assetId: string, retired: { files: string[]; projections: string[] }) => Promise<void>,
  ) {
    return this.db.transaction().execute(async (tx) => {
      // Queue admission precedes source/asset locks everywhere, including first publication.
      await sql`SELECT name FROM job_queue WHERE name IN (${QueueName.MetadataExtraction}, ${QueueName.BackgroundTask}, ${QueueName.ThumbnailGeneration}) ORDER BY name FOR NO KEY UPDATE`.execute(
        tx,
      );
      if (!(await lockSourceAuthorities(tx, [{ sourceId, ownerId: auth.ownerId }])))
        throw new NotFoundException('Photo source unavailable');
      const { source, photo, device, run } = await this.activeRun(tx, auth, sourceId, runId, false);
      if (source.mode !== 'reference') throw new ConflictException('photo_source_reference_required');
      const item = await tx
        .selectFrom('photo_source_resource')
        .selectAll()
        .where('id', '=', itemId)
        .where('runId', '=', runId)
        .forUpdate()
        .executeTakeFirst();
      if (!item) throw new NotFoundException('Photo source item unavailable');
      if (run.state !== 'open' && (item.state !== 'verified' || item.assetId !== dto.assetId))
        throw new ConflictException('photo_source_run_not_open');
      const previous = await tx
        .selectFrom('photo_source_resource as resource')
        .innerJoin('photo_source_run as run', 'run.id', 'resource.runId')
        .selectAll('resource')
        .where('run.sourceId', '=', sourceId)
        .where('resource.resourceKey', '=', item.resourceKey)
        .where('resource.assetId', 'is not', null)
        .orderBy('resource.createdAt')
        .orderBy('resource.id')
        .limit(1)
        .executeTakeFirst();
      const conflict = () => new ConflictException('photo_source_reference_changed');
      if (previous && previous.assetId !== dto.assetId) throw conflict();
      if (!previous && dto.previous) throw conflict();
      const inconsistent = await tx
        .selectFrom('photo_source_resource as resource')
        .innerJoin('photo_source_run as run', 'run.id', 'resource.runId')
        .select('resource.id')
        .where('run.sourceId', '=', sourceId)
        .where('resource.resourceKey', '=', item.resourceKey)
        .where('resource.version', '=', item.version)
        .where((eb) => eb.or([eb('resource.checksum', '!=', item.checksum), eb('resource.bytes', '!=', item.bytes)]))
        .limit(1)
        .executeTakeFirst();
      if (inconsistent) throw conflict();
      const known = await tx
        .selectFrom('photo_source_resource as resource')
        .innerJoin('photo_source_run as run', 'run.id', 'resource.runId')
        .select('resource.id')
        .where('run.sourceId', '=', sourceId)
        .where('resource.assetId', 'is not', null)
        .limit(1)
        .executeTakeFirst();
      let library = await tx
        .selectFrom('library')
        .selectAll()
        .where('id', '=', source.id)
        .forUpdate()
        .executeTakeFirst();
      if (!library) {
        // Resource associations are tombstones: deleting a library never authorizes its recreation.
        if (known) throw conflict();
        library = await tx
          .insertInto('library')
          .values({
            id: source.id,
            ownerId: auth.ownerId,
            name: source.name,
            readOnly: true,
            importPaths: [],
            exclusionPatterns: [],
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      } else if (!known) throw conflict();
      if (
        library.ownerId !== auth.ownerId ||
        library.deletedAt ||
        !library.readOnly ||
        library.importPaths.length > 0 ||
        library.exclusionPatterns.length > 0
      )
        throw conflict();
      const originalPath = sourceOriginalPath({ sourceId, resourceKey: item.resourceKey });
      const checksum = createHash('sha1').update(originalPath).digest();
      let resourceId = item.id;
      let needsElevation = false;
      let changed = false;
      let retired = { files: [] as string[], projections: [] as string[] };
      if (previous) {
        const unlocked = !!photo.pinExpiresAt && new Date(photo.pinExpiresAt).getTime() > Date.now();
        const binding = await tx
          .selectFrom('source_original')
          .innerJoin('photo_source_resource as bound', 'bound.id', 'source_original.resourceId')
          .innerJoin('photo_source_run as run', 'run.id', 'bound.runId')
          .select([
            'source_original.resourceId',
            'scopeFingerprint',
            'authorizationEpoch',
            'run.sourceId',
            'bound.resourceKey',
            'bound.version',
            'bound.checksum',
            'bound.bytes',
            'bound.state',
            'bound.verifiedAt',
            'bound.assetId',
          ])
          .where('source_original.assetId', '=', dto.assetId)
          .executeTakeFirst();
        if (
          !binding ||
          binding.sourceId !== sourceId ||
          binding.resourceKey !== item.resourceKey ||
          binding.state !== 'verified' ||
          !binding.verifiedAt ||
          binding.assetId !== dto.assetId ||
          binding.scopeFingerprint !== source.scopeFingerprint ||
          binding.authorizationEpoch !== device.authorizationEpoch
        )
          throw conflict();
        changed =
          binding.version !== item.version ||
          !binding.checksum.equals(item.checksum) ||
          Number(binding.bytes) !== Number(item.bytes);
        if (changed) {
          const expected = dto.previous;
          if (
            binding.version === item.version ||
            item.state !== 'planned' ||
            item.assetId !== null ||
            !expected ||
            expected.resourceId !== binding.resourceId ||
            expected.version !== binding.version ||
            expected.sha256 !== binding.checksum.toString('hex')
          )
            throw conflict();
          try {
            retired = await retireReferenceVersion(tx, dto.assetId, expected);
          } catch (error) {
            if (error instanceof AssetSourceChangedError) throw conflict();
            throw error;
          }
        }
        const asset = await tx
          .selectFrom('asset')
          .select(['id', 'visibility'])
          .select(isLocked().as('locked'))
          .where('id', '=', dto.assetId)
          .where('ownerId', '=', auth.ownerId)
          .where('libraryId', '=', library.id)
          .where('isExternal', '=', true)
          .where('physicalOriginalFileId', 'is', null)
          .where('originalPath', '=', originalPath)
          .where('checksum', '=', checksum)
          .where('checksumAlgorithm', '=', ChecksumAlgorithm.sha1Path)
          .where('type', '=', dto.type)
          .where('status', '=', AssetStatus.Active)
          .where('deletedAt', 'is', null)
          .where('isOffline', '=', false)
          .$if(!unlocked, (qb) => qb.where('visibility', '!=', AssetVisibility.Hidden).where(isNotLocked()))
          .forShare()
          .executeTakeFirst();
        if (!asset) throw conflict();
        resourceId = changed ? item.id : binding.resourceId;
        if (changed) {
          const switched = await tx
            .updateTable('source_original')
            .set({ resourceId: item.id })
            .where('assetId', '=', dto.assetId)
            .where('resourceId', '=', binding.resourceId)
            .executeTakeFirstOrThrow();
          if (switched.numUpdatedRows !== 1n) throw conflict();
          await tx
            .updateTable('asset')
            .set({
              originalFileName: dto.originalFileName,
              fileModifiedAt: new Date(dto.fileModifiedAt),
              fileCreatedAt: sql<Date>`CASE WHEN EXISTS (SELECT 1 FROM asset_exif e WHERE e."assetId"=${dto.assetId}::uuid AND 'dateTimeOriginal'=ANY(coalesce(e."lockedProperties",'{}'::varchar[]))) THEN "fileCreatedAt" ELSE ${new Date(dto.fileCreatedAt)} END`,
              localDateTime: sql<Date>`CASE WHEN EXISTS (SELECT 1 FROM asset_exif e WHERE e."assetId"=${dto.assetId}::uuid AND 'dateTimeOriginal'=ANY(coalesce(e."lockedProperties",'{}'::varchar[]))) THEN "localDateTime" ELSE ${new Date(dto.fileCreatedAt)} END`,
            })
            .where('id', '=', dto.assetId)
            .execute();
        }
        needsElevation = asset.visibility === AssetVisibility.Hidden || asset.locked;
      } else {
        const asset = await tx
          .insertInto('asset')
          .values({
            id: dto.assetId,
            ownerId: auth.ownerId,
            libraryId: library.id,
            type: dto.type,
            originalPath,
            checksum,
            checksumAlgorithm: ChecksumAlgorithm.sha1Path,
            isExternal: true,
            originalFileName: dto.originalFileName,
            fileCreatedAt: new Date(dto.fileCreatedAt),
            fileModifiedAt: new Date(dto.fileModifiedAt),
            localDateTime: new Date(dto.fileCreatedAt),
          })
          .onConflict((oc) => oc.doNothing())
          .returning('id')
          .executeTakeFirst();
        if (!asset) throw conflict();
        await tx
          .insertInto('source_original')
          .values({
            assetId: asset.id,
            resourceId: item.id,
            scopeFingerprint: source.scopeFingerprint,
            authorizationEpoch: device.authorizationEpoch,
          })
          .execute();
      }
      const published = await tx
        .updateTable('photo_source_resource')
        .set({
          assetId: dto.assetId,
          state: 'verified',
          verifiedAt: item.verifiedAt ?? new Date(),
        })
        .where('id', '=', item.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      if (!previous || changed) await admit(tx, dto.assetId, retired);
      const finalPhoto = await this.owner(tx, auth);
      if (needsElevation && (!finalPhoto.pinExpiresAt || new Date(finalPhoto.pinExpiresAt).getTime() <= Date.now()))
        throw conflict();
      return { item: published, assetId: dto.assetId, resourceId };
    });
  }
  private async copyTarget(
    tx: Transaction<DB>,
    auth: SourceAuthority,
    runId: string,
    itemId: string,
    uploadResourceId: string,
    unlocked: boolean,
  ): Promise<SourceCopyTarget> {
    const item = await tx
      .selectFrom('photo_source_resource')
      .selectAll()
      .where('id', '=', itemId)
      .where('runId', '=', runId)
      .executeTakeFirst();
    const upload = await tx
      .selectFrom('asset_upload_resource')
      .select(['id', 'resultAssetId', 'verifiedChecksum', 'offset'])
      .where('id', '=', uploadResourceId)
      .where('ownerId', '=', auth.ownerId)
      .where('state', '=', 'published')
      .where('ingested', '=', true)
      .executeTakeFirst();
    if (
      !item ||
      !upload?.resultAssetId ||
      !upload.verifiedChecksum?.equals(item.checksum) ||
      Number(upload.offset) !== Number(item.bytes)
    )
      throw new ConflictException('photo_source_upload_not_verified');
    const asset = await tx
      .selectFrom('asset')
      .select(['id', 'originalPath', 'visibility'])
      .where('id', '=', upload.resultAssetId)
      .where('ownerId', '=', auth.ownerId)
      .where('checksum', '=', item.checksum)
      .where('libraryId', 'is', null)
      .where('isExternal', '=', false)
      .where('isOffline', '=', false)
      .where('deletedAt', 'is', null)
      .where('status', '=', AssetStatus.Active)
      .forShare()
      .executeTakeFirst();
    if (!asset || (asset.visibility === AssetVisibility.Hidden && !unlocked))
      throw new ConflictException('photo_source_managed_original_unavailable');
    if (item.assetId && item.assetId !== asset.id) throw new ConflictException('photo_source_association_changed');
    return { item, assetId: asset.id, path: asset.originalPath, uploadResourceId };
  }
  target(auth: SourceAuthority, sourceId: string, runId: string, itemId: string, uploadResourceId: string) {
    return this.db.transaction().execute(async (tx) => {
      const { photo, source } = await this.activeRun(tx, auth, sourceId, runId);
      if (source.mode !== 'copy') throw new ConflictException('photo_source_copy_required');
      return this.copyTarget(
        tx,
        auth,
        runId,
        itemId,
        uploadResourceId,
        !!photo.pinExpiresAt && new Date(photo.pinExpiresAt).getTime() > Date.now(),
      );
    });
  }
  complete(
    auth: SourceAuthority,
    sourceId: string,
    runId: string,
    target: SourceCopyTarget,
    proof: string,
    identify: (path: string) => Promise<string | null>,
  ) {
    return this.db.transaction().execute(async (tx) => {
      const { photo, source } = await this.activeRun(tx, auth, sourceId, runId);
      if (source.mode !== 'copy') throw new ConflictException('photo_source_copy_required');
      await lockChecksum(tx, target.item.checksum);
      const current = await this.copyTarget(
        tx,
        auth,
        runId,
        target.item.id,
        target.uploadResourceId,
        !!photo.pinExpiresAt && new Date(photo.pinExpiresAt).getTime() > Date.now(),
      );
      if (current.path !== target.path || current.assetId !== target.assetId)
        throw new ConflictException('photo_source_original_changed');
      await lockFilePath(tx, current.path);
      if ((await identify(current.path)) !== proof) throw new ConflictException('photo_source_original_changed');
      return tx
        .updateTable('photo_source_resource')
        .set({
          state: 'verified',
          assetId: current.assetId,
          uploadResourceId: current.uploadResourceId,
          verifiedAt: new Date(),
        })
        .where('id', '=', current.item.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }
}
