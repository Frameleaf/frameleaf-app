import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Head,
  Options,
  Param,
  Patch,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiHeader, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { AssetUploadResource } from 'src/repositories/asset-upload-resource.repository.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  AssetUploadResultDto,
  LivePhotoUploadCommitDto,
  LivePhotoUploadResultDto,
} from 'src/dtos/asset-upload-resource.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { AssetUploadResourceService } from 'src/services/asset-upload-resource.service.js';
import { ASSET_UPLOAD_LIMITS } from 'src/utils/asset-upload-resource.js';
import { UUIDParamDto } from 'src/validation.js';

@ApiTags(ApiTag.Assets)
@Controller('assets/uploads')
export class AssetUploadResourceController {
  constructor(private service: AssetUploadResourceService) {}

  private requestHeaders(req: Request) {
    const single = new Set([
      'content-type',
      'content-encoding',
      'upload-draft-interop-version',
      'upload-complete',
      'upload-offset',
      'upload-length',
      'repr-digest',
      'asset-metadata',
    ]);
    const seen = new Set<string>();
    for (let index = 0; index < req.rawHeaders.length; index += 2) {
      const name = req.rawHeaders[index].toLowerCase();
      if (single.has(name)) {
        if (seen.has(name)) {
          throw new BadRequestException(`Ambiguous ${name}`);
        }
        seen.add(name);
      }
    }
    return req.headers;
  }

  private headers(res: Response, row?: AssetUploadResource, limits?: typeof ASSET_UPLOAD_LIMITS) {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Upload-Draft-Interop-Version', '9');
    const capacity = row ?? limits;
    if (capacity) {
      res.setHeader(
        'Upload-Limit',
        `max-size=${capacity.maxSize}, max-append-size=${capacity.maxAppendSize}, max-age=${ASSET_UPLOAD_LIMITS.maxAge}, min-size=1`,
      );
    }
    if (row) {
      res.setHeader('Upload-Offset', row.offset);
      res.setHeader('Upload-Complete', row.state === 'published' && row.ingested ? '?1' : '?0');
      if (row.expectedSize !== null) {
        res.setHeader('Upload-Length', row.expectedSize);
      }
    }
  }

  @Options()
  @ApiResponse({ status: 204, description: 'Resumable upload limits' })
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({
    summary: 'Get resumable asset upload limits',
    history: new HistoryBuilder().added('v3.2.0').beta('v3.2.0'),
  })
  async getAssetUploadResourceLimits(@Res() res: Response) {
    this.headers(res, undefined, await this.service.limits());
    res.status(204).end();
  }

  @Post()
  @Authenticated({ permission: Permission.AssetUpload })
  @ApiConsumes('image/*', 'video/*', 'audio/*')
  @ApiHeader({ name: 'Upload-Draft-Interop-Version', required: true, schema: { type: 'string', enum: ['9'] } })
  @ApiHeader({ name: 'Upload-Complete', required: true, schema: { type: 'string', enum: ['?0', '?1'] } })
  @ApiHeader({
    name: 'Upload-Length',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: ASSET_UPLOAD_LIMITS.maxSize },
  })
  @ApiHeader({
    name: 'Repr-Digest',
    required: true,
    description: 'RFC 9530 single sha-256=:base64: digest of the entire file, required before any publication',
  })
  @ApiHeader({
    name: 'Asset-Metadata',
    required: true,
    description:
      'Canonical base64url UTF-8 JSON: filename, fileCreatedAt, fileModifiedAt; optional duration (integer milliseconds), isFavorite (JSON boolean; the strings "true" and "false" are also accepted), visibility, metadata array and publication: live-photo to defer publication until atomic pair commit. No sidecar or pre-existing asset references.',
  })
  @ApiBody({ schema: { type: 'string', format: 'binary' } })
  @ApiResponse({
    status: 104,
    description: 'Committed private upload resource exists; Location identifies resumable state',
  })
  @ApiResponse({ status: 201, description: 'Private upload resource created, incomplete bytes are never an asset' })
  @ApiResponse({ status: 202, description: 'Complete bytes verified; ingestion remains pending' })
  @ApiResponse({ status: 200, type: AssetUploadResultDto })
  @Endpoint({
    summary: 'Create resumable asset upload',
    description:
      'IETF resumable upload draft 12 / interop 9 prerequisite. Single resources publish by default; explicitly declared Live Photo resources stay private until pair commit.',
    history: new HistoryBuilder().added('v3.2.0').beta('v3.2.0'),
  })
  async createAssetUploadResource(@Auth() auth: AuthDto, @Req() req: Request, @Res() res: Response) {
    this.headers(res);
    const outcome = await this.service.create(auth, this.requestHeaders(req), req, (row) => {
      this.headers(res, row);
      const location = `${req.originalUrl.split('?', 1)[0]}/${row.id}`;
      res.setHeader('Location', location);
      const information = res as Response & {
        writeInformation?: (status: number, headers: Record<string, string>) => void;
      };
      information.writeInformation?.(104, {
        Location: location,
        'Upload-Draft-Interop-Version': '9',
        'Upload-Complete': '?0',
        'Upload-Limit': String(res.getHeader('Upload-Limit')),
      });
    });
    if (!res.destroyed) {
      this.respond(res, outcome, true);
    }
  }

  private respond(
    res: Response,
    outcome: { resource: AssetUploadResource; result?: AssetUploadResultDto },
    created = false,
  ) {
    this.headers(res, outcome.resource);
    if (outcome.result) {
      res.status(200).json(outcome.result);
    } else {
      res.status(outcome.resource.state === 'published' ? 202 : created ? 201 : 204).end();
    }
  }

  @Post('live-photo/commit')
  @Authenticated({ permission: Permission.AssetUpload })
  @ApiResponse({ status: 200, type: LivePhotoUploadResultDto })
  @ApiResponse({ status: 202, description: 'Both assets committed atomically; required ingestion remains pending' })
  @ApiResponse({ status: 409, description: 'Incompatible pair, existing unrelated duplicate, or concurrent request' })
  @Endpoint({
    summary: 'Commit two verified Live Photo upload resources atomically',
    history: new HistoryBuilder().added('v3.2.0').beta('v3.2.0'),
  })
  async commitLivePhotoUpload(@Auth() auth: AuthDto, @Body() dto: LivePhotoUploadCommitDto, @Res() res: Response) {
    this.headers(res);
    const result = await this.service.commitLivePhoto(auth, dto);
    if (result) {
      res.status(200).json(result);
    } else {
      res.status(202).end();
    }
  }

  @Head(':id')
  @Authenticated({ permission: Permission.AssetUpload })
  @ApiResponse({
    status: 204,
    description: 'Durable acknowledged offset; completion only after final processing',
    headers: {
      'Upload-Offset': { schema: { type: 'integer', minimum: 0 } },
      'Upload-Complete': { schema: { type: 'string', enum: ['?0', '?1'] } },
    },
  })
  @Endpoint({ summary: 'Get durable upload offset', history: new HistoryBuilder().added('v3.2.0').beta('v3.2.0') })
  async getAssetUploadResourceOffset(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto, @Res() res: Response) {
    this.headers(res);
    this.headers(res, await this.service.head(auth, id));
    res.status(204).end();
  }

  @Patch(':id')
  @Authenticated({ permission: Permission.AssetUpload })
  @ApiConsumes('application/partial-upload')
  @ApiHeader({ name: 'Upload-Draft-Interop-Version', required: true, schema: { type: 'string', enum: ['9'] } })
  @ApiHeader({ name: 'Upload-Offset', required: true, schema: { type: 'integer', minimum: 0 } })
  @ApiHeader({ name: 'Upload-Complete', required: true, schema: { type: 'string', enum: ['?0', '?1'] } })
  @ApiBody({ schema: { type: 'string', format: 'binary' } })
  @ApiResponse({ status: 200, type: AssetUploadResultDto })
  @ApiResponse({
    status: 204,
    description: 'Immutable append durably acknowledged',
    headers: {
      'Upload-Offset': { schema: { type: 'integer', minimum: 0 } },
      'Upload-Complete': { schema: { type: 'string', enum: ['?0', '?1'] } },
    },
  })
  @ApiResponse({
    status: 202,
    description: 'Same upload is pending final ingestion; retry empty completion at the durable offset',
  })
  @ApiResponse({ status: 409, description: 'Offset or state conflict; HEAD returns the durable acknowledged offset' })
  @Endpoint({ summary: 'Append immutable upload bytes', history: new HistoryBuilder().added('v3.2.0').beta('v3.2.0') })
  async appendAssetUploadResource(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    this.headers(res);
    try {
      const outcome = await this.service.append(auth, id, this.requestHeaders(req), req);
      if (!res.destroyed) {
        this.respond(res, outcome);
      }
    } catch (error) {
      if (error instanceof ConflictException) {
        const detail = error.getResponse();
        if (typeof detail === 'object' && 'expectedOffset' in detail && typeof detail.expectedOffset === 'number') {
          res.setHeader('Upload-Offset', detail.expectedOffset);
          res.setHeader('Upload-Complete', '?0');
        }
      }
      throw error;
    }
  }

  @Get(':id/result')
  @Authenticated({ permission: Permission.AssetUpload })
  @ApiResponse({ status: 200, type: AssetUploadResultDto })
  @ApiResponse({ status: 202, description: 'Ingestion pending; retry this same resource' })
  @Endpoint({
    summary: 'Recover a completed upload result',
    history: new HistoryBuilder().added('v3.2.0').beta('v3.2.0'),
  })
  async getAssetUploadResourceResult(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto, @Res() res: Response) {
    this.headers(res);
    const outcome = await this.service.result(auth, id);
    this.headers(res, outcome.resource);
    if (outcome.result) {
      res.status(200).json(outcome.result);
    } else {
      res.status(202).end();
    }
  }

  @Delete(':id')
  @ApiResponse({ status: 204, description: 'Upload cancelled' })
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({ summary: 'Cancel an unpublished upload', history: new HistoryBuilder().added('v3.2.0').beta('v3.2.0') })
  async cancelAssetUploadResource(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto, @Res() res: Response) {
    this.headers(res);
    await this.service.cancel(auth, id);
    res.status(204).end();
  }
}
