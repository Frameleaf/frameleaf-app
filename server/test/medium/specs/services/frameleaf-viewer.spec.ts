import { ForbiddenException } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { AssetVisibility } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { FrameleafAccountRepository } from 'src/repositories/frameleaf-account.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PartnerRepository } from 'src/repositories/partner.repository.js';
import { SessionRepository } from 'src/repositories/session.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { WebsocketRepository } from 'src/repositories/websocket.repository.js';
import { DB } from 'src/schema/index.js';
import { AuthService } from 'src/services/auth.service.js';
import { VIEWER_READ_ONLY, grantViewerScope, revokeViewerAccess } from 'src/utils/frameleaf-viewer.js';
import { newMediumService } from 'test/medium.factory.js';
import { newUuid } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

/**
 * FL-235: a server Viewer on a real database. The Viewer's scope is partner sharing: the server
 * owner's library is shared at the first sign-in, library owners widen or narrow it, and revoking
 * the access removes it so the partner audit streams the deletes to every mirror.
 */
let db: Kysely<DB>;

beforeAll(async () => {
  db = await getKyselyDB();
  await sql`UPDATE immich_fork.state SET phase='dual-write' WHERE id=1`.execute(db);
});

afterAll(async () => {
  await db?.destroy();
});

const setup = () => {
  const { sut, ctx } = newMediumService(AuthService, {
    database: db,
    real: [
      AccessRepository,
      ConfigRepository,
      CryptoRepository,
      DatabaseRepository,
      FrameleafAccountRepository,
      PartnerRepository,
      SessionRepository,
      SystemMetadataRepository,
      UserRepository,
    ],
    mock: [LoggingRepository, EventRepository, WebsocketRepository],
  });
  const deps = {
    frameleafAccountRepository: ctx.get(FrameleafAccountRepository),
    partnerRepository: ctx.get(PartnerRepository),
    sessionRepository: ctx.get(SessionRepository),
    eventRepository: { emit: vi.fn() },
    websocketRepository: { clientSend: vi.fn() },
  };
  return { sut, ctx, deps };
};

const linkRow = (userId: string, access: 'owner' | 'viewer') => ({
  userId,
  sub: `sub-${newUuid()}`,
  email: `${newUuid()}@example.test`,
  emailVerified: true,
  role: access === 'owner' ? ('admin' as const) : ('user' as const),
  autoRegistered: access === 'viewer',
  access,
});

const signedInViewer = async (ctx: ReturnType<typeof setup>['ctx']) => {
  const accounts = ctx.get(FrameleafAccountRepository);
  const { user: owner } = await ctx.newUser({ isAdmin: true });
  const { user: viewer } = await ctx.newUser();
  await accounts.upsertLink(linkRow(owner.id, 'owner'));
  const link = await accounts.upsertLink(linkRow(viewer.id, 'viewer'));
  const token = `viewer-${newUuid()}`;
  const { session } = await ctx.newSession({
    userId: viewer.id,
    token: ctx.get(CryptoRepository).hashSha256(token),
    updatedAt: new Date(),
  });
  await accounts.tagSession({ sessionId: session.id, userId: viewer.id, sid: null, sub: link.sub, authTime: null });
  return { owner, viewer, token, session };
};

const request = (token: string, viewerAllowed: boolean) => ({
  headers: { cookie: `immich_access_token=${token}` },
  queryParams: {},
  metadata: { adminRoute: false, sharedLinkRoute: false, uri: '/api/test', viewerAllowed },
});

describe('server Viewer (FL-235)', () => {
  it('lets a viewer read the server owner’s library but never its Locked items', async () => {
    const { ctx, deps } = setup();
    const { owner, viewer } = await signedInViewer(ctx);
    const { asset: visible } = await ctx.newAsset({ ownerId: owner.id });
    const { asset: locked } = await ctx.newAsset({ ownerId: owner.id, visibility: AssetVisibility.Locked });
    const access = ctx.get(AccessRepository);

    await expect(access.asset.checkPartnerAccess(viewer.id, new Set([visible.id]))).resolves.toEqual(new Set());

    await expect(grantViewerScope(deps, viewer.id)).resolves.toContain(owner.id);
    await expect(ctx.get(PartnerRepository).get({ sharedById: owner.id, sharedWithId: viewer.id })).resolves.toEqual(
      expect.objectContaining({ inTimeline: true }),
    );
    await expect(access.asset.checkPartnerAccess(viewer.id, new Set([visible.id, locked.id]))).resolves.toEqual(
      new Set([visible.id]),
    );
    await expect(ctx.get(FrameleafAccountRepository).getLinkByUser(viewer.id)).resolves.toMatchObject({
      scopeGrantedAt: expect.any(Date),
    });
  });

  it('answers reads and refuses writes on the viewer’s Frameleaf session, and refuses any other session', async () => {
    const { sut, ctx } = setup();
    const { viewer, token } = await signedInViewer(ctx);

    await expect(sut.authenticate(request(token, true))).resolves.toMatchObject({ user: { id: viewer.id } });
    const error = await sut.authenticate(request(token, false)).catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getResponse()).toMatchObject({ code: VIEWER_READ_ONLY });

    // a password session of the same account is not a Frameleaf sign-in
    const other = `password-${newUuid()}`;
    await ctx.newSession({
      userId: viewer.id,
      token: ctx.get(CryptoRepository).hashSha256(other),
      updatedAt: new Date(),
    });
    await expect(sut.authenticate(request(other, true))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('streams the deletes and ends every session when the access is revoked', async () => {
    const { sut, ctx, deps } = setup();
    const { owner, viewer, token, session } = await signedInViewer(ctx);
    const { user: mum } = await ctx.newUser();
    // a library owner widened the scope by sharing with the viewer too
    await ctx.newPartner({ sharedById: mum.id, sharedWithId: viewer.id });
    await grantViewerScope(deps, viewer.id);
    const { asset } = await ctx.newAsset({ ownerId: owner.id });

    await revokeViewerAccess(deps, viewer.id);

    const audit = await db
      .selectFrom('partner_audit')
      .select(['sharedById', 'sharedWithId'])
      .where('sharedWithId', '=', viewer.id)
      .execute();
    expect(audit).toEqual(
      expect.arrayContaining([
        { sharedById: owner.id, sharedWithId: viewer.id },
        { sharedById: mum.id, sharedWithId: viewer.id },
      ]),
    );
    await expect(ctx.get(AccessRepository).asset.checkPartnerAccess(viewer.id, new Set([asset.id]))).resolves.toEqual(
      new Set(),
    );
    await expect(ctx.get(SessionRepository).get(session.id)).resolves.toBeUndefined();
    await expect(ctx.get(FrameleafAccountRepository).getSession(session.id)).resolves.toBeUndefined();
    await expect(sut.authenticate(request(token, true))).rejects.toThrow();
    // the account stays a viewer, ready for the scope to be granted again if the cloud invites it again
    await expect(ctx.get(FrameleafAccountRepository).getLinkByUser(viewer.id)).resolves.toMatchObject({
      access: 'viewer',
      scopeGrantedAt: null,
    });
  });
});
