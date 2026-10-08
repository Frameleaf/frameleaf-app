import { ForbiddenException } from '@nestjs/common';
import { ServerRole } from 'src/enum.js';
import {
  VIEWER_READ_ONLY,
  VIEWER_SIGN_IN_REQUIRED,
  canUploadAs,
  getServerRole,
  grantViewerScope,
  isServerViewer,
  revokeViewerAccess,
  viewerReadOnlyError,
  viewerSignInRequiredError,
} from 'src/utils/frameleaf-viewer.js';

const deps = () => ({
  frameleafAccountRepository: {
    getUserIdsByAccess: vi.fn().mockResolvedValue([]),
    markScopeGranted: vi.fn().mockResolvedValue(undefined),
    clearScopeGranted: vi.fn().mockResolvedValue(undefined),
    deleteSessions: vi.fn().mockResolvedValue(undefined),
  },
  partnerRepository: {
    get: vi.fn().mockResolvedValue(undefined),
    getAll: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue({}),
    remove: vi.fn().mockResolvedValue(undefined),
  },
  sessionRepository: {
    getByUserId: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
  },
  eventRepository: { emit: vi.fn().mockResolvedValue(undefined) },
  websocketRepository: { clientSend: vi.fn() },
});

describe('server role (FL-235)', () => {
  it.each([
    [true, 'owner', ServerRole.Owner],
    [true, 'admin', ServerRole.Admin],
    [true, null, ServerRole.Admin],
    // an administrator is never held back to viewing (the last one is never demoted)
    [true, 'viewer', ServerRole.Admin],
    [false, 'viewer', ServerRole.Viewer],
    [false, 'editor', ServerRole.User],
    [false, 'owner', ServerRole.User],
    [false, null, ServerRole.User],
    [false, undefined, ServerRole.User],
  ] as const)('isAdmin %s with access %s is %s', (isAdmin, access, role) => {
    expect(getServerRole(isAdmin, access)).toBe(role);
    expect(isServerViewer(isAdmin, access)).toBe(role === ServerRole.Viewer);
  });

  it('lets everyone but a Viewer upload, and an API key only with the upload permission', () => {
    expect(canUploadAs(ServerRole.Owner)).toBe(true);
    expect(canUploadAs(ServerRole.User)).toBe(true);
    expect(canUploadAs(ServerRole.Viewer)).toBe(false);
    expect(canUploadAs(ServerRole.User, ['asset.read'])).toBe(false);
    expect(canUploadAs(ServerRole.User, ['asset.upload'])).toBe(true);
    expect(canUploadAs(ServerRole.User, ['all'])).toBe(true);
    expect(canUploadAs(ServerRole.Viewer, ['all'])).toBe(false);
  });

  it('refuses with a machine-readable code', () => {
    for (const [error, code] of [
      [viewerReadOnlyError(), VIEWER_READ_ONLY],
      [viewerSignInRequiredError(), VIEWER_SIGN_IN_REQUIRED],
    ] as const) {
      expect(error).toBeInstanceOf(ForbiddenException);
      expect(error.getResponse()).toMatchObject({ code, statusCode: 403 });
    }
  });
});

describe(grantViewerScope.name, () => {
  it('shares the server owner’s library with the viewer, in their timeline, once', async () => {
    const d = deps();
    d.frameleafAccountRepository.getUserIdsByAccess.mockResolvedValue(['owner-1', 'owner-2', 'viewer-1']);
    d.partnerRepository.get.mockImplementation(({ sharedById }: { sharedById: string }) =>
      Promise.resolve(sharedById === 'owner-2' ? { sharedById } : undefined),
    );

    await expect(grantViewerScope(d as never, 'viewer-1')).resolves.toEqual(['owner-1']);

    expect(d.frameleafAccountRepository.getUserIdsByAccess).toHaveBeenCalledWith('owner');
    expect(d.partnerRepository.create).toHaveBeenCalledTimes(1);
    expect(d.partnerRepository.create).toHaveBeenCalledWith({
      sharedById: 'owner-1',
      sharedWithId: 'viewer-1',
      inTimeline: true,
    });
    expect(d.frameleafAccountRepository.markScopeGranted).toHaveBeenCalledWith('viewer-1');
  });

  it('records the grant even when the server owner is not known yet', async () => {
    const d = deps();

    await expect(grantViewerScope(d as never, 'viewer-1')).resolves.toEqual([]);
    expect(d.partnerRepository.create).not.toHaveBeenCalled();
    expect(d.frameleafAccountRepository.markScopeGranted).toHaveBeenCalledWith('viewer-1');
  });
});

describe(revokeViewerAccess.name, () => {
  it('removes every library shared with the viewer, ends all their sessions and clears the grant', async () => {
    const d = deps();
    d.partnerRepository.getAll.mockResolvedValue([
      { sharedById: 'owner-1', sharedWithId: 'viewer-1' },
      { sharedById: 'mum', sharedWithId: 'viewer-1' },
      // the viewer's own library shared with someone else is theirs to keep
      { sharedById: 'viewer-1', sharedWithId: 'someone' },
    ]);
    d.sessionRepository.getByUserId.mockResolvedValue([{ id: 'session-1' }, { id: 'session-2' }]);

    await revokeViewerAccess(d as never, 'viewer-1');

    expect(d.partnerRepository.getAll).toHaveBeenCalledWith('viewer-1');
    expect(d.partnerRepository.remove).toHaveBeenCalledTimes(2);
    expect(d.partnerRepository.remove).toHaveBeenCalledWith({ sharedById: 'owner-1', sharedWithId: 'viewer-1' });
    expect(d.partnerRepository.remove).toHaveBeenCalledWith({ sharedById: 'mum', sharedWithId: 'viewer-1' });
    expect(d.websocketRepository.clientSend).toHaveBeenCalledWith('PartnerRevokeV1', 'viewer-1', {
      sharedById: 'mum',
      sharedWithId: 'viewer-1',
    });
    expect(d.websocketRepository.clientSend).toHaveBeenCalledWith('PartnerRevokeV1', 'mum', {
      sharedById: 'mum',
      sharedWithId: 'viewer-1',
    });
    expect(d.sessionRepository.delete).toHaveBeenCalledWith('session-1');
    expect(d.sessionRepository.delete).toHaveBeenCalledWith('session-2');
    expect(d.eventRepository.emit).toHaveBeenCalledWith('SessionDelete', { sessionId: 'session-2' });
    expect(d.frameleafAccountRepository.deleteSessions).toHaveBeenCalledWith(['session-1', 'session-2']);
    expect(d.frameleafAccountRepository.clearScopeGranted).toHaveBeenCalledWith('viewer-1');
  });
});
