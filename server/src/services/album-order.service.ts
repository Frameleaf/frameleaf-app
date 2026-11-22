import { BadRequestException, Injectable } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { AlbumPlacement, AlbumTextCardRow } from 'src/repositories/album-order.repository.js';
import {
  AlbumAssetOrderDto,
  AlbumTextCardCreateDto,
  AlbumTextCardResponseDto,
  AlbumTextCardUpdateDto,
} from 'src/dtos/album-order.dto.js';
import { asAlbumKind } from 'src/dtos/album.dto.js';
import { AlbumKind, AssetOrder, Permission } from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { asDateTimeString } from 'src/utils/date.js';

// Control characters other than tab and new line; a card is plain text and never rendered as markup.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u{0}-\u{8}\u{B}-\u{1F}\u{7F}]/gu;

/** A heading is one line of plain text. */
export const cleanHeading = (value: string) =>
  value
    .replaceAll(/[\r\n\t]+/g, ' ')
    .replaceAll(CONTROL_CHARACTERS, '')
    .trim();
/** A body keeps its new lines. */
export const cleanBody = (value: string) => value.replaceAll(/\r\n?/g, '\n').replaceAll(CONTROL_CHARACTERS, '').trim();

export const mapTextCard = (row: AlbumTextCardRow): AlbumTextCardResponseDto => ({
  id: row.id,
  albumId: row.albumId,
  heading: row.heading,
  body: row.body,
  position: row.position,
  afterAssetId: row.afterAssetId,
  createdById: row.createdById,
  createdAt: asDateTimeString(row.createdAt)!,
  updatedAt: asDateTimeString(row.updatedAt)!,
});

const placementOf = (dto: { afterAssetId?: string | null; afterTextCardId?: string }): AlbumPlacement | undefined =>
  dto.afterTextCardId !== undefined || dto.afterAssetId !== undefined
    ? { afterAssetId: dto.afterAssetId, afterTextCardId: dto.afterTextCardId }
    : undefined;

/**
 * FL-869: an album's custom order, and FL-881: text cards between its photos. Owners and editors write
 * (AlbumUpdate, which a shared link never has); anyone who can read the album reads.
 */
@Injectable()
export class AlbumOrderService extends BaseService {
  private get order() {
    return this.albumRepository.order;
  }

  private async getEditableAlbum(auth: AuthDto, albumId: string) {
    await this.requireAccess({ auth, permission: Permission.AlbumUpdate, ids: [albumId] });
    const album = await this.albumRepository.getById(albumId, { withAssets: false });
    if (!album) {
      throw new BadRequestException('Album not found');
    }
    if (asAlbumKind(album.kind) !== AlbumKind.Album) {
      throw new BadRequestException('Only an album holding photos has a custom order');
    }
    return album;
  }

  /** Placing anything turns custom order on, so the album shows what the editor just arranged. */
  private async useCustomOrder(
    auth: AuthDto,
    album: { id: string; isCustomOrder: boolean; albumUsers: { user: { id: string } }[] },
  ) {
    if (!album.isCustomOrder) {
      await this.albumRepository.update(album.id, { id: album.id, isCustomOrder: true }, auth.user.id);
    }
    await this.eventRepository.emit('AlbumUpdate', {
      id: album.id,
      userIds: album.albumUsers.map(({ user }) => user.id),
      recipientIds: [],
    });
  }

  private async place(
    album: { id: string; order: AssetOrder },
    placement: AlbumPlacement,
    moving: { assetIds: string[]; cardIds: string[] },
  ) {
    const placed = await this.order.place(album.id, album.order, placement, moving);
    if (!placed) {
      throw new BadRequestException('The photo or card to place after is not in this album');
    }
  }

  async setAssetOrder(auth: AuthDto, albumId: string, dto: AlbumAssetOrderDto): Promise<void> {
    const album = await this.getEditableAlbum(auth, albumId);
    const requested = [...new Set(dto.assetIds)];
    const members = await this.order.getMembers(albumId, requested);
    const assetIds = requested.filter((id) => members.has(id));
    if (assetIds.length === 0) {
      return;
    }
    await this.place(album, placementOf(dto)!, { assetIds, cardIds: [] });
    await this.useCustomOrder(auth, album);
  }

  async getTextCards(auth: AuthDto, albumId: string): Promise<AlbumTextCardResponseDto[]> {
    await this.requireAccess({ auth, permission: Permission.AlbumRead, ids: [albumId] });
    const rows = await this.order.getTextCards(albumId);
    return rows.map((row) => mapTextCard(row));
  }

  private async getTextCard(albumId: string, cardId: string): Promise<AlbumTextCardResponseDto> {
    const [row] = await this.order.getTextCards(albumId, [cardId]);
    if (!row) {
      throw new BadRequestException('Text card not found');
    }
    return mapTextCard(row);
  }

  async createTextCard(auth: AuthDto, albumId: string, dto: AlbumTextCardCreateDto): Promise<AlbumTextCardResponseDto> {
    const album = await this.getEditableAlbum(auth, albumId);
    const heading = cleanHeading(dto.heading);
    const body = cleanBody(dto.body);
    if (!heading && !body) {
      throw new BadRequestException('A text card needs a heading or some text');
    }
    // Cards only make sense in the album's own order: seed it from the date order before the card goes in.
    await this.order.placeUnplaced(albumId, album.order);
    const id = await this.order.createTextCard({ albumId, heading, body, createdById: auth.user.id });
    const placement = placementOf(dto);
    if (placement) {
      await this.place(album, placement, { assetIds: [], cardIds: [id] });
    }
    await this.useCustomOrder(auth, album);
    return this.getTextCard(albumId, id);
  }

  async updateTextCard(
    auth: AuthDto,
    albumId: string,
    cardId: string,
    dto: AlbumTextCardUpdateDto,
  ): Promise<AlbumTextCardResponseDto> {
    const album = await this.getEditableAlbum(auth, albumId);
    if (dto.afterTextCardId === cardId) {
      throw new BadRequestException('A card cannot be placed after itself');
    }
    const current = await this.getTextCard(albumId, cardId);
    const heading = dto.heading === undefined ? current.heading : cleanHeading(dto.heading);
    const body = dto.body === undefined ? current.body : cleanBody(dto.body);
    if (!heading && !body) {
      throw new BadRequestException('A text card needs a heading or some text');
    }
    if (heading !== current.heading || body !== current.body) {
      await this.order.updateTextCard(albumId, cardId, { heading, body });
    }
    const placement = placementOf(dto);
    if (placement) {
      await this.place(album, placement, { assetIds: [], cardIds: [cardId] });
    }
    await this.useCustomOrder(auth, album);
    return this.getTextCard(albumId, cardId);
  }

  /** Removes the card only; the album's photos are never touched. */
  async deleteTextCard(auth: AuthDto, albumId: string, cardId: string): Promise<void> {
    const album = await this.getEditableAlbum(auth, albumId);
    const deleted = await this.order.deleteTextCard(albumId, cardId);
    if (!deleted) {
      throw new BadRequestException('Text card not found');
    }
    await this.eventRepository.emit('AlbumUpdate', {
      id: album.id,
      userIds: album.albumUsers.map(({ user }) => user.id),
      recipientIds: [],
    });
  }
}
