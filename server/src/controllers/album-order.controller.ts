import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  AlbumAssetOrderDto,
  AlbumTextCardCreateDto,
  AlbumTextCardParamDto,
  AlbumTextCardResponseDto,
  AlbumTextCardUpdateDto,
} from 'src/dtos/album-order.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { AlbumOrderService } from 'src/services/album-order.service.js';
import { UUIDParamDto } from 'src/validation.js';

/** FL-869 custom photo order and FL-881 text cards between an album's photos. */
@ApiTags(ApiTag.Albums)
@Controller('albums')
export class AlbumOrderController {
  constructor(private service: AlbumOrderService) {}

  @Put(':id/assets/order')
  @Authenticated({ permission: Permission.AlbumUpdate })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: "Move photos in an album's custom order",
    description:
      'Places the photos, in the order given, after a photo (afterAssetId), after a text card (afterTextCardId) or at the start (afterAssetId null), and turns on custom order for the album. Owners and editors only; one request moves up to 10,000 photos.',
    history: new HistoryBuilder().added('v3'),
  })
  setAlbumAssetOrder(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: AlbumAssetOrderDto,
  ): Promise<void> {
    return this.service.setAssetOrder(auth, id, dto);
  }

  @Get(':id/text-cards')
  @Authenticated({ permission: Permission.AlbumRead, sharedLink: true })
  @Endpoint({
    summary: 'List the text cards in an album',
    description: 'Cards in album order. Plain text: show heading and body as text, never as HTML.',
    history: new HistoryBuilder().added('v3'),
  })
  getAlbumTextCards(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<AlbumTextCardResponseDto[]> {
    return this.service.getTextCards(auth, id);
  }

  @Post(':id/text-cards')
  @Authenticated({ permission: Permission.AlbumUpdate })
  @Endpoint({
    summary: 'Add a text card to an album',
    description:
      'A heading and a short paragraph between photos. Adding a card turns on custom order for the album. Owners and editors only.',
    history: new HistoryBuilder().added('v3'),
  })
  createAlbumTextCard(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: AlbumTextCardCreateDto,
  ): Promise<AlbumTextCardResponseDto> {
    return this.service.createTextCard(auth, id, dto);
  }

  @Put(':id/text-cards/:cardId')
  @Authenticated({ permission: Permission.AlbumUpdate })
  @Endpoint({
    summary: 'Edit or move a text card',
    description: 'Change the heading or text, or move the card. Owners and editors only.',
    history: new HistoryBuilder().added('v3'),
  })
  updateAlbumTextCard(
    @Auth() auth: AuthDto,
    @Param() { id, cardId }: AlbumTextCardParamDto,
    @Body() dto: AlbumTextCardUpdateDto,
  ): Promise<AlbumTextCardResponseDto> {
    return this.service.updateTextCard(auth, id, cardId, dto);
  }

  @Delete(':id/text-cards/:cardId')
  @Authenticated({ permission: Permission.AlbumUpdate })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Delete a text card',
    description: "Removes the card only; the album's photos are never touched. Owners and editors only.",
    history: new HistoryBuilder().added('v3'),
  })
  deleteAlbumTextCard(@Auth() auth: AuthDto, @Param() { id, cardId }: AlbumTextCardParamDto): Promise<void> {
    return this.service.deleteTextCard(auth, id, cardId);
  }
}
