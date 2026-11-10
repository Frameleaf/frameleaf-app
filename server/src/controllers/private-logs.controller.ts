import { Controller, Get, Header, Query, Req, Res, StreamableFile } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import type { Request, Response } from 'express';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  PrivateLogDownloadQueryDto,
  PrivateLogPageDto,
  PrivateLogQueryDto,
  PrivateLogStreamQueryDto,
} from 'src/dtos/private-log.dto.js';
import { ApiTag } from 'src/enum.js';
import { Auth, Authenticated, FileResponse } from 'src/middleware/auth.guard.js';
import { requestVia } from 'src/middleware/frameleaf-via.middleware.js';
import { PrivateLogsService } from 'src/services/private-logs.service.js';

@ApiTags(ApiTag.Server)
@Controller('admin/logs')
export class PrivateLogsController {
  constructor(private logs: PrivateLogsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @Authenticated({ admin: true })
  @Endpoint({ summary: 'List recent local server logs', history: new HistoryBuilder().added('v3') })
  async listServerLogs(
    @Auth() auth: AuthDto,
    @Req() req: Request,
    @Query() query: PrivateLogQueryDto,
  ): Promise<PrivateLogPageDto> {
    await this.logs.authorize(auth, requestVia(req));
    return this.logs.store().list(query);
  }

  @Get('stream')
  @Authenticated({ admin: true })
  @ApiOkResponse({ content: { 'text/event-stream': { schema: { type: 'string' } } } })
  @Endpoint({ summary: 'Follow local server logs', history: new HistoryBuilder().added('v3') })
  async streamServerLogs(
    @Auth() auth: AuthDto,
    @Req() req: Request,
    @Res() res: Response,
    @Query() query: PrivateLogStreamQueryDto,
  ): Promise<void> {
    const via = requestVia(req);
    await this.logs.authorize(auth, via);
    const tail = await this.logs.store().follow(query);
    const controller = new AbortController();
    const { signal } = controller;
    res.once('close', () => controller.abort());
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const write = async (value: string) => {
      if (!res.write(value)) await once(res, 'drain', { signal });
    };
    try {
      while (!signal.aborted) {
        await this.logs.authorizeLive(auth, via);
        let delivered = false;
        for await (const entries of tail()) {
          for (const entry of entries) {
            if (signal.aborted) return;
            await write(`id: ${entry.at}|${entry.id}\ndata: ${JSON.stringify(entry)}\n\n`);
            delivered = true;
          }
        }
        if (!delivered) await write(': heartbeat\n\n');
        await delay(2000, undefined, { signal });
      }
    } catch {
      // Closed connection, expired authority or unreadable store. No private details go on the wire.
    } finally {
      res.end();
    }
  }

  @Get('download')
  @Header('Cache-Control', 'no-store')
  @Authenticated({ admin: true })
  @FileResponse()
  @ApiOkResponse({ content: { 'application/zip': { schema: { type: 'string', format: 'binary' } } } })
  @Endpoint({ summary: 'Download local server logs', history: new HistoryBuilder().added('v3') })
  async downloadServerLogs(
    @Auth() auth: AuthDto,
    @Req() req: Request,
    @Query() { hours }: PrivateLogDownloadQueryDto,
  ): Promise<StreamableFile> {
    await this.logs.authorize(auth, requestVia(req));
    return new StreamableFile(this.logs.download(hours), {
      type: 'application/zip',
      disposition: 'attachment; filename="frameleaf-server-logs.zip"',
    });
  }
}
