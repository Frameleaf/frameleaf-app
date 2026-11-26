import { Controller, Delete, Get, HttpCode, HttpStatus, Next, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { NextFunction, Request, Response } from 'express';
import { Authenticated } from 'src/middleware/auth.guard.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { HouseholdPeerService } from 'src/services/household-peer.service.js';
import { HouseholdShareService } from 'src/services/household-share.service.js';
import { sendFile } from 'src/utils/file.js';

/**
 * Linked Households (FL-952, FL-979): the routes another household's server calls. They are public to the session
 * guard because the caller is a server, not a signed-in person: `HouseholdPeerService.authorize` admits it, first,
 * on every route. Only the comment routes read a body, after that. Files are refused before `sendFile`, which would
 * answer 404.
 */
@ApiExcludeController()
@Controller('household/v1/links/:linkId')
export class HouseholdPeerController {
  constructor(
    private peer: HouseholdPeerService,
    private shares: HouseholdShareService,
    private logger: LoggingRepository,
  ) {}

  /** Authorises, runs the route and signs its reply. */
  private async reply(
    linkId: string,
    request: Request,
    response: Response,
    action: (access: Awaited<ReturnType<HouseholdPeerService['authorize']>>) => unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const access = await this.peer.authorize(request, linkId);
    return this.peer.signed(access, await action(access));
  }

  @Get('handshake')
  @Authenticated({ public: true })
  handshake(@Param('linkId') linkId: string, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    return this.reply(linkId, request, response, () => this.peer.handshake());
  }

  @Get('directory')
  @Authenticated({ public: true })
  directory(@Param('linkId') linkId: string, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    return this.reply(linkId, request, response, () => this.shares.directory());
  }

  @Get('directory/:userId/avatar')
  @Authenticated({ public: true })
  async avatar(
    @Param('linkId') linkId: string,
    @Param('userId') userId: string,
    @Req() request: Request,
    @Res() response: Response,
    @Next() next: NextFunction,
  ) {
    await this.peer.authorize(request, linkId);
    const file = await this.shares.avatar(userId);
    response.setHeader('Cache-Control', 'no-store');
    await sendFile(response, next, () => file, this.logger);
  }

  @Post('poke')
  @Authenticated({ public: true })
  @HttpCode(HttpStatus.NO_CONTENT)
  async poke(@Param('linkId') linkId: string, @Req() request: Request) {
    await this.shares.poke(await this.peer.authorize(request, linkId));
  }

  @Get('shares')
  @Authenticated({ public: true })
  offered(@Param('linkId') linkId: string, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    return this.reply(linkId, request, response, (access) => this.shares.offered(access));
  }

  @Post('shares/:shareId/members/:userId/accept')
  @Authenticated({ public: true })
  @HttpCode(HttpStatus.OK)
  accept(
    @Param('linkId') linkId: string,
    @Param('shareId') shareId: string,
    @Param('userId') userId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.reply(linkId, request, response, (access) => this.shares.accept(access, shareId, userId));
  }

  @Post('shares/:shareId/members/:userId/leave')
  @Authenticated({ public: true })
  @HttpCode(HttpStatus.OK)
  leave(
    @Param('linkId') linkId: string,
    @Param('shareId') shareId: string,
    @Param('userId') userId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.reply(linkId, request, response, (access) => this.shares.leave(access, shareId, userId));
  }

  @Get('shares/:shareId/manifest')
  @Authenticated({ public: true })
  manifest(
    @Param('linkId') linkId: string,
    @Param('shareId') shareId: string,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.reply(linkId, request, response, (access) => this.shares.manifest(access, shareId, { cursor, limit }));
  }

  @Post('shares/:shareId/comments')
  @Authenticated({ public: true })
  @HttpCode(HttpStatus.OK)
  postComment(
    @Param('linkId') linkId: string,
    @Param('shareId') shareId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.reply(linkId, request, response, async (access) =>
      this.shares.postComment(access, shareId, await this.peer.readBody(request, access)),
    );
  }

  @Put('shares/:shareId/comments/:commentId')
  @Authenticated({ public: true })
  putComment(
    @Param('linkId') linkId: string,
    @Param('shareId') shareId: string,
    @Param('commentId') commentId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.reply(linkId, request, response, async (access) =>
      this.shares.putComment(access, shareId, commentId, await this.peer.readBody(request, access)),
    );
  }

  @Delete('shares/:shareId/comments/:commentId')
  @Authenticated({ public: true })
  @HttpCode(HttpStatus.OK)
  deleteComment(
    @Param('linkId') linkId: string,
    @Param('shareId') shareId: string,
    @Param('commentId') commentId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.reply(linkId, request, response, async (access) =>
      this.shares.deleteComment(access, shareId, commentId, await this.peer.readBody(request, access)),
    );
  }

  @Get('shares/:shareId/originals/:assetId')
  @Authenticated({ public: true })
  async original(
    @Param('linkId') linkId: string,
    @Param('shareId') shareId: string,
    @Param('assetId') assetId: string,
    @Query('token') token: unknown,
    @Req() request: Request,
    @Res() response: Response,
    @Next() next: NextFunction,
  ) {
    const access = await this.peer.authorize(request, linkId);
    const file = await this.shares.original(access, shareId, assetId, token);
    response.setHeader('Cache-Control', 'no-store');
    await sendFile(response, next, () => file, this.logger);
  }
}
