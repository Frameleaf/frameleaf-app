import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Post, Put, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  ItemShareChangeDto,
  ItemShareChangeResponseDto,
  ItemShareQueryDto,
  ItemShareReceivedResponseDto,
  ItemShareResponseDto,
} from 'src/dtos/item-share.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { ItemShareService } from 'src/services/item-share.service.js';

/**
 * The address the request arrived on. Only a hint: `resolveShareBaseUrl` uses it only when it is one
 * of the addresses this server knows (FL-83 AL-30b).
 */
const requestOrigin = (request: Request): string | undefined => {
  const host = request.headers.host;
  return host ? `https://${host}` : undefined;
};

@ApiTags(ApiTag.ItemShares)
@Controller('item-shares')
export class ItemShareController {
  constructor(private service: ItemShareService) {}

  @Post()
  @Authenticated({ permission: Permission.AssetShare })
  @Endpoint({
    summary: 'Share items with people',
    description:
      'Share your own items with people who have an account on this server. They see the items under Sharing, in their own library, and are notified. Locked items are refused.',
    history: new HistoryBuilder().added('v3'),
  })
  shareItems(
    @Auth() auth: AuthDto,
    @Body() dto: ItemShareChangeDto,
    @Req() request: Request,
  ): Promise<ItemShareChangeResponseDto> {
    return this.service.share(auth, dto, requestOrigin(request));
  }

  @Delete()
  @Authenticated({ permission: Permission.AssetShare })
  @Endpoint({
    summary: 'Stop sharing items with people',
    description: 'Stop sharing your own items with these people. They lose access at once.',
    history: new HistoryBuilder().added('v3'),
  })
  unshareItems(
    @Auth() auth: AuthDto,
    @Body() dto: ItemShareChangeDto,
    @Req() request: Request,
  ): Promise<ItemShareChangeResponseDto> {
    return this.service.unshare(auth, dto, requestOrigin(request));
  }

  @Put('query')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.AssetShare })
  @Endpoint({
    summary: 'List who items are shared with',
    description: 'The people each of your own items is shared with.',
    history: new HistoryBuilder().added('v3'),
  })
  getItemShares(@Auth() auth: AuthDto, @Body() dto: ItemShareQueryDto): Promise<ItemShareResponseDto[]> {
    return this.service.getShares(auth, dto);
  }

  @Get('received')
  @Authenticated({ permission: Permission.AssetRead })
  @Endpoint({
    summary: 'Items shared with you',
    description:
      'Items other people shared with you one by one, newest first. Items that are locked, trashed or no longer shared are left out.',
    history: new HistoryBuilder().added('v3'),
  })
  getReceivedItemShares(@Auth() auth: AuthDto, @Req() request: Request): Promise<ItemShareReceivedResponseDto> {
    return this.service.getReceived(auth, requestOrigin(request));
  }
}
