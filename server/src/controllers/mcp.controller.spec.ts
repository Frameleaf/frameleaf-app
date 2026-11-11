import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { HttpException, UnauthorizedException } from '@nestjs/common';
import express, { type NextFunction, type Request, type Response, json } from 'express';
import { type Server, createServer } from 'node:http';
import request from 'supertest';
import z from 'zod';
import type { AddressInfo } from 'node:net';
import { McpController } from 'src/controllers/mcp.controller.js';

describe('MCP HTTP transport', () => {
  let server: Server;
  let endpoint: URL;
  let enabled = true;
  const app = express();
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
  const controller = new McpController(
    { authenticateMcp: authenticate } as never,
    { getConfig: () => Promise.resolve({ connectedApps: { allowMcp: enabled } }) } as never,
    { createServer: createTools } as never,
    {} as never,
    { hit } as never,
    { setContext: vi.fn() } as never,
  );
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
    app.use(json());
    app.post('/api/mcp', (req, res, next) => {
      void controller.handle(req, res, req.body).catch(next);
    });
    app.get('/api/mcp', (req, res, next) => {
      void controller.listen(req, res).catch(next);
    });
    app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      if (error instanceof HttpException) {
        res.status(error.getStatus()).json(error.getResponse());
      } else {
        res.status(500).end();
      }
    });
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    endpoint = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/mcp`);
  });

  beforeEach(() => {
    enabled = true;
    vi.clearAllMocks();
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
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

  it('reports the grant rate-limit wait before creating a tool server', async () => {
    hit.mockResolvedValueOnce({ count: 61, resetSeconds: 23 });
    await post().expect(429).expect('Retry-After', '23');
    expect(createTools).not.toHaveBeenCalled();
  });
});
