import {
  Body,
  Controller,
  Delete,
  Get,
  Head,
  Header,
  HttpCode,
  Next,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiHeader, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { NextFunction, Request, Response } from 'express';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  ConnectAlbumCreateDto,
  ConnectAlbumResultDto,
  ConnectMediaReceiptDto,
  ConnectRenditionDto,
  ConnectRenditionTicketDto,
  ConnectUploadCommitDto,
  ConnectUploadStartDto,
  ConnectUploadStateDto,
} from 'src/dtos/connect-media.dto.js';
import { Auth, Authenticated, FileResponse } from 'src/middleware/auth.guard.js';
import { requestVia } from 'src/middleware/frameleaf-via.middleware.js';
import { RemoteMediaCeiling } from 'src/middleware/rate-limit.guard.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { ConnectMediaService } from 'src/services/connect-media.service.js';
import { assetUploadRequestHeaders } from 'src/utils/asset-upload-response.js';
import { sendFile } from 'src/utils/file.js';
import { UUIDParamDto } from 'src/validation.js';

@ApiTags('Connect')
@Controller('connect')
export class ConnectMediaController {
  constructor(
    private service: ConnectMediaService,
    private logger: LoggingRepository,
  ) {}

  @Post('albums')
  @ApiResponse({ status: 201, type: ConnectAlbumResultDto })
  @Header('Cache-Control', 'no-store')
  @Authenticated({ connect: true, permission: false })
  @Endpoint({
    history: new HistoryBuilder().added('v1.2.21'),
    operationId: 'createConnectAlbum',
    summary: 'Create an authorized album with a retry receipt',
  })
  createAlbum(@Auth() auth: AuthDto, @Body() dto: ConnectAlbumCreateDto) {
    return this.service.createAlbum(auth, dto);
  }

  @Post('uploads')
  @Header('Cache-Control', 'no-store')
  @Authenticated({ connect: true, permission: false })
  @ApiResponse({ status: 201, type: ConnectUploadStateDto })
  @Endpoint({
    history: new HistoryBuilder().added('v1.2.21'),
    operationId: 'startConnectUpload',
    summary: 'Start a private resumable Connect upload',
  })
  async start(@Auth() auth: AuthDto, @Body() dto: ConnectUploadStartDto, @Res({ passthrough: true }) res: Response) {
    const state = await this.service.start(auth, dto);
    res.setHeader('Location', `/api/connect/uploads/${state.id}`);
    this.headers(res, state);
    return state;
  }

  @Head('uploads/:id')
  @Authenticated({ connect: true, permission: false })
  @ApiResponse({
    status: 204,
    description: 'Durable upload offset and completion state',
    headers: {
      'Upload-Offset': { schema: { type: 'integer', minimum: 0 } },
      'Upload-Length': { schema: { type: 'integer', minimum: 1 } },
      'Upload-Complete': { schema: { type: 'string', enum: ['?0', '?1'] } },
    },
  })
  @Endpoint({
    history: new HistoryBuilder().added('v1.2.21'),
    operationId: 'headConnectUpload',
    summary: 'Get the durable Connect upload offset',
  })
  async head(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto, @Res() res: Response) {
    this.headers(res, await this.service.state(auth, id));
    res.status(204).end();
  }

  @Get('uploads/:id')
  @Header('Cache-Control', 'no-store')
  @Authenticated({ connect: true, permission: false })
  @ApiResponse({ status: 200, type: ConnectUploadStateDto })
  @Endpoint({
    history: new HistoryBuilder().added('v1.2.21'),
    operationId: 'getConnectUpload',
    summary: 'Get Connect upload state and its committed receipt',
  })
  state(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto) {
    return this.service.state(auth, id);
  }

  @Patch('uploads/:id')
  @Authenticated({ connect: true, permission: false })
  @ApiConsumes('application/partial-upload')
  @ApiHeader({ name: 'Upload-Draft-Interop-Version', required: true, schema: { type: 'string', enum: ['9'] } })
  @ApiHeader({ name: 'Upload-Offset', required: true, schema: { type: 'integer', minimum: 0 } })
  @ApiHeader({ name: 'Upload-Complete', required: true, schema: { type: 'string', enum: ['?0', '?1'] } })
  @ApiBody({ schema: { type: 'string', format: 'binary' } })
  @ApiResponse({ status: 200, type: ConnectUploadStateDto })
  @Endpoint({
    history: new HistoryBuilder().added('v1.2.21'),
    operationId: 'appendConnectUpload',
    summary: 'Append bytes at the durable offset without publishing',
  })
  async append(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const state = await this.service.append(auth, id, assetUploadRequestHeaders(req), req);
    this.headers(res, state);
    return state;
  }

  @Post('uploads/:id/commit')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Authenticated({ connect: true, permission: false })
  @ApiResponse({ status: 200, type: ConnectMediaReceiptDto })
  @Endpoint({
    history: new HistoryBuilder().added('v1.2.21'),
    operationId: 'commitConnectUpload',
    summary: 'Commit verified bytes to their authorized destination',
  })
  commit(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto, @Body() dto: ConnectUploadCommitDto) {
    return this.service.commit(auth, id, dto);
  }

  @Delete('uploads/:id')
  @Header('Cache-Control', 'no-store')
  @Authenticated({ connect: true, permission: false })
  @ApiResponse({ status: 200, type: ConnectUploadStateDto })
  @Endpoint({
    history: new HistoryBuilder().added('v1.2.21'),
    operationId: 'cancelConnectUpload',
    summary: 'Cancel unpublished staging, preserving committed media',
  })
  cancel(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto) {
    return this.service.cancel(auth, id);
  }

  @Get('assets/:id/rendition')
  @Header('Cache-Control', 'private, no-store')
  @FileResponse('image/*', 'video/*', 'application/*')
  @RemoteMediaCeiling()
  @Authenticated({ connect: true, permission: false })
  @Endpoint({
    history: new HistoryBuilder().added('v1.2.21'),
    operationId: 'getConnectRendition',
    summary: 'Read an authorized rendition or permitted original',
  })
  async rendition(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Query() dto: ConnectRenditionDto,
    @Req() req: Request,
    @Res() res: Response,
    @Next() next: NextFunction,
  ) {
    const file = await this.service.rendition(auth, id, dto.variant, requestVia(req));
    await sendFile(res, next, () => file, this.logger);
  }

  @Post('assets/:id/rendition-ticket')
  @Header('Cache-Control', 'no-store')
  @Authenticated({ connect: true, permission: false })
  @ApiResponse({ status: 201, type: ConnectRenditionTicketDto })
  @Endpoint({
    history: new HistoryBuilder().added('v1.2.21'),
    operationId: 'createConnectRenditionTicket',
    summary: 'Create a short-lived grant-bound rendition ticket',
  })
  createTicket(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: ConnectRenditionDto,
    @Req() req: Request,
  ) {
    return this.service.createTicket(auth, id, dto.variant, requestVia(req));
  }

  @Get('renditions/:ticket')
  @Authenticated({ public: true })
  @Header('Cache-Control', 'private, no-store')
  @FileResponse('image/*', 'video/*', 'application/*')
  @RemoteMediaCeiling()
  @Endpoint({
    history: new HistoryBuilder().added('v1.2.21'),
    operationId: 'getConnectTicketRendition',
    summary: 'Read a ticket rendition after current grant authorization',
  })
  async ticket(@Param('ticket') token: string, @Req() req: Request, @Res() res: Response, @Next() next: NextFunction) {
    const file = await this.service.ticket(token, requestVia(req));
    await sendFile(res, next, () => file, this.logger);
  }

  private headers(res: Response, state: ConnectUploadStateDto) {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Upload-Draft-Interop-Version', '9');
    res.setHeader('Upload-Offset', state.offset);
    res.setHeader('Upload-Length', state.size);
    res.setHeader('Upload-Complete', ['verified', 'published'].includes(state.state) ? '?1' : '?0');
  }
}
