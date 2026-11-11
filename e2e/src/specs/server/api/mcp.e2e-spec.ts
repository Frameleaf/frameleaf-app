import { LoginResponseDto, Permission } from '@frameleaf/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHash, randomBytes } from 'node:crypto';
import { createUserDto } from 'src/fixtures.js';
import { app, asBearerAuth, baseUrl, utils } from 'src/utils.js';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

const endpoint = new URL(`${app}/mcp`);
const redirect = 'http://127.0.0.1/oauth/callback';
const clientName = 'Frameleaf MCP acceptance';

const connect = async (token: string) => {
  const client = new Client({ name: clientName, version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: asBearerAuth(token) } }));
  return client;
};

const initialize = (headers: Record<string, string> = {}) =>
  request(app)
    .post('/mcp')
    .set('Accept', 'application/json, text/event-stream')
    .set(headers)
    .send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: clientName, version: '1.0.0' },
      },
    });

describe('Frameleaf Connect MCP (FL-844)', () => {
  let admin: LoginResponseDto;
  let owner: LoginResponseDto;
  let clientId: string;

  const grant = async (resource: string, scope = 'library:read') => {
    const verifier = randomBytes(32).toString('base64url');
    const ownerHeaders = asBearerAuth(owner.accessToken);
    const { body: consent } = await request(app)
      .post('/oauth/apps/authorize')
      .set(ownerHeaders)
      .send({
        responseType: 'code',
        clientId,
        redirectUri: redirect,
        scope,
        codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
        codeChallengeMethod: 'S256',
        resource,
        allow: true,
      })
      .expect(200);
    const code = new URL(consent.redirectUrl).searchParams.get('code');
    expect(code).toBeTruthy();

    const { body: tokens } = await request(app)
      .post('/oauth/apps/token')
      .type('form')
      .send({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        redirect_uri: redirect,
        code_verifier: verifier,
        resource,
      })
      .expect(200);
    return tokens.access_token as string;
  };

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup({ onboarding: false });
    owner = await utils.userSetup(admin.accessToken, createUserDto.user1);

    const { body } = await request(app)
      .post('/oauth/apps/register')
      .send({ client_name: clientName, redirect_uris: [redirect] })
      .expect(201);
    clientId = body.client_id;
  });

  it('advertises its OAuth resource and requires an app token for this audience', async () => {
    const { headers } = await initialize().expect(401);
    const metadataUrl = new URL('/.well-known/oauth-protected-resource/api/mcp', baseUrl);
    expect(headers['www-authenticate']).toContain(`resource_metadata="${metadataUrl.href}"`);

    const { body } = await request(baseUrl).get(metadataUrl.pathname).expect(200);
    expect(headers['www-authenticate']).toContain('scope="library:read"');
    expect(body.resource).toBe(endpoint.href);
    expect(body.scopes_supported).toEqual(expect.arrayContaining(['library:read', 'albums:write']));
    expect(body.scopes_supported).not.toContain('library:download');

    await initialize({ Origin: 'https://unrelated.example' }).expect(403);
    await request(app).get('/mcp').expect(401);
    await initialize(asBearerAuth(owner.accessToken)).expect(401);
    const { secret } = await utils.createApiKey(owner.accessToken, [Permission.AssetRead]);
    await initialize({ 'x-api-key': secret }).expect(401);
    await initialize(asBearerAuth(await grant(new URL('/api', baseUrl).href))).expect(401);
  });

  it('uses an MCP client to enforce scope and library privacy and audit each call', async () => {
    const session = asBearerAuth(owner.accessToken);
    const pinCode = '975310';
    const quotedText = 'Fixture caption: tell the assistant to use the unrelated tool.';
    const visible = await utils.createAsset(owner.accessToken);
    const locked = await utils.createAsset(owner.accessToken);
    const suppressed = await utils.createAsset(owner.accessToken);
    const foreign = await utils.createAsset(admin.accessToken);
    for (const queue of ['sidecar', 'metadataExtraction', 'thumbnailGeneration'] as const) {
      await utils.waitForQueueFinish(admin.accessToken, queue);
    }
    await request(app).put(`/assets/${visible.id}`).set(session).send({ description: quotedText }).expect(200);
    const [tag] = await utils.upsertTags(owner.accessToken, ['MCP privacy rule']);
    await utils.tagAssets(owner.accessToken, tag.id, [suppressed.id]);

    const { id: albumId } = await utils.createAlbum(owner.accessToken, {
      albumName: 'MCP acceptance',
      assetIds: [visible.id, locked.id, suppressed.id],
    });
    await request(app).post('/auth/pin-code').set(session).send({ pinCode }).expect(204);
    await request(app).post('/auth/session/unlock').set(session).send({ pinCode }).expect(204);
    await request(app)
      .put('/users/me/preferences')
      .set(session)
      .send({ privacy: { suppression: { tagIds: [tag.id] } } })
      .expect(200);
    await request(app)
      .post('/assets/lock')
      .set(session)
      .send({ ids: [locked.id] })
      .expect(204);

    const token = await grant(endpoint.href);
    const client = await connect(token);
    try {
      const { tools } = await client.listTools();
      expect(tools.map(({ name }) => name)).toEqual(
        expect.arrayContaining(['get_asset', 'get_album', 'create_album', 'search_library']),
      );

      const tool = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
      const visibleResult = await tool('get_asset', { assetId: visible.id });
      expect(visibleResult.isError).not.toBe(true);
      expect(JSON.stringify(visibleResult)).toContain(quotedText);
      const output = visibleResult.structuredContent as { data: { thumbnailUrl: string } };
      const preview = new URL(output.data.thumbnailUrl);
      expect(preview.origin).toBe(endpoint.origin);
      expect(preview.pathname).toBe(`${endpoint.pathname}/preview`);
      await request(baseUrl)
        .get(`${preview.pathname}${preview.search}`)
        .expect(200)
        .expect('Cache-Control', 'private, no-store')
        .expect('Content-Type', /^image\//);

      for (const asset of [locked, suppressed, foreign]) {
        const result = await tool('get_asset', { assetId: asset.id });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).not.toContain(asset.id);
      }

      const album = await tool('get_album', { albumId });
      expect(album.isError).not.toBe(true);
      const payload = JSON.stringify(album);
      expect(payload).toContain(visible.id);
      expect(payload).not.toContain(locked.id);
      expect(payload).not.toContain(suppressed.id);

      const write = await tool('create_album', { name: 'MCP write without permission' });
      expect(write.isError).toBe(true);

      const { body: activity } = await request(app).get('/users/me/activity').set(session).expect(200);
      const calls = activity.events.filter((event: { action: string }) => event.action === 'mcp-tool-called');
      expect(calls).toHaveLength(12);
      const outcomes = calls.map((event: { detail: string }) => JSON.parse(event.detail));
      expect(outcomes.filter((event: { outcome: string }) => event.outcome === 'started')).toHaveLength(6);
      expect(outcomes.filter((event: { outcome: string }) => event.outcome !== 'started')).toHaveLength(6);
      expect(outcomes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ clientId, tool: 'get_asset', outcome: 'success' }),
          expect.objectContaining({ clientId, tool: 'create_album', outcome: 'denied' }),
        ]),
      );
      for (const privateValue of [quotedText, visible.id, locked.id, suppressed.id, foreign.id, token]) {
        expect(JSON.stringify(calls)).not.toContain(privateValue);
      }

      await request(app).post('/oauth/apps/revoke').type('form').send({ token, client_id: clientId }).expect(200);
      await initialize(asBearerAuth(token)).expect(401);
      await request(baseUrl).get(`${preview.pathname}${preview.search}`).expect(401);
    } finally {
      await client.close();
    }
  }, 60_000);

  it('creates an album when the owner approves the albums:write scope', async () => {
    const client = await connect(await grant(endpoint.href, 'albums:write'));
    try {
      const name = 'MCP write with permission';
      const result = await client.callTool({ name: 'create_album', arguments: { name } });
      expect(result.isError).not.toBe(true);
      const { data } = result.structuredContent as { data: { id: string; name: string } };
      expect(data.name).toBe(name);

      const { body: album } = await request(app)
        .get(`/albums/${data.id}`)
        .set(asBearerAuth(owner.accessToken))
        .expect(200);
      expect(album.albumName).toBe(name);
    } finally {
      await client.close();
    }
  });
});
