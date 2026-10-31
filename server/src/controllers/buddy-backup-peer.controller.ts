import { BadRequestException, Controller, Get, HttpException, Param, Post, Put, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import z from 'zod';
import type { Request, Response } from 'express';
import type { BuddyReceipt, BuddySignedSnapshot } from 'src/utils/buddy-backup-vault.js';
import { Authenticated } from 'src/middleware/auth.guard.js';
import { BuddyBackupPeerService, type BuddyPeerAccess } from 'src/services/buddy-backup-peer.service.js';
import { BUDDY_ID, BUDDY_UUID } from 'src/utils/buddy-backup-crypto.js';
import { buddyCommitReceipt } from 'src/utils/buddy-backup-protocol.js';

@ApiExcludeController()
@Controller('buddy/v1/vaults/:vaultId')
export class BuddyBackupPeerController {
  constructor(private peer: BuddyBackupPeerService) {}

  private async access(request: Request, response: Response, vaultId: string, write = false, handshake = false) {
    if (!BUDDY_UUID.test(vaultId)) throw new BadRequestException('Invalid Buddy vault');
    response.setHeader('Cache-Control', 'no-store');
    return this.peer.authorize(request, response, vaultId, write ? 'write' : 'read', handshake);
  }

  private async body(
    request: Request,
    access: BuddyPeerAccess,
    maximum = 32_768,
    consume?: (body: unknown) => Promise<unknown>,
  ) {
    // This private content type bypasses the general JSON parser. Authenticate before allocating a snapshot body.
    if (request.headers['content-type'] !== 'application/vnd.frameleaf.buddy+json')
      throw new BadRequestException('Invalid Buddy content type');
    const release = await this.peer.streamSlot('download');
    const timer = setTimeout(() => request.destroy(), Math.max(1, access.grant.exp * 1000 - Date.now()));
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > maximum) throw new HttpException('Buddy request too large', 413);
        await this.peer.assertAccess(access, 'write');
        chunks.push(Buffer.from(chunk));
      }
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        throw new BadRequestException('Invalid Buddy JSON');
      }
      return consume ? await consume(body) : body;
    } finally {
      clearTimeout(timer);
      await release();
    }
  }

  private async reply(access: BuddyPeerAccess, data: unknown, write = false) {
    await this.peer.assertAccess(access, write ? 'write' : 'read');
    return this.peer.signed(access, data);
  }

  @Get('handshake')
  @Authenticated({ public: true })
  async handshake(
    @Param('vaultId') vaultId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const access = await this.access(request, response, vaultId, false, true);
    return this.reply(access, { version: 1, vaultId, blockBytes: 8 * 1024 * 1024 });
  }

  @Post('inventory')
  @Authenticated({ public: true })
  async inventory(
    @Param('vaultId') vaultId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const access = await this.access(request, response, vaultId, true);
    const { ids } = z
      .strictObject({ ids: z.array(z.string().regex(BUDDY_ID)).max(100) })
      .parse(await this.body(request, access));
    return this.reply(access, await this.peer.dispatch(access, 'write', () => access.vault.inventory(ids)), true);
  }

  @Post('reservations')
  @Authenticated({ public: true })
  async reserve(
    @Param('vaultId') vaultId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const access = await this.access(request, response, vaultId, true);
    const receipt = (await this.body(request, access)) as BuddyReceipt;
    await this.storage(() => this.peer.reserve(access, receipt));
    return this.reply(access, { ok: true }, true);
  }

  @Put('objects/:id')
  @Authenticated({ public: true })
  async put(
    @Param('vaultId') vaultId: string,
    @Param('id') id: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const access = await this.access(request, response, vaultId, true);
    if (!BUDDY_ID.test(id) || request.headers['content-type'] !== 'application/octet-stream')
      throw new BadRequestException('Invalid Buddy object');
    return this.reply(access, await this.storage(() => this.peer.upload(access, request, id)), true);
  }

  @Get('objects/:id')
  @Authenticated({ public: true })
  async get(
    @Param('vaultId') vaultId: string,
    @Param('id') id: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const access = await this.access(request, response, vaultId);
    if (!BUDDY_ID.test(id)) throw new BadRequestException('Invalid Buddy object');
    await this.peer.download(access, response, id);
  }

  @Get('snapshots')
  @Authenticated({ public: true })
  async snapshots(
    @Param('vaultId') vaultId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const access = await this.access(request, response, vaultId);
    const snapshots = await this.peer.dispatch(access, 'read', () => access.vault.snapshots());
    return this.reply(
      access,
      snapshots.map(({ id, sequence, createdAt, keyVersion }) => ({ id, sequence, createdAt, keyVersion })),
    );
  }

  @Get('snapshots/:id')
  @Authenticated({ public: true })
  async snapshot(
    @Param('vaultId') vaultId: string,
    @Param('id') id: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const access = await this.access(request, response, vaultId);
    if (!BUDDY_UUID.test(id)) throw new BadRequestException('Invalid Buddy snapshot');
    const found = await this.peer.dispatch(access, 'read', () => access.vault.snapshot(id));
    if (!found) throw new HttpException('Buddy snapshot unavailable', 404);
    return this.reply(access, found);
  }

  @Post('snapshots')
  @Authenticated({ public: true })
  async commit(
    @Param('vaultId') vaultId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const access = await this.access(request, response, vaultId, true);
    return this.body(request, access, 256 * 1024 * 1024, async (body) => {
      const envelope = body as BuddySignedSnapshot;
      await this.storage(() => this.peer.commit(access, envelope));
      return this.reply(access, buddyCommitReceipt(envelope), true);
    });
  }

  private async storage<T>(action: () => Promise<T>) {
    try {
      return await action();
    } catch (error) {
      if (
        error instanceof Error &&
        (/Buddy (quota|disk reserve) reached/.test(error.message) || (error as NodeJS.ErrnoException).code === 'ENOSPC')
      )
        throw new HttpException('Buddy storage is full; retained snapshots have been preserved', 507);
      throw error;
    }
  }
}
