import { randomUUID } from 'node:crypto';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { CacheControl } from 'src/enum.js';
import { ConnectMediaService } from 'src/services/connect-media.service.js';
import { FileDownloadResponse } from 'src/utils/file.js';
import { authStub } from 'test/fixtures/auth.stub.js';

const id = randomUUID(),
  grantId = randomUUID(),
  assetId = randomUUID();
const auth: AuthDto = {
  user: authStub.user1.user,
  oauthApp: {
    grantId,
    clientId: randomUUID(),
    clientName: 'test',
    resource: 'https://library.example/api/connect',
    scopes: ['library:read', 'library:download'],
    accessPolicy: { version: 1, allLibraryRead: true, readAlbumIds: [], writableAlbumIds: [], writeWorkspaces: [] },
  },
};
const file = new FileDownloadResponse({
  path: '/sanitized/preview.jpg',
  contentType: 'image/jpeg',
  fileName: 'Private title.jpg',
  cacheControl: CacheControl.PrivateWithCache,
});
const fixture = () => {
  const resource = {
    id,
    offset: 10,
    expectedSize: 10,
    expectedChecksum: Buffer.alloc(32),
    state: 'verified',
    expiresAt: new Date(Date.now() + 3600_000),
    metadata: { connect: { requestId: 'save-1' } },
  };
  const repository = {
    state: vi.fn().mockResolvedValue({ resource }),
    ticket: vi.fn().mockResolvedValue({ grantId, assetId, variant: 'preview' }),
    createTicket: vi
      .fn()
      .mockResolvedValue({ url: '/api/connect/renditions/opaque', expiresAt: new Date().toISOString() }),
  };
  const uploads = {
    cancel: vi.fn(),
    commitConnect: vi.fn(),
    limits: vi.fn().mockResolvedValue({ maxSize: 1000, maxAppendSize: 100, maxAge: 86400 }),
  };
  const media = {
    viewThumbnail: vi.fn().mockResolvedValue(file),
    downloadOriginal: vi.fn().mockResolvedValue(file),
    fullSizeAllowed: vi.fn().mockResolvedValue(false),
  };
  const connect = { requireReadableAssets: vi.fn().mockResolvedValue(undefined) };
  const oauth = { validatePreviewGrant: vi.fn().mockResolvedValue(auth) };
  const authService = {
    authorizeConnectGrant: vi.fn().mockResolvedValue(auth),
    requireOriginalTransfer: vi.fn().mockResolvedValue(undefined),
  };
  const service = new ConnectMediaService(
    repository as never,
    uploads as never,
    media as never,
    connect as never,
    oauth as never,
    authService as never,
  );
  return { service, repository, uploads, media, connect, oauth, authService, resource };
};

describe('Connect media delivery and terminal state', () => {
  it('serves the existing preview preserving MIME but hiding filenames and disabling persistent caching', async () => {
    const f = fixture();
    const result = await f.service.rendition(auth, assetId, 'preview', 'relay');
    expect(result.path).toBe(file.path);
    expect(result.contentType).toBe('image/jpeg');
    expect(result.fileName).toBe(`${assetId}.jpg`);
    expect(result.cacheControl).toBe(CacheControl.None);
  });

  it('checks relay original transfer before obtaining an original', async () => {
    const f = fixture();
    f.authService.requireOriginalTransfer.mockRejectedValue(new Error('originals denied'));
    await expect(f.service.rendition(auth, assetId, 'original', 'relay')).rejects.toThrow('originals denied');
    expect(f.media.downloadOriginal).not.toHaveBeenCalled();
  });

  it('rejects original delivery without a download scope', async () => {
    const f = fixture();
    await expect(
      f.service.rendition(
        { ...auth, oauthApp: { ...auth.oauthApp!, scopes: ['library:read'] } },
        assetId,
        'original',
        null,
      ),
    ).rejects.toThrow('Missing required Connect scope');
    expect(f.media.downloadOriginal).not.toHaveBeenCalled();
  });

  it('revalidates ticket grants with the actual relay path and its media quota', async () => {
    const f = fixture();
    await f.service.ticket('opaque', 'relay');
    expect(f.oauth.validatePreviewGrant).toHaveBeenCalledWith(grantId);
    expect(f.authService.authorizeConnectGrant).toHaveBeenCalledWith(auth, auth.oauthApp!.resource, 'relay');
    expect(f.connect.requireReadableAssets).toHaveBeenCalledWith(auth, [assetId]);
  });

  it.each(['expired', 'revoked', 'private'] as const)(
    'denies a ticket that is %s without serving bytes',
    async (condition) => {
      const f = fixture();
      if (condition === 'expired') f.repository.ticket.mockRejectedValue(new Error('ticket expired'));
      if (condition === 'revoked') f.oauth.validatePreviewGrant.mockRejectedValue(new Error('grant revoked'));
      if (condition === 'private') f.connect.requireReadableAssets.mockRejectedValue(new Error('asset private'));
      await expect(f.service.ticket('opaque', 'relay')).rejects.toThrow();
      expect(f.media.viewThumbnail).not.toHaveBeenCalled();
      expect(f.media.downloadOriginal).not.toHaveBeenCalled();
    },
  );

  it('applies the original-transfer rule on anonymous ticket fetches too', async () => {
    const f = fixture();
    f.repository.ticket.mockResolvedValue({ grantId, assetId, variant: 'original' });
    f.authService.requireOriginalTransfer.mockRejectedValue(new Error('originals denied'));
    await expect(f.service.ticket('opaque', 'relay')).rejects.toThrow('originals denied');
    expect(f.media.downloadOriginal).not.toHaveBeenCalled();
  });

  it('does not issue tickets for an unreadable asset', async () => {
    const f = fixture();
    f.connect.requireReadableAssets.mockRejectedValue(new Error('private'));
    await expect(f.service.createTicket(auth, assetId, 'preview', null)).rejects.toThrow('private');
    expect(f.repository.createTicket).not.toHaveBeenCalled();
  });

  it('does not delete committed media when cancelling or create another publication on retry', async () => {
    const f = fixture();
    const receipt = { assetId, status: 'created', sha256: '00'.repeat(32) };
    f.repository.state.mockResolvedValue({ resource: { ...f.resource, state: 'published' }, receipt });
    expect((await f.service.cancel(auth, id)).receipt).toEqual(receipt);
    expect(await f.service.commit(auth, id, { requestId: 'save-1', sha256: receipt.sha256 })).toEqual(receipt);
    expect(f.uploads.cancel).not.toHaveBeenCalled();
    expect(f.uploads.commitConnect).not.toHaveBeenCalled();
  });

  it('refuses a changed key or digest even for an already committed receipt', async () => {
    const f = fixture();
    f.repository.state.mockResolvedValue({ resource: { ...f.resource, state: 'published' }, receipt: { assetId } });
    await expect(f.service.commit(auth, id, { requestId: 'another', sha256: '00'.repeat(32) })).rejects.toThrow(
      'Request ID payload changed',
    );
    await expect(f.service.commit(auth, id, { requestId: 'save-1', sha256: 'ff'.repeat(32) })).rejects.toThrow(
      'Request ID payload changed',
    );
    expect(f.uploads.commitConnect).not.toHaveBeenCalled();
  });

  it('reports effective disk and account limits with the 30 day receipt window', async () => {
    const f = fixture();
    const result = await f.service.capabilities(
      {
        ...auth,
        oauthApp: {
          ...auth.oauthApp!,
          scopes: [...auth.oauthApp!.scopes, 'boards:upload'],
          accessPolicy: { ...auth.oauthApp!.accessPolicy!, writeWorkspaces: ['design'] },
        },
        user: { ...auth.user, quotaSizeInBytes: 500, quotaUsageInBytes: 200 },
      },
      'relay',
    );
    expect(result.maxUploadBytes).toBe(300);
    expect(result.receiptWindowSeconds).toBe(30 * 86400);
    expect(result.renditionTicketSeconds).toBe(900);
    expect(result.originalsAllowed).toBe(false);
  });
});
