import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type INestApplication, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';
import z from 'zod';
import type { Request } from 'express';
import type { AddressInfo } from 'node:net';
import { McpController } from 'src/controllers/mcp.controller.js';
import { frameleafViaMiddleware } from 'src/middleware/frameleaf-via.middleware.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { RateLimitRepository } from 'src/repositories/rate-limit.repository.js';
import { AuthService } from 'src/services/auth.service.js';
import { McpPreviewService } from 'src/services/mcp-preview.service.js';
import { McpService } from 'src/services/mcp.service.js';
import { OAuthAppService } from 'src/services/oauth-app.service.js';

describe('MCP HTTP transport', () => {
  let server: Server;
  let endpoint: URL;
  let enabled = true;
  let licensed = true;
  let app: INestApplication;
  const oauthApp = { grantId: 'grant', clientId: 'client', scopes: ['library:read'] };
  const authenticate = vi.fn((headers: Request['headers'], resource: string) => {
    if (headers.authorization !== 'Bearer fla_fixture' || resource !== endpoint.href) {
      throw new UnauthorizedException();
    }
    return Promise.resolve({ user: { id: 'owner' }, oauthApp });
  });
  const hit = vi.fn(() => Promise.resolve({ count: 1, resetSeconds: 60 }));
  const createTools = vi.fn(() => {
    const tools = new McpServer({ name: 'Frameleaf transport fixture', version: '1.0.0' });
    tools.registerTool('echo', { inputSchema: z.strictObject({ text: z.string() }) }, ({ text }) => ({
      content: [{ type: 'text', text }],
    }));
    return tools;
  });
  const assistantAvailable = vi.fn(() => Promise.resolve(licensed));
  const initialize = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'Frameleaf transport fixture', version: '1.0.0' },
    },
  };
  const post = (body: object = initialize) =>
    request(server)
      .post('/api/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .set('Authorization', 'Bearer fla_fixture')
      .send(body);

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [McpController],
      providers: [
        { provide: AuthService, useValue: { authenticateMcp: authenticate } },
        {
          provide: OAuthAppService,
          useValue: { assistantAvailable, getConfig: () => Promise.resolve({ connectedApps: { allowMcp: enabled } }) },
        },
        { provide: McpService, useValue: { createServer: createTools } },
        { provide: McpPreviewService, useValue: {} },
        { provide: RateLimitRepository, useValue: { hit } },
        { provide: LoggingRepository, useValue: { setContext: vi.fn() } },
      ],
    }).compile();
    app = module.createNestApplication({ logger: false });
    app.use(frameleafViaMiddleware(null, ['127.0.0.1']));
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    server = app.getHttpServer();
    endpoint = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/mcp`);
  });

  beforeEach(() => {
    enabled = true;
    licensed = true;
    vi.clearAllMocks();
  });

  afterAll(async () => {
    server.closeAllConnections();
    await app.close();
  });

  it('initializes and lists and calls tools through the SDK client', async () => {
    const client = new Client({ name: 'Frameleaf acceptance fixture', version: '1.0.0' });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(endpoint, {
          requestInit: { headers: { Authorization: 'Bearer fla_fixture' } },
        }),
      );
      expect((await client.listTools()).tools.map(({ name }) => name)).toEqual(['echo']);
      expect(await client.callTool({ name: 'echo', arguments: { text: 'Library fixture data' } })).toMatchObject({
        content: [{ type: 'text', text: 'Library fixture data' }],
      });
      expect(hit).toHaveBeenCalledWith('mcp:grant:grant', 60);
    } finally {
      await client.close();
    }
  });

  it('rejects another Origin before using the token', async () => {
    await post().set('Origin', 'https://unrelated.example').expect(403);
    expect(authenticate).not.toHaveBeenCalled();
    expect(createTools).not.toHaveBeenCalled();
  });

  it('rejects batches before creating a tool server or spending a grant rate-limit hit', async () => {
    await post([initialize]).expect(400);
    expect(createTools).not.toHaveBeenCalled();
    expect(hit).not.toHaveBeenCalled();
  });

  it('returns the OAuth metadata challenge for unauthenticated requests', async () => {
    const response = await post().unset('Authorization').expect(401);
    expect(response.headers['www-authenticate']).toBe(
      `Bearer resource_metadata="${endpoint.origin}/.well-known/oauth-protected-resource/api/mcp", scope="library:read"`,
    );
    expect(createTools).not.toHaveBeenCalled();
  });

  it('refuses MCP while disabled and authenticated GET when no event stream exists', async () => {
    enabled = false;
    await post().expect(404);
    expect(authenticate).not.toHaveBeenCalled();
    enabled = true;
    await request(server).get('/api/mcp').set('Authorization', 'Bearer fla_fixture').expect(405);
  });

  it('challenges for the official HTTPS resource and checks eligibility before authenticating', async () => {
    const official = () =>
      request(server).post('/api/mcp/assistant').set('Accept', 'application/json, text/event-stream').send(initialize);
    await official().expect(403);
    const response = await official().set('X-Forwarded-Proto', 'https').expect(401);
    expect(response.headers['www-authenticate']).toBe(
      `Bearer resource_metadata="https://${endpoint.host}/.well-known/oauth-protected-resource/api/mcp/assistant", scope="library:read"`,
    );
    expect(authenticate).toHaveBeenCalledWith(expect.anything(), `https://${endpoint.host}/api/mcp/assistant`, null);
    licensed = false;
    await official().set('X-Forwarded-Proto', 'https').expect(404);
    await request(server).post('/api/MCP/Assistant').set('X-Forwarded-Proto', 'https').send(initialize).expect(404);
    expect(authenticate).toHaveBeenCalledTimes(1);
  });

  it('reports the grant rate-limit wait before creating a tool server', async () => {
    hit.mockResolvedValueOnce({ count: 61, resetSeconds: 23 });
    await post().expect(429).expect('Retry-After', '23');
    expect(createTools).not.toHaveBeenCalled();
  });
});
