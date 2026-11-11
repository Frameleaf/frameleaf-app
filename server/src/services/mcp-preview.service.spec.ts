import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthOAuthApp } from 'src/dtos/auth.dto.js';
import { CacheControl } from 'src/enum.js';
import { McpPreviewService } from 'src/services/mcp-preview.service.js';
import { FileDownloadResponse } from 'src/utils/file.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { newTestService } from 'test/utils.js';

const resource = 'https://library.example/api/mcp';
const assetId = '5d170114-0086-4ef7-a80f-084278f18ea7';
const app: AuthOAuthApp = {
  grantId: '4cbdcd91-0b55-4dd9-9729-c2d58991055b',
  clientId: 'test-client',
  clientName: 'Test',
  scopes: ['library:read'],
  resource,
};

describe(McpPreviewService.name, () => {
  let sut: McpPreviewService;
  let mocks: ReturnType<typeof newTestService<McpPreviewService>>['mocks'];
  const validatePreviewGrant = vi.fn();
  const authorizeMcpGrant = vi.fn();
  const viewThumbnail = vi.fn();
  const auth = { user: authStub.admin.user, oauthApp: app };

  beforeEach(() => {
    vi.resetAllMocks();
    ({ sut, mocks } = newTestService(McpPreviewService));
    mocks.crypto.serverKeyedHash.mockResolvedValue(Buffer.alloc(32, 1).toString('base64url'));
    validatePreviewGrant.mockResolvedValue(auth);
    authorizeMcpGrant.mockResolvedValue(auth);
    mocks.asset.isCastable.mockResolvedValue(true);
    viewThumbnail.mockResolvedValue(
      new FileDownloadResponse({
        path: '/test/thumbnail.webp',
        fileName: 'private-name.webp',
        contentType: 'image/webp',
        cacheControl: CacheControl.PrivateWithCache,
      }),
    );
    Object.assign(sut, { oauth: { validatePreviewGrant }, auth: { authorizeMcpGrant }, media: { viewThumbnail } });
  });

  afterEach(() => vi.useRealTimers());

  const makeToken = async () => new URL(await sut.createUrl(app, resource, assetId)).searchParams.get('token');

  it('binds a signed URL to one thumbnail and omits the source name', async () => {
    const file = await sut.read(await makeToken(), resource, 'lan');
    expect(validatePreviewGrant).toHaveBeenCalledWith(app.grantId);
    expect(viewThumbnail).toHaveBeenCalledWith(auth, assetId, { size: 'thumbnail' }, 'lan');
    expect(file).toMatchObject({ path: '/test/thumbnail.webp', fileName: undefined, cacheControl: CacheControl.None });
  });

  it('rejects an expired URL before looking up its grant', async () => {
    vi.useFakeTimers();
    const token = await makeToken();
    vi.setSystemTime(Date.now() + 5 * 60 * 1000);
    await expect(sut.read(token, resource, null)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(validatePreviewGrant).not.toHaveBeenCalled();
  });

  it('rejects a token for another origin', async () => {
    await expect(sut.read(await makeToken(), 'https://other.example/api/mcp', null)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(validatePreviewGrant).not.toHaveBeenCalled();
  });

  it('rejects a URL as soon as the photo becomes hidden', async () => {
    mocks.asset.isCastable.mockResolvedValue(false);
    await expect(sut.read(await makeToken(), resource, null)).rejects.toBeInstanceOf(NotFoundException);
    expect(viewThumbnail).not.toHaveBeenCalled();
  });
});
