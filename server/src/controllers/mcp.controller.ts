import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Next,
  NotFoundException,
  Options,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { NextFunction, Request, Response } from 'express';
import { oauthIssuer } from 'src/controllers/oauth-app.controller.js';
import { Authenticated } from 'src/middleware/auth.guard.js';
import { requestVia } from 'src/middleware/frameleaf-via.middleware.js';
import { RATE_LIMITS, RateLimited } from 'src/middleware/rate-limit.guard.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { RateLimitRepository } from 'src/repositories/rate-limit.repository.js';
import { AuthService } from 'src/services/auth.service.js';
import { McpPreviewService } from 'src/services/mcp-preview.service.js';
import { McpService } from 'src/services/mcp.service.js';
import { OAuthAppService } from 'src/services/oauth-app.service.js';
import { sendFile } from 'src/utils/file.js';
import { ASSISTANT_MCP_PATH, MCP_PATH, isAssistantResource } from 'src/utils/oauth-apps.js';

@ApiExcludeController()
@Controller('mcp')
export class McpController {
  constructor(
    private auth: AuthService,
    private apps: OAuthAppService,
    private tools: McpService,
    private previews: McpPreviewService,
    private rateLimits: RateLimitRepository,
    private logger: LoggingRepository,
  ) {
    this.logger.setContext(McpController.name);
  }

  @Options(['/', 'assistant'])
  @Authenticated({ public: true })
  @HttpCode(HttpStatus.NO_CONTENT)
  options(@Req() request: Request, @Res({ passthrough: true }) res: Response) {
    this.checkOrigin(request, res);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, MCP-Protocol-Version');
  }

  @Get(['/', 'assistant'])
  @Authenticated({ public: true })
  @RateLimited(RATE_LIMITS.mcp)
  async listen(@Req() request: Request, @Res() res: Response) {
    await this.authenticate(request, res);
    // Stateless Streamable HTTP has no server-initiated event stream to listen to.
    res.status(HttpStatus.METHOD_NOT_ALLOWED).setHeader('Allow', 'POST, OPTIONS').end();
  }

  @Post(['/', 'assistant'])
  @Authenticated({ public: true })
  @RateLimited(RATE_LIMITS.mcp)
  async handle(@Req() request: Request, @Res() res: Response, @Body() body: unknown) {
    const { auth, resource } = await this.authenticate(request, res);
    if (Array.isArray(body)) {
      throw new BadRequestException('Send one MCP message per request');
    }
    const grant = auth.oauthApp;
    const limit = await this.rateLimits.hit(`mcp:grant:${grant.grantId}`, 60);
    if (limit.count > 60) {
      res.setHeader('Retry-After', limit.resetSeconds);
      res.status(HttpStatus.TOO_MANY_REQUESTS).end();
      return;
    }
    const server = this.tools.createServer(auth, (assetId) => this.previews.createUrl(grant, resource, assetId));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, res, body ?? null);
    } finally {
      await server.close();
    }
  }

  @Get('preview')
  @Authenticated({ public: true })
  @RateLimited(RATE_LIMITS.mcp)
  async preview(
    @Req() request: Request,
    @Res() res: Response,
    @Next() next: NextFunction,
    @Query('token') token: unknown,
  ) {
    await this.requireEnabled();
    const file = await this.previews.read(token, this.resource(request), requestVia(request));
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    await sendFile(res, next, () => file, this.logger);
  }

  private async authenticate(request: Request, res: Response) {
    this.checkOrigin(request, res);
    res.setHeader('Cache-Control', 'no-store');
    await this.requireEnabled();
    const resource = this.resource(request);
    if (isAssistantResource(resource) && !resource.startsWith('https://')) {
      throw new ForbiddenException('Official assistant access requires HTTPS');
    }
    if (isAssistantResource(resource) && !(await this.apps.assistantAvailable())) {
      throw new NotFoundException();
    }
    try {
      const auth = await this.auth.authenticateMcp(request.headers, resource, requestVia(request));
      return { auth, resource };
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        const metadata = new URL(`/.well-known/oauth-protected-resource${new URL(resource).pathname}`, resource);
        const invalid = request.headers.authorization ? ' error="invalid_token",' : '';
        res.setHeader(
          'WWW-Authenticate',
          `Bearer${invalid} resource_metadata="${metadata.href}", scope="library:read"`,
        );
      }
      throw error;
    }
  }

  private checkOrigin(request: Request, res: Response) {
    const origin = request.get('origin');
    if (origin === undefined) {
      return;
    }
    if (origin !== new URL(this.resource(request)).origin) {
      throw new ForbiddenException('Origin is not allowed');
    }
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate');
  }

  private resource(request: Request) {
    const path = request.path.toLowerCase().replace(/\/$/, '').endsWith('/assistant') ? ASSISTANT_MCP_PATH : MCP_PATH;
    return new URL(path, oauthIssuer(request, path === ASSISTANT_MCP_PATH)).href;
  }

  private async requireEnabled() {
    const { connectedApps } = await this.apps.getConfig({ withCache: true });
    if (connectedApps.allowMcp === false) {
      throw new NotFoundException();
    }
  }
}
