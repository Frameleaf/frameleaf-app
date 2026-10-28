import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Kysely, Selectable, Transaction, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { CaptureCommitDto } from 'src/dtos/capture.dto.js';
import { AlbumUserRole, LibraryScope, Permission, UserMetadataKey } from 'src/enum.js';
import { AssetSourceRepository } from 'src/repositories/asset-source.repository.js';
import { DB } from 'src/schema/index.js';
import { CaptureReceiptTable } from 'src/schema/tables/capture-receipt.table.js';
import { captureActor, captureRequestHash } from 'src/utils/capture.js';
import { hiddenFromOthers, tagIsSuppressed } from 'src/utils/database.js';
import { isLocked, isNotLocked } from 'src/utils/locked.js';
import { getPreferences } from 'src/utils/preferences.js';

export type CaptureReceipt = Selectable<CaptureReceiptTable>;
type PublishedCapture = Pick<CaptureReceipt, 'kind' | 'itemId' | 'status'>;

@Injectable()
export class CaptureRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  async assertActor(auth: AuthDto, tx: Kysely<DB> = this.db, permission = Permission.CaptureCreate, file = false) {
    const actor = captureActor(auth);
    // Publication also debits quota: serialize before taking key/album/tag locks, avoiding a shared-lock upgrade deadlock.
    const user = await tx
      .selectFrom('user')
      .select(['id', 'uploadsPaused'])
      .where('id', '=', auth.user.id)
      .where('deletedAt', 'is', null)
      .forUpdate()
      .executeTakeFirst();
    if (!user) throw new NotFoundException('Capture unavailable');
    if (file && user.uploadsPaused) throw new ForbiddenException('New uploads are paused for this account');
    const current = auth.apiKey
      ? await tx
          .selectFrom('api_key')
          .select('id')
          .where('id', '=', auth.apiKey.id)
          .where('userId', '=', auth.user.id)
          .where(sql<boolean>`${permission} = any(permissions) or ${Permission.All} = any(permissions)`)
          .forShare()
          .executeTakeFirst()
      : await tx
          .selectFrom('session')
          .select('id')
          .where('id', '=', auth.session!.id)
          .where('userId', '=', auth.user.id)
          .where((eb) => eb.or([eb('expiresAt', 'is', null), eb('expiresAt', '>', new Date())]))
          .forShare()
          .executeTakeFirst();
    if (!current) throw new NotFoundException('Capture unavailable');
    return actor;
  }

  async getCompleted(auth: AuthDto, dto: CaptureCommitDto) {
    return this.db.transaction().execute(async (tx) => {
      await this.assertActor(auth, tx, Permission.CaptureCreate, !!dto.uploadResourceId);
      await this.targets(tx, auth, dto);
      return this.receipt(tx, auth, dto);
    });
  }

  catalog(auth: AuthDto) {
    return this.db.transaction().execute(async (tx) => {
      await this.assertActor(auth, tx, Permission.CaptureCatalogRead);
      const albums = await this.writableAlbums(tx, auth)
        .select(['album.id', 'album.albumName', 'album.parentId'])
        .orderBy('album.albumName')
        .orderBy('album.id')
        .execute();
      const ids = new Set(albums.map(({ id }) => id));
      const metadata = await tx
        .selectFrom('user_metadata')
        .selectAll()
        .where('userId', '=', auth.user.id)
        .where('key', '=', UserMetadataKey.Preferences)
        .forShare()
        .execute();
      return {
        albums: albums.map((album) => ({
          ...album,
          parentId: album.parentId && ids.has(album.parentId) ? album.parentId : null,
        })),
        hiddenContent: {
          ...getPreferences(metadata).privacy.suppression,
          userId: auth.user.id,
          includeNsfw: !!auth.hideNsfwAssets,
        },
      };
    });
  }

  async assertParent(auth: AuthDto, id: string): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      await this.assertActor(auth, tx);
      if (
        !(await this.writableAlbums(tx, auth)
          .select('album.id')
          .where('album.id', '=', id)
          .forShare()
          .executeTakeFirst())
      ) {
        throw new NotFoundException('Capture destination unavailable');
      }
    });
  }

  commitBookmark(auth: AuthDto, dto: CaptureCommitDto): Promise<CaptureReceipt> {
    if (!dto.bookmark || dto.uploadResourceId) throw new NotFoundException('Capture unavailable');
    return this.db.transaction().execute((tx) =>
      this.complete(tx, auth, dto, async () => {
        const bookmark = await tx
          .insertInto('bookmark')
          .values({
            ownerId: auth.user.id,
            url: dto.bookmark!.url,
            title: dto.bookmark!.title,
            libraryScope: LibraryScope.Design,
            note: dto.note ?? null,
            source: { ...dto.source, captureId: dto.captureId, note: dto.note ?? null },
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        return { kind: 'bookmark', itemId: bookmark.id, status: 'created' };
      }),
    );
  }

  commitFile(
    tx: Transaction<DB>,
    auth: AuthDto,
    dto: CaptureCommitDto,
    publish: () => Promise<{ id: string; status: 'created' | 'duplicate' }>,
  ): Promise<CaptureReceipt> {
    if (dto.uploadResourceId !== dto.captureId || !dto.sha256 || dto.bookmark)
      throw new NotFoundException('Capture unavailable');
    return this.complete(tx, auth, dto, async () => {
      const published = await publish();
      const asset = await this.getCapturedAsset(auth, published.id, tx);
      if (!asset) throw new NotFoundException('Capture unavailable');
      await new AssetSourceRepository(tx).upsertCapture(tx, {
        ...dto.source,
        captureId: dto.captureId,
        assetId: asset.id,
        note: dto.note ?? null,
      });
      return { kind: 'asset', itemId: asset.id, status: published.status };
    });
  }

  getCapturedAsset(auth: AuthDto, id: string, tx: Kysely<DB> = this.db) {
    return tx
      .selectFrom('asset')
      .selectAll('asset')
      .select(isLocked().as('isLocked'))
      .where('id', '=', id)
      .where('ownerId', '=', auth.user.id)
      .where('libraryScope', 'in', [LibraryScope.Design, LibraryScope.Both])
      .where('deletedAt', 'is', null)
      .where(isNotLocked())
      .where(sql<boolean>`not ${hiddenFromOthers(undefined)}`)
      .forShare()
      .executeTakeFirst();
  }

  private async complete(
    tx: Transaction<DB>,
    auth: AuthDto,
    dto: CaptureCommitDto,
    publish: () => Promise<PublishedCapture>,
  ): Promise<CaptureReceipt> {
    const actorId = await this.assertActor(auth, tx, Permission.CaptureCreate, !!dto.uploadResourceId);
    const tagIds = await this.targets(tx, auth, dto);
    const existing = await this.receipt(tx, auth, dto);
    if (existing) return existing;
    const item = await publish();
    if (item.kind === 'asset') {
      await tx
        .insertInto('album_asset')
        .values({ albumId: dto.albumId, assetId: item.itemId })
        .onConflict((oc) => oc.doNothing())
        .execute();
      if (tagIds.length > 0)
        await tx
          .insertInto('tag_asset')
          .values(tagIds.map((tagId) => ({ tagId, assetId: item.itemId })))
          .onConflict((oc) => oc.doNothing())
          .execute();
    } else {
      await tx.insertInto('album_bookmark').values({ albumId: dto.albumId, bookmarkId: item.itemId }).execute();
      if (tagIds.length > 0)
        await tx
          .insertInto('bookmark_tag')
          .values(tagIds.map((tagId) => ({ tagId, bookmarkId: item.itemId })))
          .execute();
    }
    return tx
      .insertInto('capture_receipt')
      .values({
        ownerId: auth.user.id,
        captureId: dto.captureId,
        actorId,
        requestHash: captureRequestHash(dto),
        ...item,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  private async receipt(tx: Transaction<DB>, auth: AuthDto, dto: CaptureCommitDto) {
    const receipt = await tx
      .selectFrom('capture_receipt')
      .selectAll()
      .where('ownerId', '=', auth.user.id)
      .where('captureId', '=', dto.captureId)
      .executeTakeFirst();
    if (!receipt) return;
    if (receipt.actorId !== captureActor(auth)) throw new NotFoundException('Capture unavailable');
    if (!receipt.requestHash.equals(captureRequestHash(dto))) throw new ConflictException('Capture payload changed');
    return receipt;
  }

  private async targets(tx: Transaction<DB>, auth: AuthDto, dto: CaptureCommitDto) {
    const album = await this.writableAlbums(tx, auth)
      .select('album.id')
      .where('album.id', '=', dto.albumId)
      .forShare()
      .executeTakeFirst();
    if (!album) throw new NotFoundException('Capture destination unavailable');
    const ids = [...new Set(dto.tagIds)].toSorted();
    if (ids.length > 0) {
      const metadata = await tx
        .selectFrom('user_metadata')
        .selectAll()
        .where('userId', '=', auth.user.id)
        .where('key', '=', UserMetadataKey.Preferences)
        .forShare()
        .execute();
      const hiddenTags = getPreferences(metadata).privacy.suppression.tagIds;
      const tags = await tx
        .selectFrom('tag')
        .select('id')
        .where('id', 'in', ids)
        .where('userId', '=', auth.user.id)
        .where(sql<boolean>`not ${tagIsSuppressed(sql.ref('tag.id'), hiddenTags)}`)
        .orderBy('id')
        .forShare()
        .execute();
      if (tags.length !== ids.length) throw new NotFoundException('Capture tag unavailable');
    }
    return ids;
  }

  private writableAlbums(tx: Kysely<DB>, auth: AuthDto) {
    return tx
      .selectFrom('album_user')
      .innerJoin('album', 'album.id', 'album_user.albumId')
      .where('userId', '=', auth.user.id)
      .where('role', 'in', [AlbumUserRole.Owner, AlbumUserRole.Editor])
      .where('album.libraryScope', 'in', [LibraryScope.Design, LibraryScope.Both])
      .where('album.deletedAt', 'is', null);
  }
}
