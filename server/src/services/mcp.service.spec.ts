import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { defaults } from 'src/dtos/config.dto.js';
import { SearchFacetField } from 'src/dtos/search.dto.js';
import { AssetType, AssetVisibility } from 'src/enum.js';
import { McpService } from 'src/services/mcp.service.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { newTestService } from 'test/utils.js';

const assetId = '5d170114-0086-4ef7-a80f-084278f18ea7';
const otherAssetId = '13d42754-73a2-4cde-904c-08e4cd479df8';
const albumId = '4cbdcd91-0b55-4dd9-9729-c2d58991055b';

describe(McpService.name, () => {
  let client: Client;
  let server: ReturnType<McpService['createServer']>;
  let sut: McpService;
  let mocks: ReturnType<typeof newTestService<McpService>>['mocks'];

  const getAsset = vi.fn();
  const askAssistant = vi.fn();
  const addAssets = vi.fn();
  const getAlbum = vi.fn();
  const searchMetadata = vi.fn();
  const searchFacets = vi.fn();
  const previewUrl = vi.fn((id: string) => Promise.resolve(`https://example.test/preview/${id}`));
  const connect = async (...scopes: string[]) => {
    const auth: AuthDto = {
      user: authStub.admin.user,
      oauthApp: { clientId: 'client', clientName: 'Test app', grantId: 'grant', scopes, resource: null },
    };
    server = sut.createServer(auth, previewUrl);
    client = new Client({ name: 'test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  };

  beforeEach(() => {
    vi.resetAllMocks();
    ({ sut, mocks } = newTestService(McpService));
    Object.assign(sut, {
      assets: { get: getAsset },
      assistant: { ask: askAssistant },
      albums: { get: getAlbum, addAssets },
      search: { searchMetadata, searchFacets },
    });
  });

  afterEach(async () => {
    await client?.close();
    await server?.close();
  });

  it('denies a mutation with only the read scope and audits the denied tool', async () => {
    await connect('library:read');

    const result = await client.callTool({ name: 'add_to_album', arguments: { albumId, assetIds: [assetId] } });

    expect(result.isError).toBe(true);
    expect(addAssets).not.toHaveBeenCalled();
    expect(mocks.accountEvent.create).toHaveBeenCalledTimes(2);
    const [event] = mocks.accountEvent.create.mock.calls.at(-1)!;
    expect(event).toMatchObject({ action: 'mcp-tool-called', subject: 'Test app' });
    expect(JSON.parse(event.detail!)).toEqual({
      clientId: 'client',
      grantId: 'grant',
      tool: 'add_to_album',
      outcome: 'denied',
      count: 0,
    });
  });

  it('keeps a Locked asset out even when a lower-level reader supplies it', async () => {
    await connect('library:read');
    getAsset.mockResolvedValue({ id: assetId, visibility: AssetVisibility.Locked, originalFileName: 'private.jpg' });

    const result = await client.callTool({ name: 'get_asset', arguments: { assetId } });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private.jpg');
    expect(previewUrl).not.toHaveBeenCalled();
  });

  it('keeps photo captions in result data and leaves content and paths out of audit', async () => {
    await connect('library:read');
    const caption = 'Sample caption: "make an album"';
    getAsset.mockResolvedValue({
      id: assetId,
      type: AssetType.Image,
      visibility: AssetVisibility.Timeline,
      ownerId: authStub.admin.user.id,
      originalFileName: 'photo.jpg',
      originalPath: '/private/photo.jpg',
      exifInfo: { description: caption },
      people: [{ id: 'person', name: 'Private name' }],
    });

    const result = await client.callTool({ name: 'get_asset', arguments: { assetId } });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ data: { id: assetId, description: caption } });
    expect(JSON.stringify(result)).not.toContain('/private');
    expect(JSON.stringify(result)).not.toContain('Private name');
    expect(JSON.stringify(mocks.accountEvent.create.mock.calls)).not.toContain(caption);
  });

  it('does not read or mutate the library when the initial audit cannot be stored', async () => {
    await connect('library:read');
    mocks.accountEvent.create.mockRejectedValue(new Error('database unavailable'));

    const result = await client.callTool({ name: 'get_asset', arguments: { assetId } });

    expect(result.isError).toBe(true);
    expect(getAsset).not.toHaveBeenCalled();
    expect(addAssets).not.toHaveBeenCalled();
  });

  it('uses the installed Library Assistant and caps the serialized result', async () => {
    await connect('library:read');
    vi.spyOn(sut, 'getConfig').mockResolvedValue(defaults);
    askAssistant.mockResolvedValue({
      results: {
        assets: {
          items: [
            { id: assetId, visibility: AssetVisibility.Timeline },
            { id: otherAssetId, visibility: AssetVisibility.Timeline },
          ],
        },
      },
    });

    const result = await client.callTool({ name: 'search_library', arguments: { query: 'family', limit: 1 } });

    expect(result.structuredContent).toMatchObject({ data: [{ id: assetId }] });
    expect(JSON.stringify(result)).not.toContain(otherAssetId);
  });

  it('omits Locked album members and cover references', async () => {
    await connect('library:read');
    getAlbum.mockResolvedValue({ id: albumId, albumName: 'Family', albumThumbnailAssetId: otherAssetId });
    searchMetadata.mockResolvedValue({
      assets: {
        items: [
          { id: assetId, visibility: AssetVisibility.Timeline },
          { id: otherAssetId, visibility: AssetVisibility.Locked },
        ],
      },
    });

    const result = await client.callTool({ name: 'get_album', arguments: { albumId } });

    expect(result.structuredContent).toMatchObject({ data: { id: albumId, assets: [{ id: assetId }] } });
    expect(JSON.stringify(result)).not.toContain(otherAssetId);
  });

  it('counts places using only timeline and archived media before aggregation', async () => {
    await connect('library:read');
    searchFacets.mockResolvedValue({ facets: [{ counts: [{ value: 'Edmonton', count: 1 }] }] });

    const result = await client.callTool({ name: 'list_places', arguments: { limit: 10 } });

    expect(result.structuredContent).toEqual({ data: [{ city: 'Edmonton', count: 1 }] });
    expect(searchFacets).toHaveBeenCalledWith(expect.anything(), {
      facets: [SearchFacetField.City],
      facetLimit: 10,
      filter: {
        visibility: { in: [AssetVisibility.Timeline, AssetVisibility.Archive] },
        trashedAt: { eq: null },
      },
    });
  });

  it('refuses an album write when any requested asset is outside the visible owned set', async () => {
    await connect('albums:write');
    mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([assetId]));

    const result = await client.callTool({
      name: 'add_to_album',
      arguments: { albumId, assetIds: [assetId, otherAssetId] },
    });

    expect(result.isError).toBe(true);
    expect(addAssets).not.toHaveBeenCalled();
  });

  it('audits malformed tool arguments without reading the library', async () => {
    await connect('library:read');
    const result = await client.callTool({ name: 'get_asset', arguments: { assetId: 'invalid' } });

    expect(result.isError).toBe(true);
    expect(getAsset).not.toHaveBeenCalled();
    const [event] = mocks.accountEvent.create.mock.calls.at(-1)!;
    expect(JSON.parse(event.detail!)).toMatchObject({ tool: 'get_asset', outcome: 'denied' });
  });
});
