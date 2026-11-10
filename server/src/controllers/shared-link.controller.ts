import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Next,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { NextFunction, Request, Response } from 'express';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { LoginDetails } from 'src/services/auth.service.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { AssetIdsResponseDto } from 'src/dtos/asset-ids.response.dto.js';
import { AssetIdsDto } from 'src/dtos/asset.dto.js';
import {
  SharedLinkCreateDto,
  SharedLinkDirectImageDto,
  SharedLinkEditDto,
  SharedLinkLoginDto,
  SharedLinkResponseDto,
  SharedLinkSearchDto,
} from 'src/dtos/shared-link.dto.js';
import { ApiTag, AuthCookie, Permission } from 'src/enum.js';
import { Auth, Authenticated, FileResponse, GetLoginDetails } from 'src/middleware/auth.guard.js';
import { requestVia } from 'src/middleware/frameleaf-via.middleware.js';
import { RATE_LIMITS, RateLimited } from 'src/middleware/rate-limit.guard.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SharedLinkService } from 'src/services/shared-link.service.js';
import { sendFile } from 'src/utils/file.js';
import { respondWithCookie } from 'src/utils/response.js';
import { UUIDParamDto } from 'src/validation.js';

const getAuthTokens = (cookies: Record<string, string> | undefined) => {
  return cookies?.[AuthCookie.SharedLinkToken]?.split(',') || [];
};

/**
 * FL-788: a direct image may sit in other sites' pages and in shared caches, but for an hour at most, so
 * a link that is removed, gets a password or stops allowing downloads stops serving it within that hour.
 * Cross-origin embedding is allowed even where the server sends the security headers that would block it.
 */
const DIRECT_IMAGE_CACHE_CONTROL = 'public, max-age=3600';

const merge = (cookies: Record<string, string> | undefined, token: string) => {
  const authTokens = getAuthTokens(cookies);
  if (!authTokens.includes(token)) {
    authTokens.push(token);
  }

  return authTokens.join(',');
};

@ApiTags(ApiTag.SharedLinks)
@Controller('shared-links')
export class SharedLinkController {
  constructor(
    private service: SharedLinkService,
    private logger: LoggingRepository,
  ) {}

  @Get()
  @Authenticated({ permission: Permission.SharedLinkRead })
  @Endpoint({
    summary: 'Retrieve all shared links',
    description: 'Retrieve a list of all shared links.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  getAllSharedLinks(@Auth() auth: AuthDto, @Query() dto: SharedLinkSearchDto): Promise<SharedLinkResponseDto[]> {
    return this.service.getAll(auth, dto);
  }

  @Post('login')
  @Authenticated({ sharedLink: true, sharedLinkPassword: false })
  @RateLimited(RATE_LIMITS.sharedLinkLogin)
  @Endpoint({
    summary: 'Shared link login',
    description: 'Login to a password protected shared link',
    history: new HistoryBuilder().added('v2.6.0').beta('v2.6.0'),
  })
  async sharedLinkLogin(
    @Auth() auth: AuthDto,
    @Body() dto: SharedLinkLoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @GetLoginDetails() loginDetails: LoginDetails,
  ): Promise<SharedLinkResponseDto> {
    const { sharedLink, token } = await this.service.login(auth, dto, loginDetails);

    return respondWithCookie(res, sharedLink, {
      isSecure: loginDetails.isSecure,
      values: [{ key: AuthCookie.SharedLinkToken, value: merge(req.cookies, token) }],
    });
  }

  @Get('me')
  @Authenticated({ sharedLink: true, sharedLinkPassword: false })
  @Endpoint({
    summary: 'Retrieve current shared link',
    description: 'Retrieve the current shared link associated with authentication method.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  getMySharedLink(@Auth() auth: AuthDto, @Req() req: Request): Promise<SharedLinkResponseDto> {
    return this.service.getMine(auth, getAuthTokens(req.cookies));
  }

  @Get('direct/:keyOrSlug.jpg')
  @Authenticated({ public: true })
  @FileResponse('image/jpeg', 'image/webp')
  @Endpoint({
    summary: 'View the image of a single-photo shared link',
    description:
      'Serve the photo of a shared link to exactly one photo as an image file, for embedding in other sites. Only for links with no password, downloads allowed and no expiry passed; any other link answers 404. The location is always removed.',
    history: new HistoryBuilder().added('v3.4.0').beta('v3.4.0'),
  })
  async getSharedLinkDirectImage(
    @Param('keyOrSlug') keyOrSlug: string,
    @Query() dto: SharedLinkDirectImageDto,
    @Req() req: Request,
    @Res() res: Response,
    @Next() next: NextFunction,
  ) {
    await sendFile(
      res,
      next,
      async () => {
        const file = await this.service.getDirectImage(keyOrSlug, dto, requestVia(req));
        res.header('Cache-Control', DIRECT_IMAGE_CACHE_CONTROL);
        res.header('Cross-Origin-Resource-Policy', 'cross-origin');
        return file;
      },
      this.logger,
    );
  }

  @Get(':id')
  @Authenticated({ permission: Permission.SharedLinkRead })
  @Endpoint({
    summary: 'Retrieve a shared link',
    description: 'Retrieve a specific shared link by its ID.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  getSharedLinkById(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<SharedLinkResponseDto> {
    return this.service.get(auth, id);
  }

  @Post()
  @Authenticated({ permission: Permission.SharedLinkCreate })
  @Endpoint({
    summary: 'Create a shared link',
    description: 'Create a new shared link.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  createSharedLink(@Auth() auth: AuthDto, @Body() dto: SharedLinkCreateDto) {
    return this.service.create(auth, dto);
  }

  @Patch(':id')
  @Authenticated({ permission: Permission.SharedLinkUpdate })
  @Endpoint({
    summary: 'Update a shared link',
    description: 'Update an existing shared link by its ID.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  updateSharedLink(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: SharedLinkEditDto,
  ): Promise<SharedLinkResponseDto> {
    return this.service.update(auth, id, dto);
  }

  @Delete(':id')
  @Authenticated({ permission: Permission.SharedLinkDelete })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Delete a shared link',
    description: 'Delete a specific shared link by its ID.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  removeSharedLink(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<void> {
    return this.service.remove(auth, id);
  }

  @Put(':id/assets')
  @Authenticated({ permission: Permission.SharedLinkUpdate })
  @Endpoint({
    summary: 'Add assets to a shared link',
    description:
      'Add assets to a specific shared link by its ID. This endpoint is only relevant for shared link of type individual.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  addSharedLinkAssets(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: AssetIdsDto,
  ): Promise<AssetIdsResponseDto[]> {
    return this.service.addAssets(auth, id, dto);
  }

  @Delete(':id/assets')
  @Authenticated({ permission: Permission.SharedLinkUpdate })
  @Endpoint({
    summary: 'Remove assets from a shared link',
    description:
      'Remove assets from a specific shared link by its ID. This endpoint is only relevant for shared link of type individual.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  removeSharedLinkAssets(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: AssetIdsDto,
  ): Promise<AssetIdsResponseDto[]> {
    return this.service.removeAssets(auth, id, dto);
  }
}
