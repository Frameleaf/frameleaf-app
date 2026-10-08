import { ForbiddenException } from '@nestjs/common';
import type { EventRepository } from 'src/repositories/event.repository.js';
import type { FrameleafAccountRepository } from 'src/repositories/frameleaf-account.repository.js';
import type { PartnerRepository } from 'src/repositories/partner.repository.js';
import type { SessionRepository } from 'src/repositories/session.repository.js';
import type { WebsocketRepository } from 'src/repositories/websocket.repository.js';
import type { FrameleafAccess } from 'src/utils/frameleaf-sign-in.js';
import { Permission, ServerRole } from 'src/enum.js';
import { isGranted } from 'src/utils/access.js';

/**
 * Server-level Viewer access (FL-235, NAPI-011) for an account Frameleaf Cloud invited to this server
 * as a viewer (`frameleaf_access = viewer` on its Sign in with Frameleaf).
 *
 * The model is a server role over partner sharing:
 * - **Role.** The account is held to reading: it may call every GET route and the routes marked
 *   `@ViewerAllowed()` (reads sent as POST, and ending or handing over its own session); every
 *   other route, every upload and every administration route refuses it
 *   (`AuthService.authenticate`). It is never an administrator, and it reaches the server only
 *   through a Sign in with Frameleaf session, so the cloud's invitation stays the authority.
 * - **Scope.** What it sees is what library owners share with it through partner sharing, plus any
 *   album or shared space it is a member of. At its first sign-in as a viewer the server owner's
 *   library (the account linked with `frameleaf_access = owner`) is shared with it, in its timeline;
 *   library owners widen or narrow that from their partner settings. Partner access never reaches
 *   Locked items, and face names follow the owner's partner rules.
 * - **Revocation.** When the cloud removes the share it ends the viewer's sessions by back-channel
 *   logout; once the last one has ended (or the server's link is removed) every partner share with
 *   the viewer is removed, so the partner audit streams the deletes (`PartnerDeleteV1`) to every
 *   mirror, and every session the account still holds ends. It stays a viewer without a scope; a
 *   new invitation grants the scope again at the next sign-in.
 */

export const VIEWER_READ_ONLY = 'frameleaf_viewer_read_only';
export const VIEWER_READ_ONLY_MESSAGE = 'You can view this server, but not change it';
export const VIEWER_SIGN_IN_REQUIRED = 'frameleaf_viewer_sign_in_required';
export const VIEWER_SIGN_IN_REQUIRED_MESSAGE = 'Sign in with your Frameleaf account to view this server';

export const viewerReadOnlyError = () =>
  new ForbiddenException({
    message: VIEWER_READ_ONLY_MESSAGE,
    error: 'Forbidden',
    statusCode: 403,
    code: VIEWER_READ_ONLY,
  });

export const viewerSignInRequiredError = () =>
  new ForbiddenException({
    message: VIEWER_SIGN_IN_REQUIRED_MESSAGE,
    error: 'Forbidden',
    statusCode: 403,
    code: VIEWER_SIGN_IN_REQUIRED,
  });

/** An administrator is never held back to viewing (the last one is never demoted by a sign-in). */
export const isServerViewer = (isAdmin: boolean, access: FrameleafAccess | null | undefined) =>
  !isAdmin && access === 'viewer';

export const getServerRole = (isAdmin: boolean, access: FrameleafAccess | null | undefined): ServerRole => {
  if (isAdmin) {
    return access === 'owner' ? ServerRole.Owner : ServerRole.Admin;
  }
  return access === 'viewer' ? ServerRole.Viewer : ServerRole.User;
};

/** Whether this role (and API key, when the request used one) may upload: the app shows backup only then. */
export const canUploadAs = (role: ServerRole, apiKeyPermissions?: string[]) =>
  role !== ServerRole.Viewer &&
  (!apiKeyPermissions ||
    isGranted({ requested: [Permission.AssetUpload], current: apiKeyPermissions as Permission[] }));

export type ViewerAccessDeps = {
  frameleafAccountRepository: Pick<
    FrameleafAccountRepository,
    'getUserIdsByAccess' | 'markScopeGranted' | 'clearScopeGranted' | 'deleteSessions'
  >;
  partnerRepository: Pick<PartnerRepository, 'get' | 'getAll' | 'create' | 'remove'>;
  sessionRepository: Pick<SessionRepository, 'getByUserId' | 'delete'>;
  eventRepository: Pick<EventRepository, 'emit'>;
  websocketRepository: Pick<WebsocketRepository, 'clientSend'>;
};

/**
 * Grant a viewer its scope: the server owner's library, shared as a partner in its timeline unless
 * that owner already shares with it. Returns the owners whose library was newly shared.
 */
export const grantViewerScope = async (deps: ViewerAccessDeps, viewerId: string): Promise<string[]> => {
  const granted: string[] = [];
  for (const ownerId of await deps.frameleafAccountRepository.getUserIdsByAccess('owner')) {
    if (ownerId === viewerId) {
      continue;
    }
    const ids = { sharedById: ownerId, sharedWithId: viewerId };
    if (await deps.partnerRepository.get(ids)) {
      continue;
    }
    await deps.partnerRepository.create({ ...ids, inTimeline: true });
    granted.push(ownerId);
  }
  await deps.frameleafAccountRepository.markScopeGranted(viewerId);
  return granted;
};

/**
 * Revoke a viewer's access: every partner share with it is removed (the partner audit streams the
 * deletes to every mirror, and open pages are told), every session it holds ends, and its scope
 * grant is cleared. Its own library, if it has one, stays as it is.
 */
export const revokeViewerAccess = async (deps: ViewerAccessDeps, viewerId: string): Promise<void> => {
  const partners = await deps.partnerRepository.getAll(viewerId);
  for (const { sharedById, sharedWithId } of partners) {
    if (sharedWithId !== viewerId) {
      continue;
    }
    const ids = { sharedById, sharedWithId };
    await deps.partnerRepository.remove(ids);
    for (const userId of [viewerId, sharedById]) {
      deps.websocketRepository.clientSend('PartnerRevokeV1', userId, ids);
    }
  }

  const sessionIds = (await deps.sessionRepository.getByUserId(viewerId)).map(({ id }) => id);
  for (const sessionId of sessionIds) {
    await deps.sessionRepository.delete(sessionId);
    await deps.eventRepository.emit('SessionDelete', { sessionId });
  }
  await deps.frameleafAccountRepository.deleteSessions(sessionIds);
  await deps.frameleafAccountRepository.clearScopeGranted(viewerId);
};
