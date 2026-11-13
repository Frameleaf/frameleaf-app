import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Options,
  Patch,
  Param,
  Post,
  Query,
  Redirect,
  Req,
  Res,
} from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  OAuthAppAdminClientDto,
  OAuthAppAccessPolicyDto,
  OAuthAppCreateClientDto,
  OAuthAppCreateClientResponseDto,
  OAuthAppAccessPolicyResponseDto,
  OAuthAppAuthorizeDto,
  OAuthAppAuthorizeResponseDto,
  OAuthAppAuthorizeStartDto,
  OAuthAppAuthorizeStartResponseDto,
  OAuthAppGrantDto,
} from 'src/dtos/oauth-app.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { RATE_LIMITS, RateLimited } from 'src/middleware/rate-limit.guard.js';
import { OAuthAppService } from 'src/services/oauth-app.service.js';
import { oauthIssuer } from 'src/utils/oauth-issuer.js';
import { UUIDParamDto } from 'src/validation.js';

export { oauthIssuer } from 'src/utils/oauth-issuer.js';

/** The protocol endpoints are called by apps from anywhere; they never read cookies, so any origin may. */
const allowAnyOrigin = (res: Response) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, MCP-Protocol-Version');
  res.setHeader('Access-Control-Max-Age', '600');
};

/**
 * FL-803 (E3-03): connected apps through OAuth 2.1. The protocol endpoints (authorize, token,
 * revoke, register) speak standard OAuth and are left out of the API description; the Allow page
 * and Settings use the rest. See `OAuthAppService`.
 */
@ApiTags(ApiTag.Authentication)
@Controller('oauth/apps')
export class OAuthAppController {
  constructor(private service: OAuthAppService) {}

  @ApiExcludeEndpoint()
  @Get('authorize')
  @Authenticated({ public: true })
  @RateLimited(RATE_LIMITS.oauthAppAuthorize)
  @Redirect()
  async authorizeRedirect(@Req() request: Request, @Query() query: Record<string, unknown>) {
    return { url: await this.service.authorizeRedirect(query, oauthIssuer(request)), statusCode: HttpStatus.FOUND };
  }

  @Post('authorize/start')
  @Authenticated({ permission: false })
  @RateLimited(RATE_LIMITS.oauthAppAuthorize)
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    operationId: 'startOAuthAppAuthorization',
    summary: 'Check an app’s request before Allow',
    description:
      'For the Allow page, signed in with a session (never a key or an app). Checks the app, its exact return address, the S256 code challenge and that every scope asked for is one this server offers, and says who the app is and what it asked for.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  start(
    @Auth() auth: AuthDto,
    @Body() dto: OAuthAppAuthorizeStartDto,
    @Req() request: Request,
  ): Promise<OAuthAppAuthorizeStartResponseDto> {
    return this.service.start(auth, dto, oauthIssuer(request));
  }

  @Post('authorize')
  @Authenticated({ permission: false })
  @RateLimited(RATE_LIMITS.oauthAppAuthorize)
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    operationId: 'authorizeOAuthApp',
    summary: 'Allow or deny an app',
    description:
      'Signed in with a session (never a key or an app). Allow makes a single-use code, valid five minutes, bound to you, this session, the app, its exact return address, the code challenge, the scopes and the resource; only its SHA-256 is kept. Deny makes nothing. Both are written to your account activity. The response is where the browser goes next.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  authorize(
    @Auth() auth: AuthDto,
    @Req() request: Request,
    @Body() dto: OAuthAppAuthorizeDto,
  ): Promise<OAuthAppAuthorizeResponseDto> {
    return this.service.authorize(auth, dto, oauthIssuer(request));
  }

  @ApiExcludeEndpoint()
  @Options(['token', 'revoke', 'register'])
  @Authenticated({ public: true })
  @HttpCode(HttpStatus.NO_CONTENT)
  preflight(@Res({ passthrough: true }) res: Response) {
    allowAnyOrigin(res);
  }

  @ApiExcludeEndpoint()
  @Post('token')
  @Authenticated({ public: true })
  @RateLimited(RATE_LIMITS.oauthAppToken)
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  token(@Body() body: Record<string, unknown>, @Res({ passthrough: true }) res: Response) {
    allowAnyOrigin(res);
    return this.service.token(body ?? {});
  }

  @ApiExcludeEndpoint()
  @Post('revoke')
  @Authenticated({ public: true })
  @RateLimited(RATE_LIMITS.oauthAppToken)
  @HttpCode(HttpStatus.OK)
  async revoke(@Body() body: Record<string, unknown>, @Res({ passthrough: true }) res: Response) {
    allowAnyOrigin(res);
    await this.service.revoke(body ?? {});
    return {};
  }

  @ApiExcludeEndpoint()
  @Post('register')
  @Authenticated({ public: true })
  @RateLimited(RATE_LIMITS.oauthAppRegister)
  @HttpCode(HttpStatus.CREATED)
  @Header('Cache-Control', 'no-store')
  register(@Body() body: Record<string, unknown>, @Res({ passthrough: true }) res: Response) {
    allowAnyOrigin(res);
    return this.service.register(body ?? {});
  }

  @Patch('grants/:id/access-policy')
  @Header('Cache-Control', 'no-store')
  @Authenticated({ permission: false })
  @Endpoint({
    history: new HistoryBuilder().added('v1.2.21'),
    operationId: 'narrowOAuthAppAccessPolicy',
    summary: 'Reduce a connected app’s access',
  })
  narrowAccessPolicy(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: OAuthAppAccessPolicyDto,
  ): Promise<OAuthAppAccessPolicyResponseDto> {
    return this.service.narrowAccessPolicy(auth, id, dto);
  }

  @Get('grants')
  @Authenticated({ permission: Permission.SessionRead })
  @Endpoint({
    operationId: 'getOAuthAppGrants',
    summary: 'List your connected apps',
    description:
      'The apps you allowed that can still use your library: who they are, what you allowed, when, and when and how they last connected. Connected apps are listed like signed-in devices: an API key needs session.read. Not available to the apps themselves.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  getGrants(@Auth() auth: AuthDto): Promise<OAuthAppGrantDto[]> {
    return this.service.getGrants(auth);
  }

  @Delete('grants/:id')
  @Authenticated({ permission: Permission.SessionDelete })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    operationId: 'revokeOAuthAppGrant',
    summary: 'Remove a connected app’s access',
    description:
      'Revokes the grant: the app’s access and refresh tokens stop working on its next request. Written to your account activity. An API key needs session.delete.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  revokeGrant(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<void> {
    return this.service.revokeGrant(auth, id);
  }
}

/** FL-803: the apps registered on this server, for administrators. */
@ApiTags(ApiTag.AuthenticationAdmin)
@Controller('admin/oauth/apps')
export class OAuthAppAdminController {
  constructor(private service: OAuthAppService) {}

  @Get()
  @Authenticated({ admin: true, permission: Permission.AdminSessionRead })
  @Endpoint({
    operationId: 'getOAuthAppClients',
    summary: 'List registered apps',
    description: 'Every app registered for connecting to this server, and how many people currently allow each.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  getClients(): Promise<OAuthAppAdminClientDto[]> {
    return this.service.getClients();
  }

  @Post()
  @Authenticated({ admin: true, permission: false })
  @Endpoint({
    history: new HistoryBuilder().added('v1.2.21'),
    operationId: 'createOAuthAppClient',
    summary: 'Register a public app client',
  })
  createClient(@Auth() auth: AuthDto, @Body() dto: OAuthAppCreateClientDto): Promise<OAuthAppCreateClientResponseDto> {
    return this.service.createClient(auth, dto);
  }

  @Delete(':id')
  @Authenticated({ admin: true, permission: Permission.AdminSessionDelete })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    operationId: 'deleteOAuthAppClient',
    summary: 'Remove a registered app',
    description:
      'Removes the app and every person’s access to it; each person sees it in their account activity. The app can register again only while new apps may register themselves.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  deleteClient(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<void> {
    return this.service.deleteClient(auth, id);
  }
}

/**
 * FL-803: OAuth discovery at the server's root (RFC 8414 and RFC 9728), outside `/api`. The
 * protected-resource document also answers for a path under it, such as `/api/mcp` (FL-844).
 */
@Controller('.well-known')
export class OAuthAppWellKnownController {
  constructor(private service: OAuthAppService) {}

  @ApiExcludeEndpoint()
  @Get('oauth-authorization-server')
  @Authenticated({ public: true })
  getAuthorizationServer(@Req() request: Request, @Res({ passthrough: true }) res: Response) {
    allowAnyOrigin(res);
    return this.service.getAuthorizationServerMetadata(oauthIssuer(request));
  }

  @ApiExcludeEndpoint()
  @Get(['oauth-protected-resource', 'oauth-protected-resource/*path'])
  @Authenticated({ public: true })
  getProtectedResource(@Req() request: Request, @Res({ passthrough: true }) res: Response) {
    allowAnyOrigin(res);
    const suffix = request.path.replace(/^\/\.well-known\/oauth-protected-resource/, '');
    const path = /^(?:\/[\w.~-]+)*$/.test(suffix) && suffix.length <= 200 ? suffix : '';
    return this.service.getProtectedResourceMetadata(oauthIssuer(request), path);
  }
}
