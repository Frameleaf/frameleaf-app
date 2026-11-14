import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { ConnectSearchDto } from 'src/dtos/connect.dto.js';
import type { DB } from 'src/schema/index.js';
import { AssetType, LibraryScope } from 'src/enum.js';
import { publicationDatabase, publicationTransaction } from 'src/queue/transaction.js';
import {
  ConnectAccessPolicy,
  connectAssetPredicate,
  connectOwnedAlbumPredicate,
  isPolicyNarrowing,
  lockConnectAssets,
  lockConnectPolicyAlbums,
  refreshConnectAuth,
  requireConnectPolicy,
} from 'src/utils/connect-policy.js';

@Injectable()
export class ConnectRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {
    this.db = publicationDatabase(db);
  }

  async availableAlbums(userId: string) {
    const rows = await this.db
      .selectFrom('album')
      .select(['album.id', 'album.albumName', 'album.libraryScope'])
      .where(connectOwnedAlbumPredicate(userId))
      .orderBy('album.albumName')
      .orderBy('album.id')
      .execute();
    return rows.map(({ id, albumName, libraryScope }) => ({
      id,
      name: albumName,
      workspace:
        libraryScope === LibraryScope.Design
          ? ('design' as const)
          : libraryScope === LibraryScope.Both
            ? ('both' as const)
            : ('photo' as const),
      canWrite: libraryScope !== LibraryScope.Both,
    }));
  }

  async validateAlbums(userId: string, policy: ConnectAccessPolicy) {
    const ids = [...new Set([...policy.readAlbumIds, ...policy.writableAlbumIds])];
    if (ids.length === 0) return;
    const rows = await this.db
      .selectFrom('album')
      .select(['album.id', 'album.libraryScope'])
      .where('album.id', 'in', ids)
      .where(connectOwnedAlbumPredicate(userId))
      .execute();
    if (
      rows.length !== ids.length ||
      rows.some((row) => row.libraryScope === LibraryScope.Both && policy.writableAlbumIds.includes(row.id))
    )
      throw new ForbiddenException('Choose owned, available albums');
  }

  async albums(auth: AuthDto) {
    const current = await refreshConnectAuth(this.db, auth);
    const policy = requireConnectPolicy(current);
    return (await this.availableAlbums(auth.user.id))
      .filter(
        ({ id }) => policy.allLibraryRead || policy.readAlbumIds.includes(id) || policy.writableAlbumIds.includes(id),
      )
      .map((album) => ({
        ...album,
        canRead: policy.allLibraryRead || policy.readAlbumIds.includes(album.id),
        canWrite: album.canWrite && policy.writableAlbumIds.includes(album.id),
      }));
  }

  private assets(auth: AuthDto) {
    return this.db
      .selectFrom('asset')
      .leftJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .where(connectAssetPredicate(auth));
  }

  async search(auth: AuthDto, dto: ConnectSearchDto) {
    let query = this.assets(auth).where('asset.type', 'in', [AssetType.Image, AssetType.Video]);
    const search = dto.q && `%${dto.q.replaceAll(/[\\%_]/g, String.raw`\$&`)}%`;
    if (search)
      query = query.where((eb) =>
        eb.or([eb('asset.originalFileName', 'ilike', search), eb('asset_exif.description', 'ilike', search)]),
      );
    if (dto.type) query = query.where('asset.type', '=', dto.type);
    if (dto.albumId)
      query = query.where((eb) =>
        eb.exists(
          eb
            .selectFrom('album_asset')
            .select('assetId')
            .whereRef('album_asset.assetId', '=', 'asset.id')
            .where('albumId', '=', dto.albumId!),
        ),
      );
    const rows = await query
      .select([
        'asset.id',
        'asset.type',
        'asset.width',
        'asset.height',
        'asset.duration',
        'asset.fileCreatedAt as createdAt',
        'asset.updatedAt',
        'asset_exif.description',
      ])
      .select(sql<number>`count(*) over ()::integer`.as('total'))
      .orderBy('asset.fileCreatedAt', 'desc')
      .orderBy('asset.id', 'desc')
      .limit(dto.size)
      .offset((dto.page - 1) * dto.size)
      .execute();
    const total =
      rows[0]?.total ??
      Number((await query.select((eb) => eb.fn.countAll<string>().as('total')).executeTakeFirstOrThrow()).total);
    return {
      items: rows.map(({ total: _total, ...row }) => this.mapAsset(row)),
      total,
      page: dto.page,
      size: dto.size,
    };
  }

  async asset(auth: AuthDto, id: string) {
    const row = await this.assets(auth)
      .select([
        'asset.id',
        'asset.type',
        'asset.width',
        'asset.height',
        'asset.duration',
        'asset.fileCreatedAt as createdAt',
        'asset.updatedAt',
        'asset_exif.description',
      ])
      .where('asset.id', '=', id)
      .where('asset.type', 'in', [AssetType.Image, AssetType.Video])
      .executeTakeFirst();
    if (!row) throw new NotFoundException('Asset not found');
    return this.mapAsset(row);
  }

  private mapAsset<T extends { createdAt: Date; updatedAt: Date; type: AssetType }>(row: T) {
    if (row.type !== AssetType.Image && row.type !== AssetType.Video) throw new NotFoundException('Asset not found');
    return {
      ...row,
      type: row.type,
      title: null,
      createdAt: new Date(row.createdAt).toISOString(),
      updatedAt: new Date(row.updatedAt).toISOString(),
    };
  }

  async requireReadableAssets(auth: AuthDto, ids: string[], writable = false) {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return;
    if (publicationTransaction.getStore()) await lockConnectAssets(this.db, auth, unique);
    const rows = await this.db
      .selectFrom('asset')
      .select('id')
      .where('id', 'in', unique)
      .where(connectAssetPredicate(auth))
      .$if(writable, (qb) => qb.where(connectAssetPredicate(auth, 'asset', true)))
      .execute();
    if (rows.length !== unique.length) throw new NotFoundException('Asset not found');
  }

  async requireWritableAlbum(auth: AuthDto, id: string) {
    const current = await refreshConnectAuth(this.db, auth);
    if (!requireConnectPolicy(current).writableAlbumIds.includes(id))
      throw new ForbiddenException('Album is not a writable destination');
    await this.validateAlbums(auth.user.id, {
      ...requireConnectPolicy(current),
      readAlbumIds: [],
      writableAlbumIds: [id],
    });
  }

  async narrowPolicy(userId: string, grantId: string, next: ConnectAccessPolicy) {
    return this.db.transaction().execute(async (tx) => {
      const grant = await tx
        .selectFrom('oauth_grant')
        .selectAll()
        .where('id', '=', grantId)
        .where('userId', '=', userId)
        .where('revokedAt', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!grant?.accessPolicy) throw new NotFoundException('Connect grant not found');
      if (!isPolicyNarrowing(grant.accessPolicy, next))
        throw new ForbiddenException('Expanded access requires new consent');
      await this.validateAlbums(userId, next);
      const updated = await tx
        .updateTable('oauth_grant')
        .set({ accessPolicy: next, policyRevision: sql`"policyRevision" + 1` })
        .where('id', '=', grantId)
        .returning(['accessPolicy', 'policyRevision'])
        .executeTakeFirstOrThrow();
      return { accessPolicy: next, policyRevision: updated.policyRevision };
    });
  }

  /** Grant lock serializes additive publication with narrowing and revocation. */
  async withGrantWrite<T>(auth: AuthDto, work: (current: AuthDto) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (tx) => {
      // Match upload publication's owner → grant → album → asset order, including tag owner FKs.
      const owner = await tx
        .selectFrom('user')
        .select('id')
        .where('id', '=', auth.user.id)
        .where('deletedAt', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!owner) throw new NotFoundException('Connect operation unavailable');
      const current = await refreshConnectAuth(tx, auth, true);
      await lockConnectPolicyAlbums(tx, current);
      return publicationTransaction.run(tx, () => work(current));
    });
  }
}
