import { Controller, Get, Param, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Authenticated } from 'src/middleware/auth.guard.js';
import { HouseholdPeerService } from 'src/services/household-peer.service.js';

/**
 * Linked Households (FL-952): the routes another household's server calls. They are public to the session
 * guard because the caller is a server, not a signed-in person: `HouseholdPeerService.authorize` admits it.
 */
@ApiExcludeController()
@Controller('household/v1/links/:linkId')
export class HouseholdPeerController {
  constructor(private peer: HouseholdPeerService) {}

  @Get('handshake')
  @Authenticated({ public: true })
  async handshake(
    @Param('linkId') linkId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const access = await this.peer.authorize(request, linkId);
    return this.peer.signed(access, await this.peer.handshake());
  }
}
