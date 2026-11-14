import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Kysely, Selectable, Transaction, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AuthDto } from 'src/dtos/auth.dto.js';
import {
  CONNECT_RECEIPT_SECONDS,
  CONNECT_TICKET_SECONDS,
  ConnectAlbumCreateDto,
  ConnectMediaReceiptDto,
  ConnectRenditionDto,
  ConnectUploadCommitDto,
  ConnectUploadStartDto,
} from 'src/dtos/connect-media.dto.js';
import { AlbumUserRole, LibraryScope } from 'src/enum.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import {
  AssetUploadResource,
  AssetUploadResourceRepository,
} from 'src/repositories/asset-upload-resource.repository.js';
import { DB } from 'src/schema/index.js';
import { ConnectReceiptTable } from 'src/schema/tables/connect-media.table.js';
import {
  connectAssetPredicate,
  connectOwnedAlbumPredicate,
  lockConnectAssets,
  lockConnectPolicyAlbums,
  refreshConnectAuth,
  requireConnectPolicy,
  requireConnectScope,
} from 'src/utils/connect-policy.js';
import { canonicalJson } from 'src/utils/object.js';

export const connectRequestHash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest();
const unavailable = () => new ConflictException('Connect operation unavailable');
const scope = (workspace: 'photo' | 'design') => (workspace === 'photo' ? LibraryScope.Personal : LibraryScope.Design);
type Receipt = Selectable<ConnectReceiptTable>;

@Injectable()
export class ConnectMediaRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  private async current(tx: Kysely<DB>, auth: AuthDto, lock = false, uploading = false) {
    const user = await tx
      .selectFrom('user')
      .selectAll()
      .where('id', '=', auth.user.id)
      .where('deletedAt', 'is', null)
      .$if(lock, (qb) => qb.forUpdate())
      .executeTakeFirst();
    if (!user) throw new NotFoundException('Connect operation unavailable');
    if (uploading && user.uploadsPaused) throw new ForbiddenException('New uploads are paused for this account');
    return refreshConnectAuth(tx, { ...auth, user: { ...auth.user, ...user } }, lock);
  }

  private async destination(
    tx: Kysely<DB>,
    auth: AuthDto,
    albumId: string,
    workspace: 'photo' | 'design',
    lock = false,
  ) {
    const policy = requireConnectPolicy(auth);
    requireConnectScope(auth, workspace === 'photo' ? 'photos:upload' : 'boards:upload');
    if (!policy.writableAlbumIds.includes(albumId)) throw unavailable();
    const album = await tx
      .selectFrom('album')
      .select('id')
      .where('id', '=', albumId)
      .where('libraryScope', '=', scope(workspace))
      .where(connectOwnedAlbumPredicate(auth.user.id))
      .$if(lock, (qb) => qb.forShare())
      .executeTakeFirst();
    if (!album) throw unavailable();
    if (lock) {
      const owner = await tx
        .selectFrom('album_user')
        .select('albumId')
        .where('albumId', '=', albumId)
        .where('userId', '=', auth.user.id)
        .where('role', '=', AlbumUserRole.Owner)
        .forShare()
        .executeTakeFirst();
      if (!owner) throw unavailable();
    }
  }

  async assertUpload(
    auth: AuthDto,
    resource: Pick<AssetUploadResource, 'metadata' | 'expectedSize'>,
    tx?: Transaction<DB>,
  ) {
    const binding = resource.metadata.connect;
    if (
      resource.metadata.publication !== 'connect' ||
      !binding ||
      binding.grantId !== auth.oauthApp?.grantId ||
      binding.actor !== `oauth:${auth.oauthApp?.grantId}`
    )
      throw new NotFoundException('Upload unavailable');
    const current = await this.current(tx ?? this.db, auth, !!tx, true);
    if (tx) await lockConnectPolicyAlbums(tx, current);
    await this.destination(tx ?? this.db, current, binding.albumId, binding.workspace, !!tx);
    return current;
  }

  private async findReceipt(
    tx: Kysely<DB>,
    auth: AuthDto,
    operation: Receipt['operation'],
    requestId: string,
    payload: unknown,
  ) {
    const row = await tx
      .selectFrom('connect_receipt')
      .selectAll()
      .where('grantId', '=', auth.oauthApp!.grantId)
      .where('operation', '=', operation)
      .where('requestId', '=', requestId)
      .executeTakeFirst();
    if (row && !row.requestHash.equals(connectRequestHash(payload)))
      throw new ConflictException('Request ID payload changed');
    return row;
  }

  private saveReceipt(
    tx: Kysely<DB>,
    auth: AuthDto,
    operation: Receipt['operation'],
    requestId: string,
    payload: unknown,
    resultId: string,
    result: Record<string, unknown>,
    status: Receipt['status'] = 'committed',
  ) {
    return tx
      .insertInto('connect_receipt')
      .values({
        grantId: auth.oauthApp!.grantId,
        operation,
        requestId,
        requestHash: connectRequestHash(payload),
        status,
        resultId,
        result,
        expiresAt: new Date(Date.now() + CONNECT_RECEIPT_SECONDS * 1000),
      })
      .execute();
  }

  async createAlbum(auth: AuthDto, dto: ConnectAlbumCreateDto) {
    return this.db.transaction().execute(async (tx) => {
      const current = await this.current(tx, auth, true);
      await lockConnectPolicyAlbums(tx, current, true);
      requireConnectScope(current, 'albums:write');
      const policy = requireConnectPolicy(current);
      if (!policy.writeWorkspaces.includes(dto.workspace)) throw unavailable();
      const existing = await this.findReceipt(tx, current, 'album-create', dto.requestId, dto);
      if (existing) {
        if (!policy.writableAlbumIds.includes(existing.resultId) || !policy.readAlbumIds.includes(existing.resultId))
          throw unavailable();
        const album = await tx
          .selectFrom('album')
          .select('id')
          .where('id', '=', existing.resultId)
          .where('libraryScope', '=', scope(dto.workspace))
          .where(connectOwnedAlbumPredicate(current.user.id))
          .forShare()
          .executeTakeFirst();
        if (!album) throw unavailable();
        return existing.result as {
          id: string;
          name: string;
          workspace: 'photo' | 'design';
          canRead: true;
          canWrite: true;
        };
      }
      if (policy.readAlbumIds.length >= 100 || policy.writableAlbumIds.length >= 100)
        throw new BadRequestException('Connect album limit reached');
      const id = randomUUID();
      await new AlbumRepository(tx).create(
        { id, albumName: dto.name, libraryScope: scope(dto.workspace) },
        [],
        [{ userId: current.user.id, role: AlbumUserRole.Owner }],
        current.user.id,
      );
      await tx
        .updateTable('oauth_grant')
        .set({
          accessPolicy: {
            ...policy,
            readAlbumIds: [...policy.readAlbumIds, id],
            writableAlbumIds: [...policy.writableAlbumIds, id],
          },
          policyRevision: sql`"policyRevision" + 1`,
        })
        .where('id', '=', current.oauthApp!.grantId)
        .execute();
      const result = { id, name: dto.name, workspace: dto.workspace, canRead: true as const, canWrite: true as const };
      await this.saveReceipt(tx, current, 'album-create', dto.requestId, dto, id, result);
      return result;
    });
  }

  async start(auth: AuthDto, dto: ConnectUploadStartDto, maxSize: number) {
    return this.db.transaction().execute(async (tx) => {
      const current = await this.current(tx, auth, true, true);
      await lockConnectPolicyAlbums(tx, current);
      await this.destination(tx, current, dto.albumId, dto.workspace, true);
      const existing = await this.findReceipt(tx, current, 'upload-start', dto.requestId, dto);
      if (existing) {
        const row = await tx
          .selectFrom('asset_upload_resource')
          .selectAll()
          .where('id', '=', existing.resultId)
          .where('ownerId', '=', current.user.id)
          .executeTakeFirst();
        if (
          !row ||
          (row.state !== 'published' && row.expiresAt <= new Date()) ||
          ['cancelled', 'rejected'].includes(row.state)
        )
          throw unavailable();
        if (row.state === 'published') await this.requireResult(tx, current, row);
        return row;
      }
      if (dto.size > maxSize) throw new BadRequestException('Upload exceeds the effective size limit');
      if (
        current.user.quotaSizeInBytes !== null &&
        current.user.quotaUsageInBytes + dto.size > current.user.quotaSizeInBytes
      )
        throw new BadRequestException('Quota has been exceeded');
      const id = randomUUID();
      const resource = await new AssetUploadResourceRepository(tx).create(id, current.user.id, {
        metadata: {
          filename: dto.filename,
          fileCreatedAt: new Date(dto.fileCreatedAt),
          fileModifiedAt: new Date(dto.fileModifiedAt),
          libraryScope: scope(dto.workspace),
          publication: 'connect',
          connect: {
            grantId: current.oauthApp!.grantId,
            actor: `oauth:${current.oauthApp!.grantId}`,
            requestId: dto.requestId,
            albumId: dto.albumId,
            workspace: dto.workspace,
            ...(dto.provenance && { provenance: dto.provenance }),
          },
        },
        checksum: Buffer.from(dto.sha256, 'hex'),
        contentType: dto.contentType,
        size: dto.size,
        maxSize,
      });
      await this.saveReceipt(tx, current, 'upload-start', dto.requestId, dto, id, { uploadId: id }, 'pending');
      return resource;
    });
  }

  async requireResult(tx: Kysely<DB>, auth: AuthDto, row: AssetUploadResource) {
    if (!row.resultAssetId || !row.metadata.connect) throw unavailable();
    await lockConnectAssets(tx, auth, [row.resultAssetId]);
    const asset = await tx
      .selectFrom('asset')
      .select('id')
      .where('id', '=', row.resultAssetId)
      .where('libraryScope', 'in', [scope(row.metadata.connect.workspace), LibraryScope.Both])
      .where(connectAssetPredicate(auth, 'asset', true))
      .forUpdate()
      .executeTakeFirst();
    if (!asset) throw unavailable();
    const membership = await tx
      .selectFrom('album_asset')
      .select('assetId')
      .where('assetId', '=', asset.id)
      .where('albumId', '=', row.metadata.connect.albumId)
      .forShare()
      .executeTakeFirst();
    if (!membership) throw unavailable();
    return { assetId: asset.id, status: row.resultStatus!, sha256: row.expectedChecksum.toString('hex') };
  }

  async state(auth: AuthDto, id: string) {
    return this.db.transaction().execute(async (tx) => {
      const row = await tx
        .selectFrom('asset_upload_resource')
        .selectAll()
        .where('id', '=', id)
        .where('ownerId', '=', auth.user.id)
        .executeTakeFirst();
      if (!row || (row.state !== 'published' && row.expiresAt <= new Date() && row.state !== 'cancelled'))
        throw new NotFoundException('Upload unavailable');
      const current = await this.assertUpload(auth, row, tx);
      const receipt = row.state === 'published' ? await this.requireResult(tx, current, row) : undefined;
      return { resource: row, receipt };
    });
  }

  async commit(
    tx: Transaction<DB>,
    auth: AuthDto,
    row: AssetUploadResource,
    dto: ConnectUploadCommitDto,
    publish: () => Promise<AssetUploadResource>,
  ): Promise<ConnectMediaReceiptDto> {
    const current = await this.assertUpload(auth, row, tx);
    const binding = row.metadata.connect!;
    if (binding.requestId !== dto.requestId || row.expectedChecksum.toString('hex') !== dto.sha256) throw unavailable();
    const payload = { uploadId: row.id, sha256: dto.sha256 };
    const existing = await this.findReceipt(tx, current, 'upload-commit', dto.requestId, payload);
    if (existing) return this.requireResult(tx, current, row);
    if (
      row.state !== 'verified' ||
      !row.verifiedChecksum?.equals(row.expectedChecksum) ||
      Number(row.expectedSize) !== Number(row.offset)
    )
      throw unavailable();
    // The owner lock serializes checksum publication; private and cross-workspace matches never leak an ID.
    const duplicate = await tx
      .selectFrom('asset')
      .select(['id', 'libraryScope'])
      .where('ownerId', '=', current.user.id)
      .where('checksum', '=', row.expectedChecksum)
      .where('libraryId', 'is', null)
      .executeTakeFirst();
    if (duplicate) {
      await lockConnectAssets(tx, current, [duplicate.id]);
      const visible = await tx
        .selectFrom('asset')
        .select('id')
        .where('id', '=', duplicate.id)
        .where(connectAssetPredicate(current))
        .where('libraryScope', 'in', [scope(binding.workspace), LibraryScope.Both])
        .executeTakeFirst();
      if (!visible || !current.oauthApp!.scopes.includes('library:read')) throw unavailable();
    }
    const published = await publish();
    if (!published.resultAssetId || !published.resultStatus) throw unavailable();
    await tx
      .insertInto('album_asset')
      .values({ albumId: binding.albumId, assetId: published.resultAssetId })
      .onConflict((oc) => oc.doNothing())
      .execute();
    if (binding.provenance)
      await tx
        .insertInto('connect_provenance')
        .values({ uploadId: row.id, assetId: published.resultAssetId, source: binding.provenance })
        .onConflict((oc) => oc.doNothing())
        .execute();
    const result = await this.requireResult(tx, current, published);
    await this.saveReceipt(tx, current, 'upload-commit', dto.requestId, payload, published.resultAssetId, result);
    await tx
      .updateTable('asset_upload_resource')
      .set({ expiresAt: new Date(Date.now() + CONNECT_RECEIPT_SECONDS * 1000) })
      .where('id', '=', row.id)
      .execute();
    await tx
      .updateTable('connect_receipt')
      .set({ status: 'committed', expiresAt: new Date(Date.now() + CONNECT_RECEIPT_SECONDS * 1000) })
      .where('grantId', '=', current.oauthApp!.grantId)
      .where('operation', '=', 'upload-start')
      .where('requestId', '=', dto.requestId)
      .execute();
    return result;
  }

  /** Receipt tombstones are intentionally retained: expiry must never recreate a previous request. */
  async deleteExpiredTickets(before: Date, limit = 1000): Promise<number> {
    const result = await this.db
      .with('expired', (db) =>
        db
          .selectFrom('connect_rendition_ticket')
          .select('tokenHash')
          .where('expiresAt', '<=', before)
          .orderBy('expiresAt')
          .orderBy('tokenHash')
          .limit(Math.max(1, Math.min(limit, 1000)))
          .forUpdate()
          .skipLocked(),
      )
      .deleteFrom('connect_rendition_ticket')
      .where('tokenHash', 'in', (db) => db.selectFrom('expired').select('tokenHash'))
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  async createTicket(auth: AuthDto, assetId: string, variant: ConnectRenditionDto['variant']) {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + CONNECT_TICKET_SECONDS * 1000);
    await this.db
      .insertInto('connect_rendition_ticket')
      .values({
        tokenHash: createHash('sha256').update(token).digest(),
        grantId: auth.oauthApp!.grantId,
        assetId,
        variant,
        expiresAt,
      })
      .execute();
    return { url: `/api/connect/renditions/${token}`, expiresAt: expiresAt.toISOString() };
  }

  async ticket(token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new NotFoundException('Rendition unavailable');
    const row = await this.db
      .selectFrom('connect_rendition_ticket')
      .selectAll()
      .where('tokenHash', '=', createHash('sha256').update(token).digest())
      .where('expiresAt', '>', new Date())
      .executeTakeFirst();
    if (!row) throw new NotFoundException('Rendition unavailable');
    return row;
  }
}
